const assert = require('assert');
const { bootstrapApp, click, getJson } = require('./helpers/dom-harness');

// "Saved articles" was renamed to "Read Later" (rss_read_later key, with a
// migration from the older rss_saved_articles key) — this covers the current UI.
async function run() {
  const feedUrl = 'https://example.com/rss.xml';
  const library = { feeds: [{ url: feedUrl, title: 'Example Feed', category: 'Uncategorized' }], categories: ['Uncategorized'] };
  const cache = { [feedUrl]: [{ id: feedUrl + '|1', title: 'Saveable Article', link: feedUrl + '/1', pubDate: '2024-01-01T00:00:00Z', summary: 'A summary.', content: '', author: '' }] };

  const { document, localStorage } = bootstrapApp({
    localStorageSeed: {
      'rssViewer.library': library,
      'rssViewer.feedItemCache': cache
    },
    // Not exercised in this test: the sidebar-feed click flow re-fetches over
    // the network, which would race with (and overwrite) the seeded cache.
    fetchImpl: async () => { throw new Error('unexpected fetch in read-later test'); }
  });

  // The default "All feeds" Today view already includes the seeded item.
  const saveBtn = document.querySelector('.item[data-item-id="' + feedUrl + '|1"] .btn-save');
  assert.ok(saveBtn, 'Save (Read Later) button should render on the item');
  click(saveBtn);

  const readLater = getJson(localStorage, 'rss_read_later');
  assert.ok(Array.isArray(readLater), 'Read Later list should be persisted');
  assert.strictEqual(readLater.length, 1, 'Saved article should be added to Read Later');
  assert.strictEqual(readLater[0].guid, feedUrl + '|1', 'Saved article guid should match the item id');

  const countEl = document.getElementById('read-later-count');
  assert.strictEqual(countEl.textContent, '1', 'Sidebar Read Later count should update');
  assert.ok(document.querySelector('.saved-badge'), 'Item card should show a saved badge');

  click(document.querySelector('.sidebar-nav-item[data-view="read_later"]'));
  const readLaterItems = document.querySelectorAll('#today-content .item');
  assert.strictEqual(readLaterItems.length, 1, 'Read Later view should list the saved article');
  assert.strictEqual(
    readLaterItems[0].querySelector('.item-title').textContent.trim(),
    'Saveable Article',
    'Read Later view should render the saved article title'
  );

  const unsaveBtn = readLaterItems[0].querySelector('.btn-save');
  click(unsaveBtn);
  const readLaterAfterRemove = getJson(localStorage, 'rss_read_later');
  assert.strictEqual(readLaterAfterRemove.length, 0, 'Removing from Read Later should clear the stored list');

  console.log('Read Later test passed: save/unsave persists, sidebar count and badge update, Read Later view lists saved items.');
}

run().catch((error) => {
  console.error(`Read Later test failed: ${error.stack || error.message}`);
  process.exit(1);
});
