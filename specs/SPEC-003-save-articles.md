# SPEC-003: Save/Bookmark Articles

## Status: Ready for implementation
## Priority: P1
## Estimated scope: Small (~1-2 files, client-only)

---

## Problem

The Save button in the article toolbar is a no-op stub. The More button has nothing behind it. Users have no way to bookmark articles for later reading.

---

## Solution

### Save button
- Toggles an article as saved/unsaved
- Persists to `localStorage`
- Visual state changes on the button (filled icon when saved)
- Saved articles accessible via a new "Saved" view in the sidebar

### More button
- **Remove it.** There's nothing to put in it yet. Removing a dead button is better than showing one that does nothing. It can be re-added in a future spec when there are actual actions to surface.

---

## Save Behavior

### Toggling save state

When the user clicks the Save button on an expanded article:
1. If the article is **not saved**: save it → button icon fills in, label changes to "Saved"
2. If the article is **already saved**: unsave it → button icon goes back to outline, label changes to "Save"

The toggle should feel instant — update the UI optimistically, then write to localStorage.

### What gets saved

Store the minimum data needed to render a saved article card:

```js
{
  guid: "unique-id-from-feed",       // primary key
  title: "Article title",
  link: "https://...",
  summary: "Plain text snippet...",
  content: "Sanitized HTML...",       // so saved articles can be read offline
  source: "Marginal Revolution",      // feed name
  author: "Tyler Cowen",
  pubDate: "2026-02-18T15:11:00Z",
  savedAt: "2026-02-18T20:30:00Z"    // when the user saved it
}
```

### localStorage schema

Key: `rss_saved_articles`

Value: JSON array of saved article objects, ordered by `savedAt` descending (most recently saved first).

```js
// Read
function getSavedArticles() {
  try {
    return JSON.parse(localStorage.getItem('rss_saved_articles') || '[]');
  } catch {
    return [];
  }
}

// Save
function saveArticle(article) {
  const saved = getSavedArticles();
  // Don't duplicate
  if (saved.some(a => a.guid === article.guid)) return;
  saved.unshift({ ...article, savedAt: new Date().toISOString() });
  localStorage.setItem('rss_saved_articles', JSON.stringify(saved));
}

// Unsave
function unsaveArticle(guid) {
  const saved = getSavedArticles().filter(a => a.guid !== guid);
  localStorage.setItem('rss_saved_articles', JSON.stringify(saved));
}

// Check
function isArticleSaved(guid) {
  return getSavedArticles().some(a => a.guid === guid);
}
```

### Storage limits

localStorage has a ~5MB limit per origin. A typical saved article (with content HTML) is ~5-10KB. That gives room for ~500-1000 saved articles before hitting limits. No action needed now, but if `saveArticle` throws a `QuotaExceededError`, catch it and show a brief toast: "Storage full — unsave some articles to make room."

---

## Save Button UI

### In the article toolbar

Replace the current stub Save button with a working toggle:

**Unsaved state (default):**
```
[🔖 Save]
```
- Outline bookmark icon
- Label: "Save"
- Same muted style as other toolbar buttons

**Saved state:**
```
[🔖 Saved ✓]
```
- Filled/solid bookmark icon (same icon, filled variant or change color)
- Label: "Saved"
- Accent color (blue) on both icon and label to clearly show it's active
- Optional: brief checkmark or subtle pulse animation on save (not required)

### On the collapsed card (optional but recommended)

When a card is collapsed and the article is saved, show a small filled bookmark icon in the meta row (next to source tag, time, etc.) so the user can see at a glance which articles they've saved without expanding.

```
[Marginal Revolution]  3h · 1 min · ~155 words · 🔖
```

---

## Saved View in Sidebar

### Add a "Saved" item to the Views section

```
VIEWS
  Today          (existing)
  Digest AI      (existing)
  Saved          (new)
```

- Shows a count badge with the number of saved articles (e.g., `3`)
- If count is 0, show the item but with no badge (or badge with `0` dimmed — match how you handle 0-count feeds)

### Saved view content

When the user clicks "Saved" in the sidebar:

1. The main content area switches to show saved articles (same as switching to Today or Digest view)
2. Header: "Saved" with subtitle "X articles"
3. Article cards rendered the same as in the feed view — same card component, same expand behavior, same toolbar
4. Ordered by `savedAt` descending (most recently saved first)
5. The Save button in the toolbar shows "Saved" (filled state) for all cards in this view, and clicking it unsaves the article and removes it from the list

### Empty state

If there are no saved articles:
```
┌─────────────────────────────────────────┐
│                                         │
│            🔖                           │
│                                         │
│     No saved articles yet               │
│     Click Save on any article           │
│     to bookmark it for later.           │
│                                         │
└─────────────────────────────────────────┘
```
Centered, muted text, subtle bookmark icon.

---

## Implementation Order

1. **localStorage utility functions** — `getSavedArticles`, `saveArticle`, `unsaveArticle`, `isArticleSaved`. Put these in a `lib/saved.js` or add to existing utils.
2. **Wire up Save button** — replace the stub click handler. On click, toggle save state and update button appearance. On card expand, check `isArticleSaved` and set correct button state.
3. **Remove the More button** — delete it from the toolbar. Clean up any associated CSS/handlers.
4. **Collapsed card bookmark indicator** — if article is saved, show a small filled bookmark icon in the meta row.
5. **Saved sidebar item** — add "Saved" to the Views section with a count badge.
6. **Saved view** — render saved articles as cards when user clicks "Saved" in sidebar. Include empty state.

---

## Files to Modify

| File | Change |
|------|--------|
| New: `public/lib/saved.js` (or add to existing utils) | localStorage CRUD functions |
| Article card component/template | Save button toggle logic, remove More button, collapsed bookmark indicator |
| Sidebar | Add "Saved" view item with count badge |
| Feed/view rendering logic | Add "saved" as a view that renders saved articles |
| CSS | Saved button active state, collapsed bookmark indicator, empty state |

---

## Acceptance Criteria

1. Clicking Save on an expanded article saves it — button changes to "Saved" with accent color / filled icon
2. Clicking "Saved" again on the same article unsaves it — button reverts to "Save" with outline icon
3. Saved articles persist across page refreshes (localStorage)
4. "Saved" appears in the sidebar under Views with a count badge
5. Clicking "Saved" in the sidebar shows all saved articles, most recent first
6. Saved articles can be expanded and read just like feed articles
7. Unsaving an article from the Saved view removes it from the list
8. The More button is gone from the toolbar
9. Empty state shown when no articles are saved
