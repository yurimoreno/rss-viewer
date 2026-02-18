# RSS Viewer

Feedly-style RSS reader with AI digest via OpenRouter. Node + Express, vanilla JS, localStorage. No build step.

## Features

- **Today** – Feed list by category, inline expand/collapse, auto mark read, full article load
- **Digest** – AI summary via OpenRouter, time window (24h/7d), source links
- **Settings** – API key, model selector, refresh interval, light theme
- **Feeds** – Add feed, import/export OPML, feed list with search
- **Shortcuts** – `j`/`k` navigate, `o` open, `?` help

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000. Add your OpenRouter API key in Settings for the Digest feature.

## Scripts

| Command   | Description        |
| --------- | ------------------ |
| `npm start` | Production server |
| `npm run dev` | Dev with watch   |
| `npm test` | Run tests         |
