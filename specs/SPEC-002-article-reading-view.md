# SPEC-002: Article Reading View (Inline Expand)

## Status: Ready for implementation (depends on SPEC-001)
## Priority: P0
## Estimated scope: Medium (~2-3 files, new component + CSS + minor server change)

---

## Problem

The article reading view is currently broken:
- Raw HTML/DOM artifacts leak into the article body (comment sections, data attributes, social buttons)
- No reading-optimized typography or layout
- No separation between the card preview and the expanded article content
- HTML entities rendered as literal text

SPEC-001 fixes the data pipeline. This spec defines the UI.

---

## Interaction Model: Inline Expand (Accordion)

When the user clicks an article card, it **expands downward in place** to reveal the full article content below the card header. The card stays in the feed list — no panel, no route change.

### Opening an article
- User clicks an article card
- The card expands downward with a smooth animation (~300ms, ease-out)
- Any previously expanded card **collapses** (accordion behavior — only one article open at a time)
- The expanded card scrolls into view (top of card aligns near top of viewport)

### Closing an article
- Click the same card's header area again → collapses
- Click a different card → old one collapses, new one expands
- Press `Escape` → collapses the currently expanded card

### Visual states
- **Collapsed**: Card has a subtle border (`1px solid` with muted border color). Shows source tag, time, read time, word count, title, and 2-line snippet.
- **Expanded**: Card border changes to accent color (blue). Background shifts slightly darker. The snippet remains visible. Below the header, the expanded content area appears.

---

## Expanded Card Layout

When a card is expanded, the following sections appear below the card header, in this order:

### 1. Toolbar

A horizontal bar separating the card header from the article content.

```
┌─────────────────────────────────────────────────────────────────┐
│  [✦ Summarize AI]  [🔖 Save]  [••• More]      [→ Open original]│
└─────────────────────────────────────────────────────────────────┘
```

- **Left side**: Summarize (AI), Save, More
- **Right side**: Open original (opens `item.link` in new browser tab)
- Separated from card header by a thin top border
- Buttons are small, muted, icon+label. The Summarize button has a subtle accent background to make it the primary action.
- Save and More are stubs for now — wire click handlers that do nothing yet (future SPEC-003+)

### 2. AI Summary (conditional)

Appears between the toolbar and the article body. Two states:

**If summary exists** (previously generated or from digest):
```
┌──────────────────────────────────────────┐
│  ✦ TL;DR                                │
│                                          │
│  Two-three sentence AI summary.          │
└──────────────────────────────────────────┘
```
- Blue left border (3px), slightly different background
- Shown by default when article expands

**If no summary yet**:
- The summary section is not shown
- User clicks "Summarize" button in toolbar to generate one
- After generation, the summary block fades in below the toolbar

### 3. Article Body

The main article content, rendered as **sanitized HTML** (not plain text).

This is the critical section. The content must be:
- Clean HTML from SPEC-001 sanitization (paragraphs, links, blockquotes, headings, images, code blocks)
- Rendered via `innerHTML` — safe because server sanitized it
- Styled with reading-optimized typography (see below)

### 4. "Read on [source]" Link

At the bottom of the expanded content:
```
Read on marginalrevolution.com ↗
```
- Text link (not a button), subtle, with external link icon
- Opens `item.link` in new browser tab
- Source domain extracted from `item.link`

---

## Typography & Readability

### Article body container:
- `max-width: 62ch`
- `font-size: 15px`
- `line-height: 1.75`
- `font-family`: system font stack or IBM Plex Sans if already loaded
- Text color: slightly muted white (not full `#fff` — use `rgba(255,255,255,0.92)` or equivalent on dark bg)

### Paragraphs:
- `margin-bottom: 1.15em`
- No first-line indent

### Links within article body:
- Accent color (blue), no underline by default
- Underline on hover
- All links open in new tab (`target="_blank" rel="noopener noreferrer"`)

### Blockquotes:
- `border-left: 3px solid` (muted border color)
- `padding-left: 20px`
- Slightly muted text color
- Italic

### Images:
- `max-width: 100%`, `height: auto`
- `border-radius: 6px`
- `margin: 1.25em 0`

### Code:
- Inline code: monospace, slightly smaller, subtle background, `padding: 2px 6px`, `border-radius: 4px`
- Code blocks (`<pre><code>`): distinct background, `padding: 16px`, `border-radius: 8px`, horizontal scroll on overflow, `border: 1px solid` subtle border

### Headings (within article body):
- h1: Should not appear (article title is already in the card header)
- h2: `18px`, `font-weight: 600`, `margin-top: 1.8em`
- h3: `16px`, `font-weight: 600`, `margin-top: 1.5em`

---

## Content Rendering Pipeline

### Data flow when article expands:

1. User clicks card → card expands immediately with the toolbar visible
2. Check if `item.content` (sanitized HTML from SPEC-001's `/api/rss` response) is sufficient:
   - "Sufficient" = more than 200 characters AND does not end with `...`
3. **If content is sufficient**: Render `item.content` as HTML immediately. No loading state needed.
4. **If content is too short or truncated**: 
   - Show a skeleton/shimmer placeholder in the article body area
   - Fetch from `GET /api/article?url={item.link}` (which uses Readability per SPEC-001)
   - On success: render the returned `content` (sanitized HTML) 
   - On error: show the RSS `item.summary` as plain text + a prominent "Read on [source] →" link
5. After inserting HTML via `innerHTML`, post-process:
   - Add `target="_blank" rel="noopener noreferrer"` to all `<a>` tags in the article body
   - Add `loading="lazy"` to all `<img>` tags

### Loading state:
```
┌─────────────────────────────────────────┐
│  ████████████████████░░░░░ (shimmer)    │
│  ██████████████░░░░░░░░░░░              │
│  █████████████████████████░░░           │
└─────────────────────────────────────────┘
```
- 3-4 lines of shimmer blocks with a subtle pulse animation
- Appears only when fetching from `/api/article` (not for RSS-provided content)

---

## Expand/Collapse Animation

Use `max-height` transition for the expand/collapse:

```css
.article-expanded {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.article-card.expanded .article-expanded {
  max-height: 3000px; /* large enough for any article */
}
```

The expanded content wrapper (`.article-expanded`) contains the toolbar, AI summary, article body, and read-original link. It animates from `max-height: 0` to a large value.

On expand, after a short delay (~50ms), scroll the card into view:
```js
card.scrollIntoView({ behavior: 'smooth', block: 'start' });
```

---

## Keyboard Navigation

When an article is expanded:
- `Escape` → collapse the currently expanded article
- `j` or `↓` → collapse current, expand next article card in the list
- `k` or `↑` → collapse current, expand previous article card in the list
- `o` or `Enter` → open original article in new browser tab
- `m` → toggle read/unread (stub — no-op for now, future spec)
- `s` → save/bookmark (stub — no-op for now, future spec)

Keyboard listeners should only be active when an article is expanded. Remove/disable when all articles are collapsed.

---

## Implementation Order

1. **Expand/collapse mechanics** — clicking a card toggles `.expanded` class, accordion behavior (only one open), scroll into view
2. **Expanded card structure** — add the `.article-expanded` wrapper inside each card containing toolbar, body area, and read-original link
3. **Toolbar** — Summarize (AI), Save, More, Open Original buttons with correct layout. Wire Open Original to `window.open(item.link)`. Summarize reuses existing AI summary logic. Save/More are no-op stubs.
4. **Article body rendering** — render `item.content` (sanitized HTML from SPEC-001) via innerHTML. Post-process links and images. Implement the fallback to `/api/article` for truncated content.
5. **Typography CSS** — all the reading styles (max-width, line-height, paragraph spacing, blockquotes, code, headings, links)
6. **AI summary section** — port existing Summarize feature into the expanded card, positioned between toolbar and body
7. **Loading state** — shimmer skeleton for when `/api/article` is being fetched
8. **Keyboard navigation** — Escape, j/k, o
9. **Visual polish** — expanded card border accent, background shift, smooth transitions

**Steps 1-3 and 5 can be done before SPEC-001 is complete** (using placeholder/dummy article content).  
**Steps 4 and 7 require SPEC-001** to be done (sanitized HTML from server).

---

## Files to Modify

| File | Change |
|------|--------|
| Article card component/template | Add `.article-expanded` wrapper with toolbar, body container, read-original link inside each card |
| CSS (main stylesheet or new file) | All typography and expanded-state styles from this spec |
| Feed list JS | Accordion toggle logic, scroll-into-view, keyboard listeners |
| Article body renderer (new or existing) | innerHTML insertion, link/image post-processing, fallback to `/api/article` |

---

## Out of Scope (future specs)

- Mark as read/unread functionality (stub the handler)
- Save/bookmark functionality (stub the handler) 
- "More" menu contents
- Scroll position memory
- Text size controls
- Progress indicator
- Share functionality

---

## Acceptance Criteria

1. Clicking a collapsed article card expands it downward to show toolbar + article body + read-original link
2. Only one article is expanded at a time (accordion)
3. Clicking an expanded card's header collapses it
4. Article body renders as **formatted HTML** — paragraphs, links, blockquotes, headings, images all styled correctly
5. **No leaked HTML artifacts**: no comment sections, no social buttons, no `data-*` attributes, no raw `&nbsp;` entities
6. Article body has proper reading typography: ~62ch max-width, 1.75 line height, paragraph spacing
7. "Open original" button opens source URL in new tab
8. Escape key collapses the expanded article
9. If RSS content is truncated, it fetches full article from `/api/article` and shows a loading skeleton while fetching
10. The Marginal Revolution "Germany projection" article from the original screenshot renders cleanly with no DOM leakage — **this is the primary regression test**

---

## Reference Mockup

See `rss-reader-mockup.html` for the approved interactive mockup showing both collapsed and expanded states, toolbar layout, AI summary placement, and typography.
