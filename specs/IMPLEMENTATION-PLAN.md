# Implementation Plan: Article Reading View

## Overview

Two specs, implemented in order. The goal is to fix the broken article reading experience — raw HTML/DOM artifacts currently leak into the article body, and there's no reading-optimized layout.

**Read both specs fully before writing any code.**

---

## Phase 1: SPEC-001 — Content Sanitization

**Read** `SPEC-001-content-sanitization.md` **first.**

### Install dependencies

```bash
npm install sanitize-html @mozilla/readability jsdom

```

### Tasks (in order)

1. Create `lib/sanitize.js` with four functions:
  - `sanitizeText(str)` — strip HTML tags, decode entities, trim
  - `sanitizeUrl(url)` — allowlist `http:`/`https:` only, return null for anything else
  - `sanitizeHtml(html)` — use `sanitize-html` with the allowlist specified in the spec. Strip comment sections, social widgets, share buttons, nav elements, footers
  - `sanitizeItem(item)` — normalize an RSS item into a clean object with both `summary` (plain text for card previews) and `content` (sanitized HTML for reading view)
2. Wire `sanitizeItem` into the `/api/rss` route in `server.js`:
  - Import sanitize functions
  - Map all `feed.items` through `sanitizeItem` before sending JSON response
  - Also sanitize `feed.title`, `feed.description`, `feed.link`
3. Rewrite the `/api/article` route:
  - Replace `extractReadableSection` + `stripHtmlTags` with `@mozilla/readability` + `jsdom`
  - Pipeline: fetch HTML → JSDOM → Readability.parse() → sanitizeHtml on the output
  - Return `{ title, author, content (sanitized HTML), excerpt, siteName, length }`
  - Return 422 if Readability can't parse the page
4. Fix client-side `stripHtml`:
  - Replace the `innerHTML`-based implementation with the pure string regex version from the spec
  - This is now a fallback only — server does the real sanitization
5. Add `safeHref` utility on the client:
  - Validate URL scheme before using in any `href` attribute
  - Apply to feed item links and digest ref links

### How to verify Phase 1 is working

- Hit `GET /api/rss?url=https://marginalrevolution.com/feed` and inspect the JSON response
- `items[].content` should be clean HTML with no `data-*` attributes, no comment markup, no social buttons
- `items[].summary` should be plain text with no HTML tags or raw entities
- Hit `GET /api/article?url={any-marginal-revolution-post-url}` and verify clean HTML output with no DOM artifacts

---

## Phase 2: SPEC-002 — Article Reading View (Inline Expand)

**Read** `SPEC-002-article-reading-view.md` **and reference** `rss-reader-mockup.html`**.**

The mockup is the source of truth for visual design. Match it.

### Tasks (in order)

1. **Expand/collapse mechanics**:
  - Clicking a card toggles an `.expanded` class on the card element
  - Accordion: only one card expanded at a time — expanding one collapses others
  - On expand, scroll the card into view after a brief delay (`scrollIntoView({ behavior: 'smooth', block: 'start' })`)
  - The expand animation uses `max-height` transition on a `.article-expanded` wrapper
2. **Expanded card DOM structure** — inside each article card, add:
  ```
  .article-card
    .article-card-header  (existing: meta, title, snippet)
    .article-expanded     (new: hidden by default, revealed on expand)
      .article-toolbar
      .ai-summary         (conditional)
      .article-body
      .read-original

  ```
3. **Toolbar**:
  - Left: Summarize (primary style, accent background), Save (stub), More (stub)
  - Right: Open Original → `window.open(safeHref(item.link), '_blank')` — `safeHref` **already exists in** `public/app.js` **from Phase 1, use it**
  - Small icon+label buttons, muted colors
  - Thin top border separating toolbar from card header
4. **Article body rendering**:
  - **NOTE:** `setArticleBody(el, htmlOrText)` **already exists in** `public/app.js` **from Phase 1.** It handles innerHTML insertion and post-processing (target="_blank" on links, loading="lazy" on images). **Reuse it — do not rewrite this logic.**
  - Check if `item.content` from the RSS response is sufficient (>200 chars, doesn't end with `...`)
  - If sufficient: call `setArticleBody(bodyEl, item.content)`
  - If truncated: show shimmer skeleton, fetch from `/api/article?url={item.link}`, then call `setArticleBody(bodyEl, response.content)` on success
  - On fetch error: show summary text + prominent "Read on [source]" link
5. **Typography CSS** — apply all styles from the spec:
  - `.article-body` max-width 62ch, line-height 1.75, font-size 15px
  - Paragraph spacing, link styles, blockquote left border, image border-radius, code block styling, heading sizes
  - Match the mockup exactly
6. **AI summary section**:
  - Port existing Summarize feature into the expanded card
  - Position between toolbar and article body
  - Blue left border, darker background
  - If no summary exists, section is hidden until user clicks Summarize
7. **Loading skeleton**:
  - 3-4 shimmer lines with pulse animation
  - Shown only while fetching from `/api/article`
8. **Keyboard navigation**:
  - `Escape` → collapse expanded article
  - `j`/`↓` → next article
  - `k`/`↑` → previous article
  - `o`/`Enter` → open original in new tab
  - `m` → no-op stub (future: toggle read)
  - `s` → no-op stub (future: save)
  - Only active when an article is expanded
9. **Visual polish**:
  - Expanded card: accent border color, slightly darker background
  - Collapsed card: subtle hover state
  - Smooth transitions on all state changes

### How to verify Phase 2 is working

- Click an article → it expands smoothly downward showing toolbar and article body
- Click another → first one collapses, second expands
- Article body shows clean formatted HTML (paragraphs, links, blockquotes)
- No raw HTML, no DOM artifacts, no `&nbsp;` literals
- Open the Marginal Revolution "Germany projection" article → should show clean text with the FT link and the Ifo economist quote in a styled blockquote
- Press Escape → article collapses
- "Open original" → opens source URL in new tab
- On mobile viewport → cards are full-width, readable

---

## Important Notes

- Do NOT change the sidebar, feed list layout, or header. Only the article card expand behavior and content rendering.
- Do NOT add new routes or change the URL structure. This is all client-side UI work (except the server sanitization in Phase 1).
- The mockup HTML file (`rss-reader-mockup.html`) shows the exact visual treatment. When in doubt, match the mockup.
- Stub Save, More, and mark-as-read handlers. They should exist as click handlers that do nothing — they'll be implemented in future specs.

