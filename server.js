const express = require('express');
const path = require('path');
const Parser = require('rss-parser');

const app = express();
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

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

module.exports = app;
