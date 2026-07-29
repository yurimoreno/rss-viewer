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

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:8080/v1';

/** Normalize an OpenAI-compatible base URL (…/v1, no trailing slash). */
function normalizeLlmBaseUrl(raw, provider) {
  const fallback = provider === 'openrouter' ? OPENROUTER_BASE : DEFAULT_LOCAL_BASE;
  let s = (typeof raw === 'string' ? raw : '').trim() || fallback;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Strip trailing slash; accept root or /v1
    let path = u.pathname.replace(/\/+$/, '') || '';
    if (!path || path === '/') path = '/v1';
    else if (!path.endsWith('/v1')) path = path + (path.endsWith('/') ? 'v1' : '/v1');
    return u.origin + path;
  } catch {
    return null;
  }
}

/** Only allow OpenRouter or private/local hosts (SSRF guard for the proxy). */
function isAllowedLlmBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase();
    if (host === 'openrouter.ai' || host === 'www.openrouter.ai') return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    // Tailscale CGNAT
    if (/^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    // RFC1918
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    const m = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

function resolveLlmConfig(body) {
  const provider = (typeof body?.provider === 'string' ? body.provider : 'local').trim() || 'local';
  const apiKey = (typeof body?.apiKey === 'string' ? body.apiKey : '').trim();
  const baseUrl = normalizeLlmBaseUrl(body?.baseUrl, provider);
  if (!baseUrl || !isAllowedLlmBaseUrl(baseUrl)) {
    return { error: 'invalid_base_url', message: 'Base URL must be OpenRouter or a local/private host' };
  }
  if (provider === 'openrouter' && !apiKey) {
    return { error: 'missing_api_key', message: 'OpenRouter requires an API key' };
  }
  return { provider, apiKey, baseUrl };
}

function llmAuthHeaders(apiKey, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  if (origin) headers['HTTP-Referer'] = origin;
  return headers;
}

app.post('/api/llm/models', async (req, res) => {
  const cfg = resolveLlmConfig(req.body || {});
  if (cfg.error) return res.status(400).json({ error: cfg.error, message: cfg.message });
  try {
    const response = await fetch(cfg.baseUrl + '/models', {
      headers: llmAuthHeaders(cfg.apiKey, req.headers.origin)
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || err.message || 'Could not list models';
      return res.status(response.status).json({ error: 'validation_failed', message: msg });
    }
    const data = await response.json();
    const models = (data.data || []).map((m) => ({ id: m.id, name: m.name || m.id }));
    return res.json({ models, baseUrl: cfg.baseUrl });
  } catch {
    return res.status(502).json({ error: 'fetch_failed', message: 'Could not reach LLM at ' + cfg.baseUrl });
  }
});

app.post('/api/llm/chat', async (req, res) => {
  const cfg = resolveLlmConfig(req.body || {});
  if (cfg.error) return res.status(400).json({ error: cfg.error, message: cfg.message });
  const model = (typeof req.body?.modelId === 'string' ? req.body.modelId : '').trim();
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!model || !msgs.length) return res.status(400).json({ error: 'missing_params', message: 'modelId and messages required' });
  try {
    const response = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: llmAuthHeaders(cfg.apiKey, req.headers.origin || 'http://localhost:3000'),
      body: JSON.stringify({
        model,
        messages: msgs.map((m) => ({ role: (m.role || 'user').toString(), content: (m.content || '').toString() })),
        // Prefer final answer only on thinking models (vLLM/Qwen); ignored if unsupported
        chat_template_kwargs: { enable_thinking: false }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: 'chat_failed',
        message: data.error?.message || data.message || 'Request failed'
      });
    }
    const choice = data.choices?.[0]?.message || {};
    const content = (choice.content || choice.reasoning_content || '').toString();
    return res.json({ content });
  } catch {
    return res.status(502).json({ error: 'fetch_failed', message: 'Could not reach LLM at ' + cfg.baseUrl });
  }
});

// Backward-compatible OpenRouter aliases (force OpenRouter base + require key)
app.post('/api/openrouter/models', async (req, res) => {
  const body = { ...(req.body || {}), provider: 'openrouter', baseUrl: OPENROUTER_BASE };
  const cfg = resolveLlmConfig(body);
  if (cfg.error) return res.status(400).json({ error: cfg.error, message: cfg.message });
  try {
    const response = await fetch(cfg.baseUrl + '/models', { headers: llmAuthHeaders(cfg.apiKey, req.headers.origin) });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: 'validation_failed', message: err.error?.message || 'Invalid API key' });
    }
    const data = await response.json();
    return res.json({ models: (data.data || []).map((m) => ({ id: m.id, name: m.name || m.id })) });
  } catch {
    return res.status(502).json({ error: 'fetch_failed' });
  }
});
app.post('/api/openrouter/chat', async (req, res) => {
  const body = { ...(req.body || {}), provider: 'openrouter', baseUrl: OPENROUTER_BASE };
  const cfg = resolveLlmConfig(body);
  if (cfg.error) return res.status(400).json({ error: cfg.error, message: cfg.message });
  const model = (typeof body.modelId === 'string' ? body.modelId : '').trim();
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (!model || !msgs.length) return res.status(400).json({ error: 'missing_params' });
  try {
    const response = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: llmAuthHeaders(cfg.apiKey, req.headers.origin || 'http://localhost:3000'),
      body: JSON.stringify({
        model,
        messages: msgs.map((m) => ({ role: (m.role || 'user').toString(), content: (m.content || '').toString() }))
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: 'chat_failed', message: data.error?.message || 'Request failed' });
    return res.json({ content: data.choices?.[0]?.message?.content || '' });
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
