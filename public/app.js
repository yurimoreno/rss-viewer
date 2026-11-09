/* RSS Viewer - Today + Digest */
(function () {
  'use strict';

  const LIBRARY_KEY = 'rssViewer.library';
  const FEED_CACHE_KEY = 'rssViewer.feedItemCache';
  const SETTINGS_KEY = 'rssViewer.settings';
  // v2: summaries made before full-text fetch were often of a feed teaser only.
  const SUMMARY_CACHE_KEY = 'rssViewer.summaryCache.v2';
  const DIGEST_CACHE_KEY = 'rssViewer.digestCache';
  const READ_LATER_KEY = 'rss_read_later';
  const READ_LATER_VIEW_SENTINEL = '__read_later__';
  const RECENTLY_READ_KEY = 'rss_recently_read';
  const RECENTLY_READ_VIEW_SENTINEL = '__recently_read__';
  const SIDEBAR_STATE_KEY = 'rss_sidebar_state';
  const UNREAD_FILTER_KEY = 'rssViewer.showUnreadOnly';
  const MAX_SUMMARY_CACHE = 80;
  const MAX_DIGEST_CACHE = 48;
  /** Cap on items sent to the LLM (prompt size). Mark-as-read still uses the full unread set. */
  const MAX_DIGEST_ITEMS = 100;
  const FEED_DIGEST_SCOPE_KEY = 'rssViewer.feedDigestScope';
  const MAX_ITEMS_PER_FEED = 50;
  const PREFETCH_CONCURRENCY = 3;
  const MAX_ARTICLE_CACHE = 30;
  // HTML length; long list posts run ~40k of markup, and a 20k cut dropped half the list.
  const MAX_ARTICLE_LENGTH = 50000;
  const UNCATEGORIZED_CATEGORY = 'Uncategorized';

  const readState = typeof window !== 'undefined' && window.RSS_READ_STATE ? window.RSS_READ_STATE : {
    isRead: function () { return false; },
    markAsRead: function () {},
    markAsUnread: function () {},
    toggleRead: function () { return false; },
    markMultipleAsRead: function () {},
    cleanupReadArticles: function () {}
  };

  let importedFeeds = [];
  let feedItemCache = {};
  let articleCache = { order: [], entries: {} };
  let selectedItemId = '';
  let selectedItemFeedUrl = '';
  let selectedSidebarFeedUrl = '';
  /** When set, reader shows an AI-first digest for this OPML category (not a single feed). */
  let selectedSidebarCategory = '';
  let refreshIntervalId = null;
  let showUnreadOnly = false;
  try {
    showUnreadOnly = localStorage.getItem(UNREAD_FILTER_KEY) === 'true';
  } catch {
    showUnreadOnly = false;
  }

  function setShowUnreadOnly(on) {
    showUnreadOnly = !!on;
    try {
      localStorage.setItem(UNREAD_FILTER_KEY, showUnreadOnly ? 'true' : 'false');
    } catch {}
    syncUnreadFilterUi();
  }

  function syncUnreadFilterUi() {
    const allBtn = document.getElementById('filter-show-all');
    const unreadBtn = document.getElementById('filter-show-unread');
    if (allBtn) {
      allBtn.classList.toggle('is-active', !showUnreadOnly);
      allBtn.setAttribute('aria-pressed', showUnreadOnly ? 'false' : 'true');
    }
    if (unreadBtn) {
      unreadBtn.classList.toggle('is-active', showUnreadOnly);
      unreadBtn.setAttribute('aria-pressed', showUnreadOnly ? 'true' : 'false');
    }
    document.body.classList.toggle('filter-unread-only', showUnreadOnly);
  }

  // Items marked read one at a time inside an Unread view stay listed (grayed)
  // so they can be flipped back in place; leaving the view drops them. Scoped to
  // one view (feed/category + filter); bulk mark-all-read never pins.
  const readPins = new Set();
  let readPinsViewKey = '';
  function pinRead(id) {
    if (showUnreadOnly && id && readState.isRead(id)) readPins.add(id);
  }
  function unpinMany(ids) {
    (ids || []).forEach((id) => readPins.delete(id));
  }

  function filterItemsByReadState(items) {
    const list = Array.isArray(items) ? items : [];
    if (!showUnreadOnly) return list;
    return list.filter((i) => i && (!readState.isRead(i.id) || readPins.has(i.id)));
  }

  function isValidHttpUrl(v) {
    try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; }
  }
  function safeHref(url) {
    if (!url) return '#';
    try {
      const parsed = new URL(url);
      // Percent-encode chars the URL parser leaves raw (e.g. `"` in a host) so a
      // feed link can't break out of an href="..." attribute built as a string.
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href.replace(/["'<>`]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      }
    } catch {}
    return '#';
  }
  function stripHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  function setArticleBody(el, htmlOrText) {
    if (!el) return;
    const s = (htmlOrText || '').trim();
    if (!s) { el.textContent = 'No content available.'; return; }
    if (s.startsWith('<')) {
      el.innerHTML = s;
      el.querySelectorAll('a[href]').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
      el.querySelectorAll('img').forEach((img) => img.setAttribute('loading', 'lazy'));
    } else {
      el.textContent = s;
    }
  }
  /** Feed text shorter than this is treated as a teaser and the full page is fetched. */
  const FULL_TEXT_MIN_CHARS = 1500;
  /** Light markdown for summaries: bullets and **bold** only, everything escaped first. */
  function renderSummaryHtml(raw) {
    const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const out = [];
    let list = [];
    const flush = () => { if (list.length) { out.push('<ul>' + list.join('') + '</ul>'); list = []; } };
    String(raw || '').split(/\n/).forEach((line) => {
      const t = line.trim();
      if (!t) { flush(); return; }
      const m = t.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) list.push('<li>' + inline(m[1]) + '</li>');
      else { flush(); out.push('<p>' + inline(t) + '</p>'); }
    });
    flush();
    return out.join('');
  }
  function plainTextLength(htmlOrText) {
    return String(htmlOrText || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length;
  }
  function isContentSufficient(content) {
    const s = (content || '').trim();
    if (/(\.\.\.|…|\[…\]|\[\.\.\.\])(\s*<\/p>)?$/.test(s)) return false;
    return plainTextLength(s) >= FULL_TEXT_MIN_CHARS;
  }
  function domainFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'source'; }
  }
  function articleBodySkeletonHtml() {
    return '<div class="article-body-skeleton"><span></span><span></span><span></span><span></span></div>';
  }
  function truncateText(v, n) {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t.length <= n ? t : t.slice(0, n).trimEnd() + '...';
  }
  function formatRelativeTime(d) {
    if (!d) return '';
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const diff = Date.now() - dt.getTime();
    const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d_ = Math.floor(diff / 86400000);
    if (m < 60) return m + 'm';
    if (h < 24) return h + 'h';
    if (d_ < 7) return d_ + 'd';
    return dt.toLocaleDateString();
  }
  function estimateReadTime(t) { return Math.max(1, Math.round((t || '').trim().split(/\s+/).filter(Boolean).length / 200)) + ' min read'; }
  function wordCount(t) { return (t || '').trim().split(/\s+/).filter(Boolean).length; }
  function escapeHtml(v) { return String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }

  function normalizeCategory(c) { return (typeof c === 'string' && c.trim()) ? c.trim() : UNCATEGORIZED_CATEGORY; }
  function normalizeFeedEntry(f) {
    if (!f || typeof f !== 'object') return null;
    const url = (f.url || '').trim();
    if (!isValidHttpUrl(url)) return null;
    return { url, title: (f.title || '').trim() || url, category: normalizeCategory(f.category) };
  }
  function dedupeFeeds(feeds) {
    const seen = new Set();
    return feeds.map(normalizeFeedEntry).filter((f) => f && !seen.has(f.url) && seen.add(f.url));
  }
  function buildLibrary(feeds, cats) {
    const f = dedupeFeeds(feeds);
    const c = new Set((cats || []).filter((n) => typeof n === 'string').map(normalizeCategory));
    f.forEach((x) => c.add(x.category));
    return { feeds: f, categories: Array.from(c) };
  }
  function readLibrary() {
    try {
      const p = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}');
      return buildLibrary(p.feeds || [], p.categories || []);
    } catch { return buildLibrary([]); }
  }
  function saveLibrary(lib) {
    const built = buildLibrary(lib.feeds || [], lib.categories || []);
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(built)); } catch {}
    persistLibraryToServer(built);
  }
  function persistLibraryToServer(lib) {
    fetch('/api/library', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lib)
    }).catch(() => {});
  }
  async function loadLibraryFromServer() {
    try {
      const res = await fetch('/api/library');
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data.feeds) || !data.feeds.length) return null;
      return buildLibrary(data.feeds, data.categories || []);
    } catch {
      return null;
    }
  }

  function getReadLaterArticles() {
    try {
      let raw = localStorage.getItem(READ_LATER_KEY);
      if (!raw && localStorage.getItem('rss_saved_articles')) {
        raw = localStorage.getItem('rss_saved_articles');
        if (raw) localStorage.setItem(READ_LATER_KEY, raw);
      }
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function addToReadLater(article) {
    const list = getReadLaterArticles();
    if (list.some((a) => a.guid === article.guid)) return;
    list.unshift({ ...article, savedAt: new Date().toISOString() });
    try {
      localStorage.setItem(READ_LATER_KEY, JSON.stringify(list));
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') showToast('Storage full — remove some articles from Read Later.');
    }
  }
  function removeFromReadLater(guid) {
    const list = getReadLaterArticles().filter((a) => a.guid !== guid);
    localStorage.setItem(READ_LATER_KEY, JSON.stringify(list));
  }
  function isInReadLater(guid) {
    return getReadLaterArticles().some((a) => a.guid === guid);
  }

  function getRecentlyRead() {
    try {
      const raw = localStorage.getItem(RECENTLY_READ_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  function addToRecentlyRead(article) {
    let recent = getRecentlyRead();
    recent = recent.filter((a) => a.guid !== article.guid);
    recent.unshift({
      guid: article.guid,
      title: article.title,
      link: article.link,
      summary: article.summary,
      source: article.source,
      readAt: new Date().toISOString()
    });
    recent = recent.slice(0, 20);
    try {
      localStorage.setItem(RECENTLY_READ_KEY, JSON.stringify(recent));
    } catch {}
  }

  function showToast(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' toast-error' : kind === 'success' ? ' toast-success' : '');
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast-visible'));
    setTimeout(() => { el.classList.remove('toast-visible'); setTimeout(() => el.remove(), 300); }, 3200);
  }

  let lastRefreshAt = null;
  function formatLastRefreshed(ts) {
    if (!ts) return '';
    try {
      return 'Updated ' + new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }
  function updateLastRefreshedUi() {
    const el = document.getElementById('last-refreshed');
    if (!el) return;
    const label = formatLastRefreshed(lastRefreshAt);
    if (!label) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = label;
  }

  function normalizeFeedItem(feedUrl, item) {
    if (!item || typeof item !== 'object') return null;
    const title = (item.title || '').trim() || 'Untitled';
    const link = (item.link || '').trim();
    const pubDate = (item.isoDate || item.pubDate || '').toString();
    const summary = stripHtml(item.summary || item.content || item.contentSnippet || '');
    const content = (item.content || item['content:encoded'] || '').trim();
    const author = (item.creator || item.author || '').trim();
    const id = (item.id || item.guid || feedUrl + '|' + link + '|' + title + '|' + pubDate).toString();
    return { id: id.startsWith(feedUrl + '|') ? id : feedUrl + '|' + id, title, link, pubDate, summary, content, author };
  }
  function normalizeFeedItemList(url, items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS_PER_FEED).map((i) => normalizeFeedItem(url, i)).filter((i) => i && !seen.has(i.id) && seen.add(i.id));
  }
  function readFeedItemCache() {
    try {
      const p = JSON.parse(localStorage.getItem(FEED_CACHE_KEY) || '{}');
      const out = {};
      Object.entries(p).forEach(([url, items]) => {
        if (isValidHttpUrl(url)) {
          const n = normalizeFeedItemList(url, items);
          if (n.length) out[url] = n;
        }
      });
      return out;
    } catch { return {}; }
  }
  function saveFeedItemCache(c) {
    try { localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(c)); } catch {}
  }
  function getCachedFeedItems(url) { return Array.isArray(feedItemCache[url]) ? feedItemCache[url] : []; }
  function setCachedFeedItems(url, items) {
    const n = normalizeFeedItemList(url, items);
    if (n.length) feedItemCache[url] = n; else delete feedItemCache[url];
    saveFeedItemCache(feedItemCache);
  }
  function getFeedLabel(url) { return (importedFeeds.find((f) => f.url === url) || {}).title || url; }

  function groupFeedsByCategory(feeds, order) {
    const m = new Map();
    (order || []).forEach((c) => m.set(normalizeCategory(c), []));
    feeds.forEach((f) => { const c = normalizeCategory(f.category); if (!m.has(c)) m.set(c, []); m.get(c).push(f); });
    return m;
  }
  function getAllItemsGrouped() {
    const lib = readLibrary();
    const g = groupFeedsByCategory(importedFeeds, lib.categories);
    const out = [];
    g.forEach((feeds, cat) => {
      const items = [];
      feeds.forEach((f) => getCachedFeedItems(f.url).forEach((i) => items.push({ ...i, feedUrl: f.url, feedTitle: f.title })));
      items.sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
      if (items.length) out.push({ category: cat, items });
    });
    return out;
  }
  function getItemsInWindow(hours) {
    const cutoff = Date.now() - hours * 3600000;
    const all = [];
    Object.entries(feedItemCache).forEach(([url, items]) => {
      const feed = importedFeeds.find((f) => f.url === url);
      items.forEach((i) => { if ((i.pubDate ? Date.parse(i.pubDate) : 0) >= cutoff) all.push({ ...i, feedUrl: url, feedTitle: feed ? feed.title : url }); });
    });
    return all.sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
  }
  function getUnreadItems() {
    const all = [];
    Object.entries(feedItemCache).forEach(([url, items]) => {
      const feed = importedFeeds.find((f) => f.url === url);
      items.forEach((i) => {
        if (!readState.isRead(i.id)) all.push({ ...i, feedUrl: url, feedTitle: feed ? feed.title : url });
      });
    });
    return all.sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
  }

  function parseOpmlFeeds(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('invalid_opml');
    const feeds = [];
    function walk(nodes, cat) {
      Array.from(nodes).forEach((o) => {
        if (o.tagName?.toLowerCase() !== 'outline') return;
        const url = (o.getAttribute('xmlUrl') || '').trim();
        const label = (o.getAttribute('title') || o.getAttribute('text') || '').trim();
        const kids = Array.from(o.children || []).filter((c) => c.tagName?.toLowerCase() === 'outline');
        const nextCat = url ? cat : (label || cat);
        if (url && isValidHttpUrl(url)) feeds.push({ url, title: label || url, category: cat || UNCATEGORIZED_CATEGORY });
        if (kids.length) walk(kids, nextCat);
      });
    }
    walk(Array.from(doc.querySelector('body')?.children || []));
    if (!feeds.length) throw new Error('invalid_opml');
    return feeds;
  }
  function buildOpmlText(lib) {
    const { feeds, categories } = buildLibrary(lib.feeds || [], lib.categories || []);
    const g = groupFeedsByCategory(feeds, categories);
    const lines = [];
    g.forEach((fs, cat) => {
      lines.push('    <outline text="' + escapeHtml(cat) + '" title="' + escapeHtml(cat) + '">');
      fs.forEach((f) => lines.push('      <outline type="rss" text="' + escapeHtml(f.title) + '" title="' + escapeHtml(f.title) + '" xmlUrl="' + escapeHtml(f.url) + '" />'));
      lines.push('    </outline>');
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head><title>RSS Viewer</title></head>\n  <body>\n' + lines.join('\n') + '\n  </body>\n</opml>';
  }

  function buildCachedFromFetch(url, items) {
    return normalizeFeedItemList(url, items);
  }
  async function fetchFeed(url, opts) {
    const res = await fetch('/api/rss?url=' + encodeURIComponent(url) + (opts && opts.force ? '&force=1' : ''));
    if (!res.ok) throw new Error();
    const data = await res.json();
    return buildCachedFromFetch(url, data.items || []);
  }
  async function fetchAllFeeds(onProgress) {
    const urls = importedFeeds.map((f) => f.url).filter(isValidHttpUrl);
    if (!urls.length) return;
    let done = 0;
    const queue = [...urls];
    const workers = Math.min(PREFETCH_CONCURRENCY, urls.length);
    async function w() {
      while (queue.length) {
        const u = queue.shift();
        if (!u) continue;
        try { setCachedFeedItems(u, await fetchFeed(u)); } catch {}
        done++;
        if (onProgress) onProgress(done, urls.length);
      }
    }
    await Promise.all(Array.from({ length: workers }, w));
  }

  /** Server-side per-feed fetch health (GET /api/feed-health), keyed by feed URL. */
  let feedHealth = {};
  const STALE_FEED_DAYS = 90;
  async function loadFeedHealth() {
    try {
      const res = await fetch('/api/feed-health');
      if (!res || !res.ok) return false;
      const data = await res.json();
      feedHealth = (data && data.feeds && typeof data.feeds === 'object') ? data.feeds : {};
      return true;
    } catch { return false; }
  }
  function formatAgo(ts) {
    const r = formatRelativeTime(ts);
    if (r === '0m' || /^-/.test(r)) return 'just now';
    return r && /\d[mhd]$/.test(r) ? r + ' ago' : r;
  }
  /** { level: 'ok'|'stale'|'warn'|'error'|'unknown', label, detail } for a feed URL. */
  function feedHealthInfo(url) {
    const h = feedHealth[url];
    if (!h) return { level: 'unknown', label: 'Not checked yet', detail: '' };
    const n = h.consecutiveFailures || 0;
    if (n > 0) {
      const since = h.firstFailureAt ? (formatAgo(h.firstFailureAt) === 'just now' ? 'just now' : 'since ' + formatAgo(h.firstFailureAt)) : '';
      const lastOk = h.lastSuccessAt ? 'last OK ' + formatAgo(h.lastSuccessAt) : 'never loaded';
      return {
        level: n >= 3 ? 'error' : 'warn',
        label: n >= 3 ? 'Broken' : 'Failing',
        detail: [h.lastError || 'fetch failed', n + ' failure' + (n === 1 ? '' : 's') + (since ? ' ' + since : ''), lastOk].join(' · ')
      };
    }
    const newest = h.newestItemAt || 0;
    if (newest && Date.now() - newest > STALE_FEED_DAYS * 86400000) {
      const days = Math.floor((Date.now() - newest) / 86400000);
      return { level: 'stale', label: 'No posts in ' + days + ' days', detail: 'Loads fine, but the newest item is from ' + new Date(newest).toLocaleDateString() };
    }
    return {
      level: 'ok',
      label: 'OK',
      detail: (h.itemCount || 0) + ' item' + (h.itemCount === 1 ? '' : 's') + (newest ? ' · newest ' + formatAgo(newest) : '') + (h.lastCheckedAt ? ' · checked ' + formatAgo(h.lastCheckedAt) : '')
    };
  }

  function readArticleCache() {
    try { const p = JSON.parse(localStorage.getItem('rssViewer.articleCache') || '{}'); return { order: p.order || [], entries: p.entries || {} }; } catch { return { order: [], entries: {} }; }
  }
  function saveArticleCache(c) { try { localStorage.setItem('rssViewer.articleCache', JSON.stringify(c)); } catch {} }
  function getCachedArticle(url) { return (articleCache.entries || {})[url] || ''; }
  function setCachedArticle(url, content) {
    const text = (content || '').slice(0, MAX_ARTICLE_LENGTH).trim();
    if (!text) return;
    const order = [...(articleCache.order || [])];
    const entries = { ...(articleCache.entries || {}) };
    const i = order.indexOf(url);
    if (i >= 0) order.splice(i, 1);
    order.push(url);
    entries[url] = text;
    while (order.length > MAX_ARTICLE_CACHE) delete entries[order.shift()];
    articleCache = { order, entries };
    saveArticleCache(articleCache);
  }
  async function loadArticle(item) {
    if (!item?.link) return '';
    const cached = getCachedArticle(item.link);
    if (cached) return cached;
    try {
      const res = await fetch('/api/article?url=' + encodeURIComponent(item.link));
      if (!res.ok) throw new Error();
      const data = await res.json();
      const content = (data.content || '').slice(0, MAX_ARTICLE_LENGTH).trim();
      if (content) setCachedArticle(item.link, content);
      return content;
    } catch { return ''; }
  }

  const DEFAULT_DIGEST_PROMPT = `Summarize these RSS items into a short, scannable digest.

## Rules
- Deduplicate first: if multiple items cover the same story, merge them into one entry and combine their citations.
- Group entries under 2-4 short theme headers (e.g., "AI", "Security", "Business").
- Put the single biggest story first under a "Lead" header with 2 sentences max.
- All other entries: **Company or Subject:** One sentence. [1][2]
- 8-12 items total. Cut routine updates and PR.
- If sources disagree on a key fact, note it briefly inline.
- Tone: neutral, concise, no hype.

## Format example
**Lead**
**Google Pixel 10a:** Google unveiled the $499 Pixel 10a with Tensor G4 and a flush camera bar, though sources differ on whether it ships March 4 or 5. [10][15][28]

**AI & Security**
- **Microsoft Copilot:** Patched a bug that let Copilot summarize confidential emails from restricted folders. [31]
- **World Labs:** Raised $200M from Autodesk to integrate spatial AI models. [50]

## Items
{{ITEMS}}`;

  const DEFAULT_SUMMARY_PROMPT = `Give the payoff of this article: the specific things a reader would have to open it to learn. The reader has already seen the title and the first paragraph, so never restate them or describe what the article "covers" or "aims to" do.

Match the shape of the article:
- List or roundup ("8 best...", "top tools"): list every item by name, each with a few words on what sets it apart (price, best for, key catch).
- How-to or guide: the actual steps or recommendations, in order.
- News: what happened, who is involved, and the key numbers or dates.
- Opinion or analysis: the core argument and the strongest evidence for it.
- Anything else: the 3-5 most specific, useful facts.

Rules:
- Lead with specifics: names, numbers, prices, dates, conclusions.
- Short bullets or 2-4 tight sentences. No intro line, no closing line.
- Use only what the article says. If it never delivers the specifics, say so in one line.

{{ARTICLE}}`;

  const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8080/v1';
  const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

  function readSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (s.modelId && !s.modelIdDigest && !s.modelIdSummary) {
        s.modelIdDigest = s.modelId;
        s.modelIdSummary = s.modelId;
      }
      // Default to local LLM when no provider was ever chosen
      if (!s.provider) s.provider = s.apiKey ? 'openrouter' : 'local';
      if (!s.baseUrl) s.baseUrl = s.provider === 'openrouter' ? OPENROUTER_BASE_URL : DEFAULT_LOCAL_BASE_URL;
      return s;
    } catch { return { provider: 'local', baseUrl: DEFAULT_LOCAL_BASE_URL }; }
  }
  function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} }

  /** Theme resolution: explicit saved choice wins; otherwise follow the system setting. */
  function systemWantsLight() {
    try { return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches; } catch { return false; }
  }
  function applyTheme(s) {
    const light = s && s.themeLight !== undefined ? !!s.themeLight : systemWantsLight();
    document.body.classList.toggle('theme-light', light);
    document.body.classList.toggle('theme-dark', !light);
    return light;
  }

  /** Payload for /api/llm/* from saved or form settings. */
  function getLlmRequestFields(s) {
    const settings = s || readSettings();
    const provider = (settings.provider || 'local').trim() || 'local';
    const baseUrl = (settings.baseUrl || (provider === 'openrouter' ? OPENROUTER_BASE_URL : DEFAULT_LOCAL_BASE_URL)).trim();
    const apiKey = (settings.apiKey || '').trim();
    return { provider, baseUrl, apiKey };
  }

  function llmConfigReady(s, modelId) {
    const cfg = getLlmRequestFields(s);
    if (!modelId) return { ok: false, message: 'Select a model in Settings, then Save.' };
    if (cfg.provider === 'openrouter' && !cfg.apiKey) {
      return { ok: false, message: 'OpenRouter requires an API key in Settings.' };
    }
    if (cfg.provider === 'local' && !cfg.baseUrl) {
      return { ok: false, message: 'Set a local base URL in Settings (e.g. http://127.0.0.1:8080/v1).' };
    }
    return { ok: true, cfg };
  }
  function getDigestPrompt() { const s = readSettings(); return (s.digestPrompt || '').trim() || DEFAULT_DIGEST_PROMPT; }
  function getSummaryPrompt() { const s = readSettings(); return (s.summaryPrompt || '').trim() || DEFAULT_SUMMARY_PROMPT; }
  function readSummaryCache() {
    try {
      const p = JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || '{}');
      return { order: p.order || [], entries: p.entries || {} };
    } catch { return { order: [], entries: {} }; }
  }
  function saveSummaryCache(c) { try { localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(c)); } catch {} }
  function getCachedSummary(itemId) { const c = readSummaryCache(); return c.entries[itemId] || ''; }
  function setCachedSummary(itemId, text) {
    const c = readSummaryCache();
    if (c.entries[itemId]) c.order = c.order.filter((k) => k !== itemId);
    c.order.push(itemId);
    c.entries[itemId] = text;
    while (c.order.length > MAX_SUMMARY_CACHE) {
      const k = c.order.shift();
      delete c.entries[k];
    }
    saveSummaryCache(c);
  }
  /** Stable cache key for a digest scope (window hours, "unread", or "feed:url:scope"). */
  function digestCacheKey(scope, items) {
    let h = 0;
    const s = (items || []).map((i) => i.id).sort().join('|');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(scope) + '-' + h;
  }

  function getFeedDigestScope() {
    try {
      const v = localStorage.getItem(FEED_DIGEST_SCOPE_KEY);
      return v === 'all' ? 'all' : 'unread';
    } catch {
      return 'unread';
    }
  }

  function setFeedDigestScope(scope) {
    try {
      localStorage.setItem(FEED_DIGEST_SCOPE_KEY, scope === 'all' ? 'all' : 'unread');
    } catch {}
  }

  function itemsForFeedDigest(items, scope) {
    const list = Array.isArray(items) ? items : [];
    if (scope === 'all') return list.slice();
    return list.filter((i) => i && !readState.isRead(i.id));
  }

  /**
   * @param {object[]} items
   * @param {{ feedTitle?: string, categoryName?: string }} [opts]
   * feedTitle: single-feed digest (omit per-item source). categoryName: multi-feed category digest.
   */
  function buildDigestUserPrompt(items, opts) {
    const feedTitle = (opts && opts.feedTitle) || '';
    const categoryName = (opts && opts.categoryName) || '';
    // Back-compat: older callers passed a string feed title as the second arg
    const legacyTitle = typeof opts === 'string' ? opts : '';
    const singleFeedTitle = feedTitle || legacyTitle;
    const usedItems = items.slice(0, MAX_DIGEST_ITEMS);
    const refs = [];
    const lines = usedItems.map((i, idx) => {
      refs.push({ title: i.feedTitle || singleFeedTitle || 'Source', link: i.link });
      const source = singleFeedTitle && !categoryName ? '' : ' (' + (i.feedTitle || 'Source') + ')';
      return '[' + (idx + 1) + '] ' + i.title + source + '\n   ' + truncateText(i.summary, 150);
    });
    const promptTemplate = getDigestPrompt();
    let itemsBlock = lines.join('\n\n');
    if (categoryName) {
      itemsBlock =
        'Category: ' +
        categoryName +
        '\nThese items are from multiple feeds in this category. Deduplicate across sources, group by theme, and rank what matters for a busy reader who will not open every article.\n\n' +
        itemsBlock;
    } else if (singleFeedTitle) {
      itemsBlock =
        'Feed: ' +
        singleFeedTitle +
        '\nThese items are all from this single feed. Deduplicate and rank what matters for a busy reader who will not open every article.\n\n' +
        itemsBlock;
    }
    const prompt = promptTemplate.includes('{{ITEMS}}')
      ? promptTemplate.replace('{{ITEMS}}', itemsBlock)
      : promptTemplate + '\n\nItems:\n' + itemsBlock;
    return { prompt, refs, usedItems };
  }

  function getCategoryItems(categoryName) {
    const group = getAllItemsGrouped().find((g) => g.category === categoryName);
    return group ? group.items.slice() : [];
  }
  function readDigestCache() {
    try {
      const p = JSON.parse(localStorage.getItem(DIGEST_CACHE_KEY) || '{}');
      return { order: p.order || [], entries: p.entries || {} };
    } catch { return { order: [], entries: {} }; }
  }
  function saveDigestCache(c) { try { localStorage.setItem(DIGEST_CACHE_KEY, JSON.stringify(c)); } catch {} }
  function getCachedDigest(key) { const c = readDigestCache(); return c.entries[key] || null; }
  function setCachedDigest(key, html) {
    const c = readDigestCache();
    if (c.entries[key]) c.order = c.order.filter((k) => k !== key);
    c.order.push(key);
    c.entries[key] = html;
    while (c.order.length > MAX_DIGEST_CACHE) {
      const k = c.order.shift();
      delete c.entries[k];
    }
    saveDigestCache(c);
  }

  function formatDigestOutput(raw, refs) {
    const toHtml = (text) =>
      escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[(\d+)\]/g, (_, n) => {
          const idx = parseInt(n, 10) - 1;
          const r = refs[idx];
          if (r) return '<a href="' + safeHref(r.link) + '" target="_blank" rel="noopener" class="digest-ref">[' + n + ']</a>';
          return '[' + n + ']';
        });

    const lines = (raw || '').trim().split(/\n+/).map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean);
    if (!lines.length) return '<p class="digest-placeholder">No digest content returned.</p>';

    const parts = [];
    for (const line of lines) {
      const soloBold = /^\*\*([^*]+)\*\*\s*$/.exec(line);
      if (soloBold) {
        parts.push('<div class="digest-header">' + toHtml(soloBold[1]) + '</div>');
        continue;
      }
      const subItem = /^-\s+(.+)$/.exec(line);
      if (subItem) {
        parts.push('<div class="digest-item digest-sub">' + toHtml(subItem[1]) + '</div>');
        continue;
      }
      parts.push('<div class="digest-item">' + toHtml(line) + '</div>');
    }
    return '<div class="digest-sections">' + parts.join('') + '</div>';
  }

  let initialized = false;
  function init() {
    // Guard: test harnesses can fire DOMContentLoaded twice, which would bind every handler twice.
    if (initialized) return;
    initialized = true;
    const appShell = document.getElementById('app-shell');
    const sidebarGroups = document.getElementById('sidebar-groups');
    const sidebarMetricEl = document.getElementById('sidebar-metric');
    const feedSearchInput = document.getElementById('feed-search-input');
    const todayContent = document.getElementById('today-content');
    const expandAllCategories = document.getElementById('expand-all-categories');
    const collapseAllCategories = document.getElementById('collapse-all-categories');
    const btnMarkAllRead = document.getElementById('btn-mark-all-read');
    const refreshWrap = document.getElementById('refresh-progress-wrap');
    const refreshBar = document.getElementById('refresh-progress-bar');
    const btnRefresh = document.getElementById('btn-refresh');
    const themeToggle = document.getElementById('theme-toggle');
    const aiProviderSelect = document.getElementById('ai-provider');
    const llmBaseUrlInput = document.getElementById('llm-base-url');
    const apiKeyInput = document.getElementById('api-key');
    const apiKeyLabel = document.getElementById('api-key-label');
    const rowBaseUrl = document.getElementById('row-base-url');
    const modelSelectDigest = document.getElementById('model-select-digest');
    const modelSelectSummary = document.getElementById('model-select-summary');
    const btnCheckModels = document.getElementById('btn-check-models');
    const modelStatus = document.getElementById('model-status');
    const btnSaveSettings = document.getElementById('btn-save-settings');
    const settingsStatus = document.getElementById('settings-status');
    const refreshIntervalSelect = document.getElementById('refresh-interval');
    const addFeedUrl = document.getElementById('add-feed-url');
    const btnAddFeed = document.getElementById('btn-add-feed');
    const opmlImport = document.getElementById('opml-import');
    const btnImportOpml = document.getElementById('btn-import-opml');
    const btnExportOpml = document.getElementById('btn-export-opml');
    const feedsList = document.getElementById('feeds-list');
    const feedsSummary = document.getElementById('feeds-summary');
    const feedMgmtSearch = document.getElementById('feed-mgmt-search');
    const digestCard = document.getElementById('digest-card');
    const digestWindow = document.getElementById('digest-window');
    const btnGenerateDigest = document.getElementById('btn-generate-digest');
    let lastDigestUnreadGuids = [];

    /** Put the mark-read row right under the digest title, so it is visible without scrolling past the references. */
    function placeDigestActions(el, count) {
      el.querySelectorAll('.digest-actions').forEach((n) => n.remove());
      if (!count) return;
      const html =
        '<div class="digest-actions"><button type="button" class="btn-quiet digest-mark-read-btn">Mark all ' +
        count +
        ' as read</button></div>';
      const title = el.firstElementChild && el.firstElementChild.tagName === 'H3' ? el.firstElementChild : null;
      if (title) title.insertAdjacentHTML('afterend', html);
      else el.insertAdjacentHTML('afterbegin', html);
    }

    function handleDigestMarkReadClick(ev) {
      const btn = ev.target.closest('.digest-mark-read-btn');
      if (!btn || btn.disabled) return;
      const guids = lastDigestUnreadGuids.slice();
      if (!guids.length) return;
      readState.markMultipleAsRead(guids);
      unpinMany(guids);
      updateUnreadCounts();
      btn.disabled = true;
      btn.textContent = '✓ Marked ' + guids.length + ' as read';
      lastDigestUnreadGuids = [];
      showToast('Marked ' + guids.length + ' article' + (guids.length === 1 ? '' : 's') + ' as read', 'success');
      // Re-render feed/category view so unread counts / empty states stay honest
      if (
        selectedSidebarCategory ||
        (selectedSidebarFeedUrl &&
          selectedSidebarFeedUrl !== READ_LATER_VIEW_SENTINEL &&
          selectedSidebarFeedUrl !== RECENTLY_READ_VIEW_SENTINEL)
      ) {
        renderToday(true);
      }
    }
    digestCard?.addEventListener('click', handleDigestMarkReadClick);
    todayContent?.addEventListener('click', handleDigestMarkReadClick);

    /**
     * Shared digest pipeline for global Digest and per-feed digest.
     * Never auto-fires: caller must invoke after an explicit user action (or cache hit display).
     * Caches by item-id set so unchanged feeds do not re-hit the LLM.
     */
    async function runDigestGeneration({ items, scopeKey, titleHtml, isUnread, feedTitle, categoryName, targetEl, generateBtn }) {
      if (!targetEl) return { ok: false };
      const s = readSettings();
      const modelId = s.modelIdDigest || modelSelectDigest?.value || '';
      const ready = llmConfigReady(s, modelId);
      if (!ready.ok) {
        targetEl.innerHTML = '<p class="digest-placeholder error">' + escapeHtml(ready.message) + '</p>';
        return { ok: false };
      }
      if (!items.length) {
        targetEl.innerHTML =
          '<p class="digest-placeholder">' +
          escapeHtml(isUnread ? "You're all caught up — no unread items." : 'No items to digest. Refresh feeds first.') +
          '</p>';
        return { ok: false };
      }
      const cacheKey = digestCacheKey(scopeKey, items);
      // Mark-as-read must clear every item in this digest scope (e.g. all 73 unread
      // in Tech, or everything from the last 24h), not only the subset that fit in
      // the LLM prompt. Already-read items are left out of the count.
      const markReadGuids = items.filter((i) => i && i.id && !readState.isRead(i.id)).map((i) => i.id);
      const cached = getCachedDigest(cacheKey);
      if (cached) {
        targetEl.innerHTML = cached;
        lastDigestUnreadGuids = markReadGuids;
        // Cached HTML may predate the button (time-window digests) or carry a stale
        // count, so rebuild the actions row from the current unread set.
        placeDigestActions(targetEl, markReadGuids.length);
        return { ok: true, fromCache: true };
      }
      targetEl.innerHTML = '<p class="digest-placeholder">Generating digest…</p>';
      if (generateBtn) generateBtn.disabled = true;
      const { prompt, refs, usedItems } = buildDigestUserPrompt(items, {
        feedTitle: feedTitle || '',
        categoryName: categoryName || ''
      });
      try {
        const res = await fetch('/api/llm/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...ready.cfg, modelId, messages: [{ role: 'user', content: prompt }] })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          targetEl.innerHTML = '<p class="digest-placeholder error">' + escapeHtml(data.message || 'Request failed') + '</p>';
          return { ok: false };
        }
        const bodyHtml = formatDigestOutput(data.content || '', refs);
        const refsHtml = refs.length
          ? '<div class="digest-refs"><strong>References:</strong> ' +
            refs
              .map((r, i) => '<a href="' + safeHref(r.link) + '" target="_blank" rel="noopener">[' + (i + 1) + '] ' + escapeHtml(r.title) + '</a>')
              .join(' ') +
            '</div>'
          : '';
        const truncatedNote =
          isUnread && items.length > usedItems.length
            ? '<p class="digest-truncation-note">Summarized ' +
              usedItems.length +
              ' of ' +
              items.length +
              ' unread. Mark as read clears all ' +
              items.length +
              '.</p>'
            : items.length > usedItems.length
              ? '<p class="digest-truncation-note">Summarized ' +
                usedItems.length +
                ' of ' +
                items.length +
                ' items.</p>'
              : '';
        const fullHtml =
          titleHtml + truncatedNote + '<div class="digest-body">' + bodyHtml + '</div>' + refsHtml;
        targetEl.innerHTML = fullHtml;
        placeDigestActions(targetEl, markReadGuids.length);
        lastDigestUnreadGuids = markReadGuids;
        // Cache without the actions row; it is rebuilt from live read state on display.
        setCachedDigest(cacheKey, fullHtml);
        return { ok: true, fromCache: false };
      } catch {
        targetEl.innerHTML = '<p class="digest-placeholder error">Network error.</p>';
        return { ok: false };
      } finally {
        if (generateBtn) generateBtn.disabled = false;
      }
    }

    function feedDigestScopeKey(feedUrl, scope) {
      return 'feed:' + feedUrl + ':' + scope;
    }

    function categoryDigestScopeKey(categoryName, scope) {
      return 'cat:' + categoryName + ':' + scope;
    }

    /**
     * AI-first digest panel for a feed or a category.
     * @param {{ kind: 'feed'|'category', label: string, scopeId: string, allItems: object[], allOptionLabel: string }} opts
     */
    function mountScopeDigestPanel(container, opts) {
      const kind = opts.kind === 'category' ? 'category' : 'feed';
      const label = opts.label || (kind === 'category' ? 'Category' : 'Feed');
      const scopeId = opts.scopeId || label;
      const allItems = opts.allItems || [];
      const allOptionLabel = opts.allOptionLabel || (kind === 'category' ? 'All in category' : 'All in feed');
      const scope = getFeedDigestScope();
      const digestItems = itemsForFeedDigest(allItems, scope);
      const unreadN = allItems.filter((i) => !readState.isRead(i.id)).length;
      const scopeKey =
        kind === 'category' ? categoryDigestScopeKey(scopeId, scope) : feedDigestScopeKey(scopeId, scope);
      const cacheKey = digestCacheKey(scopeKey, digestItems);
      const cachedHtml = digestItems.length ? getCachedDigest(cacheKey) : null;
      const kindLabel = kind === 'category' ? 'Category digest' : 'Feed digest';
      const emptyUnread = 'No unread items.';
      const emptyAll = 'No items.';

      const panel = document.createElement('section');
      panel.className = 'feed-digest-panel';
      panel.setAttribute('aria-label', kindLabel);

      const head = document.createElement('div');
      head.className = 'feed-digest-head';
      head.innerHTML =
        '<div class="feed-digest-head-text">' +
        '<p class="feed-digest-eyebrow"><span class="ai-badge">AI</span> ' +
        escapeHtml(kindLabel) +
        '</p>' +
        '</div>';

      const controls = document.createElement('div');
      controls.className = 'feed-digest-controls';
      const scopeSelect = document.createElement('select');
      scopeSelect.className = 'feed-digest-scope';
      scopeSelect.setAttribute('aria-label', 'Digest which items');
      scopeSelect.innerHTML =
        '<option value="unread"' +
        (scope === 'unread' ? ' selected' : '') +
        '>Unread (' +
        unreadN +
        ')</option>' +
        '<option value="all"' +
        (scope === 'all' ? ' selected' : '') +
        '>' +
        escapeHtml(allOptionLabel) +
        ' (' +
        allItems.length +
        ')</option>';
      const genBtn = document.createElement('button');
      genBtn.type = 'button';
      genBtn.className = 'btn-primary feed-digest-generate';
      genBtn.textContent =
        digestItems.length === 0
          ? 'Nothing to digest'
          : cachedHtml
            ? 'Regenerate digest'
            : 'Digest ' + digestItems.length + ' item' + (digestItems.length === 1 ? '' : 's');
      genBtn.disabled = digestItems.length === 0;
      controls.appendChild(scopeSelect);
      controls.appendChild(genBtn);
      head.appendChild(controls);
      panel.appendChild(head);

      const card = document.createElement('div');
      card.className = 'digest-card feed-digest-card';
      if (cachedHtml) {
        card.innerHTML = cachedHtml;
        // Full unread set for this scope, not only the LLM subset
        lastDigestUnreadGuids = digestItems.filter((i) => i && i.id && !readState.isRead(i.id)).map((i) => i.id);
        placeDigestActions(card, lastDigestUnreadGuids.length);
      } else if (!digestItems.length) {
        card.innerHTML =
          '<p class="digest-placeholder">' + (scope === 'unread' ? emptyUnread : emptyAll) + '</p>';
      } else {
        // Button is the affordance; no coaching placeholder while idle
        card.hidden = true;
      }
      panel.appendChild(card);

      scopeSelect.addEventListener('change', () => {
        setFeedDigestScope(scopeSelect.value);
        renderToday(true);
      });
      genBtn.addEventListener('click', async () => {
        const nextScope = scopeSelect.value === 'all' ? 'all' : 'unread';
        setFeedDigestScope(nextScope);
        const nextItems = itemsForFeedDigest(allItems, nextScope);
        const isUnread = nextScope === 'unread';
        const usedN = Math.min(nextItems.length, MAX_DIGEST_ITEMS);
        const titleHtml = isUnread
          ? '<h3>' +
            escapeHtml(label) +
            ' — Unread digest · ' +
            usedN +
            (nextItems.length > usedN ? ' of ' + nextItems.length : '') +
            ' items</h3>'
          : '<h3>' +
            escapeHtml(label) +
            ' — ' +
            (kind === 'category' ? 'Category' : 'Feed') +
            ' digest · ' +
            usedN +
            ' items</h3>';
        const nextKey =
          kind === 'category'
            ? categoryDigestScopeKey(scopeId, nextScope)
            : feedDigestScopeKey(scopeId, nextScope);
        if (genBtn.textContent.indexOf('Regenerate') !== -1) {
          const key = digestCacheKey(nextKey, nextItems);
          const c = readDigestCache();
          if (c.entries[key]) {
            delete c.entries[key];
            c.order = c.order.filter((k) => k !== key);
            saveDigestCache(c);
          }
        }
        card.hidden = false;
        await runDigestGeneration({
          items: nextItems,
          scopeKey: nextKey,
          titleHtml,
          isUnread,
          feedTitle: kind === 'feed' ? label : '',
          categoryName: kind === 'category' ? label : '',
          targetEl: card,
          generateBtn: genBtn
        });
        if (card.querySelector('.digest-body')) {
          genBtn.textContent = 'Regenerate digest';
        }
      });

      container.appendChild(panel);
    }

    function mountFeedDigestPanel(container, feed, allItems) {
      mountScopeDigestPanel(container, {
        kind: 'feed',
        label: feed.title || feed.url,
        scopeId: feed.url,
        allItems,
        allOptionLabel: 'All in feed'
      });
    }

    function mountCategoryDigestPanel(container, categoryName, allItems) {
      mountScopeDigestPanel(container, {
        kind: 'category',
        label: categoryName,
        scopeId: categoryName,
        allItems,
        allOptionLabel: 'All in category'
      });
    }

    function activateReaderView() {
      document.querySelectorAll('.mockup-view').forEach((x) => x.classList.remove('active'));
      document.querySelector('.mockup-view[data-tab="reader"]')?.classList.add('active');
      document.querySelectorAll('.sidebar-nav-item').forEach((x) => {
        x.classList.remove('is-active');
        x.setAttribute('aria-current', 'false');
      });
      const readerNav = document.querySelector('.sidebar-nav-item[data-view="reader"]');
      readerNav?.classList.add('is-active');
      readerNav?.setAttribute('aria-current', 'page');
    }

    function openCategoryView(cat) {
      selectedItemFeedUrl = '';
      selectedItemId = '';
      selectedSidebarFeedUrl = '';
      selectedSidebarCategory = cat;
      const current = getSidebarExpandedCategories();
      if (!current.includes(cat)) {
        setSidebarExpandedCategories([...current, cat]);
      }
      activateReaderView();
      renderToday();
      renderSidebar();
      closeMobileSidebar();
    }
    const digestPromptInput = document.getElementById('digest-prompt');
    const btnResetDigestPrompt = document.getElementById('btn-reset-digest-prompt');
    const btnSaveDigestPrompt = document.getElementById('btn-save-digest-prompt');
    const summaryPromptInput = document.getElementById('summary-prompt');
    const btnResetSummaryPrompt = document.getElementById('btn-reset-summary-prompt');

    function setImportedFeeds(feeds) {
      importedFeeds = dedupeFeeds(feeds);
      const n = importedFeeds.length;
      if (sidebarMetricEl) sidebarMetricEl.textContent = n ? n + ' feeds across ' + new Set(importedFeeds.map((f) => f.category)).size + ' categories' : 'Import OPML to get started';
      renderSidebar();
      renderToday();
      renderFeedsPage();
    }
    function filterFeeds(q) {
      if (!(q || '').trim()) return importedFeeds;
      const l = (q || '').trim().toLowerCase();
      return importedFeeds.filter((f) => (f.title || '').toLowerCase().includes(l) || (f.url || '').toLowerCase().includes(l));
    }
    function renderSidebar() {
      if (!sidebarGroups) return;
      const q = (feedSearchInput?.value || '').trim().toLowerCase();
      const filtered = filterFeeds(q);
      const lib = readLibrary();
      const g = groupFeedsByCategory(filtered, lib.categories);
      const expanded = getSidebarExpandedCategories();
      sidebarGroups.innerHTML = '';

      const totalUnread = importedFeeds.reduce((sum, f) => {
        const items = getCachedFeedItems(f.url);
        return sum + items.filter((i) => !readState.isRead(i.id)).length;
      }, 0);
      const allRow = document.createElement('div');
      allRow.className = 'sidebar-all-row';
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className =
        'sidebar-feed sidebar-all' + (selectedSidebarFeedUrl === '' && !selectedSidebarCategory ? ' is-active' : '');
      allBtn.innerHTML =
        '<span class="sidebar-feed-name">All</span>' +
        (totalUnread > 0
          ? '<span class="sidebar-count">' + totalUnread + '</span>'
          : '<span class="sidebar-count is-zero" aria-hidden="true">0</span>');
      allBtn.onclick = () => {
        selectedItemFeedUrl = '';
        selectedItemId = '';
        selectedSidebarFeedUrl = '';
        selectedSidebarCategory = '';
        activateReaderView();
        renderToday();
        renderSidebar();
        closeMobileSidebar();
      };
      allRow.appendChild(allBtn);
      sidebarGroups.appendChild(allRow);

      g.forEach((feeds, cat) => {
        const isExpanded = expanded.includes(cat);
        const sec = document.createElement('section');
        sec.className = 'sidebar-group' + (isExpanded ? ' is-expanded' : '');
        sec.dataset.category = cat;

        const aggregateUnread = feeds.reduce((sum, f) => {
          const items = getCachedFeedItems(f.url);
          return sum + items.filter((i) => !readState.isRead(i.id)).length;
        }, 0);

        const header = document.createElement('button');
        header.type = 'button';
        header.className =
          'sidebar-category-row' + (selectedSidebarCategory === cat ? ' is-active' : '');
        header.title = 'Open category digest for ' + cat;
        header.innerHTML =
          '<span class="sidebar-category-chevron" aria-hidden="true" title="Expand or collapse feeds">' +
          (isExpanded ? '▼' : '▶') +
          '</span>' +
          '<span class="sidebar-category-name">' +
          escapeHtml(cat) +
          '</span>' +
          (aggregateUnread > 0
            ? '<span class="sidebar-category-count">' + aggregateUnread + '</span>'
            : '<span class="sidebar-category-count is-zero" aria-hidden="true"></span>');
        header.onclick = (ev) => {
          // Chevron alone toggles expand; name/count opens category AI digest view
          if (ev.target.closest('.sidebar-category-chevron')) {
            const current = getSidebarExpandedCategories();
            const nowExpanded = current.includes(cat);
            const next = nowExpanded ? current.filter((c) => c !== cat) : [...current, cat];
            setSidebarExpandedCategories(next);
            sec.classList.toggle('is-expanded');
            const chev = sec.querySelector('.sidebar-category-chevron');
            if (chev) chev.textContent = sec.classList.contains('is-expanded') ? '▼' : '▶';
            return;
          }
          openCategoryView(cat);
        };
        sec.appendChild(header);

        const ul = document.createElement('ul');
        ul.className = 'sidebar-feed-list';
        feeds.forEach((f) => {
          const items = getCachedFeedItems(f.url);
          const unread = items.filter((i) => !readState.isRead(i.id)).length;
          const li = document.createElement('li');
          li.className = 'sidebar-feed-row';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'sidebar-feed' + (f.url === selectedSidebarFeedUrl ? ' is-active' : '');
          btn.dataset.url = f.url;
          btn.title = f.title;
          const health = feedHealthInfo(f.url);
          const warn = health.level === 'error'
            ? '<span class="sidebar-feed-warn" title="' + escapeHtml(health.label + ': ' + health.detail) + '" aria-label="Feed is broken">⚠</span>'
            : '';
          btn.innerHTML =
            '<span class="sidebar-feed-name">' +
            escapeHtml(f.title) +
            '</span>' +
            warn +
            (unread > 0
              ? '<span class="sidebar-count">' + unread + '</span>'
              : '<span class="sidebar-count is-zero" aria-hidden="true"></span>');
          btn.onclick = async () => {
            selectedItemFeedUrl = '';
            selectedItemId = '';
            selectedSidebarFeedUrl = f.url;
            selectedSidebarCategory = '';
            const url = f.url;
            try {
              setCachedFeedItems(url, await fetchFeed(url, { force: true }));
            } catch (err) {
              showToast('Could not refresh this feed', 'error');
            }
            loadFeedHealth().then((ok) => { if (ok) { renderSidebar(); renderFeedsPage(); } });
            activateReaderView();
            renderToday();
            renderSidebar();
            closeMobileSidebar();
          };
          li.appendChild(btn);
          ul.appendChild(li);
        });
        sec.appendChild(ul);
        sidebarGroups.appendChild(sec);
      });
    }
    function createItemEl(item, feedUrl, feedTitle) {
      const li = document.createElement('li');
      li.className = 'item article-card' + (readState.isRead(item.id) ? ' is-read' : '') + (item.id === selectedItemId ? ' is-selected expanded' : '');
      li.dataset.itemId = item.id;
      li.dataset.feedUrl = feedUrl;
      const relTime = formatRelativeTime(item.pubDate);
      const readTime = estimateReadTime(item.summary || item.title);
      const words = wordCount(item.summary || item.title);
      const readOriginalHref = safeHref(item.link);
      const domain = domainFromUrl(item.link);
      const saved = isInReadLater(item.id);
      const savedBadge = saved ? '<span class="saved-badge" title="In Read Later">🔖</span>' : '';
      li.innerHTML =
        '<div class="article-card-header">' +
        '<div class="item-meta-row"><span class="item-source-badge">' + escapeHtml(feedTitle) + '</span><span class="item-metrics"><span>' + escapeHtml(relTime) + '</span><span>' + escapeHtml(readTime) + '</span><span>~' + words + ' words</span></span>' + savedBadge + '</div>' +
        '<h2 class="item-title"><a href="' + readOriginalHref + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.title || 'Untitled') + '</a></h2>' +
        '<p class="item-snippet">' + escapeHtml(truncateText(item.summary, 120)) + '</p>' +
        '</div>' +
        '<div class="article-expanded">' +
        '<div class="article-expanded-inner">' +
        '<div class="article-toolbar">' +
        '<div class="toolbar-left">' +
        '<button type="button" class="toolbar-btn primary btn-summarize">Summarize <span class="ai-badge">AI</span></button>' +
        '<button type="button" class="toolbar-btn btn-save' + (saved ? ' is-saved' : '') + '" title="' + (saved ? 'Saved' : 'Read Later') + '">' + (saved ? '🔖 Saved ✓' : '🔖 Read Later') + '</button>' +
        '</div>' +
        '<div class="toolbar-right">' +
        '<button type="button" class="toolbar-btn btn-read-toggle" title="' + (readState.isRead(item.id) ? 'Mark unread' : 'Mark read') + '">' + (readState.isRead(item.id) ? '○ Mark unread' : '● Mark read') + '</button>' +
        '<button type="button" class="toolbar-btn btn-open-original">Open original</button>' +
        '</div>' +
        '</div>' +
        '<div class="ai-summary is-hidden"><div class="ai-summary-header"><span class="ai-icon">✦</span><span>TL;DR</span></div><div class="ai-summary-text"></div></div>' +
        '<div class="article-body">' + (isContentSufficient(item.content) ? '' : articleBodySkeletonHtml()) + '</div>' +
        '<a class="read-original" href="' + readOriginalHref + '" target="_blank" rel="noopener noreferrer">Read on ' + escapeHtml(domain) + ' ↗</a>' +
        '</div></div>';
      const bodyEl = li.querySelector('.article-body');
      const summaryBlock = li.querySelector('.ai-summary');
      const summaryTextEl = li.querySelector('.ai-summary-text');
      const btnSum = li.querySelector('.btn-summarize');
      const btnOpen = li.querySelector('.btn-open-original');
      const btnReadToggle = li.querySelector('.btn-read-toggle');

      function loadBody() {
        if (isContentSufficient(item.content)) {
          setArticleBody(bodyEl, item.content);
          return;
        }
        loadArticle(item)
          .then((t) => {
            // Extraction failed or came back thinner than the feed's own text: keep the feed text.
            if (!t || plainTextLength(t) < plainTextLength(item.content)) throw new Error('no full text');
            bodyEl.innerHTML = '';
            bodyEl.classList.remove('article-body-skeleton');
            setArticleBody(bodyEl, t);
          })
          .catch(() => {
            bodyEl.innerHTML = '';
            bodyEl.classList.remove('article-body-skeleton');
            if (item.content && plainTextLength(item.content) > plainTextLength(item.summary)) {
              setArticleBody(bodyEl, item.content);
              return;
            }
            const p = document.createElement('p');
            p.textContent = item.summary || 'No summary available.';
            bodyEl.appendChild(p);
            const a = document.createElement('a');
            a.href = safeHref(item.link);
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.className = 'read-original-inline';
            a.textContent = 'Read on ' + domain + ' →';
            bodyEl.appendChild(a);
          });
      }

      const btnSave = li.querySelector('.btn-save');
      const updateSaveUi = (isSaved) => {
        const badge = li.querySelector('.saved-badge');
        if (isSaved) {
          btnSave.textContent = '🔖 Saved ✓';
          btnSave.title = 'Saved';
          btnSave.classList.add('is-saved');
          if (!badge) li.querySelector('.item-meta-row').insertAdjacentHTML('beforeend', '<span class="saved-badge" title="In Read Later">🔖</span>');
        } else {
          btnSave.textContent = '🔖 Read Later';
          btnSave.title = 'Read Later';
          btnSave.classList.remove('is-saved');
          badge?.remove();
        }
      };
      btnSave.onclick = (ev) => {
        ev.stopPropagation();
        const currentlySaved = isInReadLater(item.id);
        if (currentlySaved) {
          removeFromReadLater(item.id);
          updateSaveUi(false);
          updateReadLaterCount();
          if (selectedSidebarFeedUrl === READ_LATER_VIEW_SENTINEL) { renderToday(); renderSidebar(); }
        } else {
          const payload = { guid: item.id, title: item.title || '', link: item.link || '', summary: item.summary || '', content: item.content || '', source: feedTitle, author: item.author || '', pubDate: item.pubDate || '' };
          addToReadLater(payload);
          updateSaveUi(true);
          updateReadLaterCount();
        }
      };
      btnOpen.onclick = (ev) => {
        ev.stopPropagation();
        const u = safeHref(item.link);
        if (u !== '#') window.open(u, '_blank');
      };
      function updateReadToggleButton() {
        const read = readState.isRead(item.id);
        if (btnReadToggle) {
          btnReadToggle.textContent = read ? '○ Mark unread' : '● Mark read';
          btnReadToggle.title = read ? 'Mark unread' : 'Mark read';
        }
        li.classList.toggle('is-read', read);
      }
      btnReadToggle.onclick = (ev) => {
        ev.stopPropagation();
        readState.toggleRead(item.id);
        pinRead(item.id);
        updateReadToggleButton();
        updateUnreadCounts();
      };

      btnSum.onclick = async (ev) => {
        ev.stopPropagation();
        summaryBlock.classList.remove('is-hidden');
        const s = readSettings();
        const modelId = s.modelIdSummary || modelSelectSummary?.value || '';
        const ready = llmConfigReady(s, modelId);
        if (!ready.ok) {
          summaryTextEl.textContent = ready.message;
          summaryTextEl.classList.add('error');
          return;
        }
        summaryTextEl.classList.remove('error');
        summaryTextEl.textContent = 'Summarizing…';
        btnSum.disabled = true;
        try {
          // Summarize the full article, never just the feed teaser.
          let text = (bodyEl.innerText || bodyEl.textContent || '').trim();
          if (text === 'No content available.') text = '';
          if (text.length < FULL_TEXT_MIN_CHARS) {
            const fetched = await loadArticle(item);
            // DOMParser, not innerHTML on a live element, so images in the article don't load.
            const parsed = new DOMParser().parseFromString(fetched || '', 'text/html');
            const fetchedText = (parsed.body.innerText || parsed.body.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
            if (fetchedText && fetchedText.length >= text.length) {
              text = fetchedText;
            } else if (text.length < 600) {
              summaryTextEl.textContent =
                "Only the feed's teaser is available (the full page couldn't be loaded), so there's nothing more to summarize. Use Open original.";
              return;
            }
          }
          const truncated = text.length > 24000 ? text.slice(0, 24000) + '\n\n[Article truncated…]' : text;
          const promptTpl = getSummaryPrompt();
          const prompt = promptTpl.includes('{{ARTICLE}}') ? promptTpl.replace('{{ARTICLE}}', truncated) : promptTpl + '\n\n' + truncated;
          const res = await fetch('/api/llm/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...ready.cfg, modelId, messages: [{ role: 'user', content: prompt }] })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            summaryTextEl.textContent = data.message || data.error || 'Request failed.';
            summaryTextEl.classList.add('error');
            return;
          }
          const result = (data.content || '').trim() || 'No summary returned.';
          summaryTextEl.innerHTML = renderSummaryHtml(result);
          setCachedSummary(item.id, result);
        } catch {
          summaryTextEl.textContent = 'Network error.';
          summaryTextEl.classList.add('error');
        } finally {
          btnSum.disabled = false;
        }
      };

      li.onclick = function (e) {
        if (e.target.closest('a') || e.target.closest('button')) return;
        const wasExpanded = li.classList.contains('expanded');
        (todayContent?.querySelectorAll('.article-card') ?? []).forEach((c) => c.classList.remove('expanded', 'is-selected'));
        if (!wasExpanded) {
          li.classList.add('expanded', 'is-selected');
          selectedItemId = item.id;
          selectedItemFeedUrl = feedUrl;
          if (selectedSidebarFeedUrl !== READ_LATER_VIEW_SENTINEL) {
            readState.markAsRead(item.id);
            pinRead(item.id);
            updateReadToggleButton();
            updateUnreadCounts();
          }
          addToRecentlyRead({ guid: item.id, title: item.title || '', link: item.link || '', summary: item.summary || '', source: feedTitle });
          let exp = li.querySelector('.article-expanded');
          if (exp && !exp.dataset.loaded) {
            exp.dataset.loaded = '1';
            loadBody();
          }
          setTimeout(() => li.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
        } else {
          // Read card stays (grayed) in an Unread view until the view changes.
          selectedItemId = '';
        }
      };

      const cachedSummary = getCachedSummary(item.id);
      if (cachedSummary) {
        summaryBlock.classList.remove('is-hidden');
        summaryTextEl.innerHTML = renderSummaryHtml(cachedSummary);
      }

      if (li.classList.contains('expanded')) {
        li.querySelector('.article-expanded')?.setAttribute('data-loaded', '1');
        loadBody();
      }
      return li;
    }
    const COLLAPSED_KEY = 'rss-viewer-collapsed-categories';
    function getCollapsedCategories() {
      try {
        const raw = sessionStorage.getItem(COLLAPSED_KEY);
        return raw ? new Set(JSON.parse(raw)) : new Set();
      } catch { return new Set(); }
    }
    function setCollapsedCategories(set) {
      try { sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); } catch {}
    }

    function getSidebarExpandedCategories() {
      try {
        const raw = localStorage.getItem(SIDEBAR_STATE_KEY);
        const o = raw ? JSON.parse(raw) : {};
        return Array.isArray(o.expandedCategories) ? o.expandedCategories : [];
      } catch { return []; }
    }
    function setSidebarExpandedCategories(arr) {
      try {
        localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify({ expandedCategories: arr || [] }));
      } catch {}
    }
    function updateReadLaterCount() {
      const el = document.getElementById('read-later-count');
      if (!el) return;
      const n = getReadLaterArticles().length;
      el.textContent = n ? String(n) : '';
      el.classList.toggle('dimmed', n === 0);
    }
    function updateCategoryUnreadInView() {
      if (!todayContent) return;
      todayContent.querySelectorAll('.feed-group').forEach((g) => {
        const metricsEl = g.querySelector('.feed-group-collapsed-metrics');
        if (!metricsEl) return;
        const cards = g.querySelectorAll('.article-card');
        const n = cards.length;
        const feedUrls = new Set(Array.from(cards).map((c) => c.dataset.feedUrl).filter(Boolean));
        const unread = Array.from(cards).filter((c) => !readState.isRead(c.dataset.itemId)).length;
        const feedCount = feedUrls.size;
        metricsEl.textContent = n + ' item' + (n === 1 ? '' : 's') + (feedCount > 1 ? ' · ' + feedCount + ' feeds' : '') + (unread ? ' · ' + unread + ' unread' : '');
      });
    }
    function updateUnreadCounts() {
      renderSidebar();
      updateCategoryUnreadInView();
    }

    function emptyStateHtml({ icon, title, desc, actions }) {
      const acts = Array.isArray(actions) ? actions : [];
      const actionsHtml = acts.length
        ? '<div class="empty-state-actions">' +
          acts
            .map((a) => {
              const cls = a.primary ? 'btn-primary' : 'btn-quiet';
              return (
                '<button type="button" class="' +
                cls +
                '" data-empty-action="' +
                escapeHtml(a.id) +
                '">' +
                escapeHtml(a.label) +
                '</button>'
              );
            })
            .join('') +
          '</div>'
        : '';
      return (
        '<div class="empty-state">' +
        '<div class="empty-state-icon" aria-hidden="true">' +
        (icon || '◎') +
        '</div>' +
        '<p class="empty-state-title">' +
        escapeHtml(title || '') +
        '</p>' +
        (desc
          ? '<p class="empty-state-desc">' + escapeHtml(desc) + '</p>'
          : '') +
        actionsHtml +
        '</div>'
      );
    }

    function bindEmptyStateActions(root) {
      if (!root) return;
      root.querySelectorAll('[data-empty-action]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const action = btn.getAttribute('data-empty-action');
          if (action === 'import-opml') {
            openPage('feeds');
            // Defer so feeds view is active, then open file picker
            setTimeout(() => {
              const input = document.getElementById('opml-import');
              if (input) input.click();
            }, 0);
          } else if (action === 'manage-feeds') {
            openPage('feeds');
          } else if (action === 'refresh') {
            btnRefresh?.click();
          } else if (action === 'show-all') {
            setShowUnreadOnly(false);
            renderToday(true);
          }
        });
      });
    }

    /** Items currently in the Today/All, category, or single-feed reader view (not Read Later / Recently Read). */
    function getCurrentReaderItems() {
      if (selectedSidebarFeedUrl === READ_LATER_VIEW_SENTINEL || selectedSidebarFeedUrl === RECENTLY_READ_VIEW_SENTINEL) {
        return [];
      }
      let items;
      if (selectedSidebarCategory) {
        items = getCategoryItems(selectedSidebarCategory);
      } else if (selectedSidebarFeedUrl) {
        const feed = importedFeeds.find((f) => f.url === selectedSidebarFeedUrl);
        items = getCachedFeedItems(selectedSidebarFeedUrl).map((i) => ({
          ...i,
          feedUrl: selectedSidebarFeedUrl,
          feedTitle: feed ? feed.title : selectedSidebarFeedUrl
        }));
      } else {
        items = getAllItemsGrouped().flatMap((g) => g.items);
      }
      return filterItemsByReadState(items);
    }

    function setMarkAllReadVisible(show) {
      if (!btnMarkAllRead) return;
      btnMarkAllRead.classList.toggle('is-hidden', !show);
    }

    function applyMarkAllReadToDom(guids) {
      const set = new Set(guids);
      todayContent?.querySelectorAll('.article-card').forEach((card) => {
        if (!set.has(card.dataset.itemId)) return;
        card.classList.add('is-read');
        const btn = card.querySelector('.btn-read-toggle');
        if (btn) {
          btn.textContent = '○ Mark unread';
          btn.title = 'Mark unread';
        }
      });
      updateUnreadCounts();
    }

    function renderToday(skipDefaultCollapse) {
      const viewKey = [selectedSidebarFeedUrl, selectedSidebarCategory, showUnreadOnly ? 'unread' : 'all'].join('\u0001');
      if (viewKey !== readPinsViewKey) {
        readPins.clear();
        readPinsViewKey = viewKey;
      }
      renderTodayView(skipDefaultCollapse);
      syncRoute();
    }

    // --- URL state: #/feed/<url>, #/category/<name>, #/later, #/recent, #/digest, #/feeds, #/settings
    let applyingRoute = false;
    let routeReady = false;
    function routeFromState() {
      const tab = document.querySelector('.mockup-view.active')?.dataset.tab || 'reader';
      if (tab !== 'reader') return '#/' + tab;
      if (selectedSidebarFeedUrl === READ_LATER_VIEW_SENTINEL) return '#/later';
      if (selectedSidebarFeedUrl === RECENTLY_READ_VIEW_SENTINEL) return '#/recent';
      if (selectedSidebarCategory) return '#/category/' + encodeURIComponent(selectedSidebarCategory);
      if (selectedSidebarFeedUrl) return '#/feed/' + encodeURIComponent(selectedSidebarFeedUrl);
      return '#/';
    }
    function normalizedHash() {
      const h = (location.hash || '').replace(/^#\/?/, '');
      return '#/' + h;
    }
    function syncRoute() {
      if (applyingRoute || !routeReady) return;
      const want = routeFromState();
      if (normalizedHash() === want) return;
      try { history.pushState(null, '', want); } catch {}
    }
    function clickNav(view) {
      document.querySelector('.sidebar-nav-item[data-view="' + view + '"]')?.click();
    }
    function applyRoute() {
      if (normalizedHash() === routeFromState()) return;
      const h = normalizedHash().slice(2);
      const slash = h.indexOf('/');
      const kind = slash === -1 ? h : h.slice(0, slash);
      let arg = '';
      try { arg = slash === -1 ? '' : decodeURIComponent(h.slice(slash + 1)); } catch {}
      applyingRoute = true;
      try {
        if (kind === 'feeds' || kind === 'settings') {
          openPage(kind);
        } else if (kind === 'digest') {
          clickNav('digest');
        } else if (kind === 'later') {
          clickNav('read_later');
        } else if (kind === 'recent') {
          clickNav('recently_read');
        } else if (kind === 'feed' && importedFeeds.some((f) => f.url === arg)) {
          selectedItemFeedUrl = '';
          selectedItemId = '';
          selectedSidebarFeedUrl = arg;
          selectedSidebarCategory = '';
          activateReaderView();
          renderToday();
          renderSidebar();
        } else if (kind === 'category' && importedFeeds.some((f) => normalizeCategory(f.category) === arg)) {
          openCategoryView(arg);
        } else {
          clickNav('reader');
        }
      } finally {
        applyingRoute = false;
      }
      // Unknown feed/category fell back to All: fix the address bar without a new entry.
      const want = routeFromState();
      if (normalizedHash() !== want) {
        try { history.replaceState(null, '', want); } catch {}
      }
    }
    window.addEventListener('hashchange', applyRoute);

    function renderTodayView(skipDefaultCollapse) {
      if (!todayContent) return;
      const heroEyebrow = document.getElementById('viewer-reader-eyebrow');
      const heroTitle = document.getElementById('viewer-reader-title');
      if (selectedSidebarFeedUrl === READ_LATER_VIEW_SENTINEL) {
        setMarkAllReadVisible(false);
        if (heroEyebrow) heroEyebrow.textContent = 'Read Later';
        if (heroTitle) heroTitle.textContent = getReadLaterArticles().length === 1 ? '1 article' : getReadLaterArticles().length + ' articles';
        todayContent.innerHTML = '';
        const list = getReadLaterArticles();
        if (!list.length) {
          todayContent.innerHTML = emptyStateHtml({
            icon: '🔖',
            title: 'No read-later articles yet',
            desc: 'Save an article from Today with Read Later to build this list.',
            actions: []
          });
          return;
        }
        const ul = document.createElement('ul');
        ul.className = 'results';
        list.forEach((a) => {
          const item = { id: a.guid, title: a.title, link: a.link, pubDate: a.pubDate, summary: a.summary, content: a.content, author: a.author, feedUrl: a.link, feedTitle: a.source, isRead: true };
          ul.appendChild(createItemEl(item, a.link, a.source));
        });
        todayContent.appendChild(ul);
        updateReadLaterCount();
        return;
      }
      if (selectedSidebarFeedUrl === RECENTLY_READ_VIEW_SENTINEL) {
        setMarkAllReadVisible(false);
        if (heroEyebrow) heroEyebrow.textContent = 'Recently Read';
        if (heroTitle) heroTitle.textContent = 'Recently Read';
        todayContent.innerHTML = '';
        const recent = getRecentlyRead();
        if (!recent.length) {
          todayContent.innerHTML = emptyStateHtml({
            icon: '◷',
            title: 'No recently read articles',
            desc: 'Articles you open in Today will show up here.',
            actions: []
          });
          return;
        }
        const ul = document.createElement('ul');
        ul.className = 'results';
        recent.forEach((a) => {
          const item = { id: a.guid, title: a.title, link: a.link, pubDate: a.readAt, summary: a.summary, content: '', author: '', feedUrl: a.link, feedTitle: a.source, isRead: true };
          ul.appendChild(createItemEl(item, a.link, a.source));
        });
        todayContent.appendChild(ul);
        return;
      }
      setMarkAllReadVisible(true);
      if (heroEyebrow) {
        if (selectedSidebarCategory) heroEyebrow.textContent = 'Category';
        else if (selectedSidebarFeedUrl) heroEyebrow.textContent = 'Feed';
        else heroEyebrow.textContent = 'Today';
      }
      if (heroTitle) {
        const unreadSuffix = showUnreadOnly ? ' · Unread' : '';
        if (selectedSidebarCategory) {
          heroTitle.textContent = selectedSidebarCategory + unreadSuffix;
        } else if (selectedSidebarFeedUrl) {
          const feed = importedFeeds.find((f) => f.url === selectedSidebarFeedUrl);
          heroTitle.textContent = (feed ? feed.title : 'Feed') + unreadSuffix;
        } else {
          heroTitle.textContent = showUnreadOnly ? 'Unread' : 'All feeds';
        }
      }
      todayContent.innerHTML = '';
      let collapsed = getCollapsedCategories();
      // Default to all collapsed when user has no saved preference (unless they just clicked Expand all)
      if (!skipDefaultCollapse) {
        if (selectedSidebarCategory) {
          // Category view lists feeds as source groups; leave expand preference alone
        } else if (selectedSidebarFeedUrl) {
          const feed = importedFeeds.find((f) => f.url === selectedSidebarFeedUrl);
          const singleTitle = feed ? feed.title : 'Feed';
          if (collapsed.size === 0) {
            setCollapsedCategories(new Set([singleTitle]));
            collapsed = getCollapsedCategories();
          }
        } else {
          const groupedForDefault = getAllItemsGrouped();
          if (groupedForDefault.length > 0 && collapsed.size === 0) {
            setCollapsedCategories(new Set(groupedForDefault.map((x) => x.category)));
            collapsed = getCollapsedCategories();
          }
        }
      }
      function addGroup(title, items, feedUrl, feedTitle, parentEl) {
        items = filterItemsByReadState(items);
        if (!items.length) return;
        const host = parentEl || todayContent;
        const g = document.createElement('div');
        g.className = 'feed-group' + (collapsed.has(title) ? ' is-collapsed' : '');
        g.dataset.category = title;
        const block = document.createElement('div');
        block.className = 'feed-group-header-block';
        block.onclick = () => {
          g.classList.toggle('is-collapsed');
          const next = new Set(collapsed);
          if (g.classList.contains('is-collapsed')) next.add(title); else next.delete(title);
          setCollapsedCategories(next);
        };
        const h3 = document.createElement('h3');
        h3.className = 'feed-group-title';
        h3.innerHTML = '<span class="category-chevron" aria-hidden="true">▼</span><span class="category-name">' + escapeHtml(title) + '</span>';
        block.appendChild(h3);
        const feedCount = new Set(items.map((i) => i.feedUrl || feedUrl)).size;
        const unreadCount = items.filter((i) => !readState.isRead(i.id)).length;
        const summaryEl = document.createElement('div');
        summaryEl.className = 'feed-group-collapsed-summary';
        const metricsLine =
          items.length +
          ' item' +
          (items.length === 1 ? '' : 's') +
          (feedCount > 1 ? ' · ' + feedCount + ' feeds' : '') +
          (unreadCount ? ' · ' + unreadCount + ' unread' : '');
        const latestOne = items[0] ? truncateText(items[0].title || '', 72) : '';
        summaryEl.innerHTML =
          '<div class="feed-group-collapsed-metrics">' +
          escapeHtml(metricsLine) +
          '</div>' +
          (latestOne
            ? '<div class="feed-group-collapsed-latest" title="' +
              escapeHtml(items[0].title || '') +
              '">' +
              escapeHtml(latestOne) +
              '</div>'
            : '');
        block.appendChild(summaryEl);
        const headerRow = document.createElement('div');
        headerRow.className = 'feed-group-header-row';
        const blockWrap = document.createElement('div');
        blockWrap.className = 'feed-group-header-block-wrap';
        blockWrap.appendChild(block);
        headerRow.appendChild(blockWrap);
        const markAllReadLink = document.createElement('button');
        markAllReadLink.type = 'button';
        markAllReadLink.className = 'feed-group-mark-all-read';
        markAllReadLink.textContent = 'Mark all read';
        markAllReadLink.onclick = (ev) => {
          ev.stopPropagation();
          const guids = items.map((i) => i.id);
          readState.markMultipleAsRead(guids);
          unpinMany(guids);
          updateUnreadCounts();
          if (showUnreadOnly) {
            renderToday(true);
            return;
          }
          g.querySelectorAll('.article-card').forEach((card) => {
            card.classList.add('is-read');
            const btn = card.querySelector('.btn-read-toggle');
            if (btn) { btn.textContent = '○ Mark unread'; btn.title = 'Mark unread'; }
          });
        };
        headerRow.appendChild(markAllReadLink);
        g.appendChild(headerRow);
        const detailEl = document.createElement('div');
        detailEl.className = 'feed-group-detail';
        detailEl.textContent = items.length + ' item' + (items.length === 1 ? '' : 's') + (feedCount > 1 ? ' · ' + feedCount + ' feeds' : '');
        g.appendChild(detailEl);
        const ul = document.createElement('ul');
        ul.className = 'results';
        items.forEach((i) => ul.appendChild(createItemEl(i, i.feedUrl ?? feedUrl, i.feedTitle ?? feedTitle)));
        g.appendChild(ul);
        host.appendChild(g);
      }
      if (selectedSidebarCategory) {
        const cat = selectedSidebarCategory;
        const items = getCategoryItems(cat);
        const visible = filterItemsByReadState(items);
        if (!items.length) {
          todayContent.innerHTML = emptyStateHtml({
            icon: '◌',
            title: 'No items in ' + cat,
            desc: 'Refresh feeds in this category, or check that feed URLs still work.',
            actions: [{ id: 'refresh', label: 'Refresh feeds', primary: true }]
          });
          bindEmptyStateActions(todayContent);
          return;
        }
        mountCategoryDigestPanel(todayContent, cat, items);
        if (!visible.length) {
          const caughtUp = document.createElement('div');
          caughtUp.className = 'feed-source-empty';
          caughtUp.innerHTML = emptyStateHtml({
            icon: '✓',
            title: 'No unread articles',
            desc: '',
            actions: [{ id: 'show-all', label: 'Show all', primary: true }]
          });
          todayContent.appendChild(caughtUp);
          bindEmptyStateActions(caughtUp);
          return;
        }
        const sourceWrap = document.createElement('section');
        sourceWrap.className = 'feed-source-section';
        const sourceHead = document.createElement('div');
        sourceHead.className = 'feed-source-heading-row';
        const feedCount = new Set(items.map((i) => i.feedUrl)).size;
        sourceHead.innerHTML =
          '<h3 class="feed-source-heading">Source items · ' +
          feedCount +
          ' feed' +
          (feedCount === 1 ? '' : 's') +
          '</h3>';
        sourceWrap.appendChild(sourceHead);
        const groupHost = document.createElement('div');
        groupHost.className = 'feed-source-groups';
        sourceWrap.appendChild(groupHost);
        todayContent.appendChild(sourceWrap);
        // One group per feed inside the category for scannable source list
        const byFeed = new Map();
        items.forEach((i) => {
          const key = i.feedUrl || '';
          if (!byFeed.has(key)) byFeed.set(key, { title: i.feedTitle || key, items: [] });
          byFeed.get(key).items.push(i);
        });
        byFeed.forEach((bucket, feedUrl) => {
          addGroup(bucket.title, bucket.items, feedUrl, bucket.title, groupHost);
        });
        return;
      }
      if (selectedSidebarFeedUrl) {
        const feedMeta = importedFeeds.find((f) => f.url === selectedSidebarFeedUrl) || {
          url: selectedSidebarFeedUrl,
          title: selectedSidebarFeedUrl
        };
        const items = getCachedFeedItems(selectedSidebarFeedUrl)
          .map((i) => ({
            ...i,
            feedUrl: selectedSidebarFeedUrl,
            feedTitle: feedMeta.title || selectedSidebarFeedUrl
          }))
          .sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
        const visible = filterItemsByReadState(items);
        if (!items.length) {
          todayContent.innerHTML = emptyStateHtml({
            icon: '◌',
            title: 'No items in this feed',
            desc: 'Try refreshing, or check that the feed URL still works.',
            actions: [{ id: 'refresh', label: 'Refresh feeds', primary: true }]
          });
          bindEmptyStateActions(todayContent);
          return;
        }
        // AI-first: digest panel always leads. Source list is secondary and
        // still respects All/Unread filter for manual browsing.
        mountFeedDigestPanel(todayContent, feedMeta, items);
        if (!visible.length) {
          const caughtUp = document.createElement('div');
          caughtUp.className = 'feed-source-empty';
          caughtUp.innerHTML = emptyStateHtml({
            icon: '✓',
            title: 'No unread articles',
            desc: '',
            actions: [{ id: 'show-all', label: 'Show all', primary: true }]
          });
          todayContent.appendChild(caughtUp);
          bindEmptyStateActions(caughtUp);
          return;
        }
        const sourceWrap = document.createElement('section');
        sourceWrap.className = 'feed-source-section';
        const sourceHead = document.createElement('div');
        sourceHead.className = 'feed-source-heading-row';
        sourceHead.innerHTML = '<h3 class="feed-source-heading">Source items</h3>';
        sourceWrap.appendChild(sourceHead);
        const groupHost = document.createElement('div');
        groupHost.className = 'feed-source-groups';
        sourceWrap.appendChild(groupHost);
        todayContent.appendChild(sourceWrap);
        addGroup(feedMeta.title || 'Feed', items, selectedSidebarFeedUrl, feedMeta.title || 'Feed', groupHost);
        return;
      }
      const grouped = getAllItemsGrouped();
      if (!grouped.length) {
        todayContent.innerHTML = emptyStateHtml({
          icon: '◎',
          title: importedFeeds.length ? 'No items to show' : 'No feeds yet',
          desc: importedFeeds.length
            ? 'Refresh to fetch the latest posts from your feeds.'
            : 'Import an OPML file or add a feed URL to start reading.',
          actions: importedFeeds.length
            ? [{ id: 'refresh', label: 'Refresh feeds', primary: true }]
            : [
                { id: 'import-opml', label: 'Import OPML', primary: true },
                { id: 'manage-feeds', label: 'Manage feeds', primary: false }
              ]
        });
        bindEmptyStateActions(todayContent);
        return;
      }
      const visibleGroups = grouped
        .map((g) => ({ ...g, items: filterItemsByReadState(g.items) }))
        .filter((g) => g.items.length);
      if (!visibleGroups.length) {
        todayContent.innerHTML = emptyStateHtml({
          icon: '✓',
          title: showUnreadOnly ? 'No unread articles' : 'No items to show',
          desc: showUnreadOnly
            ? 'You’re caught up. Switch to All to browse everything again.'
            : 'Refresh to fetch the latest posts from your feeds.',
          actions: showUnreadOnly
            ? [{ id: 'show-all', label: 'Show all', primary: true }]
            : [{ id: 'refresh', label: 'Refresh feeds', primary: true }]
        });
        bindEmptyStateActions(todayContent);
        return;
      }
      visibleGroups.forEach(({ category, items }) => {
        const feedTitle = items[0]?.feedTitle || category;
        const feedUrl = items[0]?.feedUrl || '';
        addGroup(category, items, feedUrl, feedTitle);
      });
    }
    let feedsProblemsOnly = false;
    function renderFeedsPage() {
      if (!feedsList || !feedsSummary) return;
      const q = (feedMgmtSearch?.value || '').trim().toLowerCase();
      const isProblem = (f) => feedHealthInfo(f.url).level !== 'ok' && feedHealthInfo(f.url).level !== 'unknown';
      const problems = importedFeeds.filter(isProblem);
      if (!problems.length) feedsProblemsOnly = false;
      let filtered = filterFeeds(q);
      if (feedsProblemsOnly) filtered = filtered.filter(isProblem);
      const cats = new Set(filtered.map((f) => f.category).filter(Boolean));
      feedsSummary.textContent = filtered.length
        ? filtered.length + ' feed' + (filtered.length === 1 ? '' : 's') + (cats.size ? ' · ' + cats.size + ' categor' + (cats.size === 1 ? 'y' : 'ies') : '') + '.'
        : (feedsProblemsOnly ? 'No problem feeds match.' : 'No feeds yet.');
      if (problems.length) {
        const broken = problems.filter((f) => feedHealthInfo(f.url).level !== 'stale').length;
        const stale = problems.length - broken;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn-quiet feeds-problems-toggle' + (feedsProblemsOnly ? ' is-active' : '');
        toggle.setAttribute('aria-pressed', feedsProblemsOnly ? 'true' : 'false');
        toggle.textContent = feedsProblemsOnly
          ? 'Show all feeds'
          : [broken ? broken + ' failing' : '', stale ? stale + ' stale' : ''].filter(Boolean).join(' · ');
        toggle.onclick = () => { feedsProblemsOnly = !feedsProblemsOnly; renderFeedsPage(); };
        feedsSummary.appendChild(toggle);
      }
      feedsList.innerHTML = '';
      filtered.forEach((f) => {
        const health = feedHealthInfo(f.url);
        const li = document.createElement('li');
        li.className = 'feeds-list-item';
        li.dataset.url = f.url;
        li.dataset.health = health.level;
        li.innerHTML =
          '<div class="feeds-list-main">' +
          '<span class="feeds-list-title">' +
          escapeHtml(f.title) +
          '</span>' +
          '<span class="feeds-list-url">' +
          escapeHtml(f.url) +
          '</span>' +
          '<span class="feeds-list-health is-' + health.level + '">' +
          '<span class="feeds-list-health-label">' + escapeHtml(health.label) + '</span>' +
          (health.detail ? '<span class="feeds-list-health-detail">' + escapeHtml(health.detail) + '</span>' : '') +
          '</span>' +
          '</div>' +
          '<span class="feeds-list-cat">' +
          escapeHtml(f.category || 'Uncategorized') +
          '</span>' +
          '<button type="button" class="feeds-list-remove" title="Remove feed" aria-label="Remove ' +
          escapeHtml(f.title) +
          '">&times;</button>';
        const removeBtn = li.querySelector('.feeds-list-remove');
        removeBtn.onclick = () => {
          if (!confirm('Remove "' + f.title + '"? This cannot be undone.')) return;
          removeFeed(f.url);
        };
        feedsList.appendChild(li);
      });
    }
    function removeFeed(url) {
      const lib = readLibrary();
      lib.feeds = lib.feeds.filter((f) => f.url !== url);
      saveLibrary(lib);
      delete feedItemCache[url];
      saveFeedItemCache(feedItemCache);
      if (selectedSidebarFeedUrl === url) selectedSidebarFeedUrl = '';
      setImportedFeeds(lib.feeds);
      showToast('Feed removed');
    }
    document.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input')) return;
      const sel = document.querySelector('.view-reader .article-card.expanded');
      if (!sel || e.target.closest('.article-card') === sel) return;
      sel.classList.remove('expanded', 'is-selected');
      selectedItemId = '';
    });

    document.querySelectorAll('.sidebar-nav-item').forEach((item) => {
      const activate = () => {
        const v = item.dataset.view;
        if (v !== 'reader' && v !== 'digest' && v !== 'read_later' && v !== 'recently_read') return;
        if (v === 'reader') {
          selectedSidebarFeedUrl = '';
          selectedSidebarCategory = '';
        } else if (v === 'read_later') {
          selectedSidebarFeedUrl = READ_LATER_VIEW_SENTINEL;
          selectedSidebarCategory = '';
        } else if (v === 'recently_read') {
          selectedSidebarFeedUrl = RECENTLY_READ_VIEW_SENTINEL;
          selectedSidebarCategory = '';
        }
        document.querySelectorAll('.mockup-view').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.sidebar-nav-item').forEach((x) => {
          x.classList.remove('is-active');
          x.setAttribute('aria-current', 'false');
        });
        const tab = (v === 'read_later' || v === 'recently_read') ? 'reader' : v;
        const view = document.querySelector('.mockup-view[data-tab="' + tab + '"]');
        if (view) view.classList.add('active');
        item.classList.add('is-active');
        item.setAttribute('aria-current', 'page');
        renderToday();
        renderSidebar();
        closeMobileSidebar();
      };
      item.addEventListener('click', activate);
    });
    function openPage(p) {
      document.querySelectorAll('.mockup-view').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.sidebar-nav-item').forEach((x) => {
        x.classList.remove('is-active');
        x.setAttribute('aria-current', 'false');
      });
      const view = document.querySelector('.mockup-view[data-tab="' + p + '"]');
      if (view) view.classList.add('active');
      if (p === 'feeds') loadFeedHealth().then((ok) => { if (ok) renderFeedsPage(); });
      syncRoute();
    }
    document.querySelectorAll('.sidebar-footer-link[data-page], .page-nav a[data-page]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        openPage(a.dataset.page);
        closeMobileSidebar();
      };
    });
    const sidebarEl = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');

    function closeMobileSidebar() {
      sidebarEl?.classList.remove('open');
      sidebarOverlay?.classList.remove('visible');
    }

    function isMobileSidebar() {
      return typeof window !== 'undefined' && window.innerWidth <= 768;
    }

    function updateRailToggleLabel() {
      const btn = document.getElementById('sidebar-rail-toggle');
      if (!btn || isMobileSidebar()) return;
      const collapsed = sidebarEl?.classList.contains('collapsed');
      btn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
      btn.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
    }

    function toggleDesktopSidebarCollapse() {
      if (!sidebarEl) return;
      sidebarEl.classList.toggle('collapsed');
      try {
        localStorage.setItem('rss_sidebar_collapsed', sidebarEl.classList.contains('collapsed') ? 'true' : 'false');
      } catch {}
      updateRailToggleLabel();
    }

    // Desktop collapse UI removed; clear any sticky collapsed state
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem('rss_sidebar_collapsed'); } catch {}
    }
    sidebarEl?.classList.remove('collapsed');
    updateRailToggleLabel();

    document.getElementById('main-menu-btn')?.addEventListener('click', () => {
      if (isMobileSidebar()) {
        sidebarEl?.classList.add('open');
        sidebarOverlay?.classList.add('visible');
      }
    });
    document.getElementById('sidebar-show-btn')?.addEventListener('click', () => {
      if (isMobileSidebar()) {
        sidebarEl?.classList.add('open');
        sidebarOverlay?.classList.add('visible');
      } else {
        toggleDesktopSidebarCollapse();
      }
    });
    document.getElementById('sidebar-rail-toggle')?.addEventListener('click', () => {
      if (!isMobileSidebar()) toggleDesktopSidebarCollapse();
    });

    sidebarOverlay?.addEventListener('click', closeMobileSidebar);

    window.addEventListener('resize', () => {
      if (!isMobileSidebar()) closeMobileSidebar();
    });

    expandAllCategories?.addEventListener('click', () => {
      setCollapsedCategories(new Set());
      renderToday(true);
    });
    collapseAllCategories?.addEventListener('click', () => {
      const groups = todayContent?.querySelectorAll('.feed-group[data-category]') ?? [];
      const names = [...groups].map((g) => g.dataset.category).filter(Boolean);
      setCollapsedCategories(new Set(names));
      renderToday();
    });

    // Initial empty-state CTAs (static HTML before first render)
    bindEmptyStateActions(document.getElementById('today-content'));
    syncUnreadFilterUi();
    document.getElementById('filter-show-all')?.addEventListener('click', () => {
      setShowUnreadOnly(false);
      renderToday(true);
    });
    document.getElementById('filter-show-unread')?.addEventListener('click', () => {
      setShowUnreadOnly(true);
      renderToday(true);
    });

    btnMarkAllRead?.addEventListener('click', () => {
      const items = getCurrentReaderItems();
      if (!items.length) return;
      const guids = items.map((i) => i.id).filter(Boolean);
      if (!guids.length) return;
      readState.markMultipleAsRead(guids);
      unpinMany(guids);
      applyMarkAllReadToDom(guids);
      // Re-render so collapsed category unread metrics update immediately
      renderToday(true);
      renderSidebar();
    });

    btnRefresh?.addEventListener('click', async () => {
      if (!refreshWrap || !refreshBar) return;
      if (btnRefresh) btnRefresh.disabled = true;
      refreshWrap.hidden = false;
      refreshWrap.style.display = 'block';
      refreshBar.style.width = '0%';
      try {
        const total = importedFeeds.length;
        await fetchAllFeeds((done, t) => {
          refreshBar.style.width = ((done / (t || 1)) * 100) + '%';
        });
        lastRefreshAt = Date.now();
        updateLastRefreshedUi();
        if (await loadFeedHealth()) renderFeedsPage();
        showToast(total ? 'Feeds refreshed' : 'No feeds to refresh', total ? 'success' : undefined);
      } catch {
        showToast('Refresh failed', 'error');
      } finally {
        refreshWrap.hidden = true;
        refreshWrap.style.display = 'none';
        if (btnRefresh) btnRefresh.disabled = false;
      }
      renderToday();
      renderSidebar();
    });
    const SHORTCUTS = [
      ['j / n', 'Next article (opens the first one if none is open)'],
      ['k / p', 'Previous article'],
      ['o / Enter', 'Open original'],
      ['m', 'Toggle read / unread'],
      ['s', 'Save to Read Later'],
      ['Esc', 'Collapse article / close this help'],
      ['g a', 'Go to All'],
      ['g u', 'Go to Unread'],
      ['g s', 'Go to Read Later'],
      ['g r', 'Go to Recently Read'],
      ['g d', 'Go to Digest'],
      ['g f', 'Go to Feeds'],
      ['/', 'Search feeds'],
      ['Shift+R', 'Refresh all feeds'],
      ['?', 'Show this help']
    ];
    function toggleShortcutHelp(force) {
      let el = document.getElementById('shortcut-help');
      if (!el) {
        el = document.createElement('div');
        el.id = 'shortcut-help';
        el.className = 'shortcut-help-backdrop';
        el.hidden = true;
        el.innerHTML =
          '<div class="shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">' +
          '<div class="shortcut-help-head"><h2 id="shortcut-help-title">Keyboard shortcuts</h2>' +
          '<button type="button" class="btn-quiet shortcut-help-close" aria-label="Close">&times;</button></div>' +
          '<dl>' +
          SHORTCUTS.map(([k, d]) => '<div><dt>' + k.split(' / ').map((x) => '<kbd>' + escapeHtml(x) + '</kbd>').join(' / ') + '</dt><dd>' + escapeHtml(d) + '</dd></div>').join('') +
          '</dl></div>';
        el.addEventListener('click', (ev) => {
          if (ev.target === el || ev.target.closest('.shortcut-help-close')) toggleShortcutHelp(false);
        });
        document.body.appendChild(el);
      }
      el.hidden = typeof force === 'boolean' ? !force : !el.hidden;
      return !el.hidden;
    }

    let gPrefixAt = 0;
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
      const help = document.getElementById('shortcut-help');
      if (e.key === 'Escape' && help && !help.hidden) {
        toggleShortcutHelp(false);
        e.preventDefault();
        return;
      }
      if (typing) {
        if (e.key === 'Escape' && t.blur) t.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (gPrefixAt && Date.now() - gPrefixAt < 1500) {
        gPrefixAt = 0;
        const k = e.key.toLowerCase();
        if (k === 'a' || k === 'u') {
          setShowUnreadOnly(k === 'u');
          clickNav('reader');
        } else if (k === 's') clickNav('read_later');
        else if (k === 'r') clickNav('recently_read');
        else if (k === 'd') clickNav('digest');
        else if (k === 'f') openPage('feeds');
        else return;
        e.preventDefault();
        return;
      }
      gPrefixAt = 0;
      if (e.key === 'g') { gPrefixAt = Date.now(); e.preventDefault(); return; }
      if (e.key === '?') { toggleShortcutHelp(); e.preventDefault(); return; }
      if (e.key === '/') {
        if (isMobileSidebar()) { sidebarEl?.classList.add('open'); sidebarOverlay?.classList.add('visible'); }
        feedSearchInput?.focus();
        e.preventDefault();
        return;
      }
      if (e.key === 'R' && e.shiftKey) { btnRefresh?.click(); e.preventDefault(); return; }

      const readerActive = !!document.querySelector('.mockup-view.view-reader.active');
      const expandedCard = document.querySelector('.view-reader .article-card.expanded');
      const nextKeys = ['j', 'n', 'ArrowDown'];
      const prevKeys = ['k', 'p', 'ArrowUp'];
      if (e.key === 'Escape' && expandedCard) {
        expandedCard.classList.remove('expanded', 'is-selected');
        selectedItemId = '';
        e.preventDefault();
        return;
      }
      if (!expandedCard && readerActive && ['j', 'n', 'k', 'p'].includes(e.key)) {
        // Nothing open yet: start at the first visible card; if every group is
        // collapsed (Today's default), open the first group and start there.
        const cards = Array.from(document.querySelectorAll('.view-reader .article-card'));
        let first = cards.find((c) => !c.closest('.feed-group.is-collapsed'));
        if (!first && cards[0]) {
          cards[0].closest('.feed-group')?.querySelector('.feed-group-header-block')?.click();
          first = cards[0];
        }
        if (first) first.click();
        e.preventDefault();
        return;
      }
      if (expandedCard && (nextKeys.includes(e.key) || prevKeys.includes(e.key))) {
        const items = Array.from(document.querySelectorAll('.view-reader .article-card'));
        if (!items.length) return;
        let idx = items.indexOf(expandedCard);
        idx = nextKeys.includes(e.key) ? idx + 1 : idx - 1;
        idx = Math.max(0, Math.min(items.length - 1, idx));
        if (items[idx] && items[idx] !== expandedCard) items[idx].click();
        e.preventDefault();
        return;
      }
      if (expandedCard && (e.key === 'o' || e.key === 'Enter')) {
        const link = expandedCard.querySelector('.read-original');
        if (link?.href && link.href !== '#') window.open(link.href, '_blank');
        e.preventDefault();
        return;
      }
      if (expandedCard && e.key === 'm') {
        const itemId = expandedCard.dataset.itemId;
        if (itemId) {
          readState.toggleRead(itemId);
          pinRead(itemId);
          expandedCard.classList.toggle('is-read', readState.isRead(itemId));
          const btn = expandedCard.querySelector('.btn-read-toggle');
          if (btn) {
            btn.textContent = readState.isRead(itemId) ? '○ Mark unread' : '● Mark read';
            btn.title = readState.isRead(itemId) ? 'Mark unread' : 'Mark read';
          }
          updateUnreadCounts();
        }
        e.preventDefault();
        return;
      }
      if (expandedCard && e.key === 's') {
        expandedCard.querySelector('.btn-save')?.click();
        e.preventDefault();
      }
    });
    themeToggle?.addEventListener('change', (e) => {
      document.body.classList.toggle('theme-light', e.target.checked);
      saveSettings({ ...readSettings(), themeLight: e.target.checked });
    });

    function syncProviderUi() {
      const provider = (aiProviderSelect?.value || 'local');
      const isLocal = provider === 'local';
      if (rowBaseUrl) rowBaseUrl.style.display = isLocal ? '' : 'none';
      if (apiKeyInput) {
        apiKeyInput.placeholder = isLocal ? 'leave empty for local' : 'sk-or-...';
        apiKeyInput.required = !isLocal;
      }
      if (apiKeyLabel) {
        apiKeyLabel.innerHTML = isLocal
          ? 'API key <span class="muted-hint">(optional for local)</span>'
          : 'OpenRouter API key';
      }
      if (isLocal && llmBaseUrlInput && !(llmBaseUrlInput.value || '').trim()) {
        llmBaseUrlInput.value = DEFAULT_LOCAL_BASE_URL;
      }
      if (!isLocal && llmBaseUrlInput) {
        llmBaseUrlInput.value = OPENROUTER_BASE_URL;
      }
    }

    function loadSettingsIntoUI() {
      const s = readSettings();
      if (aiProviderSelect) aiProviderSelect.value = s.provider === 'openrouter' ? 'openrouter' : 'local';
      if (llmBaseUrlInput) {
        llmBaseUrlInput.value = s.baseUrl || (s.provider === 'openrouter' ? OPENROUTER_BASE_URL : DEFAULT_LOCAL_BASE_URL);
      }
      if (apiKeyInput) apiKeyInput.value = s.apiKey || '';
      if (refreshIntervalSelect) refreshIntervalSelect.value = String(s.refreshInterval || 0);
      if (themeToggle) themeToggle.checked = applyTheme(s);
      if (digestPromptInput) digestPromptInput.value = (s.digestPrompt || '').trim() || DEFAULT_DIGEST_PROMPT;
      if (summaryPromptInput) summaryPromptInput.value = (s.summaryPrompt || '').trim() || DEFAULT_SUMMARY_PROMPT;
      const models = Array.isArray(s.modelsCache) ? s.modelsCache : [];
      if (models.length) {
        const fillSelect = (sel, val) => {
          if (!sel) return;
          sel.innerHTML = '<option value="">— Select model —</option>';
          models.forEach((m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name || m.id; sel.appendChild(o); });
          sel.disabled = false;
          if (val && models.some((m) => m.id === val)) sel.value = val;
        };
        fillSelect(modelSelectDigest, s.modelIdDigest || s.modelId);
        fillSelect(modelSelectSummary, s.modelIdSummary || s.modelId);
      }
      applyTheme(s);
      syncProviderUi();
    }
    async function checkModels() {
      const provider = (aiProviderSelect?.value || 'local').trim() || 'local';
      const baseUrl = (llmBaseUrlInput?.value || '').trim() || (provider === 'openrouter' ? OPENROUTER_BASE_URL : DEFAULT_LOCAL_BASE_URL);
      const key = (apiKeyInput?.value || '').trim();
      if (provider === 'openrouter' && !key) {
        if (modelStatus) { modelStatus.textContent = 'Enter OpenRouter API key first'; modelStatus.className = 'model-status error'; }
        return;
      }
      if (modelStatus) { modelStatus.textContent = 'Checking...'; modelStatus.className = 'model-status'; }
      if (btnCheckModels) btnCheckModels.disabled = true;
      try {
        const res = await fetch('/api/llm/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, baseUrl, apiKey: key })
        });
        const data = await res.json();
        if (!res.ok) {
          if (modelStatus) {
            modelStatus.textContent = data.message || data.error || 'Could not list models';
            modelStatus.className = 'model-status error';
          }
          return;
        }
        const models = data.models || [];
        const fillSelect = (sel, val) => {
          if (!sel) return;
          sel.innerHTML = '<option value="">— Select model —</option>';
          models.forEach((m) => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name || m.id; sel.appendChild(o); });
          sel.disabled = false;
          if (val && models.some((m) => m.id === val)) sel.value = val;
        };
        const s = readSettings();
        fillSelect(modelSelectDigest, s.modelIdDigest || s.modelId);
        fillSelect(modelSelectSummary, s.modelIdSummary || s.modelId);
        // Prefer first local model when none selected yet
        if (models.length) {
          if (modelSelectDigest && !modelSelectDigest.value) modelSelectDigest.value = models[0].id;
          if (modelSelectSummary && !modelSelectSummary.value) modelSelectSummary.value = models[0].id;
        }
        saveSettings({
          ...s,
          provider,
          baseUrl,
          apiKey: key,
          modelsCache: models,
          modelIdDigest: modelSelectDigest?.value || s.modelIdDigest || '',
          modelIdSummary: modelSelectSummary?.value || s.modelIdSummary || ''
        });
        if (modelStatus) {
          modelStatus.textContent = 'Done · ' + models.length + ' model' + (models.length === 1 ? '' : 's');
          modelStatus.className = 'model-status success';
        }
      } catch {
        if (modelStatus) { modelStatus.textContent = 'Request failed'; modelStatus.className = 'model-status error'; }
      } finally {
        if (btnCheckModels) btnCheckModels.disabled = false;
      }
    }
    aiProviderSelect?.addEventListener('change', syncProviderUi);
    btnCheckModels?.addEventListener('click', checkModels);
    btnSaveSettings?.addEventListener('click', () => {
      const digestPrompt = (digestPromptInput?.value || '').trim();
      const summaryPrompt = (summaryPromptInput?.value || '').trim();
      const provider = (aiProviderSelect?.value || 'local').trim() || 'local';
      const baseUrl = (llmBaseUrlInput?.value || '').trim() || (provider === 'openrouter' ? OPENROUTER_BASE_URL : DEFAULT_LOCAL_BASE_URL);
      saveSettings({
        ...readSettings(),
        provider,
        baseUrl,
        apiKey: (apiKeyInput?.value || '').trim(),
        modelIdDigest: modelSelectDigest?.value || '',
        modelIdSummary: modelSelectSummary?.value || '',
        digestPrompt: digestPrompt || undefined,
        summaryPrompt: summaryPrompt || undefined,
        refreshInterval: parseInt(refreshIntervalSelect?.value, 10) || 0
      });
      if (refreshIntervalId) clearInterval(refreshIntervalId);
      refreshIntervalId = null;
      const mins = parseInt(readSettings().refreshInterval, 10) || 0;
      if (mins > 0) refreshIntervalId = setInterval(() => fetchAllFeeds().then(renderToday), mins * 60000);
      if (settingsStatus) { settingsStatus.textContent = 'Saved'; settingsStatus.className = 'model-status success'; }
    });
    btnResetDigestPrompt?.addEventListener('click', () => {
      if (digestPromptInput) digestPromptInput.value = DEFAULT_DIGEST_PROMPT;
    });
    btnResetSummaryPrompt?.addEventListener('click', () => {
      if (summaryPromptInput) summaryPromptInput.value = DEFAULT_SUMMARY_PROMPT;
    });

    const addFeedStatus = document.getElementById('add-feed-status');
    const discoverResults = document.getElementById('discover-results');
    function setAddFeedStatus(text, isError) {
      if (!addFeedStatus) return;
      addFeedStatus.textContent = text || '';
      addFeedStatus.classList.toggle('error', !!isError);
    }
    function clearDiscoverResults() {
      if (!discoverResults) return;
      discoverResults.innerHTML = '';
      discoverResults.hidden = true;
    }
    async function addFeedToLibrary(url, title) {
      const lib = readLibrary();
      if (lib.feeds.some((f) => f.url === url)) {
        setAddFeedStatus('Already in your feeds.', true);
        return false;
      }
      const entry = normalizeFeedEntry({ url, title: title || url, category: UNCATEGORIZED_CATEGORY });
      if (!entry) return false;
      lib.feeds.push(entry);
      saveLibrary(lib);
      setImportedFeeds(lib.feeds);
      clearDiscoverResults();
      if (addFeedUrl) addFeedUrl.value = '';
      setAddFeedStatus('Added ' + (title || url) + '.');
      try { setCachedFeedItems(url, await fetchFeed(url, { force: true })); renderToday(); renderSidebar(); } catch {}
      loadFeedHealth().then((ok) => { if (ok) renderFeedsPage(); });
      return true;
    }
    async function discoverAndAdd() {
      let url = (addFeedUrl?.value || '').trim();
      if (url && !/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+/.test(url)) url = 'https://' + url;
      if (!isValidHttpUrl(url)) { setAddFeedStatus('Enter a valid http(s) URL.', true); return; }
      if (readLibrary().feeds.some((f) => f.url === url)) { setAddFeedStatus('Already in your feeds.', true); return; }
      clearDiscoverResults();
      setAddFeedStatus('Looking for a feed…');
      if (btnAddFeed) btnAddFeed.disabled = true;
      let feeds = [];
      try {
        const res = await fetch('/api/discover?url=' + encodeURIComponent(url));
        const data = await res.json().catch(() => ({}));
        feeds = Array.isArray(data.feeds) ? data.feeds.filter((f) => f && isValidHttpUrl(f.url)) : [];
      } catch {
        feeds = [];
      } finally {
        if (btnAddFeed) btnAddFeed.disabled = false;
      }
      if (!feeds.length) { setAddFeedStatus('No RSS or Atom feed found at that address.', true); return; }
      if (feeds.length === 1 && feeds[0].verified !== false) { await addFeedToLibrary(feeds[0].url, feeds[0].title); return; }
      setAddFeedStatus(feeds.length === 1
        ? 'Found a feed link, but it did not load just now. Add it anyway?'
        : 'Found ' + feeds.length + ' feeds. Pick one:');
      if (!discoverResults) return;
      const have = new Set(readLibrary().feeds.map((f) => f.url));
      feeds.forEach((f) => {
        const li = document.createElement('li');
        li.innerHTML =
          '<div class="feeds-list-main"><span class="feeds-list-title">' + escapeHtml(f.title || f.url) + '</span>' +
          '<span class="feeds-list-url">' + escapeHtml(f.url) + '</span>' +
          (f.verified === false ? '<span class="discover-hint">Declared by the page, but did not load just now</span>' : '') +
          '</div>';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = have.has(f.url) ? 'btn-quiet' : 'btn-primary';
        b.textContent = have.has(f.url) ? 'Added' : 'Add';
        b.disabled = have.has(f.url);
        b.onclick = () => addFeedToLibrary(f.url, f.title);
        li.appendChild(b);
        discoverResults.appendChild(li);
      });
      discoverResults.hidden = false;
    }
    btnAddFeed?.addEventListener('click', discoverAndAdd);
    addFeedUrl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); discoverAndAdd(); } });
    opmlImport?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const feeds = parseOpmlFeeds(await file.text());
        const lib = readLibrary();
        const merged = buildLibrary([...feeds, ...lib.feeds], lib.categories);
        saveLibrary(merged);
        setImportedFeeds(merged.feeds);
        await fetchAllFeeds();
        renderToday();
      } catch { alert('Could not import OPML.'); }
      opmlImport.value = '';
    });
    btnImportOpml?.addEventListener('click', () => opmlImport?.click());
    btnExportOpml?.addEventListener('click', () => {
      const lib = readLibrary();
      if (!lib.feeds.length) { alert('Add feeds before exporting.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buildOpmlText(lib)], { type: 'text/x-opml+xml;charset=utf-8' }));
      a.download = 'rss-viewer-' + new Date().toISOString().slice(0, 10) + '.opml';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    btnGenerateDigest?.addEventListener('click', async () => {
      const windowVal = digestWindow?.value || '24h';
      const isUnread = windowVal === 'unread';
      const hours = windowVal === '7d' ? 168 : 24;
      const items = isUnread ? getUnreadItems() : getItemsInWindow(hours);
      const usedN = Math.min(items.length, MAX_DIGEST_ITEMS);
      const titleHtml = isUnread
        ? '<h3>Unread digest — ' +
          usedN +
          (items.length > usedN ? ' of ' + items.length : '') +
          ' item' +
          (usedN === 1 ? '' : 's') +
          '</h3>'
        : '<h3>' + new Date().toLocaleDateString(undefined, { dateStyle: 'long' }) + ' — Digest</h3>';
      await runDigestGeneration({
        items,
        scopeKey: isUnread ? 'unread' : String(hours),
        titleHtml,
        isUnread,
        feedTitle: '',
        targetEl: digestCard,
        generateBtn: btnGenerateDigest
      });
    });

    feedSearchInput?.addEventListener('input', renderSidebar);
    feedMgmtSearch?.addEventListener('input', renderFeedsPage);

    articleCache = readArticleCache();
    feedItemCache = readFeedItemCache();
    readState.cleanupReadArticles && readState.cleanupReadArticles(30, new Set(
      Object.values(feedItemCache).flatMap((items) => items.map((i) => i.id))
    ));
    const lib = readLibrary();
    setImportedFeeds(lib.feeds);
    loadSettingsIntoUI();
    updateReadLaterCount();
    routeReady = true;
    if (location.hash && location.hash !== '#' && location.hash !== '#/') applyRoute();
    const mins = parseInt(readSettings().refreshInterval, 10) || 0;
    if (mins > 0) refreshIntervalId = setInterval(() => fetchAllFeeds().then(renderToday), mins * 60000);
    const afterFetchAll = () => {
      renderToday();
      loadFeedHealth().then((ok) => { if (ok) { renderSidebar(); renderFeedsPage(); } });
    };
    loadFeedHealth().then((ok) => { if (ok) { renderSidebar(); renderFeedsPage(); } });
    if (lib.feeds.length) setTimeout(() => fetchAllFeeds().then(afterFetchAll), 100);
    // The server copy is the source of truth (every edit is PUT there), so a feed
    // list changed on another device or on the server replaces this browser's.
    loadLibraryFromServer().then((remote) => {
      const local = readLibrary();
      if (!remote) {
        if (local.feeds.length) persistLibraryToServer(local);
        return;
      }
      if (JSON.stringify(remote) === JSON.stringify(local)) return;
      try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(remote)); } catch {}
      const keep = new Set(remote.feeds.map((f) => f.url));
      Object.keys(feedItemCache).forEach((url) => { if (!keep.has(url)) delete feedItemCache[url]; });
      saveFeedItemCache(feedItemCache);
      if (selectedSidebarFeedUrl && !keep.has(selectedSidebarFeedUrl)) selectedSidebarFeedUrl = '';
      setImportedFeeds(remote.feeds);
      fetchAllFeeds().then(renderToday);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
