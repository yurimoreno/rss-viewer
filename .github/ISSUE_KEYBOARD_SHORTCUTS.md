# Keyboard shortcuts not working

**Copy the content below into a new GitHub issue.**

---

## Title
Keyboard shortcuts not working

## Description

The article reading view (SPEC-002) defines keyboard shortcuts that are currently not working:

- **Escape** — collapse expanded article
- **j** / **↓** — next article
- **k** / **↑** — previous article  
- **o** / **Enter** — open original in new tab
- **m** — (stub) toggle read
- **s** — (stub) save

The shortcuts menu has been removed from the UI until this is fixed. The keydown handlers exist in `public/app.js` but do not trigger as expected (e.g. focus/scope or event propagation may need adjustment).

**Spec reference:** `specs/SPEC-002-article-reading-view.md` (Keyboard Navigation section)  
**Implementation plan:** `specs/IMPLEMENTATION-PLAN.md` Phase 2, task 8

## Acceptance criteria

- [ ] When an article card is expanded, pressing **Escape** collapses it
- [ ] **j** / **↓** expands the next article (accordion)
- [ ] **k** / **↑** expands the previous article
- [ ] **o** / **Enter** opens the article’s original URL in a new tab
- [ ] Shortcuts are only active when an article is expanded (or document has focus in the reader view)
- [ ] Optional: Re-add a “Keyboard shortcuts” entry in the UI that opens a modal listing these shortcuts
