const assert = require('assert');
const { bootstrapApp, click, setFiles, getJson } = require('./helpers/dom-harness');

async function run() {
  const feedAUrl = 'https://feed-a.example/rss.xml';
  const feedBUrl = 'https://feed-b.example/rss.xml';
  const opml = `<?xml version="1.0"?>
    <opml version="1.0">
      <body>
        <outline text="Tech">
          <outline text="Feed A" xmlUrl="${feedAUrl}" />
          <outline text="Feed B" xmlUrl="${feedBUrl}" />
        </outline>
      </body>
    </opml>`;

  const { document, localStorage } = bootstrapApp({
    fetchImpl: async (requestUrl) => {
      const target = new URL(requestUrl, 'http://localhost').searchParams.get('url');
      return {
        ok: true,
        async json() {
          return {
            items: [
              { title: 'Item from ' + target, link: target + '/1', pubDate: '2024-01-01T00:00:00Z' }
            ]
          };
        }
      };
    }
  });

  const opmlInput = document.getElementById('opml-import');
  setFiles(opmlInput, [{ text: async () => opml }]);
  opmlInput.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));

  // The change handler awaits fetchAllFeeds() before re-rendering; give the microtask queue a turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const library = getJson(localStorage, 'rssViewer.library');
  assert.ok(library, 'Library should be persisted to localStorage');
  assert.strictEqual(library.feeds.length, 2, 'Both feeds from the OPML outline should be imported');
  assert.deepStrictEqual(
    library.feeds.map((f) => f.url).sort(),
    [feedAUrl, feedBUrl].sort(),
    'Imported feed URLs should match the OPML xmlUrl attributes'
  );
  assert.ok(
    library.feeds.every((f) => f.category === 'Tech'),
    'Imported feeds should carry the OPML outline folder as their category'
  );

  const sidebarCategory = document.querySelector('.sidebar-group[data-category="Tech"]');
  assert.ok(sidebarCategory, 'Sidebar should render a "Tech" category group after import');
  assert.strictEqual(
    sidebarCategory.querySelectorAll('.sidebar-feed').length,
    2,
    'Sidebar category should list both imported feeds'
  );

  click(document.querySelector('.sidebar-footer-link[data-page="feeds"]'));
  const feedsListItems = document.querySelectorAll('#feeds-list .feeds-list-item');
  assert.strictEqual(feedsListItems.length, 2, 'Feeds management page should list both imported feeds');

  // Re-importing the same OPML should not duplicate entries.
  const opmlInput2 = document.getElementById('opml-import');
  setFiles(opmlInput2, [{ text: async () => opml }]);
  opmlInput2.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const libraryAfterReimport = getJson(localStorage, 'rssViewer.library');
  assert.strictEqual(libraryAfterReimport.feeds.length, 2, 'Re-importing the same OPML should dedupe by feed URL');

  console.log('OPML import test passed: import merges into library, renders in sidebar and Feeds page, dedupes on re-import.');
}

run().catch((error) => {
  console.error(`OPML import test failed: ${error.stack || error.message}`);
  process.exit(1);
});
