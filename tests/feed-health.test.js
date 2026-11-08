const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Conditional GET (ETag/304), failure backoff, Retry-After, /api/feed-health
// and /api/discover, against a local fixture server.
process.env.RSS_VIEWER_ALLOW_PRIVATE_FETCH = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rssv-health-'));
process.env.RSS_VIEWER_LIBRARY_PATH = path.join(tmp, 'library.json');
process.env.RSS_VIEWER_FEED_STATE_PATH = path.join(tmp, 'feed-state.json');

const { backoffDelay, parseRetryAfter, parseFreshness, BASE_BACKOFF_MS, MAX_BACKOFF_MS } = require('../lib/feed-state');
const app = require('../server');

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture Feed</title><link>http://x/</link>' +
  '<item><title>One</title><link>http://x/1</link><guid>1</guid><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item>' +
  '</channel></rss>';
const ATOM = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Comments</title><id>c</id><updated>2026-11-01T00:00:00Z</updated>' +
  '<entry><title>C</title><id>c1</id><link href="http://x/c1"/><updated>2026-11-01T00:00:00Z</updated></entry></feed>';

const hits = {};
let brokenStatus = 500;
const fixture = http.createServer((req, res) => {
  hits[req.url] = (hits[req.url] || 0) + 1;
  if (req.url === '/etag.xml') {
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/rss+xml', ETag: '"v1"' });
    return res.end(RSS);
  }
  if (req.url === '/fresh.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Cache-Control': 'max-age=600' });
    return res.end(RSS);
  }
  if (req.url === '/broken.xml') {
    res.writeHead(brokenStatus, brokenStatus === 429 ? { 'Retry-After': '7200' } : {});
    return res.end('nope');
  }
  if (req.url === '/notfeed') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('just text');
  }
  if (req.url === '/site/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><head><link rel="alternate" type="application/rss+xml" href="/etag.xml">' +
      '<link rel="alternate" type="application/atom+xml" href="comments.atom">' +
      '<link rel="alternate" type="application/rss+xml" title="Rate limited" href="limited.xml"><link rel="stylesheet" href="/a.css"></head><body></body></html>');
  }
  if (req.url === '/site/comments.atom') {
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    return res.end(ATOM);
  }
  if (req.url === '/site/limited.xml') {
    res.writeHead(419);
    return res.end();
  }
  if (req.url === '/bare') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><head><title>No links</title></head></html>');
  }
  if (req.url === '/feed') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return res.end(RSS);
  }
  res.writeHead(404);
  res.end();
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function run() {
  // Pure policy
  assert.strictEqual(backoffDelay(0), 0);
  assert.strictEqual(backoffDelay(1), BASE_BACKOFF_MS);
  assert.strictEqual(Math.round(backoffDelay(2)), Math.round(BASE_BACKOFF_MS * 1.8));
  assert.strictEqual(backoffDelay(50), MAX_BACKOFF_MS);
  assert.strictEqual(parseRetryAfter('120'), 120000);
  assert.strictEqual(parseRetryAfter(new Date(Date.now() + 60000).toUTCString()) > 50000, true);
  assert.strictEqual(parseRetryAfter('garbage'), 0);
  assert.strictEqual(parseFreshness('public, max-age=300'), 300000);
  assert.strictEqual(parseFreshness('max-age=999999'), 3600000, 'freshness is capped at 1h');
  assert.strictEqual(parseFreshness('no-cache, max-age=300'), 0);

  const fx = await listen(fixture);
  const base = 'http://127.0.0.1:' + fx;
  const appServer = http.createServer(app);
  const port = await listen(appServer);
  const rss = (u, extra = '') => getJson(port, '/api/rss?url=' + encodeURIComponent(base + u) + extra);

  // ETag → second fetch is a conditional GET answered from memory.
  let r = await rss('/etag.xml');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.items.length, 1);
  r = await rss('/etag.xml');
  assert.strictEqual(r.status, 200, '304 upstream still answers 200 with items');
  assert.strictEqual(r.headers['x-feed-cache'], 'not-modified');
  assert.strictEqual(r.body.items[0].title, 'One');
  assert.strictEqual(hits['/etag.xml'], 2);

  // Cache-Control max-age → second call doesn't touch upstream at all.
  await rss('/fresh.xml');
  r = await rss('/fresh.xml');
  assert.strictEqual(r.headers['x-feed-cache'], 'fresh');
  assert.strictEqual(hits['/fresh.xml'], 1);
  await rss('/fresh.xml', '&force=1');
  assert.strictEqual(hits['/fresh.xml'], 2, 'force=1 bypasses freshness');

  // Failure → backoff: next non-forced call is refused without hitting upstream.
  r = await rss('/broken.xml');
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.message, 'HTTP 500');
  r = await rss('/broken.xml');
  assert.strictEqual(r.body.error, 'backing_off');
  assert.strictEqual(hits['/broken.xml'], 1);
  brokenStatus = 429;
  await rss('/broken.xml', '&force=1');
  assert.strictEqual(hits['/broken.xml'], 3, '429 also triggers the one-shot UA fallback retry');
  const st = app.feedState.get(base + '/broken.xml');
  assert.strictEqual(st.consecutiveFailures, 2);
  assert.ok(st.retryAfterUntil - Date.now() > 7000 * 1000, 'Retry-After (2h) beats the 27min backoff');

  // Non-feed body is a recorded failure with a readable reason.
  r = await rss('/notfeed');
  assert.strictEqual(r.body.message, 'Not a valid RSS/Atom feed');

  // Health only reports library feeds.
  fs.writeFileSync(process.env.RSS_VIEWER_LIBRARY_PATH, JSON.stringify({
    feeds: [{ url: base + '/etag.xml', title: 'E', category: 'X' }, { url: base + '/broken.xml', title: 'B', category: 'X' }]
  }));
  r = await getJson(port, '/api/feed-health');
  assert.deepStrictEqual(Object.keys(r.body.feeds).sort(), [base + '/broken.xml', base + '/etag.xml'].sort());
  const ok = r.body.feeds[base + '/etag.xml'];
  assert.strictEqual(ok.consecutiveFailures, 0);
  assert.strictEqual(ok.itemCount, 1);
  assert.strictEqual(ok.newestItemAt, Date.parse('Mon, 02 Nov 2026 10:00:00 GMT'));
  const bad = r.body.feeds[base + '/broken.xml'];
  assert.strictEqual(bad.consecutiveFailures, 2);
  assert.strictEqual(bad.lastError, 'HTTP 429');
  assert.ok(bad.firstFailureAt > 0);

  // A later success clears the failure fields.
  app.feedState.recordSuccess(base + '/broken.xml', { status: 200, itemCount: 3 });
  r = await getJson(port, '/api/feed-health');
  assert.strictEqual(r.body.feeds[base + '/broken.xml'].lastError, '');
  assert.strictEqual(r.body.feeds[base + '/broken.xml'].retryAfterUntil, 0);

  // Discovery: a feed URL returns itself with its title.
  r = await getJson(port, '/api/discover?url=' + encodeURIComponent(base + '/etag.xml'));
  assert.deepStrictEqual(r.body.feeds, [{ url: base + '/etag.xml', title: 'Fixture Feed', verified: true }]);
  // An HTML page lists its <link rel=alternate> feeds, resolved, non-feed links ignored.
  r = await getJson(port, '/api/discover?url=' + encodeURIComponent(base + '/site/'));
  assert.deepStrictEqual(r.body.feeds, [
    { url: base + '/etag.xml', title: 'Fixture Feed', verified: true },
    { url: base + '/site/comments.atom', title: 'Comments', verified: true },
    { url: base + '/site/limited.xml', title: 'Rate limited', verified: false }
  ]);
  // A page without links falls back to common paths on the origin.
  r = await getJson(port, '/api/discover?url=' + encodeURIComponent(base + '/bare'));
  assert.deepStrictEqual(r.body.feeds, [{ url: base + '/feed', title: 'Fixture Feed', verified: true }]);
  r = await getJson(port, '/api/discover?url=not-a-url');
  assert.strictEqual(r.status, 400);

  app.feedState.flush();
  const saved = JSON.parse(fs.readFileSync(process.env.RSS_VIEWER_FEED_STATE_PATH, 'utf8'));
  assert.strictEqual(saved[base + '/etag.xml'].etag, '"v1"', 'state persists to disk');

  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => fixture.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Feed health test passed: ETag/304, max-age freshness, backoff + Retry-After, health endpoint, discovery.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
