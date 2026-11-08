const assert = require('assert');
const { bootstrapApp, click } = require('./helpers/dom-harness');

// Fusion-inspired reader UX: read rows stay grayed (undoable) in the Unread view
// until the view changes, the address bar tracks the view (#/feed/..., back works),
// and g-prefixed jumps, '?', and 'j' with nothing open.
async function run() {
  const feedA = 'https://a.example/rss.xml';
  const feedB = 'https://b.example/rss.xml';
  const library = {
    feeds: [
      { url: feedA, title: 'Feed A', category: 'Tech' },
      { url: feedB, title: 'Feed B', category: 'News' }
    ],
    categories: ['Tech', 'News']
  };
  const mk = (feed, n) => ({ id: feed + '|' + n, title: 'Item ' + n, link: feed + '/' + n, pubDate: '2026-11-0' + n + 'T00:00:00Z', summary: 's', content: '', author: '' });
  const cache = { [feedA]: [mk(feedA, 1), mk(feedA, 2), mk(feedA, 3)], [feedB]: [mk(feedB, 1)] };

  const { window, document } = bootstrapApp({
    localStorageSeed: {
      'rssViewer.library': library,
      'rssViewer.feedItemCache': cache,
      'rssViewer.showUnreadOnly': 'true'
    },
    fetchImpl: async (u) => {
      if (String(u).includes('/api/feed-health')) return { ok: true, json: async () => ({ feeds: {} }) };
      if (String(u).includes('/api/rss')) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const press = (key, opts = {}) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  const cards = () => Array.from(document.querySelectorAll('#today-content .article-card'));
  const card = (id) => document.querySelector('#today-content .article-card[data-item-id="' + id + '"]');

  // --- grayed rows in the Unread view
  assert.strictEqual(cards().length, 4, 'Unread view starts with 4 unread items');
  click(card(feedA + '|3'));
  assert.ok(card(feedA + '|3').classList.contains('is-read'), 'Opening marks read');
  click(card(feedA + '|3')); // collapse
  assert.ok(card(feedA + '|3'), 'Read row stays listed after collapsing in the Unread view');
  click(card(feedA + '|3').querySelector('.btn-read-toggle'));
  assert.ok(!card(feedA + '|3').classList.contains('is-read'), 'Can flip it back to unread in place');
  click(card(feedA + '|3').querySelector('.btn-read-toggle'));
  assert.ok(card(feedA + '|3').classList.contains('is-read'));

  // Refresh-style re-render of the same view keeps the pinned row.
  document.getElementById('filter-show-unread').click();
  assert.ok(card(feedA + '|3'), 'Re-rendering the same view keeps grayed rows');

  // Leaving the view commits: back in Unread, the read item is gone.
  document.getElementById('filter-show-all').click();
  assert.strictEqual(cards().length, 4);
  document.getElementById('filter-show-unread').click();
  assert.strictEqual(card(feedA + '|3'), null, 'After switching views, read rows drop out of Unread');
  assert.strictEqual(cards().length, 3);

  // Mark-all-read is bulk: rows drop immediately.
  click(document.querySelector('.feed-group-mark-all-read'));
  assert.ok(cards().length < 3, 'Group mark-all-read removes rows from the Unread view right away');
  document.getElementById('filter-show-all').click();

  // --- URL state
  assert.ok(!window.location.hash || window.location.hash === '#/', 'All view has a clean hash');
  click(document.querySelector('.sidebar-feed[data-url="' + feedB + '"]'));
  await tick(); await tick();
  assert.strictEqual(window.location.hash, '#/feed/' + encodeURIComponent(feedB), 'Opening a feed updates the hash');
  assert.strictEqual(document.getElementById('viewer-reader-title').textContent, 'Feed B');

  click(document.querySelector('.sidebar-category-row .sidebar-category-name'));
  assert.ok(/^#\/category\//.test(window.location.hash), 'Opening a category updates the hash');

  click(document.querySelector('.sidebar-footer-link[data-page="feeds"]'));
  assert.strictEqual(window.location.hash, '#/feeds');

  // Navigating by hash (back button / pasted link) restores the view.
  window.location.hash = '#/feed/' + encodeURIComponent(feedA);
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.ok(document.querySelector('.mockup-view.view-reader.active'), 'Reader view is active again');
  assert.strictEqual(document.getElementById('viewer-reader-title').textContent, 'Feed A');
  assert.ok(document.querySelector('.sidebar-feed.is-active[data-url="' + feedA + '"]'));

  window.location.hash = '#/feed/' + encodeURIComponent('https://unknown.example/x');
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  assert.strictEqual(window.location.hash, '#/', 'Unknown feed falls back to All and fixes the hash');

  // --- shortcuts
  press('g'); press('f');
  assert.ok(document.querySelector('.mockup-view.view-feeds.active'), 'g f opens Feeds');
  press('g'); press('s');
  assert.strictEqual(window.location.hash, '#/later', 'g s opens Read Later');
  press('g'); press('a');
  assert.ok(document.querySelector('.mockup-view.view-reader.active'));
  assert.ok(document.getElementById('filter-show-all').classList.contains('is-active'), 'g a shows All');

  press('j');
  const opened = document.querySelector('#today-content .article-card.expanded');
  assert.ok(opened, 'j with nothing open opens the first article, even when its group was collapsed');
  assert.ok(!opened.closest('.feed-group.is-collapsed'), 'its group is expanded');
  press('Escape');

  press('?');
  const help = document.getElementById('shortcut-help');
  assert.ok(help && !help.hidden, '? opens the shortcut help');
  assert.ok(/g u/.test(help.textContent.replace(/\s+/g, ' ')) || help.textContent.includes('Go to Unread'));
  press('Escape');
  assert.ok(help.hidden, 'Escape closes the help');

  // Typing in a field never triggers shortcuts.
  const search = document.getElementById('feed-search-input');
  press('/');
  assert.strictEqual(document.activeElement, search, '/ focuses feed search');
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));
  assert.ok(help.hidden, 'Keys typed into an input are ignored');

  console.log('Reader UX test passed: grayed undo rows, hash routing + back, g-jumps, j-from-nothing, ? help, input guard.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
