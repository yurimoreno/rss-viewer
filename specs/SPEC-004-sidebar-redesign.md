# SPEC-004: Sidebar Redesign

## Status: Ready for implementation
## Priority: P1
## Estimated scope: Medium (~3-4 files)
## Depends on: SPEC-003 (Save/Read Later localStorage functions)

---

## Problems

1. **Flat feed list** — every feed listed individually. With 52 feeds across 9 categories, the sidebar is too long to scan. Needs collapsible category folders.
2. **No Read Later view** — SPEC-003 adds save functionality but calls it "Saved." Rename to "Read Later" to match Feedly's language and user expectations.
3. **No Recently Read view** — no way to find an article you read earlier today. Need auto-tracked history.
4. **Broken mobile collapse** — the sidebar collapses to a narrow visible strip that overlaps content instead of fully hiding. Needs a proper slide-off-screen + overlay pattern.

---

## 1. Sidebar Structure

The sidebar should have these sections, in this order:

```
┌─────────────────────────┐
│  RSS Viewer  52 FEEDS   │
├─────────────────────────┤
│  VIEWS                  │
│    Today                │
│    Digest AI            │
│    Read Later     3     │
│    Recently Read        │
├─────────────────────────┤
│  FEEDS                  │
│    Search feeds...      │
│  ▶ Thinkers       64   │
│  ▶ Business        80  │
│  ▶ Dev             25  │
│  ▶ Tech           347  │
│  ▶ ...                  │
└─────────────────────────┘
```

### Views section

| Item | Behavior |
|------|----------|
| **Today** | Existing — shows today's articles across all feeds |
| **Digest AI** | Existing — AI-generated digest |
| **Read Later** | New — shows articles saved via the Save/Read Later button (SPEC-003). Rename from "Saved" everywhere. Badge shows count of read-later articles. |
| **Recently Read** | New — shows the last 20 articles the user expanded/read, most recent first |

### Feeds section

Each **category** is a collapsible folder. Individual feeds are nested inside.

---

## 2. Collapsible Category Folders

### Collapsed state (default):
```
▶ Thinkers                    64
```
- Chevron pointing right (▶)
- Category name
- Aggregate unread count (sum of all feeds in the category)

### Expanded state (on click):
```
▼ Thinkers                    64
    Wait But Why              10
    Daniel Gross               0
    Mad Fientist              20
    Julian.com                 9
    Marginal Revolution       15
    Mike Crittenden            0
```
- Chevron pointing down (▼)
- Individual feeds indented below
- Each feed shows its own unread count
- Feeds with 0 unread: dim the count badge (lower opacity)

### Behavior:
- Click the category row → toggle expand/collapse
- Multiple categories can be open at the same time (not accordion — user may want to see feeds from two categories)
- Collapse state persists in localStorage so it remembers which categories were open:
  ```
  localStorage key: 'rss_sidebar_state'
  value: { expandedCategories: ['Thinkers', 'Business'] }
  ```
- Clicking a **category name** toggles the folder open/closed — it does NOT filter the feed view
- Clicking an **individual feed** within a category filters the main view to show only that feed's articles

### Animation:
- Expand/collapse uses a smooth height transition (~200ms ease-out)
- Chevron rotates from right-pointing to down-pointing (90° rotation, ~150ms)

---

## 3. Read Later

Rename all references to "Saved" from SPEC-003:

| SPEC-003 name | New name |
|---|---|
| "Saved" sidebar item | "Read Later" |
| "Save" button label | "Read Later" |
| "Saved" button label (active state) | "Saved ✓" (keep this — "saved" as past tense confirmation is fine) |
| `rss_saved_articles` localStorage key | `rss_read_later` |
| `getSavedArticles()` | `getReadLaterArticles()` |
| `saveArticle()` | `addToReadLater()` |
| `unsaveArticle()` | `removeFromReadLater()` |
| `isArticleSaved()` | `isInReadLater()` |

The sidebar item shows a count badge with the number of read-later articles.

Icon: bookmark outline (📄 or simple bookmark SVG) to the left of "Read Later."

Everything else about the feature (localStorage, toggle behavior, article cards in the view) stays the same as SPEC-003.

---

## 4. Recently Read

### Auto-tracking

When the user **expands** an article card (i.e., clicks to read it), automatically record it in localStorage.

```js
localStorage key: 'rss_recently_read'
value: JSON array of objects, max 20 items, most recent first
```

Each entry:
```js
{
  guid: "unique-id",
  title: "Article title",
  link: "https://...",
  summary: "Plain text snippet...",
  source: "Marginal Revolution",
  readAt: "2026-02-18T20:45:00Z"
}
```

**Do NOT store `content` (sanitized HTML) in recently read.** Unlike Read Later, users aren't saving these to read offline — they already read them. Storing content would bloat localStorage. If they expand a recently read article, fetch the content fresh (from RSS cache or `/api/article`).

### Storage logic:

```js
function addToRecentlyRead(article) {
  let recent = getRecentlyRead();
  // Remove if already in list (move to top)
  recent = recent.filter(a => a.guid !== article.guid);
  // Add to front
  recent.unshift({
    guid: article.guid,
    title: article.title,
    link: article.link,
    summary: article.summary,
    source: article.source,
    readAt: new Date().toISOString()
  });
  // Cap at 20
  recent = recent.slice(0, 20);
  localStorage.setItem('rss_recently_read', JSON.stringify(recent));
}
```

### Recently Read view:

When the user clicks "Recently Read" in the sidebar:
- Header: "Recently Read"
- Article cards in order of `readAt` descending
- Same card component and expand behavior as feed view
- When expanding, fetch content from RSS cache or `/api/article` (since we don't store content)
- No count badge in the sidebar (it's not an inbox — just a history)

### Empty state:
```
┌─────────────────────────────────────────┐
│                                         │
│            ◷                            │
│                                         │
│     No recently read articles           │
│     Articles you read will              │
│     appear here.                        │
│                                         │
└─────────────────────────────────────────┘
```

---

## 5. Mobile Sidebar Fix

### Current bug
The sidebar collapses to a narrow strip that stays visible and overlaps the main content.

### Fix
On viewports < 768px, the sidebar should:

1. **Default to fully hidden** — off-screen to the left, `transform: translateX(-100%)`
2. **Open via hamburger menu** — tap the ☰ button → sidebar slides in from the left over the content
3. **Dark overlay behind it** — a semi-transparent overlay (`rgba(0,0,0,0.5)`) covers the main content
4. **Close on**:
   - Tapping the overlay
   - Tapping a sidebar item (after navigating to that view)
   - Tapping the ☰ button again
   - Swiping left on the sidebar (nice-to-have, not required)

### CSS:
```css
/* Mobile: sidebar off-screen by default */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    width: 280px;
    z-index: 100;
    transform: translateX(-100%);
    transition: transform 0.25s ease-out;
  }

  .sidebar.open {
    transform: translateX(0);
  }

  .sidebar-overlay {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 99;
  }

  .sidebar-overlay.visible {
    display: block;
  }
}

/* Desktop: sidebar always visible */
@media (min-width: 769px) {
  .sidebar {
    position: sticky;
    top: 0;
    transform: none;
  }

  .sidebar-overlay {
    display: none !important;
  }
}
```

### JS:
- Hamburger button toggles `.open` on sidebar and `.visible` on overlay
- Clicking overlay or sidebar item removes both classes
- On window resize to desktop width, remove `.open` class (clean up mobile state)

---

## Implementation Order

1. **Mobile sidebar fix** — do this first, it's a bug fix. Add overlay element, fix CSS for mobile slide-in/out, wire hamburger toggle.
2. **Collapsible category folders** — restructure feed list into category rows with nested feed lists. Add expand/collapse toggle with chevron rotation. Persist state to localStorage.
3. **Rename Save → Read Later** — update all labels, function names, and localStorage keys from SPEC-003. If SPEC-003 isn't implemented yet, just use the "Read Later" naming from the start.
4. **Recently Read** — add auto-tracking on article expand, localStorage capped at 20 entries, sidebar item, view rendering.
5. **Sidebar item icons** — add simple icons to the left of each Views item (optional polish, do last).

---

## Files to Modify

| File | Change |
|------|--------|
| Sidebar component/template | Restructure into Views section + collapsible Feeds section. Add Read Later + Recently Read items. |
| CSS | Collapsible folder styles, chevron rotation, mobile sidebar fix (translateX, overlay), indent for nested feeds |
| Feed list JS | Category expand/collapse toggle, localStorage persistence for folder state |
| Article expand handler | Add `addToRecentlyRead()` call when any article is expanded |
| SPEC-003 save utilities | Rename Saved → Read Later (functions and localStorage key) |
| View rendering logic | Add "recently_read" as a view that renders from localStorage, fetching content on expand |
| HTML | Add `.sidebar-overlay` element for mobile |

---

## Acceptance Criteria

1. Feed categories are collapsible folders with chevron indicators — click to expand/collapse
2. Multiple categories can be open simultaneously
3. Category folder state persists across page refreshes
4. Aggregate unread count shown on collapsed categories (sum of feeds within)
5. "Read Later" appears in Views with correct count badge
6. "Recently Read" appears in Views, shows last 20 expanded articles
7. Expanding an article automatically adds it to Recently Read
8. Recently Read does not store article content HTML (lightweight entries only)
9. On mobile (< 768px): sidebar is fully hidden by default, slides in from left on hamburger tap, dark overlay behind it, closes on overlay tap or item selection
10. No visible sidebar strip or overlap when sidebar is closed on mobile
