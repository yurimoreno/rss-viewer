const assert = require('assert');
const http = require('http');

const app = require('../server');

function requestJson(serverPort, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        path,
        headers: {
          Accept: 'application/json'
        }
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ statusCode: res.statusCode, body: parsed });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on('error', reject);
  });
}

function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function run() {
  const appServer = http.createServer(app);
  const feedServer = http.createServer((req, res) => {
    if (req.url === '/feed.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Example Feed</title>
            <description>Example Description</description>
            <link>https://example.com</link>
            <item>
              <title>First Item</title>
              <link>https://example.com/1</link>
              <pubDate>Mon, 10 Feb 2026 10:00:00 GMT</pubDate>
              <description>Hello world</description>
            </item>
          </channel>
        </rss>`);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const { port: appPort } = await startServer(appServer);
  const { port: feedPort } = await startServer(feedServer);

  try {
    const missingUrl = await requestJson(appPort, '/api/rss');
    assert.strictEqual(missingUrl.statusCode, 400);
    assert.deepStrictEqual(missingUrl.body, { error: 'invalid_url' });

    const invalidUrl = await requestJson(appPort, '/api/rss?url=notaurl');
    assert.strictEqual(invalidUrl.statusCode, 400);
    assert.deepStrictEqual(invalidUrl.body, { error: 'invalid_url' });

    // SSRF guard: loopback/private hosts are rejected by default, for both routes.
    const ssrfRss = await requestJson(
      appPort,
      `/api/rss?url=${encodeURIComponent(`http://127.0.0.1:${feedPort}/feed.xml`)}`
    );
    assert.strictEqual(ssrfRss.statusCode, 400, '/api/rss should reject loopback hosts by default');
    assert.deepStrictEqual(ssrfRss.body, { error: 'invalid_url' });

    const ssrfArticle = await requestJson(
      appPort,
      `/api/article?url=${encodeURIComponent(`http://127.0.0.1:${feedPort}/feed.xml`)}`
    );
    assert.strictEqual(ssrfArticle.statusCode, 400, '/api/article should reject loopback hosts by default');
    assert.deepStrictEqual(ssrfArticle.body, { error: 'invalid_url' });

    // Remaining assertions need to reach the local fixture feed server, so opt
    // into the explicit test-only escape hatch for the SSRF guard.
    process.env.RSS_VIEWER_ALLOW_PRIVATE_FETCH = '1';
    try {
      const validFeed = await requestJson(
        appPort,
        `/api/rss?url=${encodeURIComponent(`http://127.0.0.1:${feedPort}/feed.xml`)}`
      );
      assert.strictEqual(validFeed.statusCode, 200);
      assert.strictEqual(validFeed.body.feed.title, 'Example Feed');
      assert.ok(Array.isArray(validFeed.body.items));
      assert.ok(validFeed.body.items.length > 0);

      const fetchFailure = await requestJson(
        appPort,
        `/api/rss?url=${encodeURIComponent('http://127.0.0.1:1/unreachable.xml')}`
      );
      assert.strictEqual(fetchFailure.statusCode, 502);
      assert.deepStrictEqual(fetchFailure.body, { error: 'fetch_failed' });
    } finally {
      delete process.env.RSS_VIEWER_ALLOW_PRIVATE_FETCH;
    }

    console.log('RSS proxy test passed: endpoint validates URL, parses feeds, blocks SSRF to private hosts, and handles failures.');
  } finally {
    await Promise.all([closeServer(appServer), closeServer(feedServer)]);
  }
}

run().catch((error) => {
  console.error(`RSS proxy test failed: ${error.stack || error.message}`);
  process.exit(1);
});
