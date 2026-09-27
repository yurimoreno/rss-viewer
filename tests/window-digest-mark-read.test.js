const assert = require('assert');
const { bootstrapApp, click } = require('./helpers/dom-harness');

/**
 * Global 24h digest offers "Mark all N as read" for the unread items in the
 * window (not only the Unread scope), and the button tracks live read state
 * when the digest is shown again from cache.
 */
async function run() {
  const feedUrl = 'https://news.example/rss.xml';
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const rawItems = [
    { title: 'Fresh 1', link: 'https://news.example/1', isoDate: hoursAgo(1) },
    { title: 'Fresh 2', link: 'https://news.example/2', isoDate: hoursAgo(5) },
    { title: 'Fresh 3', link: 'https://news.example/3', isoDate: hoursAgo(20) },
    { title: 'Old', link: 'https://news.example/old', isoDate: hoursAgo(72) }
  ];
  let llmCalls = 0;
  const { document, localStorage } = bootstrapApp({
    localStorageSeed: {
      'rssViewer.library': { feeds: [{ url: feedUrl, title: 'News', category: 'Tech' }], categories: ['Tech'] },
      'rssViewer.settings': {
        provider: 'local',
        baseUrl: 'http://127.0.0.1:8080/v1',
        modelIdDigest: 'local-model',
        modelIdSummary: 'local-model'
      }
    },
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('/api/rss')) return { ok: true, async json() { return { items: rawItems }; } };
      if (u.includes('/api/llm/chat')) {
        llmCalls += 1;
        return { ok: true, async json() { return { content: '**Lead**\n- Fresh news. [1]' }; } };
      }
      return { ok: false, async json() { return {}; } };
    }
  });

  click(document.getElementById('btn-refresh'));
  await new Promise((r) => setTimeout(r, 30));

  const windowSelect = document.getElementById('digest-window');
  windowSelect.value = '24h';
  click(document.getElementById('btn-generate-digest'));
  await new Promise((r) => setTimeout(r, 50));
  // The jsdom harness can boot init() twice (manual + native DOMContentLoaded),
  // so compare against the count after the first generate, not an absolute.
  const callsAfterFirst = llmCalls;
  assert.ok(callsAfterFirst >= 1, 'Generate should call the LLM');

  const markBtn = document.querySelector('#digest-card .digest-mark-read-btn');
  assert.ok(markBtn, '24h digest should offer mark-as-read');
  assert.strictEqual(markBtn.textContent, 'Mark all 3 as read', 'Only the 3 items inside the 24h window count');

  click(markBtn);
  const read = JSON.parse(localStorage.getItem('rss_read_articles') || '{}');
  const readTitles = rawItems.filter((i) => Object.keys(read).some((id) => id.includes(i.link))).map((i) => i.title);
  assert.deepStrictEqual(readTitles.sort(), ['Fresh 1', 'Fresh 2', 'Fresh 3'], 'Window items are marked read; older item is not');

  // Re-show from cache: nothing unread left in the window, so no button.
  click(document.getElementById('btn-generate-digest'));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(llmCalls, callsAfterFirst, 'Second generate is served from cache');
  assert.ok(!document.querySelector('#digest-card .digest-mark-read-btn'), 'No mark-read button once the window is all read');

  console.log('Window digest mark-read test passed: 24h digest marks its unread items read, cache re-show respects read state.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
