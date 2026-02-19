const express = require('express');
const path = require('path');
const Parser = require('rss-parser');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const { sanitizeText, sanitizeUrl, sanitizeHtml, sanitizeItem } = require('./lib/sanitize');

const app = express();
app.use(express.json());
const parser = new Parser();
const port = process.env.PORT || 3000;

app.get('/api/rss', async (req, res) => {
  const { url } = req.query;

  if (typeof url !== 'string' || url.trim() === '') {
    return res.status(400).json({ error: 'invalid_url' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'invalid_url' });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'invalid_url' });
  }

  try {
    const feed = await parser.parseURL(parsedUrl.toString());

    return res.json({
      feed: {
        title: sanitizeText(feed.title || ''),
        description: sanitizeText(feed.description || ''),
        link: sanitizeUrl(feed.link) || parsedUrl.toString()
      },
      items: (Array.isArray(feed.items) ? feed.items : []).map(sanitizeItem)
    });
  } catch {
    return res.status(502).json({ error: 'fetch_failed' });
  }
});

app.get('/api/article', async (req, res) => {
  const { url } = req.query;

  if (typeof url !== 'string' || url.trim() === '') {
    return res.status(400).json({ error: 'invalid_url' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'invalid_url' });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'invalid_url' });
  }

  try {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent': 'rss-viewer'
      }
    });
    if (!response.ok) {
      return res.status(502).json({ error: 'fetch_failed' });
    }

    const html = await response.text();
    const sliced = html.slice(0, 1_000_000);
    const dom = new JSDOM(sliced, { url: parsedUrl.toString() });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) {
      return res.status(422).json({ error: 'unreadable' });
    }

    return res.json({
      title: sanitizeText(article.title),
      author: sanitizeText(article.byline || ''),
      content: sanitizeHtml(article.content),
      excerpt: sanitizeText(article.excerpt || ''),
      siteName: sanitizeText(article.siteName || ''),
      length: article.length || 0
    });
  } catch {
    return res.status(502).json({ error: 'fetch_failed' });
  }
});

app.post('/api/openrouter/models', async (req, res) => {
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!apiKey) return res.status(400).json({ error: 'missing_api_key' });
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: 'validation_failed', message: err.error?.message || 'Invalid API key' });
    }
    const data = await response.json();
    const models = (data.data || []).map((m) => ({ id: m.id, name: m.name || m.id }));
    return res.json({ models });
  } catch { return res.status(502).json({ error: 'fetch_failed' }); }
});

app.post('/api/openrouter/chat', async (req, res) => {
  const { apiKey, modelId, messages } = req.body || {};
  const key = (typeof apiKey === 'string' ? apiKey : '').trim();
  const model = (typeof modelId === 'string' ? modelId : '').trim();
  const msgs = Array.isArray(messages) ? messages : [];
  if (!key || !model || !msgs.length) return res.status(400).json({ error: 'missing_params' });
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers.origin || 'http://localhost:3000'
      },
      body: JSON.stringify({
        model,
        messages: msgs.map((m) => ({ role: (m.role || 'user').toString(), content: (m.content || '').toString() }))
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: 'chat_failed', message: data.error?.message || 'Request failed' });
    return res.json({ content: data.choices?.[0]?.message?.content || '' });
  } catch { return res.status(502).json({ error: 'fetch_failed' }); }
});

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = app;
