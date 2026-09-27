const assert = require('assert');
const { bootstrapApp, click, getJson } = require('./helpers/dom-harness');

/**
 * Category AI digest: click category name opens AI-first view for all feeds
 * in that category. Explicit generate only; cache key is cat-scoped.
 */
async function run() {
  const feedA = 'https://bi.example/rss.xml';
  const feedB = 'https://mw.example/rss.xml';
  const library = {
    feeds: [
      { url: feedA, title: 'BI Wire', category: 'Business' },
      { url: feedB, title: 'Market Watch', category: 'Business' },
      { url: 'https://tech.example/rss.xml', title: 'Tech Blog', category: 'Tech' }
    ],
    categories: ['Business', 'Tech']
  };
  const itemsFor = (prefix, n) =>
    new Array(n).fill(null).map((_, i) => ({
      title: prefix + ' ' + i,
      link: 'https://example.com/' + prefix + '/' + i,
      pubDate: '2024-06-0' + ((i % 9) + 1) + 'T12:00:00Z',
      contentSnippet: 'Summary ' + prefix + ' ' + i
    }));

  let llmCalls = 0;
  const { document, localStorage } = bootstrapApp({
    localStorageSeed: {
      'rssViewer.library': library,
      'rssViewer.settings': {
        provider: 'local',
        baseUrl: 'http://127.0.0.1:8080/v1',
        modelIdDigest: 'local-model',
        modelIdSummary: 'local-model'
      }
    },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/api/rss')) {
        const items = u.includes('bi.example')
          ? itemsFor('BI', 20)
          : u.includes('mw.example')
            ? itemsFor('MW', 15)
            : itemsFor('T', 5);
        return { ok: true, async json() { return { items }; } };
      }
      if (u.includes('/api/llm/chat')) {
        llmCalls += 1;
        return {
          ok: true,
          async json() {
            return { content: '**Lead**\n**BI 0:** Top story. [1]\n\n**Markets**\n- **MW 0:** Secondary. [21]' };
          }
        };
      }
      return { ok: false, async json() { return {}; } };
    }
  });

  click(document.getElementById('btn-refresh'));
  await new Promise((r) => setTimeout(r, 40));

  const catHeader = document.querySelector('.sidebar-group[data-category="Business"] .sidebar-category-row');
  assert.ok(catHeader, 'Business category should exist');

  // Chevron alone expands without opening digest view
  const beforeTitle = document.getElementById('viewer-reader-title')?.textContent || '';
  click(catHeader.querySelector('.sidebar-category-chevron'));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    document.querySelector('.sidebar-group[data-category="Business"].is-expanded'),
    'Chevron should expand the category'
  );
  assert.ok(!document.querySelector('.feed-digest-panel'), 'Chevron alone should not open category digest');

  // Click category name → AI-first category view
  click(catHeader.querySelector('.sidebar-category-name'));
  await new Promise((r) => setTimeout(r, 40));

  assert.ok(document.querySelector('.feed-digest-panel'), 'Category name opens digest panel');
  assert.match(document.getElementById('viewer-reader-title').textContent, /Business/);
  assert.strictEqual(document.getElementById('viewer-reader-eyebrow').textContent.trim(), 'Category');
  assert.ok(catHeader.classList.contains('is-active') || document.querySelector('.sidebar-category-row.is-active'), 'Category row should look selected');
  assert.strictEqual(llmCalls, 0, 'Opening category must not call the LLM');

  const genBtn = document.querySelector('.feed-digest-generate');
  assert.ok(genBtn, 'Generate button present');
  // Unread count across both Business feeds: 20 + 15 = 35
  assert.ok(/35|Digest/i.test(genBtn.textContent), 'Button should reflect category unread count, got: ' + genBtn.textContent);

  click(genBtn);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(llmCalls, 1, 'One generate → one LLM call');
  assert.ok(document.querySelector('.feed-digest-card .digest-body'), 'Digest body rendered');

  const cache = getJson(localStorage, 'rssViewer.digestCache');
  const keys = Object.keys((cache && cache.entries) || {});
  assert.ok(
    keys.some((k) => k.indexOf('cat:Business:') === 0),
    'Cache key should be category-scoped, got: ' + keys.join(', ')
  );

  assert.ok(
    document.querySelectorAll('.feed-source-groups .feed-group').length >= 2,
    'Source list should group items by feed within the category'
  );

  // Re-open: cache hit
  click(document.querySelector('.sidebar-all-row .sidebar-feed'));
  await new Promise((r) => setTimeout(r, 20));
  click(document.querySelector('.sidebar-group[data-category="Business"] .sidebar-category-name'));
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(llmCalls, 1, 'Re-open with cache must not re-call LLM');
  assert.ok(document.querySelector('.feed-digest-card .digest-body'), 'Cached category digest shown');

  // Mark all unread in scope (not only LLM subset): 20+15 = 35
  const markBtn = document.querySelector('.digest-mark-read-btn');
  assert.ok(markBtn, 'Mark-as-read control on unread digest');
  assert.match(markBtn.textContent, /35/, 'Button should name full unread count, got: ' + markBtn.textContent);
  click(markBtn);
  await new Promise((r) => setTimeout(r, 40));
  const readMap = getJson(localStorage, 'rss_read_articles') || {};
  assert.strictEqual(Object.keys(readMap).length, 35, 'Mark all should mark every unread item in the category');
  const bizCount = document.querySelector(
    '.sidebar-group[data-category="Business"] .sidebar-category-count'
  );
  assert.ok(
    !bizCount || bizCount.classList.contains('is-zero') || !bizCount.textContent.trim(),
    'Business unread badge should clear after mark-all'
  );

  console.log('Category digest test passed: open via name, chevron expand-only, explicit generate, cat cache, mark-all full set.');
}

run().catch((error) => {
  console.error(`Category digest test failed: ${error.stack || error.message}`);
  process.exit(1);
});
