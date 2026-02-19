# SPEC-005: Read / Unread Tracking

## Status: Ready for implementation
## Priority: P1
## Estimated scope: Medium (~3-4 files, client-only)

---

## Problem

There's no way to track which articles have been read. Unread counts in the sidebar are based on total feed items, not actual read state. Users can't distinguish read from unread articles in the feed, can't manually toggle read state, and can't mark a whole category as read.

---

## Solution

Four behaviors, all backed by localStorage:

1. **Auto-mark as read** when an article is expanded
2. **Manual toggle** button in the article toolbar
3. **Mark all as read** per category or feed
4. **Visual distinction** — read articles appear dimmed in the feed list

---

## 1. localStorage Schema

Key: `rss_read_articles`

Value: JSON object mapping article GUIDs to read timestamps.

```js
{
  "guid-123": "2026-02-18T20:30:00Z",
  "guid-456": "2026-02-18T19:15:00Z",
  // ...
}
```

Using an object (not an array) for O(1) lookups. The timestamp is stored for potential future use (e.g., "mark as unread if read more than 30 days ago" cleanup).

### Utility functions:

```js
// Read state
function getReadArticles() {
  try {
    return JSON.parse(localStorage.getItem('rss_read_articles') || '{}');
  } catch {
    return {};
  }
}

function isRead(guid) {
  return guid in getReadArticles();
}

// Mark as read
function markAsRead(guid) {
  const read = getReadArticles();
  if (read[guid]) return; // already read
  read[guid] = new Date().toISOString();
  localStorage.setItem('rss_read_articles', JSON.stringify(read));
}

// Mark as unread
function markAsUnread(guid) {
  const read = getReadArticles();
  delete read[guid];
  localStorage.setItem('rss_read_articles', JSON.stringify(read));
}

// Toggle
function toggleRead(guid) {
  if (isRead(guid)) {
    markAsUnread(guid);
  } else {
    markAsRead(guid);
  }
  return isRead(guid);
}

// Mark multiple as read (for "mark all as read")
function markMultipleAsRead(guids) {
  const read = getReadArticles();
  const now = new Date().toISOString();
  guids.forEach(guid => {
    if (!read[guid]) read[guid] = now;
  });
  localStorage.setItem('rss_read_articles', JSON.stringify(read));
}
```

### Storage management

Over time this object grows unboundedly. Add a cleanup function that runs on app load:

```js
function cleanupReadArticles(maxAge = 30) {
  const read = getReadArticles();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAge);
  const cutoffISO = cutoff.toISOString();

  let changed = false;
  for (const guid in read) {
    if (read[guid] < cutoffISO) {
      delete read[guid];
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem('rss_read_articles', JSON.stringify(read));
  }
}
```

Call `cleanupReadArticles()` once on app startup. Articles read more than 30 days ago are purged. This keeps localStorage from growing indefinitely.

---

## 2. Auto-Mark as Read on Expand

When the user clicks an article card to expand it, immediately mark it as read.

In the expand handler (same place that adds to Recently Read from SPEC-004):

```js
function onArticleExpand(article) {
  markAsRead(article.guid);
  addToRecentlyRead(article);  // existing from SPEC-004
  updateCardReadState(article.guid);  // update visual state
  updateUnreadCounts();  // recalculate sidebar badges
}
```

This should feel instant — no delay, no animation on the read state change.

---

## 3. Manual Toggle in Article Toolbar

Add a toggle button to the article toolbar (between Save/Read Later and Open Original):

### Toolbar layout (updated):

```
┌──────────────────────────────────────────────────────────────────────┐
│  [✦ Summarize AI]  [📄 Read Later]  [● Mark unread]    [→ Open original] │
└──────────────────────────────────────────────────────────────────────┘
```

### Button states:

**When article is read** (default after expanding):
- Label: "Mark unread"
- Icon: open circle or envelope icon (○)
- Muted style (same as other toolbar buttons)

**When article is unread** (after user manually marks it unread):
- Label: "Mark read"
- Icon: filled circle or check (●)
- Muted style

### Behavior:
- Click toggles the read/unread state
- Updates the button label/icon immediately
- Updates the card's visual state (dimmed/not dimmed)
- Recalculates sidebar unread counts

### Use case:
User expands an article (auto-marked read), skims it, realizes they want to come back to it later → clicks "Mark unread" so it stays prominent in the feed.

---

## 4. Mark All as Read

### Per category

Add a "Mark all read" action to each category section in the Today view.

When a category is expanded and showing article cards, show a subtle "Mark all read" link in the category header area:

```
▼  THINKERS                                    Mark all read
   64 items · 5 feeds · 53 unread
```

- Muted text, right-aligned in the category header row
- Only visible when category is expanded (no need to show it when collapsed)
- Also acceptable: always visible in the category header row regardless of expand state

On click:
1. Collect all article GUIDs in that category
2. Call `markMultipleAsRead(guids)`
3. Update all card visual states in that category to read (dimmed)
4. Update sidebar unread count for that category to 0
5. Update the stats line (`53 unread` → `0 unread`)

### Per feed (in sidebar)

When a category folder is expanded in the sidebar showing individual feeds, add a right-click or hover action on each feed to "Mark all read" for that specific feed. 

Simplest approach: show a small "✓" button on hover, right side of the feed row:

```
    Marginal Revolution    15   [✓]  ← appears on hover
```

On click:
1. Collect all article GUIDs from that specific feed
2. Mark all as read
3. Update badge count to 0

If this is too complex for now, skip the per-feed hover button and only implement the per-category "Mark all read" link. Per-feed can be a follow-up.

---

## 5. Visual Distinction for Read Articles

### Card appearance when read:

Apply a `.is-read` class to article cards that have been read.

```css
.article-card.is-read {
  opacity: 0.6;
}

.article-card.is-read:hover {
  opacity: 0.8;
}

.article-card.is-read .article-title {
  font-weight: 500;  /* lighter than unread's 600 */
}
```

Key visual changes:
- **Reduced opacity** on the entire card (0.6) — most impactful, immediately scannable
- **Lighter title weight** — unread titles are bolder, read titles are regular weight
- **No other changes** — don't change background color, borders, or layout. Keep it subtle.

When a card is expanded (and therefore marked read), don't apply the dimming to the expanded card itself — that would be jarring while reading. Apply the `.is-read` styling only when the card is collapsed.

```css
/* Don't dim the currently expanded card even if read */
.article-card.is-read.expanded {
  opacity: 1;
}

.article-card.is-read.expanded .article-title {
  font-weight: 600;
}
```

### On page load / render:

When rendering article cards, check `isRead(guid)` for each card and apply `.is-read` class accordingly.

### Unread count updates:

The sidebar unread counts must be recalculated based on actual read state, not just total items. When rendering or updating the sidebar:

```js
function getUnreadCount(feedItems) {
  return feedItems.filter(item => !isRead(item.guid)).length;
}
```

Apply this to:
- Individual feed badges in the sidebar
- Category aggregate badges in the sidebar
- The "All" feed count
- The stats line in category sections (`X unread`)

---

## Implementation Order

1. **localStorage utility functions** — `getReadArticles`, `isRead`, `markAsRead`, `markAsUnread`, `toggleRead`, `markMultipleAsRead`, `cleanupReadArticles`. Put in `public/lib/read-state.js` or add to existing utils.
2. **Auto-mark on expand** — in the article expand handler, call `markAsRead(guid)`. This is one line of code.
3. **Visual distinction** — add `.is-read` class to cards, CSS for dimmed appearance, apply on render and on state change.
4. **Recalculate unread counts** — sidebar badges and category stats lines based on actual read state. Write an `updateUnreadCounts()` function that recalcs everything.
5. **Manual toggle button** — add "Mark unread" / "Mark read" button to toolbar, wire toggle.
6. **Mark all as read (per category)** — add link to category header, wire to `markMultipleAsRead`.
7. **Mark all as read (per feed)** — hover button on feed row in sidebar (optional, lower priority).
8. **Cleanup on startup** — call `cleanupReadArticles()` on app load.

---

## Files to Modify

| File | Change |
|------|--------|
| New: `public/lib/read-state.js` (or add to utils) | All read state localStorage functions |
| Article card component/template | Add `.is-read` class based on state, add "Mark unread/read" toolbar button |
| Article expand handler | Call `markAsRead()` and `updateUnreadCounts()` |
| Sidebar rendering | Recalculate badge counts using `isRead()` |
| Category section in feed view | Add "Mark all read" link |
| CSS | `.is-read` card styles (opacity, font-weight) |
| App init | Call `cleanupReadArticles()` on startup |

---

## Acceptance Criteria

1. Expanding an article auto-marks it as read
2. Read articles appear dimmed (lower opacity, lighter title) when collapsed
3. The currently expanded article is NOT dimmed even though it's read
4. "Mark unread" button in toolbar toggles the article back to unread (undimmed, bolder title)
5. "Mark read" button toggles it back to read
6. Sidebar unread counts reflect actual read state, not total items
7. Sidebar counts update immediately when articles are marked read/unread
8. "Mark all read" on a category marks every article in that category as read, dims all cards, updates count to 0
9. Read state persists across page refreshes (localStorage)
10. Articles read more than 30 days ago are automatically cleaned up from localStorage on app start
11. Toggling read/unread on one article does not affect any other article's state
