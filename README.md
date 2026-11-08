# RSS Viewer

Feedly-style RSS reader with AI digest via OpenRouter or a local OpenAI-compatible LLM (vLLM/Ollama). Node + Express, vanilla JS, localStorage. No build step.

## Features

- **Today** – Feed list by category, inline expand/collapse, per-article AI summary, All/Unread filter, read/unread toggle (auto on expand; in Unread, read rows stay grayed so you can undo until you leave the view), mark-all-read (per category or whole view), Read Later and Recently Read views
- **Linkable views** – The address bar tracks the view (`#/feed/<url>`, `#/category/<name>`, `#/later`, `#/digest`, `#/feeds`…), so back/forward and bookmarks work
- **Feed & category digest (AI-first)** – Opening a single feed, or clicking a category name (e.g. Business), leads with an AI digest for that scope (Unread or All). Generate is explicit (no auto LLM on open); results cache until the item set changes. Chevron on a category only expands/collapses the feed list. Source items stay below for optional deep dives.
- **Digest** – Cross-feed AI summary via OpenRouter or local LLM, time window (24h/7d/unread), source links, mark digest items as read
- **Settings** – AI provider (OpenRouter or local LLM base URL), separate models for digest/summary, editable prompts, refresh interval, light theme
- **Feeds** – Add/remove feeds, import/export OPML, feed list with search. Paste a site's address and the feed is auto-discovered (`<link rel=alternate>` or common paths)
- **Feed health** – Each feed shows OK / Failing / Broken / stale (no posts in 90 days) with the last error; a filter lists only problem feeds, and broken feeds get a ⚠ in the sidebar. The server sends conditional requests (ETag / Last-Modified), honors `Cache-Control`, and backs off failing feeds (15 min × 1.8ⁿ, max 24 h, or `Retry-After`). State lives in `data/feed-state.json`
- **Shortcuts** – `j`/`k` (or `n`/`p`) next/previous (opens the first article if none is open), `o`/`Enter` open original, `m` toggle read, `s` Read Later, `Escape` collapse, `g a`/`g u`/`g s`/`g r`/`g d`/`g f` jump to All/Unread/Read Later/Recently Read/Digest/Feeds, `/` search feeds, `Shift+R` refresh, `?` help

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000 (or `PORT`, if set). Core RSS reading works with no configuration. For Digest/Summarize, set an AI provider in Settings: OpenRouter (needs an API key) or a local OpenAI-compatible server like vLLM/Ollama (no key needed).

## Scripts

| Command   | Description        |
| --------- | ------------------ |
| `npm start` | Production server |
| `npm run dev` | Dev with watch   |
| `npm test` | Run tests         |
