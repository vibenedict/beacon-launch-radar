# Beacon — Launch Radar for DataHub

A real-time governance radar over the DataHub metadata graph. New and changed
assets (datasets, dashboards, ML models, data jobs) stream in, each scored on a
0–100 **trust score** across six governance factors — ownership, lineage, PII
sensitivity, documentation, freshness/SLA, and schema stability. An optional
autonomous agent auto-certifies high-confidence assets and quarantines risky
ones, writing every decision back to the graph.

This is a React implementation of the `Beacon.dc.html` design prototype from the
**Nocturne** design system. The Nocturne tokens and component classes are carried
over verbatim in `src/nocturne.css`.

## Screens

- **Launch Feed** — live table of incoming assets + a detail panel with the
  trust gauge, governance breakdown, and a streaming freshness/volume sparkline.
- **Governance Agent** — arm the autonomous agent, tune the certify / quarantine
  thresholds and per-entity-type auto-action, and watch the decision log.
- **Watchlist** — assets pinned from the feed, re-scored on every graph update.
- **Alert Rules** — delivery channels (Slack / Telegram / webhook), trust +
  downstream-impact thresholds, and governance gates.
- **Source Health** — ingestion sources and MCP server connection status.
- **Alert Preview** — how a cleared alert renders as a Slack/Telegram card.

Connecting to a (mock) DataHub instance unlocks certify write-backs and lets you
arm the agent.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # production build → dist/
npm run preview  # preview the build
```

## Architecture

- `src/beacon.ts` — framework-agnostic domain logic: the asset data model,
  the trust-scoring generator (`make`), the agent decision policy, and all the
  formatting/classification helpers. Ported 1:1 from the prototype's `DCLogic`.
- `src/App.tsx` — the React shell. Holds all UI state, drives the realtime
  timers (feed tick, latency, freshness series), builds a per-render view model
  (`renderVals`), and renders the six screens.
- `src/nocturne.css` — the Nocturne design system (tokens + component classes).
- `src/index.css` — app chrome: the semantic status ramp (`--ok/--warn/--risk`),
  scrollbars, and keyframes.

Everything is client-side with mock/generated data; there is no backend.
