# BUG-003: Top Bar and Content Width Issues

## Priority: P0

---

## Problem 1: Top bar is disconnected from sidebar

There's a separate fixed top header bar (`RSS Viewer 52 FEEDS | Refresh | Feeds | Settings`) that sits above both the sidebar and the main content. This is wrong. In Feedly:

- There is **no separate top bar**
- The "RSS Viewer 52 FEEDS" branding is **inside the sidebar**, at the top
- The Refresh / Feeds / Settings controls are **inside the main content area**, not in a fixed top bar

### Fix

**Remove the fixed top header bar entirely.** Redistribute its contents:

- **"RSS Viewer 52 FEEDS"** — already exists inside the sidebar header. Remove the duplicate from the top bar.
- **Hamburger ☰** — move it into the sidebar itself (top-left of the sidebar, always visible even when collapsed). It already exists there based on the screenshots.
- **"Refresh" button** — move into the main content area, top-right of the feed header (next to "Expand all / Collapse all" which is already there)
- **"Feeds" and "Settings" links** — move into the sidebar, at the bottom (like Feedly puts "Integrations & API", "Blog", "Learn & Get Support" at the sidebar bottom)

After this change:
- The sidebar goes all the way to the top of the viewport
- The main content area goes all the way to the top of the viewport
- There is no fixed bar above either of them
- The layout is just: `[sidebar] [main content]` — two columns, full height

---

## Problem 2: Main content doesn't expand when sidebar collapses

When the sidebar collapses to the 48px icon rail, the main content area stays at its previous width instead of expanding to fill the freed space.

### Fix

The main content area must be in a flex layout that automatically takes remaining space:

```css
.app {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 260px;
  min-width: 260px;
  transition: width 0.2s ease, min-width 0.2s ease;
  flex-shrink: 0;
}

.sidebar.collapsed {
  width: 48px;
  min-width: 48px;
}

.main {
  flex: 1;          /* THIS is the key — takes all remaining space */
  min-width: 0;     /* prevents flex child from overflowing */
  /* Do NOT set a fixed width or max-width on .main that would prevent expansion */
}
```

Check for any of these issues that could prevent `.main` from expanding:
- `.main` has a fixed `width` or `max-width` that caps it — **remove fixed width, keep only `max-width` on the inner content area if needed for readability**
- `.main` has `margin-left` matching the sidebar width — **remove, let flexbox handle it**
- `.main` is using `calc(100% - 260px)` or similar — **remove, use `flex: 1` instead**
- The top bar was taking up the full width and pushing layout — **removing the top bar (Problem 1) may fix this automatically**

### Structure should be:

```html
<div class="app">
  <aside class="sidebar">
    <!-- hamburger, branding, views, feeds — full height -->
  </aside>
  <main class="main">
    <!-- feed header with Refresh button, content area -->
  </main>
</div>
```

No wrapper divs, no top bar, no fixed positioning tricks. Just two flex children.

---

## Where to put Refresh / Feeds / Settings after removing top bar

### Refresh button
Place it in the main content feed header, aligned right:

```
┌──────────────────────────────────────────────────────────┐
│  TODAY                          ↻ Refresh                │
│  Today                    Expand all · Collapse all      │
└──────────────────────────────────────────────────────────┘
```

### Feeds and Settings
Place them at the bottom of the sidebar:

```
┌──────────────────────────┐
│  ☰  RSS Viewer           │
│                          │
│  VIEWS                   │
│  ...                     │
│                          │
│  FEEDS                   │
│  ...                     │
│                          │
│  ────────────────────    │  ← subtle divider
│  ⚙ Settings              │
│  📡 Manage Feeds         │  ← rename "Feeds" to "Manage Feeds" for clarity
└──────────────────────────┘
```

These bottom items are hidden when sidebar is collapsed (same as everything else except ☰).

---

## Acceptance Criteria

1. No fixed top header bar exists — sidebar and main content both extend to the top of the viewport
2. Hamburger ☰ is inside the sidebar (top), not in a separate bar
3. Refresh button is in the main content area header
4. Settings and Manage Feeds are at the bottom of the sidebar
5. When sidebar collapses to 48px rail, main content expands to fill the full remaining width immediately
6. When sidebar expands back to 260px, main content contracts accordingly
7. Width transitions are smooth (~200ms)
8. Article cards in the main content reflow to the new width (no fixed-width cards)
