const sanitizeHtmlLib = require('sanitize-html');
const { JSDOM } = require('jsdom');

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'img', 'figure', 'figcaption'
];
const ALLOWED_ATTRS = {
  a: ['href'],
  img: ['src', 'alt']
};

const BAD_PATTERN = /comment|share|social|related|sidebar|nav|footer/i;

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function sanitizeText(str) {
  if (str == null || typeof str !== 'string') return '';
  return decodeEntities(
    str.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  );
}

function sanitizeUrl(url) {
  if (url == null || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (/["'<>`]/.test(parsed.hostname)) return null;
    return parsed.toString();
  } catch {}
  return null;
}

function removeBadSections(html) {
  if (!html || typeof html !== 'string') return '';
  try {
    const dom = new JSDOM('<div id="root">' + html + '</div>');
    const root = dom.window.document.getElementById('root');
    const toRemove = root.querySelectorAll(
      '[id*="comment"], [class*="comment"], [id*="share"], [class*="share"], [id*="social"], [class*="social"], [id*="related"], [class*="related"], [id*="sidebar"], [class*="sidebar"], [id*="nav"], [class*="nav"], [id*="footer"], [class*="footer"]'
    );
    toRemove.forEach((el) => el.remove());
    return root.innerHTML;
  } catch {
    return html;
  }
}

function sanitizeHtml(html) {
  if (html == null || typeof html !== 'string') return '';
  const first = sanitizeHtmlLib(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: {},
    allowedSchemesAppliedToAttributes: ['href', 'src']
  });
  return removeBadSections(first);
}

function sanitizeItem(item) {
  if (!item || typeof item !== 'object') {
    return { title: '', link: null, summary: '', content: '', pubDate: null, author: '', guid: null };
  }
  const rawContent = item.content || item['content:encoded'] || item.summary || '';
  const rawSummary = item.contentSnippet || item.summary || item.content || '';
  return {
    title: sanitizeText(item.title || ''),
    link: sanitizeUrl(item.link),
    summary: sanitizeText(rawSummary),
    content: sanitizeHtml(rawContent),
    pubDate: item.pubDate || item.isoDate || null,
    author: sanitizeText(item.creator || item.author || ''),
    guid: item.guid || item.link || null
  };
}

module.exports = {
  sanitizeText,
  sanitizeUrl,
  sanitizeHtml,
  sanitizeItem
};
