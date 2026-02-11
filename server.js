const express = require('express');
const path = require('path');
const Parser = require('rss-parser');

const app = express();
const parser = new Parser();
const port = process.env.PORT || 3000;

function stripHtmlTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReadableSection(html) {
  const candidates = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i
  ];

  for (const regex of candidates) {
    const match = html.match(regex);
    if (match && match[1]) {
      return match[1];
    }
  }

  return html;
}

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
        title: feed.title || '',
        description: feed.description || '',
        link: feed.link || parsedUrl.toString()
      },
      items: Array.isArray(feed.items) ? feed.items : []
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
    const section = extractReadableSection(sliced);
    const content = stripHtmlTags(section);

    return res.json({ content });
  } catch {
    return res.status(502).json({ error: 'fetch_failed' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = app;
