# BUG-004: Category Block Should Be Fully Clickable

## Priority: P1

---

## Problem

In the Today feed view, each category section shows a header (`► DEV`), stats line (`25 items · 3 feeds · 25 unread`), and a "Latest" preview line. But only the `► DEV` chevron/title row is clickable to expand. Users instinctively click anywhere in the block — the stats line, the latest preview, the whitespace — expecting it to expand, and nothing happens.

## Fix

Wrap the entire category block (header + stats + latest preview) in a single clickable container. Clicking **anywhere** in that block expands the category to show its article cards.

```html
<div class="category-block" onclick="toggleCategory(this)">  <!-- whole thing clickable -->
  <div class="category-header">
    <span class="chevron">►</span>
    <span class="category-name">DEV</span>
  </div>
  <div class="category-meta">25 items · 3 feeds · 25 unread</div>
  <div class="category-latest">Latest: "My updated Home Server setup" · "Step Aside, Phone: Week 1" · ...</div>
</div>
```

Add `cursor: pointer` and a subtle hover state (same background highlight as other interactive elements) to the entire block so it's visually obvious it's clickable.

## Acceptance Criteria

1. Clicking anywhere in the category block (header, stats, latest, whitespace) toggles expand/collapse
2. The entire block shows `cursor: pointer`
3. Hover state applies to the full block, not just the header row
