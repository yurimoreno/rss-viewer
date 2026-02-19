# SPEC-001: RSS Content Sanitization

## Status: Ready for implementation
## Priority: P0 (prerequisite for SPEC-002 reading view)
## Estimated scope: Small (~1-2 files, server.js + client utils)

---

## Problem

RSS feed content arrives as untrusted HTML/text and is handled inconsistently across the app. Current issues:

1. **XSS vector in `stripHtml`**: Assigns raw HTML to `innerHTML` on a live DOM element before reading `textContent`. Any script in the feed content executes.
2. **Raw HTML leaks into article body**: The `/api/article` pipeline (`extractReadableSection` + `stripHtmlTags`) doesn't strip comment sections, social widgets, share buttons, voting UI, or data attributes — all of which bleed into the rendered article.
3. **No URL scheme validation**: `item.link` and `feed.link` are used directly in `href` attributes with no allowlist. `javascript:` or `data:` URIs could be injected.
4. **HTML entities rendered as text**: `&nbsp;` and similar entities appear literally in the article body instead of being decoded or stripped.

---

## Solution

### 1. Server-side: Sanitize in `/api/rss` before sending to client

**File: `server.js` (or extract to `lib/sanitize.js`)**

Add a `sanitizeItem(item)` function called on every item before `res.json()`:

```
app.get('/api/rss', async (req, res) => {
  const feed = await parser.parseURL(parsedUrl.toString());
  return res.json({
    feed: {
      title: sanitizeText(feed.title),
      description: sanitizeText(feed.description),
      link: sanitizeUrl(feed.link)
    },
    items: (feed.items || []).map(sanitizeItem)
  });
});
```

#### `sanitizeText(str)` → string
- Input: untrusted string that should contain no HTML
- Strip all HTML tags (regex is fine here: `str.replace(/<[^>]*>/g, '')`)
- Decode HTML entities (`&nbsp;` → space, `&amp;` → `&`, etc.)
- Trim whitespace
- Return plain text

#### `sanitizeUrl(url)` → string | null
- Parse with `new URL(url)` in a try/catch
- Allow only `http:` and `https:` protocols
- Return the URL string if valid, `null` otherwise

#### `sanitizeHtml(html)` → string
- Input: untrusted HTML (from `item.content`, `item.summary`, `item['content:encoded']`)
- Use a server-side HTML sanitizer (recommended: **`sanitize-html`** npm package)
- Allowlist: `p, br, strong, b, em, i, a[href], ul, ol, li, blockquote, h1-h6, pre, code, img[src][alt], figure, figcaption`
- Strip everything else (comments sections, forms, scripts, iframes, social widgets, data-* attributes)
- After sanitization, also remove common non-article patterns:
  - Elements matching selectors like `[id*="comment"]`, `[class*="share"]`, `[class*="social"]`, `[class*="related"]`, `[class*="sidebar"]`, `[class*="nav"]`, `[class*="footer"]`
  - This can be done with `sanitize-html`'s `exclusiveFilter` or with a post-process regex pass
- Return safe HTML string

#### `sanitizeItem(item)` → object
```js
function sanitizeItem(item) {
  return {
    title: sanitizeText(item.title || ''),
    link: sanitizeUrl(item.link),
    summary: sanitizeText(item.contentSnippet || item.summary || item.content || ''),
    content: sanitizeHtml(item.content || item['content:encoded'] || item.summary || ''),
    pubDate: item.pubDate || item.isoDate || null,
    author: sanitizeText(item.creator || item.author || ''),
    guid: item.guid || item.link || null,
  };
}
```

Key design decision: **return both `summary` (plain text, for card previews) and `content` (sanitized HTML, for reading view)**. This gives the client two clean fields with clear purposes.

### 2. Server-side: Fix `/api/article` content extraction

**File: wherever `extractReadableSection` / `stripHtmlTags` live**

The `/api/article` endpoint fetches the full article page and extracts content. Current issues:
- Comment sections, social buttons, and voting UI leak through
- HTML entities not decoded
- Returns raw-ish text with DOM artifacts

Fix:
- Use **`@mozilla/readability`** (the library behind Firefox Reader View) instead of the current `extractReadableSection`. It's purpose-built for this exact problem.
- Pipeline: fetch page HTML → parse with `jsdom` → run `Readability` → get clean article object with `title`, `content` (clean HTML), `textContent` (plain text), `excerpt`
- Then apply `sanitizeHtml()` from above to the Readability output as a second pass (belt and suspenders)
- Return both `html` (sanitized HTML for rich rendering) and `text` (plain text fallback)

```
npm install @mozilla/readability jsdom sanitize-html
```

```js
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const sanitizeHtml = require('sanitize-html');

app.get('/api/article', async (req, res) => {
  const response = await fetch(url);
  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    return res.status(422).json({ error: 'unreadable' });
  }

  return res.json({
    title: sanitizeText(article.title),
    author: sanitizeText(article.byline || ''),
    content: sanitizeHtml(article.content, { /* allowlist config */ }),
    excerpt: sanitizeText(article.excerpt || ''),
    siteName: sanitizeText(article.siteName || ''),
    length: article.length,  // word count from Readability
  });
});
```

### 3. Client-side: Replace `stripHtml` utility

**File: wherever `stripHtml` is defined**

Delete the current `innerHTML`-based `stripHtml`. Replace with:

```js
// Safe text extraction — no DOM parsing of untrusted HTML
function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>/g, '')        // strip tags
    .replace(/&nbsp;/gi, ' ')       // common entity
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}
```

This is now a pure string function with no DOM interaction. It's a fallback only — the server should be doing the real sanitization.

### 4. Client-side: Validate URLs before use in `href`

**File: wherever links are rendered**

```js
function safeHref(url) {
  if (!url) return '#';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return url;
    }
  } catch {}
  return '#';
}
```

Apply to all `href` attributes built from feed item links and digest ref links.

---

## Dependencies to install

```
npm install sanitize-html @mozilla/readability jsdom
```

## Files to modify

| File | Change |
|------|--------|
| `server.js` (or new `lib/sanitize.js`) | Add `sanitizeText`, `sanitizeUrl`, `sanitizeHtml`, `sanitizeItem`. Apply in `/api/rss` route. |
| `server.js` `/api/article` route | Replace `extractReadableSection` + `stripHtmlTags` with Readability + sanitize-html pipeline. |
| Client utility file (where `stripHtml` lives) | Replace `stripHtml` with pure string version. Add `safeHref`. |
| Client rendering code | Use `safeHref()` for all link hrefs. |

## Out of scope

- Changing the feed list UI or card layout (that's SPEC-002)
- Digest sanitization (follow-up spec)
- Caching or feed refresh logic

## Testing

After implementation, verify with these feeds (they're known to include noisy HTML):
- Marginal Revolution (comment sections, social buttons — the exact bug in the screenshot)
- Any WordPress blog (typically heavy markup in `content:encoded`)
- Hacker News RSS (minimal content, good sanity check that clean feeds still work)

Manual checks:
1. Open an article from Marginal Revolution → no comment section HTML, no data attributes, no social buttons
2. View page source / inspect the rendered article → no `<script>`, no `onclick`, no `javascript:` hrefs
3. Feed items with `&nbsp;` in titles render as normal spaces
