const form = document.getElementById('feed-form');
const urlInput = document.getElementById('feed-url');
const loadButton = document.getElementById('load-feed');
const opmlInput = document.getElementById('opml-file');
const statusBanner = document.getElementById('status');
const resultsList = document.getElementById('results');
const recentFeedsList = document.getElementById('recent-feeds');
const recentFeedsEmpty = document.getElementById('recent-feeds-empty');

const RECENT_FEEDS_KEY = 'rssViewer.recentFeeds';
const MAX_RECENT_FEEDS = 5;
let recentFeeds = [];

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

function createItemElement(item) {
  const li = document.createElement('li');
  li.className = 'item';

  const title = item.title || 'Untitled item';
  const itemLink = typeof item.link === 'string' ? item.link : '';
  const pubDate = formatDate(item.isoDate || item.pubDate);
  const summarySource = item.contentSnippet || item.summary || item.content || item.description || '';
  const summary = stripHtml(summarySource) || 'No summary available.';

  const heading = document.createElement('h2');
  const link = document.createElement('a');
  link.textContent = title;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.href = itemLink || '#';
  if (!itemLink) {
    link.removeAttribute('target');
    link.removeAttribute('rel');
  }
  heading.appendChild(link);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = pubDate;

  const summaryText = document.createElement('p');
  summaryText.textContent = summary;

  li.append(heading, meta, summaryText);
  return li;
}

function renderItems(items) {
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    fragment.appendChild(createItemElement(item));
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

function parseOpmlFeedUrls(opmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(opmlText, 'application/xml');

  if (xmlDoc.querySelector('parsererror')) {
    throw new Error('invalid_opml');
  }

  const outlines = Array.from(xmlDoc.querySelectorAll('outline[xmlUrl]'));
  const urls = outlines
    .map((outline) => outline.getAttribute('xmlUrl'))
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && isValidHttpUrl(value));

  if (urls.length === 0) {
    throw new Error('invalid_opml');
  }

  return urls;
}

async function loadFeed(url) {
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
    renderItems(items);

    if (items.length === 0) {
      setStatus('Feed loaded, but no items were found.');
      return;
    }

    setStatus(`Loaded ${items.length} item${items.length === 1 ? '' : 's'}.`);
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
  await loadFeed(url);
});

if (opmlInput) {
  opmlInput.addEventListener('change', async () => {
    const [file] = opmlInput.files || [];
    if (!file) {
      return;
    }

    try {
      const content = await file.text();
      const importedUrls = parseOpmlFeedUrls(content);

      if (!mergeRecentFeeds(importedUrls)) {
        throw new Error('invalid_opml');
      }

      setStatus(`Imported ${importedUrls.length} feed${importedUrls.length === 1 ? '' : 's'} from OPML.`);
    } catch {
      setStatus('Could not import OPML. Please upload a valid OPML file.', 'error');
    } finally {
      opmlInput.value = '';
    }
  });
}

recentFeeds = readRecentFeeds();
renderRecentFeeds();
