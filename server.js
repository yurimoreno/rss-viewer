const express = require('express');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const Parser = require('rss-parser');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const { sanitizeText, sanitizeUrl, sanitizeHtml, sanitizeItem } = require('./lib/sanitize');

const app = express();
app.use(express.json());
const parser = new Parser();
const port = process.env.PORT || 3000;
const LIBRARY_PATH = process.env.RSS_VIEWER_LIBRARY_PATH || path.join(__dirname, 'data', 'library.json');

/** Blocks loopback/private/link-local/CGNAT hosts (SSRF guard for feed and article fetches). */
function isBlockedFetchHost(hostname) {
  // Explicit, off-by-default test escape hatch — lets integration tests hit a
  // local fixture server without weakening the guard for real requests.
  if (process.env.RSS_VIEWER_ALLOW_PRIVATE_FETCH === '1') return false;
  // URL.hostname keeps IPv6 brackets and may end in a root-label dot.
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  // IPv4-mapped IPv6 (::ffff:127.0.0.1, normalized by URL to ::ffff:7f00:1).
  const mapped = host.match(/^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    if (mapped[1]) host = mapped[1];
    else {
      const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
      host = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    }
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1') return true;
  if (/^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  // Link-local, incl. cloud metadata endpoints (169.254.169.254).
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // Tailscale/CGNAT 100.64.0.0/10.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.includes(':') && (/^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host))) return true;
  return false;
}

// Bot filters on some feeds (Cloudflare, Akamai) turn away an unknown reader
// with 403/429/202 but allowlist Feedly's fetcher, so retry once with a UA that
// still names this app but also matches that allowlist.
const APP_UA = 'Mozilla/5.0 (compatible; rss-viewer/1.0; +https://github.com/yurimoreno/rss-viewer)';
const FETCH_USER_AGENTS = [APP_UA, APP_UA.replace(/\)$/, '; like Feedly/1.0)')];
const BOT_BLOCK_STATUSES = new Set([202, 403, 429]);

async function getWithUaFallback(url, headers) {
  let response;
  for (const ua of FETCH_USER_AGENTS) {
    response = await getOnce(url, { ...headers, 'User-Agent': ua });
    if (!BOT_BLOCK_STATUSES.has(response.status)) break;
  }
  return response;
}

/** Rejects hostnames that resolve to a blocked address (e.g. 127.0.0.1.nip.io). */
async function resolvesToBlockedHost(hostname) {
  if (process.env.RSS_VIEWER_ALLOW_PRIVATE_FETCH === '1') return false;
  const host = hostname.replace(/^\[|\]$/g, '');
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isBlockedFetchHost(a.address));
  } catch {
    return true;
  }
}

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 5_000_000;

// One GET, no redirect following. Uses node:http(s) rather than fetch(): Cloudflare
// 403s undici's client fingerprint on some feeds (e.g. neilpatel.com) that
// rss-parser, which also uses node:http(s), could always read.
function getOnce(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers, timeout: FETCH_TIMEOUT_MS }, (res) => {
      const status = res.statusCode || 0;
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body_too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => res.headers[name.toLowerCase()] || null },
        text: async () => Buffer.concat(chunks).toString('utf8')
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** GET that re-validates the host (text + DNS) on the first request and every redirect hop. */
async function safeFetch(url, init = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = parsePublicFetchUrl(current);
    if (!parsed || (await resolvesToBlockedHost(parsed.hostname))) {
      const err = new Error('blocked_host');
      err.code = 'BLOCKED_HOST';
      throw err;
    }
    const response = await getWithUaFallback(parsed, init.headers || {});
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, parsed).toString();
      continue;
    }
    return response;
  }
  throw new Error('too_many_redirects');
}

/** Parses and validates a user-supplied feed/article URL, or returns null. */
function parsePublicFetchUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (isBlockedFetchHost(parsed.hostname)) return null;
  return parsed;
}

function readStoredLibrary() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
    return normalizeStoredLibrary(parsed);
  } catch {
    return { feeds: [], categories: [] };
  }
}

function normalizeStoredLibrary(body) {
  const feedsIn = Array.isArray(body && body.feeds) ? body.feeds : [];
  const seen = new Set();
  const feeds = [];
  feedsIn.forEach((f) => {
    if (!f || typeof f !== 'object') return;
    const parsedUrl = parsePublicFetchUrl(typeof f.url === 'string' ? f.url : '');
    if (!parsedUrl) return;
    const url = parsedUrl.toString();
    if (seen.has(url)) return;
    seen.add(url);
    const title = sanitizeText((typeof f.title === 'string' ? f.title : '').trim()) || url;
    const category = sanitizeText((typeof f.category === 'string' ? f.category : '').trim()) || 'Uncategorized';
    feeds.push({ url, title, category });
  });
  const catsIn = Array.isArray(body && body.categories) ? body.categories : [];
  const categories = [];
  const seenCat = new Set();
  catsIn.concat(feeds.map((f) => f.category)).forEach((c) => {
    const name = sanitizeText((typeof c === 'string' ? c : '').trim());
    if (!name || seenCat.has(name)) return;
    seenCat.add(name);
    categories.push(name);
  });
  return { feeds, categories };
}

function writeStoredLibrary(lib) {
  fs.mkdirSync(path.dirname(LIBRARY_PATH), { recursive: true });
  const normalized = normalizeStoredLibrary(lib);
  fs.writeFileSync(LIBRARY_PATH, JSON.stringify(normalized, null, 2));
  return normalized;
}

app.get('/api/library', (req, res) => {
  return res.json(readStoredLibrary());
});

app.put('/api/library', (req, res) => {
  return res.json(writeStoredLibrary(req.body || {}));
});

app.get('/api/rss', async (req, res) => {
  const parsedUrl = parsePublicFetchUrl(req.query.url);
  if (!parsedUrl) {
    return res.status(400).json({ error: 'invalid_url' });
  }

  try {
    // Fetch ourselves (not parser.parseURL) so redirects are re-checked by the SSRF guard.
    const response = await safeFetch(parsedUrl.toString(), {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
    if (!response.ok) {
      return res.status(502).json({ error: 'fetch_failed' });
    }
    const feed = await parser.parseString(await response.text());

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
  const parsedUrl = parsePublicFetchUrl(req.query.url);
  if (!parsedUrl) {
    return res.status(400).json({ error: 'invalid_url' });
  }

  try {
    const response = await safeFetch(parsedUrl.toString(), {
      headers: {}
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

// Thinking-model controls. Chat templates disagree on the key: vLLM/Qwen reads
// `enable_thinking`, DeepSeek V4 Flash reads `thinking` (its server default is
// thinking on at effort max). Send both — a template ignores keys it doesn't
// know — so a digest pays for the answer, not a multi-thousand-token reasoning
// pass that can run for ten minutes.
const NO_THINK_KWARGS = { enable_thinking: false, thinking: false };

// A local model generates at ~25 tok/s, so a long digest can outrun Node's
// 300 s fetch header timeout and surface as a bogus "could not reach" error.
// Streaming keeps bytes flowing, and this budget is the only thing that ends it.
const LLM_TIMEOUT_MS = Number(process.env.RSS_VIEWER_LLM_TIMEOUT_MS || 900000);

/** Collect an OpenAI-compatible SSE chat stream into one message string. */
async function readChatStream(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      const delta = parsed.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string') content += delta.content;
      // vLLM names the reasoning delta reasoning_content; DSV4 Flash names it reasoning.
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    }
  }
  return content || reasoning;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: llmAuthHeaders(cfg.apiKey, req.headers.origin || 'http://localhost:3000'),
      body: JSON.stringify({
        model,
        messages: msgs.map((m) => ({ role: (m.role || 'user').toString(), content: (m.content || '').toString() })),
        chat_template_kwargs: NO_THINK_KWARGS,
        // Streamed so a slow local model can't trip Node's fetch header timeout.
        stream: true
      })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: 'chat_failed',
        message: data.error?.message || data.message || 'Request failed'
      });
    }
    const content = await readChatStream(response);
    return res.json({ content });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return res.status(504).json({
        error: 'llm_timeout',
        message: 'LLM at ' + cfg.baseUrl + ' did not answer within ' + Math.round(LLM_TIMEOUT_MS / 1000) + 's'
      });
    }
    const detail = err && err.message ? ' (' + err.message + ')' : '';
    return res.status(502).json({ error: 'fetch_failed', message: 'Could not reach LLM at ' + cfg.baseUrl + detail });
  } finally {
    clearTimeout(timer);
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
