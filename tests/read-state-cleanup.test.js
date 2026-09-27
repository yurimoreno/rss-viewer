// Regression: read marks for articles still served by a feed must survive cleanup,
// otherwise slow/dead feeds resurface old posts as unread every 30 days.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const window = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/lib/read-state.js'), 'utf8'), { window, localStorage });
const rs = window.RSS_READ_STATE;

const old = new Date(Date.now() - 60 * 86400000).toISOString();
store.rss_read_articles = JSON.stringify({ 'feed|live': old, 'feed|gone': old });
rs.cleanupReadArticles(30, new Set(['feed|live']));
assert.ok(rs.isRead('feed|live'), 'old mark for an item still in the feed must be kept');
assert.ok(!rs.isRead('feed|gone'), 'old mark for an item no longer in any feed is pruned');
console.log('Read-state cleanup test passed: live items keep read marks past 30 days.');
