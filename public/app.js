/* RSS Viewer - Today + Digest */
(function () {
  'use strict';

  const LIBRARY_KEY = 'rssViewer.library';
  const FEED_CACHE_KEY = 'rssViewer.feedItemCache';
  const SETTINGS_KEY = 'rssViewer.settings';
  const SUMMARY_CACHE_KEY = 'rssViewer.summaryCache';
  const DIGEST_CACHE_KEY = 'rssViewer.digestCache';
  const MAX_SUMMARY_CACHE = 80;
  const MAX_DIGEST_CACHE = 20;
  const MAX_ITEMS_PER_FEED = 50;
  const PREFETCH_CONCURRENCY = 3;
  const MAX_ARTICLE_CACHE = 40;
  const MAX_ARTICLE_LENGTH = 20000;
  const UNCATEGORIZED_CATEGORY = 'Uncategorized';

  let importedFeeds = [];
  let feedItemCache = {};
  let articleCache = { order: [], entries: {} };
  let selectedItemId = '';
  let selectedItemFeedUrl = '';
  let selectedSidebarFeedUrl = '';
  let refreshIntervalId = null;

  function isValidHttpUrl(v) {
    try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; }
  }
  function safeHref(url) {
    if (!url) return '#';
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
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
  function isContentSufficient(content) {
    const s = (content || '').trim();
    return s.length > 200 && !s.endsWith('...');
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
    try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(buildLibrary(lib.feeds || [], lib.categories || []))); } catch {}
  }

  function normalizeFeedItem(feedUrl, item) {
    if (!item || typeof item !== 'object') return null;
    const title = (item.title || '').trim() || 'Untitled';
    const link = (item.link || '').trim();
    const pubDate = (item.isoDate || item.pubDate || '').toString();
    const summary = stripHtml(item.summary || item.content || item.contentSnippet || '');
    const id = (item.id || item.guid || feedUrl + '|' + link + '|' + title + '|' + pubDate).toString();
    return { id: id.startsWith(feedUrl + '|') ? id : feedUrl + '|' + id, title, link, pubDate, summary, isRead: !!item.isRead };
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
  function updateItemReadState(url, id, read) {
    if (!isValidHttpUrl(url) || !id) return;
    setCachedFeedItems(url, getCachedFeedItems(url).map((i) => (i.id === id ? { ...i, isRead: read } : i)));
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
    const existing = new Map(getCachedFeedItems(url).map((i) => [i.id, { isRead: i.isRead }]));
    return normalizeFeedItemList(url, items).map((i) => ({ ...i, isRead: existing.has(i.id) ? existing.get(i.id).isRead : false }));
  }
  async function fetchFeed(url) {
    const res = await fetch('/api/rss?url=' + encodeURIComponent(url));
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

  const DEFAULT_SUMMARY_PROMPT = `Summarize this article in 2-4 concise sentences. TL;DR style.

{{ARTICLE}}`;

  function readSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (s.modelId && !s.modelIdDigest && !s.modelIdSummary) {
        s.modelIdDigest = s.modelId;
        s.modelIdSummary = s.modelId;
      }
      return s;
    } catch { return {}; }
  }
  function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} }
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
  function digestCacheKey(hours, items) {
    let h = 0;
    const s = items.map((i) => i.id).sort().join('|');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return hours + '-' + h;
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

  function init() {
    const appShell = document.getElementById('app-shell');
    const sidebarGroups = document.getElementById('sidebar-groups');
    const feedCountEl = document.getElementById('feed-count');
    const feedBadgeEl = document.getElementById('feed-badge');
    const sidebarMetricEl = document.getElementById('sidebar-metric');
    const feedSearchInput = document.getElementById('feed-search-input');
    const todayContent = document.getElementById('today-content');
    const expandAllCategories = document.getElementById('expand-all-categories');
    const collapseAllCategories = document.getElementById('collapse-all-categories');
    const refreshWrap = document.getElementById('refresh-progress-wrap');
    const refreshBar = document.getElementById('refresh-progress-bar');
    const btnRefresh = document.getElementById('btn-refresh');
    const themeToggle = document.getElementById('theme-toggle');
    const apiKeyInput = document.getElementById('api-key');
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
    const digestPromptInput = document.getElementById('digest-prompt');
    const btnResetDigestPrompt = document.getElementById('btn-reset-digest-prompt');
    const btnSaveDigestPrompt = document.getElementById('btn-save-digest-prompt');
    const summaryPromptInput = document.getElementById('summary-prompt');
    const btnResetSummaryPrompt = document.getElementById('btn-reset-summary-prompt');

    function setImportedFeeds(feeds) {
      importedFeeds = dedupeFeeds(feeds);
      const n = importedFeeds.length;
      if (feedBadgeEl) feedBadgeEl.textContent = n + ' feed' + (n === 1 ? '' : 's');
      if (feedCountEl) feedCountEl.textContent = n + ' feed' + (n === 1 ? '' : 's');
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
      sidebarGroups.innerHTML = '';
      g.forEach((feeds, cat) => {
        const sec = document.createElement('section');
        sec.className = 'sidebar-group';
        sec.innerHTML = '<h3 class="sidebar-category-header"><span class="sidebar-category-name">' + escapeHtml(cat) + '</span></h3>';
        const ul = document.createElement('ul');
        ul.className = 'sidebar-feed-list';
        feeds.forEach((f) => {
          const li = document.createElement('li');
          li.className = 'sidebar-feed-row';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'sidebar-feed' + (f.url === selectedSidebarFeedUrl ? ' is-active' : '');
          btn.dataset.url = f.url;
          const count = getCachedFeedItems(f.url).length;
          btn.innerHTML = '<span class="sidebar-feed-name">' + escapeHtml(f.title) + '</span><span class="sidebar-count">' + count + '</span>';
          btn.onclick = async () => {
            selectedItemFeedUrl = '';
            selectedItemId = '';
            selectedSidebarFeedUrl = f.url;
            const url = f.url;
            try {
              setCachedFeedItems(url, await fetchFeed(url));
            } catch {}
            document.querySelectorAll('.mockup-view').forEach((x) => x.classList.remove('active'));
            document.querySelector('.mockup-view[data-tab="reader"]')?.classList.add('active');
            document.querySelectorAll('.sidebar-nav-item').forEach((x) => x.classList.remove('is-active'));
            document.querySelector('.sidebar-nav-item[data-view="reader"]')?.classList.add('is-active');
            renderToday();
            renderSidebar();
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
      li.className = 'item article-card' + (item.isRead ? ' is-read' : '') + (item.id === selectedItemId ? ' is-selected expanded' : '');
      li.dataset.itemId = item.id;
      li.dataset.feedUrl = feedUrl;
      const relTime = formatRelativeTime(item.pubDate);
      const readTime = estimateReadTime(item.summary || item.title);
      const words = wordCount(item.summary || item.title);
      const readOriginalHref = safeHref(item.link);
      const domain = domainFromUrl(item.link);
      li.innerHTML =
        '<div class="article-card-header">' +
        '<div class="item-meta-row"><span class="item-source-badge">' + escapeHtml(feedTitle) + '</span><span class="item-metrics"><span>' + escapeHtml(relTime) + '</span><span>' + escapeHtml(readTime) + '</span><span>~' + words + ' words</span></span></div>' +
        '<h2 class="item-title"><a href="' + readOriginalHref + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.title || 'Untitled') + '</a></h2>' +
        '<p class="item-snippet">' + escapeHtml(truncateText(item.summary, 120)) + '</p>' +
        '</div>' +
        '<div class="article-expanded">' +
        '<div class="article-expanded-inner">' +
        '<div class="article-toolbar">' +
        '<div class="toolbar-left">' +
        '<button type="button" class="toolbar-btn primary btn-summarize">Summarize <span class="ai-badge">AI</span></button>' +
        '<button type="button" class="toolbar-btn btn-save">Save</button>' +
        '<button type="button" class="toolbar-btn btn-more">More</button>' +
        '</div>' +
        '<div class="toolbar-right">' +
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

      function loadBody() {
        if (isContentSufficient(item.content)) {
          setArticleBody(bodyEl, item.content);
          return;
        }
        loadArticle(item)
          .then((t) => {
            bodyEl.innerHTML = '';
            bodyEl.classList.remove('article-body-skeleton');
            setArticleBody(bodyEl, t);
          })
          .catch(() => {
            bodyEl.innerHTML = '';
            bodyEl.classList.remove('article-body-skeleton');
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

      li.querySelector('.btn-save').onclick = (ev) => { ev.stopPropagation(); };
      li.querySelector('.btn-more').onclick = (ev) => { ev.stopPropagation(); };
      btnOpen.onclick = (ev) => {
        ev.stopPropagation();
        const u = safeHref(item.link);
        if (u !== '#') window.open(u, '_blank');
      };

      btnSum.onclick = async (ev) => {
        ev.stopPropagation();
        summaryBlock.classList.remove('is-hidden');
        const s = readSettings();
        const apiKey = (s.apiKey || apiKeyInput?.value || '').trim();
        const modelId = s.modelIdSummary || modelSelectSummary?.value || '';
        if (!apiKey || !modelId) {
          summaryTextEl.textContent = 'Configure API key and Summary model in Settings, then Save.';
          summaryTextEl.classList.add('error');
          return;
        }
        const text = (bodyEl.innerText || bodyEl.textContent || '').trim();
        if (!text || text === 'No content available.') {
          summaryTextEl.textContent = 'No article content to summarize.';
          return;
        }
        summaryTextEl.classList.remove('error');
        summaryTextEl.textContent = 'Summarizing…';
        btnSum.disabled = true;
        try {
          const truncated = text.length > 12000 ? text.slice(0, 12000) + '\n\n[Article truncated…]' : text;
          const promptTpl = getSummaryPrompt();
          const prompt = promptTpl.includes('{{ARTICLE}}') ? promptTpl.replace('{{ARTICLE}}', truncated) : promptTpl + '\n\n' + truncated;
          const res = await fetch('/api/openrouter/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey, modelId, messages: [{ role: 'user', content: prompt }] }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            summaryTextEl.textContent = data.message || data.error || 'Request failed.';
            summaryTextEl.classList.add('error');
            return;
          }
          const result = (data.content || '').trim() || 'No summary returned.';
          summaryTextEl.textContent = result;
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
          updateItemReadState(feedUrl, item.id, true);
          let exp = li.querySelector('.article-expanded');
          if (exp && !exp.dataset.loaded) {
            exp.dataset.loaded = '1';
            loadBody();
          }
          setTimeout(() => li.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
        } else {
          selectedItemId = '';
        }
      };

      const cachedSummary = getCachedSummary(item.id);
      if (cachedSummary) {
        summaryBlock.classList.remove('is-hidden');
        summaryTextEl.textContent = cachedSummary;
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
    function renderToday() {
      if (!todayContent) return;
      todayContent.innerHTML = '';
      let collapsed = getCollapsedCategories();
      // Default to all collapsed when user has no saved preference
      if (selectedSidebarFeedUrl) {
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
      function addGroup(title, items, feedUrl, feedTitle) {
        const g = document.createElement('div');
        g.className = 'feed-group' + (collapsed.has(title) ? ' is-collapsed' : '');
        g.dataset.category = title;
        const h3 = document.createElement('h3');
        h3.className = 'feed-group-title';
        h3.innerHTML = '<span class="category-chevron" aria-hidden="true">▼</span><span class="category-name">' + escapeHtml(title) + '</span>';
        h3.onclick = () => {
          g.classList.toggle('is-collapsed');
          const next = new Set(collapsed);
          if (g.classList.contains('is-collapsed')) next.add(title); else next.delete(title);
          setCollapsedCategories(next);
        };
        g.appendChild(h3);
        const feedCount = new Set(items.map((i) => i.feedUrl || feedUrl)).size;
        const unreadCount = items.filter((i) => !i.isRead).length;
        const summaryEl = document.createElement('div');
        summaryEl.className = 'feed-group-collapsed-summary';
        const metricsLine = items.length + ' item' + (items.length === 1 ? '' : 's') + (feedCount > 1 ? ' · ' + feedCount + ' feeds' : '') + (unreadCount ? ' · ' + unreadCount + ' unread' : '');
        const latestTitles = items.slice(0, 3).map((i) => '"' + truncateText(i.title || '', 48) + '"').join(' · ');
        summaryEl.innerHTML = '<div class="feed-group-collapsed-metrics">' + escapeHtml(metricsLine) + '</div><div class="feed-group-collapsed-latest">Latest: ' + escapeHtml(latestTitles) + '</div>';
        g.appendChild(summaryEl);
        const detailEl = document.createElement('div');
        detailEl.className = 'feed-group-detail';
        detailEl.textContent = items.length + ' item' + (items.length === 1 ? '' : 's') + (feedCount > 1 ? ' · ' + feedCount + ' feeds' : '');
        g.appendChild(detailEl);
        const ul = document.createElement('ul');
        ul.className = 'results';
        items.forEach((i) => ul.appendChild(createItemEl(i, i.feedUrl ?? feedUrl, i.feedTitle ?? feedTitle)));
        g.appendChild(ul);
        todayContent.appendChild(g);
      }
      if (selectedSidebarFeedUrl) {
        const feed = importedFeeds.find((f) => f.url === selectedSidebarFeedUrl);
        const items = getCachedFeedItems(selectedSidebarFeedUrl)
          .map((i) => ({ ...i, feedUrl: selectedSidebarFeedUrl, feedTitle: feed ? feed.title : selectedSidebarFeedUrl }))
          .sort((a, b) => (b.pubDate ? Date.parse(b.pubDate) : 0) - (a.pubDate ? Date.parse(a.pubDate) : 0));
        if (!items.length) {
          todayContent.innerHTML = '<p class="empty-hint">No items in this feed yet. Try refreshing.</p>';
          return;
        }
        const title = feed ? feed.title : 'Feed';
        addGroup(title, items, selectedSidebarFeedUrl, title);
        return;
      }
      const grouped = getAllItemsGrouped();
      if (!grouped.length) {
        todayContent.innerHTML = '<p class="empty-hint">Import OPML or add feeds to see items here.</p>';
        return;
      }
      grouped.forEach(({ category, items }) => {
        const feedTitle = items[0]?.feedTitle || category;
        const feedUrl = items[0]?.feedUrl || '';
        addGroup(category, items, feedUrl, feedTitle);
      });
    }
    function renderFeedsPage() {
      if (!feedsList || !feedsSummary) return;
      const q = (feedMgmtSearch?.value || '').trim().toLowerCase();
      const filtered = filterFeeds(q);
      feedsSummary.textContent = filtered.length ? filtered.length + ' feed' + (filtered.length === 1 ? '' : 's') + '.' : 'No feeds yet.';
      feedsList.innerHTML = '';
      filtered.forEach((f) => {
        const li = document.createElement('li');
        li.innerHTML = '<span>' + escapeHtml(f.title) + '</span><span style="font-size:0.8rem;color:var(--muted)">' + escapeHtml(f.category) + '</span>';
        feedsList.appendChild(li);
      });
    }
    document.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input')) return;
      const sel = document.querySelector('.view-reader .article-card.expanded');
      if (!sel || e.target.closest('.article-card') === sel) return;
      sel.classList.remove('expanded', 'is-selected');
      selectedItemId = '';
    });

    document.querySelectorAll('.sidebar-nav-item').forEach((item) => {
      item.onclick = () => {
        const v = item.dataset.view;
        if (v !== 'reader' && v !== 'digest') return;
        if (v === 'reader') selectedSidebarFeedUrl = '';
        document.querySelectorAll('.mockup-view').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.sidebar-nav-item').forEach((x) => x.classList.remove('is-active'));
        const view = document.querySelector('.mockup-view[data-tab="' + v + '"]');
        if (view) view.classList.add('active');
        item.classList.add('is-active');
        renderToday();
        renderSidebar();
      };
    });
    document.querySelectorAll('.page-nav a[data-page]').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        const p = a.dataset.page;
        document.querySelectorAll('.mockup-view').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.sidebar-nav-item').forEach((x) => x.classList.remove('is-active'));
        const view = document.querySelector('.mockup-view[data-tab="' + p + '"]');
        if (view) view.classList.add('active');
      };
    });
    document.getElementById('sidebar-toggle-btn')?.addEventListener('click', () => appShell?.classList.add('sidebar-collapsed'));
    document.getElementById('sidebar-show-btn')?.addEventListener('click', () => appShell?.classList.remove('sidebar-collapsed'));

    expandAllCategories?.addEventListener('click', (e) => {
      e.preventDefault();
      setCollapsedCategories(new Set());
      renderToday();
    });
    collapseAllCategories?.addEventListener('click', (e) => {
      e.preventDefault();
      const groups = todayContent?.querySelectorAll('.feed-group[data-category]') ?? [];
      const names = [...groups].map((g) => g.dataset.category).filter(Boolean);
      setCollapsedCategories(new Set(names));
      renderToday();
    });

    btnRefresh?.addEventListener('click', async () => {
      if (!refreshWrap || !refreshBar) return;
      refreshWrap.style.display = 'block';
      refreshBar.style.width = '0%';
      await fetchAllFeeds((done, total) => { refreshBar.style.width = (done / total) * 100 + '%'; });
      refreshWrap.style.display = 'none';
      renderToday();
      renderSidebar();
    });
    document.addEventListener('keydown', (e) => {
      const expandedCard = document.querySelector('.view-reader .article-card.expanded');
      if (e.key === 'Escape' && expandedCard) {
        expandedCard.classList.remove('expanded', 'is-selected');
        selectedItemId = '';
        e.preventDefault();
        return;
      }
      if (expandedCard && ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        const items = document.querySelectorAll('.view-reader .article-card');
        if (!items.length) return;
        let idx = Array.from(items).indexOf(expandedCard);
        idx = (e.key === 'j' || e.key === 'ArrowDown') ? idx + 1 : idx - 1;
        idx = Math.max(0, Math.min(items.length - 1, idx));
        if (items[idx]) items[idx].click();
        e.preventDefault();
        return;
      }
      if (expandedCard && (e.key === 'o' || e.key === 'Enter')) {
        const link = expandedCard.querySelector('.read-original');
        if (link?.href && link.href !== '#') window.open(link.href, '_blank');
        e.preventDefault();
        return;
      }
      if (expandedCard && (e.key === 'm' || e.key === 's')) {
        e.preventDefault();
      }
    });
    themeToggle?.addEventListener('change', (e) => {
      document.body.classList.toggle('theme-light', e.target.checked);
      saveSettings({ ...readSettings(), themeLight: e.target.checked });
    });

    function loadSettingsIntoUI() {
      const s = readSettings();
      if (apiKeyInput) apiKeyInput.value = s.apiKey || '';
      if (refreshIntervalSelect) refreshIntervalSelect.value = String(s.refreshInterval || 0);
      if (themeToggle) themeToggle.checked = !!s.themeLight;
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
      document.body.classList.toggle('theme-light', !!s.themeLight);
    }
    async function checkModels() {
      const key = (apiKeyInput?.value || '').trim();
      if (!key) { if (modelStatus) { modelStatus.textContent = 'Enter API key first'; modelStatus.className = 'model-status error'; } return; }
      if (modelStatus) { modelStatus.textContent = 'Checking...'; modelStatus.className = 'model-status'; }
      if (btnCheckModels) btnCheckModels.disabled = true;
      try {
        const res = await fetch('/api/openrouter/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) });
        const data = await res.json();
        if (!res.ok) { if (modelStatus) { modelStatus.textContent = data.message || 'Invalid API key'; modelStatus.className = 'model-status error'; } return; }
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
        saveSettings({ ...s, modelsCache: models });
        if (modelStatus) { modelStatus.textContent = 'Done'; modelStatus.className = 'model-status success'; }
      } catch { if (modelStatus) { modelStatus.textContent = 'Request failed'; modelStatus.className = 'model-status error'; } }
      finally { if (btnCheckModels) btnCheckModels.disabled = false; }
    }
    btnCheckModels?.addEventListener('click', checkModels);
    btnSaveSettings?.addEventListener('click', () => {
      const digestPrompt = (digestPromptInput?.value || '').trim();
      const summaryPrompt = (summaryPromptInput?.value || '').trim();
      saveSettings({
        ...readSettings(),
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

    btnAddFeed?.addEventListener('click', async () => {
      const url = (addFeedUrl?.value || '').trim();
      if (!isValidHttpUrl(url)) return;
      const lib = readLibrary();
      if (lib.feeds.some((f) => f.url === url)) return;
      const entry = normalizeFeedEntry({ url, title: url, category: UNCATEGORIZED_CATEGORY });
      if (!entry) return;
      lib.feeds.push(entry);
      saveLibrary(lib);
      setImportedFeeds(lib.feeds);
      addFeedUrl.value = '';
      try { setCachedFeedItems(url, await fetchFeed(url)); renderToday(); } catch {}
    });
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
      const s = readSettings();
      const apiKey = (s.apiKey || apiKeyInput?.value || '').trim();
      const modelId = s.modelIdDigest || modelSelectDigest?.value || '';
      if (!apiKey || !modelId) { if (digestCard) digestCard.innerHTML = '<p class="digest-placeholder error">Configure API key and model in Settings, then Save.</p>'; return; }
      const hours = (digestWindow?.value || '24h') === '7d' ? 168 : 24;
      const items = getItemsInWindow(hours);
      if (!items.length) { if (digestCard) digestCard.innerHTML = '<p class="digest-placeholder">No items in this time window. Refresh feeds first.</p>'; return; }
      const cacheKey = digestCacheKey(hours, items);
      const cached = getCachedDigest(cacheKey);
      if (cached) { if (digestCard) digestCard.innerHTML = cached; return; }
      if (digestCard) digestCard.innerHTML = '<p class="digest-placeholder">Generating digest…</p>';
      if (btnGenerateDigest) btnGenerateDigest.disabled = true;
      const refs = [];
      const lines = items.slice(0, 50).map((i, idx) => { refs.push({ title: i.feedTitle, link: i.link }); return '[' + (idx + 1) + '] ' + i.title + ' (' + i.feedTitle + ')\n   ' + truncateText(i.summary, 150); });
      const promptTemplate = getDigestPrompt();
      const itemsBlock = lines.join('\n\n');
      const prompt = promptTemplate.includes('{{ITEMS}}') ? promptTemplate.replace('{{ITEMS}}', itemsBlock) : promptTemplate + '\n\nItems:\n' + itemsBlock;
      try {
        const res = await fetch('/api/openrouter/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey, modelId, messages: [{ role: 'user', content: prompt }] }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { digestCard.innerHTML = '<p class="digest-placeholder error">' + (data.message || 'Request failed') + '</p>'; return; }
        const bodyHtml = formatDigestOutput(data.content || '', refs);
        const refsHtml = refs.length ? '<div class="digest-refs"><strong>References:</strong> ' + refs.map((r, i) => '<a href="' + safeHref(r.link) + '" target="_blank" rel="noopener">[' + (i + 1) + '] ' + escapeHtml(r.title) + '</a>').join(' ') + '</div>' : '';
        const fullHtml = '<h3>' + new Date().toLocaleDateString(undefined, { dateStyle: 'long' }) + ' — Digest</h3><div class="digest-body">' + bodyHtml + '</div>' + refsHtml;
        digestCard.innerHTML = fullHtml;
        setCachedDigest(cacheKey, fullHtml);
      } catch { digestCard.innerHTML = '<p class="digest-placeholder error">Network error.</p>'; }
      finally { if (btnGenerateDigest) btnGenerateDigest.disabled = false; }
    });

    feedSearchInput?.addEventListener('input', renderSidebar);
    feedMgmtSearch?.addEventListener('input', renderFeedsPage);

    articleCache = readArticleCache();
    feedItemCache = readFeedItemCache();
    const lib = readLibrary();
    setImportedFeeds(lib.feeds);
    loadSettingsIntoUI();
    const mins = parseInt(readSettings().refreshInterval, 10) || 0;
    if (mins > 0) refreshIntervalId = setInterval(() => fetchAllFeeds().then(renderToday), mins * 60000);
    if (lib.feeds.length) setTimeout(() => fetchAllFeeds().then(renderToday), 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
