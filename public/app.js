const form = document.getElementById('feed-form');
const urlInput = document.getElementById('feed-url');
const loadButton = document.getElementById('load-feed');
const opmlInput = document.getElementById('opml-file');
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
const smallScreenMediaQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 640px)')
  : { matches: false };

const RECENT_FEEDS_KEY = 'rssViewer.recentFeeds';
const LIBRARY_KEY = 'rssViewer.library';
const FEED_CACHE_KEY = 'rssViewer.feedItemCache';
const MAX_RECENT_FEEDS = 5;
const MAX_ITEMS_PER_FEED = 50;
const UNCATEGORIZED_CATEGORY = 'Uncategorized';
let recentFeeds = [];
let importedFeeds = [];
let selectedSidebarFeedUrl = '';
let selectedFeedUrl = '';
let feedItemCache = {};
const feedUnreadCounts = new Map();
let currentView = 'feed';
let currentSearchQuery = '';

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
  if (item.isRead) {
    li.classList.add('is-read');
  }

  const title = item.title || 'Untitled item';
  const itemLink = typeof item.link === 'string' ? item.link : '';
  const pubDate = formatDate(item.pubDate);
  const summarySource = item.summary || '';
  const summary = stripHtml(summarySource) || 'No summary available.';

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

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = includeFeedLabel ? `${getFeedLabel(feedUrl)} • ${pubDate}` : pubDate;

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
  summaryText.textContent = summary;

  li.append(heading, meta, actions, summaryText);
  return li;
}

function renderItems(feedUrl, items) {
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    fragment.appendChild(createItemElement(feedUrl, item));
  });
  clearResults();
  resultsList.appendChild(fragment);
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
  const fragment = document.createDocumentFragment();

  results.forEach((item) => {
    fragment.appendChild(createItemElement(item.feedUrl, item, { includeFeedLabel: true }));
  });

  clearResults();
  resultsList.appendChild(fragment);
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
    return;
  }

  savedEmpty.classList.add('is-hidden');
  const fragment = document.createDocumentFragment();
  savedItems.forEach((item) => {
    fragment.appendChild(createItemElement(item.feedUrl, item));
  });
  savedResultsList.appendChild(fragment);
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
  }
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

function groupFeedsByCategory(feeds) {
  const grouped = new Map();

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
  const grouped = groupFeedsByCategory(importedFeeds);

  grouped.forEach((feeds, categoryName) => {
    const section = document.createElement('section');
    section.className = 'sidebar-group';
    section.setAttribute('aria-label', `${categoryName} feeds`);

    const heading = document.createElement('h3');
    const headingLabel = document.createElement('span');
    headingLabel.className = 'sidebar-category-name';
    headingLabel.textContent = categoryName;
    const headingCount = document.createElement('span');
    headingCount.className = 'sidebar-count';
    headingCount.textContent = String(getCategoryCount(feeds));
    heading.append(headingLabel, headingCount);
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'sidebar-feed-list';

    feeds.forEach((feed) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = feed.url === selectedSidebarFeedUrl ? 'sidebar-feed is-active' : 'sidebar-feed';
      button.dataset.url = feed.url;
      const feedName = document.createElement('span');
      feedName.className = 'sidebar-feed-name';
      feedName.textContent = feed.title;
      const feedCount = document.createElement('span');
      feedCount.className = 'sidebar-count';
      feedCount.textContent = String(getFeedCount(feed.url));
      button.append(feedName, feedCount);
      li.appendChild(button);
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

function mergeIntoLibrary(imported) {
  const currentLibrary = readLibrary();
  const merged = buildLibrary([...imported, ...currentLibrary.feeds], currentLibrary.categories);
  saveLibrary(merged);
  setImportedFeeds(merged.feeds);
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

if (searchInput) {
  searchInput.addEventListener('input', () => {
    currentSearchQuery = searchInput.value.trim().toLowerCase();
    rerenderSelectedFeed();
  });
}

recentFeeds = readRecentFeeds();
feedItemCache = readFeedItemCache();
refreshUnreadCounts();
const startupLibrary = readLibrary();
setImportedFeeds(startupLibrary.feeds);
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
