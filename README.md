# RSS Viewer

Feedly-style RSS reader with AI digest via OpenRouter or a local OpenAI-compatible LLM (vLLM/Ollama). Node + Express, vanilla JS, localStorage. No build step.

## Features

- **Today** – Feed list by category, inline expand/collapse, per-article AI summary, All/Unread filter, read/unread toggle (auto on expand), mark-all-read (per category or whole view), Read Later and Recently Read views
- **Digest** – AI summary via OpenRouter or local LLM, time window (24h/7d/unread), source links, mark digest items as read
- **Settings** – AI provider (OpenRouter or local LLM base URL), separate models for digest/summary, editable prompts, refresh interval, light theme
- **Feeds** – Add/remove feeds, import/export OPML, feed list with search
- **Shortcuts** – `j`/`k` navigate, `o`/`Enter` open original, `m` toggle read, `Escape` collapse (active while an article is expanded)

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
