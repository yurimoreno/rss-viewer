const assert = require('assert');
const { bootstrapApp, click, getJson } = require('./helpers/dom-harness');

// Read state moved from a per-item `isRead` flag in the feed cache (SPEC-005)
// to a separate rss_read_articles map — this covers the current model plus
// the sidebar/category mark-all-read and All/Unread filter built on top of it.
async function run() {
  const feedUrl = 'https://feed-a.example/rss.xml';
  const library = { feeds: [{ url: feedUrl, title: 'Feed A', category: 'Tech' }], categories: ['Tech'] };
  const rawItems = new Array(60).fill(null).map((_, i) => ({
    title: 'Item ' + i,
    link: 'https://example.com/' + i,
    pubDate: '2024-01-' + String((i % 28) + 1).padStart(2, '0') + 'T00:00:00Z'
  }));

  const { document, localStorage } = bootstrapApp({
    localStorageSeed: { 'rssViewer.library': library },
    fetchImpl: async () => ({ ok: true, async json() { return { items: rawItems }; } })
  });

  click(document.getElementById('btn-refresh'));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cached = getJson(localStorage, 'rssViewer.feedItemCache');
  assert.strictEqual(cached[feedUrl].length, 50, 'Cached feed items should be capped at MAX_ITEMS_PER_FEED (50)');

  const categoryFeedRow = document.querySelector('.sidebar-group[data-category="Tech"] .sidebar-feed');
  assert.strictEqual(categoryFeedRow.querySelector('.sidebar-count').textContent, '50', 'Sidebar feed badge should show 50 unread');

  const firstItem = document.querySelector('#today-content .item');
  assert.ok(firstItem, 'Today view should render cached items');
  const readToggle = firstItem.querySelector('.btn-read-toggle');
  click(readToggle);

  const readArticles = getJson(localStorage, 'rss_read_articles');
  assert.strictEqual(Object.keys(readArticles).length, 1, 'Toggling read on one item should mark exactly one article read');
  assert.ok(firstItem.classList.contains('is-read'), 'Read item should get the is-read class');

  const updatedCategoryFeedRow = document.querySelector('.sidebar-group[data-category="Tech"] .sidebar-feed');
  assert.strictEqual(updatedCategoryFeedRow.querySelector('.sidebar-count').textContent, '49', 'Sidebar unread count should decrement after marking read');

  // Unread-only filter should hide the one read item.
  click(document.getElementById('filter-show-unread'));
  assert.strictEqual(document.querySelectorAll('#today-content .item').length, 49, 'Unread filter should hide the read item');
  click(document.getElementById('filter-show-all'));
  assert.strictEqual(document.querySelectorAll('#today-content .item').length, 50, 'Switching back to All should show every item again');

  // Mark all as read for the category.
  const markAllReadBtn = document.querySelector('.feed-group-mark-all-read');
  assert.ok(markAllReadBtn, 'Category header should expose a Mark all read control');
  click(markAllReadBtn);

  const readArticlesAfterMarkAll = getJson(localStorage, 'rss_read_articles');
  assert.strictEqual(Object.keys(readArticlesAfterMarkAll).length, 50, 'Mark all read should mark every cached item in the category as read');
  const finalCategoryFeedRow = document.querySelector('.sidebar-group[data-category="Tech"] .sidebar-feed');
  assert.strictEqual(finalCategoryFeedRow.querySelector('.sidebar-count').classList.contains('is-zero'), true, 'Sidebar count should read zero after mark all read');

  console.log('Unread cache test passed: 50-item cap, read toggle, unread filter, and category mark-all-read all verified.');
}

run().catch((error) => {
  console.error(`Unread cache test failed: ${error.stack || error.message}`);
  process.exit(1);
});
