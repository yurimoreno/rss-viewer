const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-library-'));
process.env.RSS_VIEWER_LIBRARY_PATH = path.join(tmpDir, 'library.json');

const app = require('../server');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw) });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  const { server, port } = await listen();
  try {
    const empty = await request(port, 'GET', '/api/library');
    assert.strictEqual(empty.statusCode, 200);
    assert.deepStrictEqual(empty.body, { feeds: [], categories: [] });

    const saved = await request(port, 'PUT', '/api/library', {
      feeds: [
        { url: 'https://example.com/feed.xml', title: 'Example', category: 'Tech' },
        { url: 'not-a-url', title: 'Bad' },
        { url: 'https://example.com/feed.xml', title: 'Dupe' }
      ],
      categories: ['Tech', 'Ignored Empty', '']
    });
    assert.strictEqual(saved.statusCode, 200);
    assert.strictEqual(saved.body.feeds.length, 1);
    assert.strictEqual(saved.body.feeds[0].url, 'https://example.com/feed.xml');
    assert.ok(saved.body.categories.includes('Tech'));

    const loaded = await request(port, 'GET', '/api/library');
    assert.deepStrictEqual(loaded.body.feeds, saved.body.feeds);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('Library store test passed: GET/PUT /api/library persists a sanitized feed list.');
}

run().catch((error) => {
  console.error('Library store test failed: ' + (error.stack || error.message));
  process.exit(1);
});
