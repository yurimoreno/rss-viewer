const form = document.getElementById('feed-form');
const urlInput = document.getElementById('feed-url');
const loadButton = document.getElementById('load-feed');
const opmlInput = document.getElementById('opml-file');
const opmlExportButton = document.getElementById('opml-export');
const statusBanner = document.getElementById('status');
const resultsList = document.getElementById('results');
const recentFeedsList = document.getElementById('recent-feeds');
const recentFeedsEmpty = document.getElementById('recent-feeds-empty');
const searchInput = document.getElementById('item-search');
const sidebarGroups = document.getElementById('sidebar-groups');
const feedView = document.getElementById('feed-view');
const savedView = document.getElementById('saved-view');
const savedResultsList = document.getElementById('saved-results');
const savedEmpty = document.getElementById('saved-empty');
const savedViewToggle = document.getElementById('saved-view-toggle');
const feedViewToggle = document.getElementById('feed-view-toggle');
const sidebar = document.getElementById('feed-sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const readerEmpty = document.getElementById('reader-empty');
const readerArticle = document.getElementById('reader-article');
const readerSource = document.getElementById('reader-source');
const readerTitle = document.getElementById('reader-title');
const readerDate = document.getElementById('reader-date');
const readerOpen = document.getElementById('reader-open');
const readerContent = document.getElementById('reader-content');
const smallScreenMediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 640px)')
  : { matches: false };

const RECENT_FEEDS_KEY = 'rssViewer.recentFeeds';
const LIBRARY_KEY = 'rssViewer.library';
const FEED_CACHE_KEY = 'rssViewer.feedItemCache';
const CATEGORY_STATE_KEY = 'rssViewer.categoryState';
const ARTICLE_CACHE_KEY = 'rssViewer.articleCache';
const MAX_RECENT_FEEDS = 5;
const MAX_ITEMS_PER_FEED = 50;
const PREFETCH_CONCURRENCY = 3;
const MAX_ARTICLE_CACHE = 40;
const MAX_ARTICLE_LENGTH = 20000;
const UNCATEGORIZED_CATEGORY = 'Uncategorized';
let recentFeeds = [];
let importedFeeds = [];
let selectedSidebarFeedUrl = '';
let selectedFeedUrl = '';
let feedItemCache = {};
const feedUnreadCounts = new Map();
let currentView = 'feed';
let currentSearchQuery = '';
let selectedItemId = '';
let selectedItemFeedUrl = '';
let currentVisibleItems = [];
let currentListElement = resultsList;
let categoryState = {};
let dragState = null;
let articleCache = { order: [], entries: {} };
let readerRequestId = 0;

function setStatus(message, kind = 'idle') {
  statusBanner.classList.remove('loading', 'error');
  statusBanner.textContent = '';

  if (kind === 'loading') {
    statusBanner.classList.add('loading');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = message;
    statusBanner.append(spinner, label);
    return;
  }

  if (kind === 'error') {
    statusBanner.classList.add('error');
  }

  statusBanner.textContent = message;
}

function clearResults() {
  resultsList.innerHTML = '';
}

function stripHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const temp = document.createElement('div');
  temp.innerHTML = value;
  return (temp.textContent || '').trim();
}

function truncateText(value, maxLength = 240) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength).trimEnd()}...`;
}

function normalizeArticleText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX_ARTICLE_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_ARTICLE_LENGTH).trimEnd()}...`;
}

function formatDate(rawDate) {
  if (!rawDate) {
    return 'Unknown date';
  }

  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown date';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(parsed);
}

function getFeedLabel(feedUrl) {
  const matchedFeed = importedFeeds.find((feed) => feed.url === feedUrl);
  return matchedFeed ? matchedFeed.title : feedUrl;
}

function createItemElement(feedUrl, item, { includeFeedLabel = false } = {}) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.itemId = item.id;
  li.dataset.feedUrl = feedUrl;
  if (item.isRead) {
    li.classList.add('is-read');
  }
  if (selectedItemId === item.id && selectedItemFeedUrl === feedUrl) {
    li.classList.add('is-selected');
  }

  const title = item.title || 'Untitled item';
  const itemLink = typeof item.link === 'string' ? item.link : '';
  const pubDate = formatDate(item.pubDate);
  const summarySource = item.summary || '';
  const summary = stripHtml(summarySource) || 'No summary available.';
  const summaryPreview = truncateText(summary);
  const feedLabel = getFeedLabel(feedUrl);

  const heading = document.createElement('h2');
  const link = document.createElement('a');
  link.textContent = title;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.href = itemLink || '#';
  if (itemLink) {
    link.addEventListener('click', () => {
      updateItemReadState(feedUrl, item.id, true);
      rerenderSelectedFeed();
    });
  }
  if (!itemLink) {
    link.removeAttribute('target');
    link.removeAttribute('rel');
  }
  heading.appendChild(link);

  const row = document.createElement('div');
  row.className = 'item-row';

  const icon = document.createElement('span');
  icon.className = 'item-icon';

  const source = document.createElement('span');
  source.className = 'item-source';
  source.textContent = feedLabel;

  const time = document.createElement('span');
  time.className = 'item-time';
  time.textContent = pubDate;

  row.append(icon, source, heading, time);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = includeFeedLabel ? `${feedLabel} • ${pubDate}` : pubDate;

  const readToggle = document.createElement('button');
  readToggle.type = 'button';
  readToggle.className = 'item-read-toggle';
  readToggle.textContent = item.isRead ? 'Mark unread' : 'Mark read';
  readToggle.addEventListener('click', () => {
    updateItemReadState(feedUrl, item.id, !item.isRead);
    rerenderSelectedFeed();
  });

  const saveToggle = document.createElement('button');
  saveToggle.type = 'button';
  saveToggle.className = 'item-save-toggle';
  saveToggle.textContent = item.isSaved ? 'Unsave' : 'Save';
  saveToggle.addEventListener('click', () => {
    updateItemSavedState(feedUrl, item.id, !item.isSaved);
    rerenderSelectedFeed();
  });

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  actions.append(readToggle, saveToggle);

  const summaryText = document.createElement('p');
  summaryText.textContent = summaryPreview;

  li.append(row, meta, actions, summaryText);
  li.addEventListener('click', (event) => {
    const target = event.target;
    if (target && (target.tagName === 'BUTTON' || target.tagName === 'A')) {
      return;
    }
    setSelectedItem(feedUrl, item.id);
  });
  return li;
}

function updateReaderView(item, feedUrl) {
  if (!readerArticle || !readerEmpty || !readerTitle || !readerDate || !readerContent || !readerSource) {
    return;
  }

  if (!item || !feedUrl) {
    readerArticle.classList.add('is-hidden');
    readerEmpty.classList.remove('is-hidden');
    return;
  }

  readerTitle.textContent = item.title || 'Untitled item';
  readerSource.textContent = getFeedLabel(feedUrl);
  readerDate.textContent = formatDate(item.pubDate);
  const bodyText = stripHtml(item.summary || item.content || item.contentSnippet || item.description || '');
  readerContent.textContent = bodyText || 'No content available.';
  readerContent.removeAttribute('data-state');

  if (readerOpen) {
    if (item.link) {
      readerOpen.href = item.link;
      readerOpen.classList.remove('is-hidden');
    } else {
      readerOpen.href = '#';
      readerOpen.classList.add('is-hidden');
    }
  }

  readerEmpty.classList.add('is-hidden');
  readerArticle.classList.remove('is-hidden');
}

function getVisibleItemsForCurrentView() {
  if (currentView === 'saved') {
    return getSavedItems();
  }

  if (currentSearchQuery.length > 0) {
    return getSearchResults(currentSearchQuery);
  }

  if (selectedFeedUrl) {
    return getCachedFeedItems(selectedFeedUrl).map((item) => ({ ...item, feedUrl: selectedFeedUrl }));
  }

  return [];
}

function setSelectedItem(feedUrl, itemId, { scroll = false } = {}) {
  if (!feedUrl || !itemId) {
    selectedItemId = '';
    selectedItemFeedUrl = '';
    updateReaderView(null, '');
    syncSelectedListItems();
    return;
  }

  selectedItemId = itemId;
  selectedItemFeedUrl = feedUrl;
  const item = currentVisibleItems.find((entry) => entry.id === itemId && entry.feedUrl === feedUrl)
    || getCachedFeedItems(feedUrl).find((entry) => entry.id === itemId);
  updateReaderView(item || null, feedUrl);
  if (item) {
    void loadFullArticle(item);
  }
  syncSelectedListItems();

  if (scroll && currentListElement && currentListElement.children) {
    const children = Array.from(currentListElement.children);
    const selectedElement = children.find((child) => (
      child && child.dataset && child.dataset.itemId === itemId && child.dataset.feedUrl === feedUrl
    ));
    if (selectedElement && typeof selectedElement.scrollIntoView === 'function') {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }
}

function getCachedArticle(url) {
  if (!url || !articleCache || !articleCache.entries) {
    return '';
  }
  return typeof articleCache.entries[url] === 'string' ? articleCache.entries[url] : '';
}

function setCachedArticle(url, content) {
  if (!url || typeof content !== 'string') {
    return;
  }

  const normalized = normalizeArticleText(content);
  if (!normalized) {
    return;
  }

  const order = Array.isArray(articleCache.order) ? [...articleCache.order] : [];
  const entries = articleCache.entries && typeof articleCache.entries === 'object'
    ? { ...articleCache.entries }
    : {};

  const existingIndex = order.indexOf(url);
  if (existingIndex !== -1) {
    order.splice(existingIndex, 1);
  }
  order.push(url);
  entries[url] = normalized;

  while (order.length > MAX_ARTICLE_CACHE) {
    const oldest = order.shift();
    if (oldest && entries[oldest]) {
      delete entries[oldest];
    }
  }

  articleCache = { order, entries };
  saveArticleCache(articleCache);
}

async function loadFullArticle(item) {
  if (!item || !item.link || !readerContent) {
    return;
  }

  const cached = getCachedArticle(item.link);
  const requestId = readerRequestId + 1;
  readerRequestId = requestId;

  if (cached) {
    if (selectedItemId === item.id) {
      readerContent.textContent = cached;
      readerContent.removeAttribute('data-state');
    }
    return;
  }

  readerContent.setAttribute('data-state', 'loading');
  readerContent.textContent = 'Loading full article...';

  try {
    const response = await fetch(`/api/article?url=${encodeURIComponent(item.link)}`);
    if (!response.ok) {
      throw new Error('fetch_failed');
    }

    const data = await response.json();
    const content = normalizeArticleText(data && data.content ? data.content : '');
    if (!content) {
      throw new Error('empty_content');
    }

    setCachedArticle(item.link, content);
    if (selectedItemId === item.id && readerRequestId === requestId) {
      readerContent.textContent = content;
      readerContent.removeAttribute('data-state');
    }
  } catch {
    if (selectedItemId === item.id && readerRequestId === requestId) {
      readerContent.removeAttribute('data-state');
    }
  }
}

function syncSelectedListItems() {
  if (!currentListElement || !currentListElement.children) {
    return;
  }

  Array.from(currentListElement.children).forEach((child) => {
    if (!child || !child.classList || !child.dataset) {
      return;
    }
    const isSelected = child.dataset.itemId === selectedItemId && child.dataset.feedUrl === selectedItemFeedUrl;
    if (typeof child.classList.toggle === 'function') {
      child.classList.toggle('is-selected', isSelected);
    } else if (isSelected) {
      child.classList.add('is-selected');
    } else {
      child.classList.remove('is-selected');
    }
  });
}

function ensureSelectionAfterRender(items) {
  if (items.length === 0) {
    setSelectedItem('', '');
    return;
  }

  const stillVisible = items.some((item) => item.id === selectedItemId && item.feedUrl === selectedItemFeedUrl);
  if (!stillVisible) {
    const next = items[0];
    setSelectedItem(next.feedUrl, next.id);
    return;
  }

  setSelectedItem(selectedItemFeedUrl, selectedItemId);
}

function getSelectedVisibleItem() {
  return currentVisibleItems.find((item) => item.id === selectedItemId && item.feedUrl === selectedItemFeedUrl) || null;
}

function moveSelection(delta) {
  if (currentVisibleItems.length === 0) {
    return;
  }

  const currentIndex = currentVisibleItems.findIndex(
    (item) => item.id === selectedItemId && item.feedUrl === selectedItemFeedUrl
  );
  const nextIndex = currentIndex === -1
    ? 0
    : Math.min(currentVisibleItems.length - 1, Math.max(0, currentIndex + delta));
  const nextItem = currentVisibleItems[nextIndex];
  if (nextItem) {
    setSelectedItem(nextItem.feedUrl, nextItem.id, { scroll: true });
  }
}

function toggleSelectedSavedState() {
  const item = getSelectedVisibleItem();
  if (!item) {
    return;
  }

  updateItemSavedState(item.feedUrl, item.id, !item.isSaved);
  if (currentView === 'saved') {
    renderSavedItems();
  } else {
    rerenderSelectedFeed();
  }
}

function toggleSelectedReadState() {
  const item = getSelectedVisibleItem();
  if (!item) {
    return;
  }

  updateItemReadState(item.feedUrl, item.id, !item.isRead);
  if (currentView === 'saved') {
    renderSavedItems();
  } else {
    rerenderSelectedFeed();
  }
}

function openSelectedItem() {
  const item = getSelectedVisibleItem();
  if (!item || !item.link) {
    return;
  }

  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(item.link, '_blank', 'noopener,noreferrer');
  }
}

function isEditableTarget(target) {
  if (!target || typeof target.tagName !== 'string') {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  return Boolean(target.isContentEditable);
}

function renderItems(feedUrl, items) {
  currentListElement = resultsList;
  currentVisibleItems = items.map((item) => ({ ...item, feedUrl }));
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    fragment.appendChild(createItemElement(feedUrl, item));
  });
  clearResults();
  resultsList.appendChild(fragment);
  ensureSelectionAfterRender(currentVisibleItems);
}

function getAllCachedItems() {
  const allItems = [];

  Object.entries(feedItemCache).forEach(([feedUrl, items]) => {
    items.forEach((item) => {
      allItems.push({ ...item, feedUrl });
    });
  });

  return allItems;
}

function getSearchResults(query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const results = getAllCachedItems().filter((item) => {
    const title = typeof item.title === 'string' ? item.title.toLowerCase() : '';
    const summary = typeof item.summary === 'string' ? item.summary.toLowerCase() : '';
    return title.includes(normalizedQuery) || summary.includes(normalizedQuery);
  });

  results.sort((a, b) => {
    const aTime = a.pubDate ? Date.parse(a.pubDate) : 0;
    const bTime = b.pubDate ? Date.parse(b.pubDate) : 0;
    return bTime - aTime;
  });

  return results;
}

function renderSearchResults() {
  const results = getSearchResults(currentSearchQuery);
  currentListElement = resultsList;
  currentVisibleItems = results;
  const fragment = document.createDocumentFragment();

  results.forEach((item) => {
    fragment.appendChild(createItemElement(item.feedUrl, item, { includeFeedLabel: true }));
  });

  clearResults();
  resultsList.appendChild(fragment);
  ensureSelectionAfterRender(currentVisibleItems);
}

function isValidHttpUrl(value) {
  try {
    const candidate = new URL(value);
    return candidate.protocol === 'http:' || candidate.protocol === 'https:';
  } catch {
    return false;
  }
}

function readRecentFeeds() {
  try {
    const raw = localStorage.getItem(RECENT_FEEDS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((value) => typeof value === 'string' && isValidHttpUrl(value))
      .slice(0, MAX_RECENT_FEEDS);
  } catch {
    return [];
  }
}

function readCategoryState() {
  try {
    const raw = localStorage.getItem(CATEGORY_STATE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function readArticleCache() {
  try {
    const raw = localStorage.getItem(ARTICLE_CACHE_KEY);
    if (!raw) {
      return { order: [], entries: {} };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { order: [], entries: {} };
    }

    const order = Array.isArray(parsed.order) ? parsed.order.filter((url) => typeof url === 'string') : [];
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    return { order, entries };
  } catch {
    return { order: [], entries: {} };
  }
}

function saveArticleCache(nextCache) {
  try {
    localStorage.setItem(ARTICLE_CACHE_KEY, JSON.stringify(nextCache));
  } catch {
    // Ignore localStorage write failures.
  }
}

function saveCategoryState(nextState) {
  try {
    localStorage.setItem(CATEGORY_STATE_KEY, JSON.stringify(nextState));
  } catch {
    // Ignore localStorage write failures.
  }
}

function saveRecentFeeds(urls) {
  try {
    localStorage.setItem(RECENT_FEEDS_KEY, JSON.stringify(urls));
  } catch {
    // Ignore localStorage write failures.
  }
}

function normalizeCategory(category) {
  if (typeof category !== 'string') {
    return UNCATEGORIZED_CATEGORY;
  }

  const trimmed = category.trim();
  return trimmed.length > 0 ? trimmed : UNCATEGORIZED_CATEGORY;
}

function normalizeFeedEntry(feed) {
  if (!feed || typeof feed !== 'object') {
    return null;
  }

  const url = typeof feed.url === 'string' ? feed.url.trim() : '';
  if (!isValidHttpUrl(url)) {
    return null;
  }

  const rawTitle = typeof feed.title === 'string' ? feed.title.trim() : '';
  return {
    url,
    title: rawTitle.length > 0 ? rawTitle : url,
    category: normalizeCategory(feed.category)
  };
}

function dedupeFeeds(feeds) {
  const unique = [];
  const seenUrls = new Set();

  feeds.forEach((feed) => {
    const normalized = normalizeFeedEntry(feed);
    if (!normalized || seenUrls.has(normalized.url)) {
      return;
    }

    seenUrls.add(normalized.url);
    unique.push(normalized);
  });

  return unique;
}

function buildLibrary(feeds, categories = []) {
  const normalizedFeeds = dedupeFeeds(feeds);
  const categorySet = new Set(
    categories
      .filter((name) => typeof name === 'string')
      .map((name) => normalizeCategory(name))
  );

  normalizedFeeds.forEach((feed) => {
    categorySet.add(feed.category);
  });

  return {
    feeds: normalizedFeeds,
    categories: Array.from(categorySet)
  };
}

function readLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) {
      return buildLibrary([]);
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return buildLibrary([]);
    }

    const feeds = Array.isArray(parsed.feeds) ? parsed.feeds : [];
    const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
    return buildLibrary(feeds, categories);
  } catch {
    return buildLibrary([]);
  }
}

function saveLibrary(library) {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(buildLibrary(library.feeds, library.categories)));
  } catch {
    // Ignore localStorage write failures.
  }
}

function normalizeFeedItem(feedUrl, item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const title = typeof item.title === 'string' && item.title.trim().length > 0
    ? item.title.trim()
    : 'Untitled item';
  const link = typeof item.link === 'string' && item.link.trim().length > 0 ? item.link.trim() : '';
  const rawPubDate = typeof item.isoDate === 'string' && item.isoDate.trim().length > 0
    ? item.isoDate
    : item.pubDate;
  const pubDate = typeof rawPubDate === 'string' && rawPubDate.trim().length > 0
    ? rawPubDate.trim()
    : '';
  const summarySource = item.summary || item.contentSnippet || item.content || item.description || '';
  const summary = stripHtml(summarySource);

  const idSource = typeof item.id === 'string' && item.id.trim().length > 0
    ? item.id.trim()
    : (typeof item.guid === 'string' && item.guid.trim().length > 0 ? item.guid.trim() : '');
  const fallbackId = [feedUrl, link, title, pubDate].join('|');
  const id = idSource.length > 0
    ? (idSource.startsWith(`${feedUrl}|`) ? idSource : `${feedUrl}|${idSource}`)
    : fallbackId;

  return {
    id,
    title,
    link,
    pubDate,
    summary,
    isRead: item.isRead === true,
    isSaved: item.isSaved === true
  };
}

function normalizeFeedItemList(feedUrl, items) {
  const normalizedItems = [];
  const seenIds = new Set();
  const sourceItems = Array.isArray(items) ? items : [];

  sourceItems.slice(0, MAX_ITEMS_PER_FEED).forEach((item) => {
    const normalized = normalizeFeedItem(feedUrl, item);
    if (!normalized || seenIds.has(normalized.id)) {
      return;
    }

    seenIds.add(normalized.id);
    normalizedItems.push(normalized);
  });

  return normalizedItems;
}

function readFeedItemCache() {
  try {
    const raw = localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const normalized = {};
    Object.entries(parsed).forEach(([feedUrl, items]) => {
      if (!isValidHttpUrl(feedUrl)) {
        return;
      }

      const normalizedItems = normalizeFeedItemList(feedUrl, items);
      if (normalizedItems.length > 0) {
        normalized[feedUrl] = normalizedItems;
      }
    });

    return normalized;
  } catch {
    return {};
  }
}

function saveFeedItemCache(cache) {
  try {
    localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore localStorage write failures.
  }
}

function getCachedFeedItems(feedUrl) {
  return Array.isArray(feedItemCache[feedUrl]) ? feedItemCache[feedUrl] : [];
}

function setCachedFeedItems(feedUrl, items) {
  const normalizedItems = normalizeFeedItemList(feedUrl, items);

  if (normalizedItems.length === 0) {
    delete feedItemCache[feedUrl];
  } else {
    feedItemCache[feedUrl] = normalizedItems;
  }

  updateFeedUnreadCount(feedUrl);
  saveFeedItemCache(feedItemCache);
}

function markFeedAllRead(feedUrl) {
  if (!isValidHttpUrl(feedUrl)) {
    return 0;
  }

  const items = getCachedFeedItems(feedUrl);
  if (items.length === 0) {
    return 0;
  }

  const updatedItems = items.map((item) => (item.isRead ? item : { ...item, isRead: true }));
  setCachedFeedItems(feedUrl, updatedItems);
  return updatedItems.length;
}

function markCategoryAllRead(categoryName) {
  const normalizedCategory = normalizeCategory(categoryName);
  const feedsToUpdate = importedFeeds.filter(
    (feed) => normalizeCategory(feed.category) === normalizedCategory
  );
  let count = 0;
  feedsToUpdate.forEach((feed) => {
    count += markFeedAllRead(feed.url);
  });
  return count;
}

function moveArrayItem(items, fromIndex, toIndex) {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function persistLibraryOrdering(feeds, categories) {
  const normalized = buildLibrary(feeds, categories);
  saveLibrary(normalized);
  setImportedFeeds(normalized.feeds);
}

function reorderCategories(draggedCategory, targetCategory) {
  if (!draggedCategory || !targetCategory || draggedCategory === targetCategory) {
    return;
  }

  const library = readLibrary();
  const normalized = buildLibrary(library.feeds, library.categories);
  const categories = [...normalized.categories];
  const fromIndex = categories.indexOf(draggedCategory);
  const toIndex = categories.indexOf(targetCategory);
  if (fromIndex === -1 || toIndex === -1) {
    return;
  }

  const nextCategories = moveArrayItem(categories, fromIndex, toIndex);
  persistLibraryOrdering(normalized.feeds, nextCategories);
}

function findInsertIndexForCategory(feeds, categoryName) {
  let lastIndex = -1;
  feeds.forEach((feed, index) => {
    if (normalizeCategory(feed.category) === normalizeCategory(categoryName)) {
      lastIndex = index;
    }
  });

  return lastIndex === -1 ? feeds.length : lastIndex + 1;
}

function reorderFeed(draggedUrl, targetUrl, targetCategory) {
  if (!draggedUrl || draggedUrl === targetUrl) {
    return;
  }

  const library = readLibrary();
  const normalized = buildLibrary(library.feeds, library.categories);
  const feeds = [...normalized.feeds];
  const draggedIndex = feeds.findIndex((feed) => feed.url === draggedUrl);
  if (draggedIndex === -1) {
    return;
  }

  const dragged = feeds[draggedIndex];
  feeds.splice(draggedIndex, 1);

  let updated = dragged;
  if (targetCategory) {
    updated = { ...dragged, category: normalizeCategory(targetCategory) };
  }

  if (targetUrl) {
    const targetIndex = feeds.findIndex((feed) => feed.url === targetUrl);
    if (targetIndex === -1) {
      return;
    }
    feeds.splice(targetIndex, 0, updated);
  } else if (targetCategory) {
    const insertIndex = findInsertIndexForCategory(feeds, targetCategory);
    feeds.splice(insertIndex, 0, updated);
  } else {
    feeds.push(updated);
  }

  const categories = normalized.categories.includes(updated.category)
    ? normalized.categories
    : [...normalized.categories, updated.category];
  persistLibraryOrdering(feeds, categories);
}

function updateFeedUnreadCount(feedUrl) {
  const unreadCount = getCachedFeedItems(feedUrl).reduce((count, item) => (
    item.isRead ? count : count + 1
  ), 0);
  feedUnreadCounts.set(feedUrl, unreadCount);
}

function refreshUnreadCounts() {
  feedUnreadCounts.clear();
  Object.keys(feedItemCache).forEach((feedUrl) => {
    updateFeedUnreadCount(feedUrl);
  });
}

function buildCachedItemsFromFetch(feedUrl, items) {
  const existingState = new Map(
    getCachedFeedItems(feedUrl).map((item) => [item.id, { isRead: item.isRead, isSaved: item.isSaved }])
  );
  return normalizeFeedItemList(feedUrl, items).map((item) => ({
    ...item,
    isRead: existingState.has(item.id) ? existingState.get(item.id).isRead : false,
    isSaved: existingState.has(item.id) ? existingState.get(item.id).isSaved : false
  }));
}

function updateItemReadState(feedUrl, itemId, isRead) {
  if (!isValidHttpUrl(feedUrl) || typeof itemId !== 'string' || itemId.trim().length === 0) {
    return;
  }

  const updatedItems = getCachedFeedItems(feedUrl).map((item) => (
    item.id === itemId ? { ...item, isRead } : item
  ));
  setCachedFeedItems(feedUrl, updatedItems);
  renderSidebarFeeds();
}

function updateItemSavedState(feedUrl, itemId, isSaved) {
  if (!isValidHttpUrl(feedUrl) || typeof itemId !== 'string' || itemId.trim().length === 0) {
    return;
  }

  const updatedItems = getCachedFeedItems(feedUrl).map((item) => (
    item.id === itemId ? { ...item, isSaved } : item
  ));
  setCachedFeedItems(feedUrl, updatedItems);
  if (currentView === 'saved') {
    renderSavedItems();
  }
}

function rerenderSelectedFeed() {
  if (currentSearchQuery.length > 0) {
    renderSearchResults();
    return;
  }

  if (selectedFeedUrl) {
    renderItems(selectedFeedUrl, getCachedFeedItems(selectedFeedUrl));
    return;
  }

  clearResults();
  setSelectedItem('', '');
}

function getSavedItems() {
  const savedItems = [];
  Object.entries(feedItemCache).forEach(([feedUrl, items]) => {
    items.forEach((item) => {
      if (item.isSaved) {
        savedItems.push({ ...item, feedUrl });
      }
    });
  });

  savedItems.sort((a, b) => {
    const aTime = a.pubDate ? Date.parse(a.pubDate) : 0;
    const bTime = b.pubDate ? Date.parse(b.pubDate) : 0;
    return bTime - aTime;
  });

  return savedItems;
}

function renderSavedItems() {
  if (!savedResultsList || !savedEmpty) {
    return;
  }

  const savedItems = getSavedItems();
  savedResultsList.innerHTML = '';

  if (savedItems.length === 0) {
    savedEmpty.classList.remove('is-hidden');
    if (currentView === 'saved') {
      currentVisibleItems = [];
      currentListElement = savedResultsList;
      setSelectedItem('', '');
    }
    return;
  }

  savedEmpty.classList.add('is-hidden');
  const fragment = document.createDocumentFragment();
  savedItems.forEach((item) => {
    fragment.appendChild(createItemElement(item.feedUrl, item));
  });
  savedResultsList.appendChild(fragment);
  if (currentView === 'saved') {
    currentListElement = savedResultsList;
    currentVisibleItems = savedItems;
    ensureSelectionAfterRender(currentVisibleItems);
  }
}

function setView(view) {
  currentView = view;

  if (feedView) {
    feedView.classList.toggle('is-hidden', view === 'saved');
  }

  if (savedView) {
    savedView.classList.toggle('is-hidden', view !== 'saved');
  }

  if (view === 'saved') {
    renderSavedItems();
    return;
  }

  currentListElement = resultsList;
  currentVisibleItems = getVisibleItemsForCurrentView();
  ensureSelectionAfterRender(currentVisibleItems);
}

function renderRecentFeeds() {
  recentFeedsList.innerHTML = '';

  if (recentFeeds.length === 0) {
    recentFeedsEmpty.hidden = false;
    return;
  }

  recentFeedsEmpty.hidden = true;
  const fragment = document.createDocumentFragment();

  recentFeeds.forEach((url) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-feed-button';
    button.dataset.url = url;
    button.textContent = url;
    li.appendChild(button);
    fragment.appendChild(li);
  });

  recentFeedsList.appendChild(fragment);
}

function mergeRecentFeeds(urls) {
  const uniqueIncoming = [];
  const seen = new Set();

  urls.forEach((url) => {
    if (!isValidHttpUrl(url) || seen.has(url)) {
      return;
    }
    seen.add(url);
    uniqueIncoming.push(url);
  });

  if (uniqueIncoming.length === 0) {
    return false;
  }

  recentFeeds = [
    ...uniqueIncoming,
    ...recentFeeds.filter((entry) => !seen.has(entry))
  ].slice(0, MAX_RECENT_FEEDS);

  saveRecentFeeds(recentFeeds);
  renderRecentFeeds();
  return true;
}

function addRecentFeed(url) {
  mergeRecentFeeds([url]);
}

function getOutlineLabel(outline) {
  if (!outline || typeof outline.getAttribute !== 'function') {
    return '';
  }

  const title = outline.getAttribute('title');
  if (typeof title === 'string' && title.trim().length > 0) {
    return title.trim();
  }

  const text = outline.getAttribute('text');
  if (typeof text === 'string' && text.trim().length > 0) {
    return text.trim();
  }

  return '';
}

function getOutlineChildren(node) {
  if (!node || !node.children) {
    return [];
  }

  return Array.from(node.children).filter((child) =>
    child && typeof child.tagName === 'string' && child.tagName.toLowerCase() === 'outline'
  );
}

function setSidebarExpanded(isExpanded) {
  if (!sidebar || !sidebarToggle) {
    return;
  }

  sidebar.classList.toggle('is-open', isExpanded);
  sidebarToggle.setAttribute('aria-expanded', String(isExpanded));
}

function syncSidebarToViewport() {
  if (!sidebar || !sidebarToggle) {
    return;
  }

  if (smallScreenMediaQuery.matches) {
    setSidebarExpanded(false);
    return;
  }

  setSidebarExpanded(true);
}

function parseOpmlFeeds(opmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(opmlText, 'application/xml');

  if (xmlDoc.querySelector('parsererror')) {
    throw new Error('invalid_opml');
  }

  const body = xmlDoc.querySelector('body');
  const rootOutlines = getOutlineChildren(body);
  const parsedFeeds = [];

  function walkOutlines(outlines, currentCategory = '') {
    outlines.forEach((outline) => {
      const xmlUrl = outline.getAttribute('xmlUrl');
      const label = getOutlineLabel(outline);
      const hasUrl = typeof xmlUrl === 'string' && xmlUrl.trim().length > 0;
      const nextCategory = hasUrl ? currentCategory : label || currentCategory;
      const childOutlines = getOutlineChildren(outline);

      if (hasUrl) {
        const normalizedUrl = xmlUrl.trim();
        if (!isValidHttpUrl(normalizedUrl)) {
          return;
        }

        parsedFeeds.push({
          url: normalizedUrl,
          title: label || normalizedUrl,
          category: currentCategory || UNCATEGORIZED_CATEGORY
        });
      }

      if (childOutlines.length > 0) {
        walkOutlines(childOutlines, nextCategory);
      }
    });
  }

  walkOutlines(rootOutlines);

  if (parsedFeeds.length === 0) {
    throw new Error('invalid_opml');
  }

  return parsedFeeds;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildOpmlTextFromLibrary(library) {
  const normalizedLibrary = buildLibrary(
    library && Array.isArray(library.feeds) ? library.feeds : [],
    library && Array.isArray(library.categories) ? library.categories : []
  );
  const grouped = groupFeedsByCategory(normalizedLibrary.feeds, normalizedLibrary.categories);
  const outlineLines = [];

  grouped.forEach((feeds, categoryName) => {
    outlineLines.push(`    <outline text="${escapeXml(categoryName)}" title="${escapeXml(categoryName)}">`);

    feeds.forEach((feed) => {
      const title = feed.title || feed.url;
      outlineLines.push(
        `      <outline type="rss" text="${escapeXml(title)}" title="${escapeXml(title)}" xmlUrl="${escapeXml(feed.url)}" />`
      );
    });

    outlineLines.push('    </outline>');
  });

  const now = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head>
    <title>RSS Viewer Library</title>
    <dateCreated>${escapeXml(now)}</dateCreated>
  </head>
  <body>
${outlineLines.join('\n')}
  </body>
</opml>`;
}

function downloadLibraryAsOpml() {
  const library = readLibrary();
  if (!library.feeds.length) {
    setStatus('Add at least one feed before exporting OPML.', 'error');
    return;
  }

  const opmlText = buildOpmlTextFromLibrary(library);
  const blob = new Blob([opmlText], { type: 'text/x-opml+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const dateStamp = new Date().toISOString().slice(0, 10);
  link.href = objectUrl;
  link.download = `rss-viewer-library-${dateStamp}.opml`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  setStatus(`Exported ${library.feeds.length} feed${library.feeds.length === 1 ? '' : 's'} as OPML.`);
}

function groupFeedsByCategory(feeds, categoryOrder = []) {
  const grouped = new Map();
  const normalizedOrder = categoryOrder
    .filter((name) => typeof name === 'string')
    .map((name) => normalizeCategory(name));

  normalizedOrder.forEach((name) => {
    if (!grouped.has(name)) {
      grouped.set(name, []);
    }
  });

  feeds.forEach((feed) => {
    const categoryName = typeof feed.category === 'string' && feed.category.trim().length > 0
      ? feed.category.trim()
      : UNCATEGORIZED_CATEGORY;

    if (!grouped.has(categoryName)) {
      grouped.set(categoryName, []);
    }

    grouped.get(categoryName).push(feed);
  });

  return grouped;
}

function getFeedCount(feedUrl) {
  return feedUnreadCounts.get(feedUrl) || 0;
}

function getCategoryCount(feeds) {
  return feeds.reduce((total, feed) => total + getFeedCount(feed.url), 0);
}

function renderSidebarFeeds() {
  if (!sidebarGroups) {
    return;
  }

  sidebarGroups.innerHTML = '';

  if (importedFeeds.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sidebar-empty';
    empty.textContent = 'Import an OPML file to list feeds by category.';
    sidebarGroups.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const library = readLibrary();
  const grouped = groupFeedsByCategory(importedFeeds, library.categories);

  grouped.forEach((feeds, categoryName) => {
    const section = document.createElement('section');
    section.className = 'sidebar-group';
    section.setAttribute('aria-label', `${categoryName} feeds`);

    const isCollapsed = Boolean(categoryState[categoryName]);
    if (isCollapsed) {
      section.classList.add('is-collapsed');
    }

    const heading = document.createElement('h3');
    heading.className = 'sidebar-category-header';
    heading.dataset.dndType = 'category';
    heading.dataset.category = categoryName;
    heading.setAttribute('draggable', 'true');
    const headingLabel = document.createElement('span');
    headingLabel.className = 'sidebar-category-name';
    headingLabel.textContent = categoryName;
    const headingCount = document.createElement('span');
    headingCount.className = 'sidebar-count';
    const categoryUnreadCount = getCategoryCount(feeds);
    headingCount.textContent = String(categoryUnreadCount);
    headingCount.setAttribute('title', 'Unread items in category');
    if (categoryUnreadCount === 0) {
      headingCount.classList.add('is-zero');
    }

    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'category-toggle';
    toggleButton.dataset.category = categoryName;
    toggleButton.dataset.action = 'toggle-category';
    toggleButton.setAttribute('aria-expanded', String(!isCollapsed));
    toggleButton.textContent = isCollapsed ? 'Show' : 'Hide';

    const markReadButton = document.createElement('button');
    markReadButton.type = 'button';
    markReadButton.className = 'category-action';
    markReadButton.dataset.category = categoryName;
    markReadButton.dataset.action = 'mark-category-read';
    markReadButton.textContent = 'Mark read';

    heading.append(headingLabel, headingCount, toggleButton, markReadButton);
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'sidebar-feed-list';

    feeds.forEach((feed) => {
      const li = document.createElement('li');
      li.className = 'sidebar-feed-row';
      li.dataset.dndType = 'feed';
      li.dataset.url = feed.url;
      li.dataset.category = feed.category;
      li.setAttribute('draggable', 'true');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = feed.url === selectedSidebarFeedUrl ? 'sidebar-feed is-active' : 'sidebar-feed';
      button.dataset.url = feed.url;
      button.setAttribute('draggable', 'true');
      const feedName = document.createElement('span');
      feedName.className = 'sidebar-feed-name';
      feedName.textContent = feed.title;
      const feedCount = document.createElement('span');
      feedCount.className = 'sidebar-count';
      const unreadCount = getFeedCount(feed.url);
      feedCount.textContent = String(unreadCount);
      feedCount.setAttribute('title', 'Unread items');
      if (unreadCount === 0) {
        feedCount.classList.add('is-zero');
      }
      button.append(feedName, feedCount);

      const markReadButton = document.createElement('button');
      markReadButton.type = 'button';
      markReadButton.className = 'feed-action';
      markReadButton.dataset.feedAction = 'mark-read';
      markReadButton.dataset.url = feed.url;
      markReadButton.setAttribute('aria-label', `Mark ${feed.title} as read`);
      markReadButton.textContent = 'Read';

      li.append(button, markReadButton);
      list.appendChild(li);
    });

    section.appendChild(list);
    fragment.appendChild(section);
  });

  sidebarGroups.appendChild(fragment);
}

function setImportedFeeds(feeds) {
  importedFeeds = dedupeFeeds(feeds);

  if (!importedFeeds.some((feed) => feed.url === selectedSidebarFeedUrl)) {
    selectedSidebarFeedUrl = '';
  }

  renderSidebarFeeds();
}

function shouldPrefetchFeed(feedUrl) {
  return getCachedFeedItems(feedUrl).length === 0;
}

async function fetchFeedItemsForCache(feedUrl) {
  try {
    const response = await fetch(`/api/rss?url=${encodeURIComponent(feedUrl)}`);
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    const cachedItems = buildCachedItemsFromFetch(feedUrl, items);
    setCachedFeedItems(feedUrl, cachedItems);
    renderSidebarFeeds();
  } catch {
    // Ignore prefetch failures.
  }
}

function prefetchLibraryFeeds(feeds) {
  const queue = feeds
    .map((feed) => feed.url)
    .filter((url) => isValidHttpUrl(url) && shouldPrefetchFeed(url));

  if (queue.length === 0) {
    return;
  }

  let index = 0;
  const workerCount = Math.min(PREFETCH_CONCURRENCY, queue.length);
  const workers = Array.from({ length: workerCount }, () => (async () => {
    while (index < queue.length) {
      const nextUrl = queue[index];
      index += 1;
      await fetchFeedItemsForCache(nextUrl);
    }
  })());

  void Promise.all(workers);
}

function mergeIntoLibrary(imported) {
  const currentLibrary = readLibrary();
  const merged = buildLibrary([...imported, ...currentLibrary.feeds], currentLibrary.categories);
  saveLibrary(merged);
  setImportedFeeds(merged.feeds);
  prefetchLibraryFeeds(merged.feeds);
}

async function loadFeed(url) {
  setView('feed');
  setStatus('Loading feed...', 'loading');
  loadButton.disabled = true;
  urlInput.disabled = true;

  try {
    const response = await fetch(`/api/rss?url=${encodeURIComponent(url)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data && data.error ? data.error : 'fetch_failed');
    }

    addRecentFeed(url);

    const items = Array.isArray(data.items) ? data.items : [];
    selectedFeedUrl = url;
    const cachedItems = buildCachedItemsFromFetch(url, items);
    setCachedFeedItems(url, cachedItems);
    renderSidebarFeeds();
    rerenderSelectedFeed();

    if (cachedItems.length === 0) {
      setStatus('Feed loaded, but no items were found.');
      return;
    }

    setStatus(`Loaded ${cachedItems.length} item${cachedItems.length === 1 ? '' : 's'}.`);
  } catch {
    clearResults();
    setStatus('Could not load this feed URL. Check the URL and try again.', 'error');
  } finally {
    loadButton.disabled = false;
    urlInput.disabled = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!isValidHttpUrl(url)) {
    clearResults();
    setStatus('Enter a valid http(s) feed URL.', 'error');
    return;
  }

  await loadFeed(url);
});

recentFeedsList.addEventListener('click', async (event) => {
  const target = event.target;
  const button = target && typeof target.closest === 'function'
    ? target.closest('button[data-url]')
    : null;

  if (!button || !button.dataset || typeof button.dataset.url !== 'string') {
    return;
  }

  const { url } = button.dataset;
  urlInput.value = url;
  selectedFeedUrl = url;
  selectedSidebarFeedUrl = importedFeeds.some((feed) => feed.url === url) ? url : '';
  renderSidebarFeeds();
  await loadFeed(url);
});

if (sidebarGroups) {
  sidebarGroups.addEventListener('click', async (event) => {
    const target = event.target;
    const actionButton = target && typeof target.closest === 'function'
      ? target.closest('[data-action], [data-feed-action]')
      : null;

    if (actionButton && actionButton.dataset) {
      if (actionButton.dataset.action === 'toggle-category' && typeof actionButton.dataset.category === 'string') {
        const categoryName = actionButton.dataset.category;
        categoryState = {
          ...categoryState,
          [categoryName]: !categoryState[categoryName]
        };
        saveCategoryState(categoryState);
        renderSidebarFeeds();
        return;
      }

      if (actionButton.dataset.action === 'mark-category-read' && typeof actionButton.dataset.category === 'string') {
        const categoryName = actionButton.dataset.category;
        const updated = markCategoryAllRead(categoryName);
        if (updated > 0) {
          setStatus(`Marked ${updated} item${updated === 1 ? '' : 's'} as read in ${categoryName}.`);
        }
        renderSidebarFeeds();
        rerenderSelectedFeed();
        if (currentView === 'saved') {
          renderSavedItems();
        }
        return;
      }

      if (actionButton.dataset.feedAction === 'mark-read' && typeof actionButton.dataset.url === 'string') {
        const feedUrl = actionButton.dataset.url;
        const updated = markFeedAllRead(feedUrl);
        if (updated > 0) {
          setStatus(`Marked ${updated} item${updated === 1 ? '' : 's'} as read.`);
        }
        renderSidebarFeeds();
        rerenderSelectedFeed();
        if (currentView === 'saved') {
          renderSavedItems();
        }
        return;
      }
    }

    const button = target && typeof target.closest === 'function'
      ? target.closest('button[data-url]')
      : null;

    if (!button || !button.dataset || typeof button.dataset.url !== 'string') {
      return;
    }

    const { url } = button.dataset;
    urlInput.value = url;
    selectedFeedUrl = url;
    selectedSidebarFeedUrl = url;
    renderSidebarFeeds();
    await loadFeed(url);
  });
}

if (sidebarGroups) {
  sidebarGroups.addEventListener('dragstart', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
      return;
    }

    const closestButton = target.closest('button');
    if (closestButton) {
      const isFeedButton = closestButton.classList
        && typeof closestButton.classList.contains === 'function'
        && closestButton.classList.contains('sidebar-feed');
      if (!isFeedButton) {
        return;
      }
    }

    const categoryHeader = target.closest('[data-dnd-type="category"]');
    const feedRow = target.closest('[data-dnd-type="feed"]');
    if (categoryHeader && categoryHeader.dataset.category) {
      dragState = {
        type: 'category',
        category: categoryHeader.dataset.category,
        element: categoryHeader
      };
      categoryHeader.classList.add('is-dragging');
    } else if (feedRow && feedRow.dataset.url) {
      dragState = {
        type: 'feed',
        url: feedRow.dataset.url,
        category: feedRow.dataset.category,
        element: feedRow
      };
      feedRow.classList.add('is-dragging');
    }

    if (event.dataTransfer && dragState) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', JSON.stringify(dragState));
    }
  });

  sidebarGroups.addEventListener('dragover', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function' || !dragState) {
      return;
    }

    const canDropOnCategory = Boolean(target.closest('[data-dnd-type="category"]'));
    const canDropOnFeed = Boolean(target.closest('[data-dnd-type="feed"]'));
    if (canDropOnCategory || canDropOnFeed) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    }
  });

  sidebarGroups.addEventListener('drop', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function' || !dragState) {
      return;
    }

    const categoryHeader = target.closest('[data-dnd-type="category"]');
    const feedRow = target.closest('[data-dnd-type="feed"]');

    if (dragState.type === 'category' && categoryHeader && categoryHeader.dataset.category) {
      reorderCategories(dragState.category, categoryHeader.dataset.category);
    }

    if (dragState.type === 'feed') {
      if (feedRow && feedRow.dataset.url) {
        reorderFeed(dragState.url, feedRow.dataset.url, feedRow.dataset.category);
      } else if (categoryHeader && categoryHeader.dataset.category) {
        reorderFeed(dragState.url, null, categoryHeader.dataset.category);
      }
    }

    if (dragState && dragState.element && dragState.element.classList) {
      dragState.element.classList.remove('is-dragging');
    }
    dragState = null;
    renderSidebarFeeds();
  });

  sidebarGroups.addEventListener('dragend', () => {
    if (dragState && dragState.element && dragState.element.classList) {
      dragState.element.classList.remove('is-dragging');
    }
    dragState = null;
  });
}

if (savedViewToggle) {
  savedViewToggle.addEventListener('click', () => {
    setView('saved');
  });
}

if (feedViewToggle) {
  feedViewToggle.addEventListener('click', () => {
    setView('feed');
  });
}

if (opmlInput) {
  opmlInput.addEventListener('change', async () => {
    const [file] = opmlInput.files || [];
    if (!file) {
      return;
    }

    try {
      const content = await file.text();
      const imported = parseOpmlFeeds(content);
      const importedUrls = imported.map((feed) => feed.url);

      if (!mergeRecentFeeds(importedUrls)) {
        throw new Error('invalid_opml');
      }

      mergeIntoLibrary(imported);
      setStatus(`Imported ${importedUrls.length} feed${importedUrls.length === 1 ? '' : 's'} from OPML.`);
    } catch {
      setStatus('Could not import OPML. Please upload a valid OPML file.', 'error');
    } finally {
      opmlInput.value = '';
    }
  });
}

if (opmlExportButton) {
  opmlExportButton.addEventListener('click', () => {
    try {
      downloadLibraryAsOpml();
    } catch {
      setStatus('Could not export OPML. Please try again.', 'error');
    }
  });
}

if (searchInput) {
  searchInput.addEventListener('input', () => {
    currentSearchQuery = searchInput.value.trim().toLowerCase();
    rerenderSelectedFeed();
  });
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', (event) => {
    if (!event || event.defaultPrevented) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    const key = String(event.key || '').toLowerCase();
    if (!key) {
      return;
    }

    switch (key) {
      case 'j':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'k':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 'o':
        event.preventDefault();
        openSelectedItem();
        break;
      case 's':
        event.preventDefault();
        toggleSelectedSavedState();
        break;
      case 'm':
        event.preventDefault();
        toggleSelectedReadState();
        break;
      default:
        break;
    }
  });
}

recentFeeds = readRecentFeeds();
feedItemCache = readFeedItemCache();
refreshUnreadCounts();
categoryState = readCategoryState();
articleCache = readArticleCache();
const startupLibrary = readLibrary();
setImportedFeeds(startupLibrary.feeds);
prefetchLibraryFeeds(startupLibrary.feeds);
renderRecentFeeds();
syncSidebarToViewport();

if (sidebarToggle) {
  sidebarToggle.addEventListener('click', () => {
    if (!sidebar || !smallScreenMediaQuery.matches) {
      return;
    }

    const isExpanded = sidebar.classList.contains('is-open');
    setSidebarExpanded(!isExpanded);
  });
}

if (typeof smallScreenMediaQuery.addEventListener === 'function') {
  smallScreenMediaQuery.addEventListener('change', syncSidebarToViewport);
} else if (typeof smallScreenMediaQuery.addListener === 'function') {
  smallScreenMediaQuery.addListener(syncSidebarToViewport);
}
