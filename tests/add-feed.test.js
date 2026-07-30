const assert = require('assert');
const { bootstrapApp, click, setValue, getJson } = require('./helpers/dom-harness');

// "Recent feeds" (a transient list of last-loaded URLs) was replaced by the
// persistent library model — this covers the current single-feed add flow.
async function run() {
  const feedUrl = 'https://example.com/rss.xml';

  const { document, localStorage } = bootstrapApp({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { items: [{ title: 'Hello', link: feedUrl + '/1', pubDate: '2024-01-01T00:00:00Z' }] };
      }
    })
  });

  const addFeedUrl = document.getElementById('add-feed-url');
  const btnAddFeed = document.getElementById('btn-add-feed');

  setValue(addFeedUrl, 'not-a-url');
  click(btnAddFeed);
  assert.strictEqual(getJson(localStorage, 'rssViewer.library'), null, 'Invalid URLs should not be persisted');

  setValue(addFeedUrl, feedUrl);
  click(btnAddFeed);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const library = getJson(localStorage, 'rssViewer.library');
  assert.ok(library, 'Adding a valid feed URL should persist the library');
  assert.strictEqual(library.feeds.length, 1, 'Library should contain the added feed');
  assert.strictEqual(library.feeds[0].url, feedUrl, 'Persisted feed URL should match input');
  assert.strictEqual(library.feeds[0].category, 'Uncategorized', 'Feeds added without a category default to Uncategorized');
  assert.strictEqual(addFeedUrl.value, '', 'Input should clear after a successful add');

  const sidebarFeed = document.querySelector('.sidebar-feed[data-url="' + feedUrl + '"]');
  assert.ok(sidebarFeed, 'Newly added feed should render in the sidebar');

  // Re-adding the same URL should not duplicate the entry.
  setValue(addFeedUrl, feedUrl);
  click(btnAddFeed);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const libraryAfterDupe = getJson(localStorage, 'rssViewer.library');
  assert.strictEqual(libraryAfterDupe.feeds.length, 1, 'Adding a duplicate URL should be a no-op');

  // Remove, from the Feeds management page.
  click(document.querySelector('.sidebar-footer-link[data-page="feeds"]'));
  const removeBtn = document.querySelector('#feeds-list .feeds-list-remove');
  assert.ok(removeBtn, 'Feeds list row should expose a remove button');
  click(removeBtn);

  const libraryAfterRemove = getJson(localStorage, 'rssViewer.library');
  assert.strictEqual(libraryAfterRemove.feeds.length, 0, 'Removing the feed should clear it from the library');
  assert.strictEqual(
    document.querySelectorAll('#feeds-list .feeds-list-item').length,
    0,
    'Feeds management list should no longer show the removed feed'
  );
  assert.strictEqual(
    document.querySelector('.sidebar-feed[data-url="' + feedUrl + '"]'),
    null,
    'Sidebar should no longer show the removed feed'
  );
  assert.strictEqual(getJson(localStorage, 'rssViewer.feedItemCache')[feedUrl], undefined, 'Removing a feed should also drop its cached items');

  console.log('Add-feed test passed: valid URLs persist and render, invalid/duplicate URLs are rejected, removal clears library/cache/UI.');
}

run().catch((error) => {
  console.error(`Add-feed test failed: ${error.stack || error.message}`);
  process.exit(1);
});
