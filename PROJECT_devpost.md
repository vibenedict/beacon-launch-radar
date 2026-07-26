# Beacon — a Launch Radar for the data graph

## Inspiration

Data platforms don't have a discovery problem anymore — they have a **trust** problem. Catalogs like DataHub list every dataset, dashboard, model, and pipeline, but the second a new asset lands, someone asks in Slack: *"Can I actually use this?"* No owner, unchecked PII, half-resolved lineage. We wanted the thing that watches the graph so people don't have to — air-traffic control for metadata.

## What it does

**Beacon** streams new and changed assets in real time and scores each one **0–100** across six governance factors — ownership, lineage, PII sensitivity, documentation, freshness/SLA, and schema stability:

$$
\text{Trust} = \sum_{i=1}^{6} p_i, \qquad \sum m_i = 18+20+22+15+13+12 = 100
$$

An optional **autonomous agent** you can *arm* then acts on that judgment — computing a separate confidence from trust, lineage $\ell$, and freshness $f$:

$$
\text{conf} = \left\lfloor 100\left(0.5\cdot\tfrac{s}{100} + 0.3\,\ell + 0.2\,f\right)\right\rceil
$$

It auto-**certifies** high-confidence assets, **quarantines** risky ones, and **skips** the rest to a human — all gated by a finite action budget so it fails safe. Six screens: Launch Feed, Governance Agent, Watchlist, Alert Rules, Source Health, and a Slack/Telegram alert preview.

## How we built it

A design-to-code port. Beacon started as a prototype in Claude's design tool (`Beacon.dc.html`, Nocturne design system), which we re-implemented as a real **Vite + React + TypeScript** app — domain logic (scoring, agent policy, generators) in a framework-agnostic module, the Nocturne tokens carried over verbatim, and mock assets streaming client-side every ~2.8s.

## Challenges

- Porting a class component's imperative `setState` into hooks without stale closures inside `setInterval` — solved with a merge-style `setState` backed by a hot `ref`.
- Carrying hundreds of inline `style` strings into React via a tiny `css()` parser instead of rewriting each by hand.
- Verifying render (not just compile) with a `renderToStaticMarkup` smoke test.

## What we learned

Separate the *judgment* from the *view*, give autonomy a **budget** so it fails safe, and treat **confidence ≠ trust** — that split is what makes automated governance defensible.

## What's next

Wire the scoring and connect/writeback flow to a live DataHub graph over MCP.
