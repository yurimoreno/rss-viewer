const assert = require('assert');
const { bootstrapApp, click } = require('./helpers/dom-harness');

// Summaries must be built from the full article, not the feed's teaser: a
// 205-char excerpt is a teaser, so Summarize fetches the page first. When the
// page can't be loaded, it says so instead of summarizing the teaser.
async function run() {
  const feedUrl = 'https://buffer.example/rss';
  const teaser = "Hootsuite's pricing, workflow, or feature set no longer feels like the right fit, we've rounded up the best Hootsuite alternatives to help you find a platform that matches your workflow, goals, and budget.";
  const mk = (n, link) => ({ id: feedUrl + '|' + n, title: 'Best Hootsuite alternatives ' + n, link, pubDate: '2026-11-02T00:00:00Z', summary: teaser, content: '<p>' + teaser + '</p>', author: '' });
  const okLink = 'https://buffer.example/ok';
  const badLink = 'https://buffer.example/blocked';
  const fullHtml = '<h2>1. Buffer</h2><p>Free plan, $6/channel.</p>' + '<p>' + 'Filler paragraph about social tools. '.repeat(60) + '</p><h2>8. Sendible</h2><p>Agencies, $29/mo.</p>';
  const prompts = [];
  const { window, document } = bootstrapApp({
    localStorageSeed: {
      'rssViewer.library': { feeds: [{ url: feedUrl, title: 'Buffer', category: 'Social' }], categories: ['Social'] },
      'rssViewer.feedItemCache': { [feedUrl]: [mk(1, okLink), mk(2, badLink)] },
      'rssViewer.settings': { provider: 'local', baseUrl: 'http://127.0.0.1:8080/v1', modelIdDigest: 'm', modelIdSummary: 'm' }
    },
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.includes('/api/article')) {
        if (u.includes(encodeURIComponent(okLink))) return { ok: true, json: async () => ({ content: fullHtml }) };
        return { ok: false, status: 502, json: async () => ({ error: 'fetch_failed' }) };
      }
      if (u.includes('/api/llm/chat')) {
        prompts.push(JSON.parse(opts.body).messages[0].content);
        return { ok: true, json: async () => ({ content: '- **Buffer:** free plan, $6/channel\n- **Sendible:** agencies, $29/mo' }) };
      }
      if (u.includes('/api/feed-health')) return { ok: true, json: async () => ({ feeds: {} }) };
      if (u.includes('/api/rss')) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const card = (n) => document.querySelector('.article-card[data-item-id="' + feedUrl + '|' + n + '"]');

  // Teaser item, page loads: the prompt carries the full article, not the excerpt.
  click(card(1).querySelector('.btn-summarize'));
  await wait(30);
  assert.strictEqual(prompts.length, 1, 'One LLM call');
  assert.ok(prompts[0].includes('8. Sendible'), 'Prompt includes the full article text (end of the list)');
  assert.ok(/never restate/i.test(prompts[0]), 'Default prompt asks for the payoff, not a restatement');
  const sumEl = card(1).querySelector('.ai-summary-text');
  assert.strictEqual(sumEl.querySelectorAll('li').length, 2, 'Bulleted summary renders as a list');
  assert.strictEqual(sumEl.querySelector('strong').textContent, 'Buffer:');

  // Teaser item, page blocked: explain instead of summarizing 33 words.
  click(card(2).querySelector('.btn-summarize'));
  await wait(30);
  assert.strictEqual(prompts.length, 1, 'No LLM call on a teaser-only item');
  assert.ok(/Only the feed's teaser/.test(card(2).querySelector('.ai-summary-text').textContent));

  // Summary output is escaped.
  assert.ok(!window.document.querySelector('.ai-summary-text script'));
  console.log('Summary full-text test passed: teaser triggers full fetch, payoff prompt, list rendering, teaser-only message.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
