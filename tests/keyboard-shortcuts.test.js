const assert = require('assert');
const { bootstrapApp, click, getJson } = require('./helpers/dom-harness');

// Covers GH issue #1 (yurimoreno/rss-viewer): article reading view keyboard
// shortcuts (SPEC-002) reported as not working. Escape/j/k/o/m were already
// correct; 's' (save to Read Later) was a dead stub — fixed to click the
// same .btn-save the UI button uses.
async function run() {
  const feedUrl = 'https://example.com/rss.xml';
  const library = { feeds: [{ url: feedUrl, title: 'Example Feed', category: 'Uncategorized' }], categories: ['Uncategorized'] };
  const cache = {
    [feedUrl]: [
      { id: feedUrl + '|1', title: 'First Article', link: feedUrl + '/1', pubDate: '2024-01-02T00:00:00Z', summary: 'A summary.', content: '', author: '' },
      { id: feedUrl + '|2', title: 'Second Article', link: feedUrl + '/2', pubDate: '2024-01-01T00:00:00Z', summary: 'Another summary.', content: '', author: '' }
    ]
  };

  const { window, document, localStorage } = bootstrapApp({
    localStorageSeed: {
      'rssViewer.library': library,
      'rssViewer.feedItemCache': cache
    },
    fetchImpl: async () => { throw new Error('unexpected fetch in keyboard-shortcuts test'); }
  });

  function press(key) {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  const firstCard = document.querySelector('.item[data-item-id="' + feedUrl + '|1"]');
  const secondCard = document.querySelector('.item[data-item-id="' + feedUrl + '|2"]');
  assert.ok(firstCard && secondCard, 'Both article cards should render');

  click(firstCard);
  assert.ok(firstCard.classList.contains('expanded'), 'Clicking a card expands it');

  press('j');
  assert.ok(!firstCard.classList.contains('expanded'), 'j moves expansion off the first card');
  assert.ok(secondCard.classList.contains('expanded'), 'j expands the next card');

  press('k');
  assert.ok(firstCard.classList.contains('expanded'), 'k moves expansion back to the first card');

  const readToggleBtn = firstCard.querySelector('.btn-read-toggle');
  const wasRead = readToggleBtn.textContent.includes('unread');
  press('m');
  assert.strictEqual(firstCard.classList.contains('is-read'), !wasRead, 'm toggles read state on the expanded card');

  press('s');
  const readLater = getJson(localStorage, 'rss_read_later');
  assert.ok(Array.isArray(readLater) && readLater.length === 1, 's saves the expanded article to Read Later');
  assert.strictEqual(readLater[0].guid, feedUrl + '|1', 's saves the currently expanded article');

  press('Escape');
  assert.ok(!firstCard.classList.contains('expanded'), 'Escape collapses the expanded card');

  console.log('Keyboard shortcuts test passed: j/k navigation, m read-toggle, s save-to-read-later, and Escape collapse all verified.');
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
