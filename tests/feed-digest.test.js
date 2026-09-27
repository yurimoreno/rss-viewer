const assert = require('assert');
const { bootstrapApp, click, getJson } = require('./helpers/dom-harness');

/**
 * Per-feed AI digest: panel mounts on feed open without calling the LLM.
 * Generate is explicit; cache key is feed-scoped.
 */
async function run() {
  const feedUrl = 'https://business-insider.example/rss.xml';
  const library = {
    feeds: [{ url: feedUrl, title: 'Business Insider', category: 'Business' }],
    categories: ['Business']
  };
  const rawItems = new Array(40).fill(null).map((_, i) => ({
    title: 'Story ' + i,
    link: 'https://example.com/bi/' + i,
    pubDate: '2024-06-' + String((i % 28) + 1).padStart(2, '0') + 'T12:00:00Z',
    contentSnippet: 'Summary for story ' + i
  }));

  let llmCalls = 0;
  const { document, localStorage, window } = bootstrapApp({
    localStorageSeed: {
      'rssViewer.library': library,
      'rssViewer.settings': {
        provider: 'local',
        baseUrl: 'http://127.0.0.1:8080/v1',
        modelIdDigest: 'local-model',
        modelIdSummary: 'local-model'
      }
    },
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.includes('/api/rss')) {
        return { ok: true, async json() { return { items: rawItems }; } };
      }
      if (u.includes('/api/llm/chat')) {
        llmCalls += 1;
        return {
          ok: true,
          async json() {
            return { content: '**Lead**\n**Story 0:** Biggest update in the set. [1]\n\n**Business**\n- **Story 1:** Secondary item. [2]' };
          }
        };
      }
      return { ok: false, async json() { return {}; } };
    }
  });

  click(document.getElementById('btn-refresh'));
  await new Promise((r) => setTimeout(r, 30));

  // Open the feed from the sidebar (expand category first if needed)
  const catHeader = document.querySelector('.sidebar-group[data-category="Business"] .sidebar-category-row');
  assert.ok(catHeader, 'Business category should exist');
  if (!document.querySelector('.sidebar-group[data-category="Business"].is-expanded')) {
    click(catHeader);
  }
  const feedBtn = document.querySelector('.sidebar-group[data-category="Business"] .sidebar-feed');
  assert.ok(feedBtn, 'Business Insider feed row should exist');
  click(feedBtn);
  await new Promise((r) => setTimeout(r, 40));

  const panel = document.querySelector('.feed-digest-panel');
  assert.ok(panel, 'Opening a feed should show the AI feed-digest panel');
  const genBtn = document.querySelector('.feed-digest-generate');
  assert.ok(genBtn, 'Feed digest generate button should exist');
  assert.strictEqual(llmCalls, 0, 'Opening a feed must not call the LLM automatically');

  const idleCard = document.querySelector('.feed-digest-card');
  assert.ok(idleCard, 'Digest card exists');
  assert.ok(idleCard.hidden, 'Idle digest card stays hidden until generate (no coaching placeholder)');

  assert.ok(document.querySelector('.feed-source-section'), 'Source items section should sit below the digest');
  assert.ok(document.querySelectorAll('#today-content .article-card').length > 0, 'Source list should still list items');

  click(genBtn);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(llmCalls, 1, 'One explicit Generate should make one LLM call');
  assert.ok(document.querySelector('.feed-digest-card .digest-body'), 'Digest body should render after generate');

  const cache = getJson(localStorage, 'rssViewer.digestCache');
  const keys = Object.keys(cache.entries || cache || {}).filter((k) => String(k).includes('feed:'));
  // cache shape is { order, entries }
  const entryKeys = cache.entries ? Object.keys(cache.entries) : Object.keys(cache);
  assert.ok(
    entryKeys.some((k) => k.indexOf('feed:') === 0 || k.indexOf('feed:' + feedUrl) !== -1 || k.includes('feed:')),
    'Digest cache should store a feed-scoped key, got: ' + entryKeys.join(', ')
  );

  // Re-open feed: still no extra LLM call (cache hit on mount)
  click(document.querySelector('.sidebar-feed.sidebar-all') || document.querySelector('.sidebar-all-row .sidebar-feed'));
  await new Promise((r) => setTimeout(r, 20));
  click(feedBtn);
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(llmCalls, 1, 'Re-opening feed with cached digest must not re-call the LLM');
  assert.ok(document.querySelector('.feed-digest-card .digest-body'), 'Cached digest should show on reopen');

  console.log('Feed digest test passed: AI-first panel, explicit generate, cache, no auto LLM on open.');
}

run().catch((error) => {
  console.error(`Feed digest test failed: ${error.stack || error.message}`);
  process.exit(1);
});
