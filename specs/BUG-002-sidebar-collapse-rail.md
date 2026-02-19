# BUG-002: Sidebar Desktop Collapse — Icon Rail

## Priority: P1

---

## Problem

On desktop, the sidebar either fully hides or collapses to a broken narrow strip. Feedly's pattern is better: the sidebar collapses to a thin icon rail (~48px wide) showing just the hamburger menu icon and key view icons. Clicking the hamburger or any icon expands it back to full width.

---

## What Feedly Does (from screenshots)

### Expanded (full sidebar):
```
┌──────────────────────────┐
│  RSS Viewer  52 FEEDS    │
│                          │
│  ◷ Today                 │
│  ✦ Digest AI             │
│  📄 Read Later        3  │
│  ◷ Recently Read         │
│                          │
│  FEEDS                   │
│  > Thinkers         145  │
│  > Dev               25  │
│  > Business          80  │
│  ...                     │
└──────────────────────────┘
```

### Collapsed (icon rail):
```
┌────┐
│ ☰  │
│    │
│    │
│    │
│    │
│    │
│    │
│    │
└────┘
```

- ~48px wide
- Shows only the hamburger ☰ toggle button at the top
- Main content area expands to fill the freed space
- Clicking ☰ expands back to full sidebar

---

## Implementation

### Desktop (≥ 769px)

Two states toggled by clicking the ☰ hamburger button:

**Expanded** (default):
- Sidebar at full width (260px)
- All content visible: views, feed folders, search, badges
- Hamburger icon visible at the top

**Collapsed**:
- Sidebar shrinks to 48px
- Only the ☰ hamburger icon visible
- All text, badges, feed lists, section titles hidden
- Main content area expands to fill the space

### CSS:

```css
/* Desktop sidebar states */
@media (min-width: 769px) {
  .sidebar {
    width: 260px;
    min-width: 260px;
    transition: width 0.2s ease, min-width 0.2s ease;
    overflow: hidden;
  }

  .sidebar.collapsed {
    width: 48px;
    min-width: 48px;
  }

  /* Hide everything except the hamburger when collapsed */
  .sidebar.collapsed .sidebar-header-text,
  .sidebar.collapsed .sidebar-section,
  .sidebar.collapsed .sidebar-search {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.1s ease;
  }

  .sidebar:not(.collapsed) .sidebar-header-text,
  .sidebar:not(.collapsed) .sidebar-section,
  .sidebar:not(.collapsed) .sidebar-search {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.15s ease 0.1s; /* slight delay so width animates first */
  }

  /* Hamburger always visible */
  .sidebar-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    cursor: pointer;
    flex-shrink: 0;
  }
}
```

### JS:

```js
// Toggle sidebar collapse on desktop
hamburgerBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('rss_sidebar_collapsed', sidebar.classList.contains('collapsed'));
});

// Restore on load
if (localStorage.getItem('rss_sidebar_collapsed') === 'true') {
  sidebar.classList.add('collapsed');
}
```

### Mobile (< 769px) — keep existing behavior

The SPEC-004 mobile behavior stays: sidebar slides in from left over content with overlay, hamburger opens/closes it. No icon rail on mobile — screen is too narrow.

---

## Acceptance Criteria

1. On desktop, clicking ☰ collapses sidebar to a ~48px icon rail showing only the hamburger
2. Clicking ☰ again expands back to full 260px sidebar
3. Collapse state persists across page refreshes via localStorage
4. Main content area expands/contracts to fill available space when sidebar toggles
5. Smooth width transition (~200ms)
6. Text and badges fade out before width shrinks, fade in after width expands
7. Mobile behavior unchanged (full slide-in/out with overlay from SPEC-004)
