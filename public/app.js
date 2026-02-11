const form = document.getElementById('feed-form');
const urlInput = document.getElementById('feed-url');
const loadButton = document.getElementById('load-feed');
const statusBanner = document.getElementById('status');
const resultsList = document.getElementById('results');

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
