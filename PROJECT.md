# Beacon — a Launch Radar for the data graph

## Inspiration

Modern data platforms don't have a *discovery* problem anymore — they have a **trust** problem. Tools like DataHub already catalog every dataset, dashboard, ML model, and pipeline in the org. But the moment a new asset lands in the graph, a very human question fires off in a dozen Slack channels: *"Can I actually use this?"*

Nobody owns it. Nobody's checked whether it carries ungoverned PII. Its lineage is half-resolved and its freshness SLA is anyone's guess. By the time a governance review happens — if it ever does — the asset is already wired into three downstream dashboards and a revenue model.

I wanted to build the thing that watches the graph *so people don't have to*: a real-time radar that scores every incoming asset the instant it appears, tells you whether to trust it, and — if you let it — acts on that judgment autonomously and writes the decision back to DataHub. Air-traffic control, but for metadata.

## What it does

**Beacon** streams new and changed assets across the DataHub graph in real time and assigns each one a **0–100 trust score** across six governance factors. It has six surfaces:

- **Launch Feed** — a live table of incoming assets with a detail panel: trust gauge, per-factor governance breakdown, and a streaming freshness/volume sparkline.
- **Governance Agent** — an autonomous agent you can *arm*. It auto-certifies high-confidence assets, quarantines risky ones, spends from an action budget, and logs every decision.
- **Watchlist**, **Alert Rules**, **Source Health**, and **Alert Preview** (how a cleared alert renders as a Slack/Telegram card).

### The trust score

Each asset is graded on six weighted factors — ownership, lineage completeness, PII/sensitivity governance, documentation, freshness/SLA, and schema stability. Every factor $i$ lands in one of three states (`pass` / `warn` / `fail`) worth full, half, or zero of its ceiling $m_i$:

$$
\text{Trust} = \sum_{i=1}^{6} p_i, \qquad p_i = \begin{cases} m_i & \text{pass} \\ \left\lfloor m_i/2 \right\rfloor & \text{warn} \\ 0 & \text{fail} \end{cases}
$$

The ceilings are chosen so a perfect asset scores exactly 100 — PII carries the most weight, schema stability the least:

$$
\sum_{i=1}^{6} m_i = 18 + 20 + 22 + 15 + 13 + 12 = 100
$$

That score maps to a verdict via two thresholds:

$$
\text{verdict}(s) = \begin{cases} \textsf{TRUSTED} & s \geq 80 \\ \textsf{REVIEW} & 55 \leq s < 80 \\ \textsf{HIGH RISK} & s < 55 \end{cases}
$$

### The agent's decision policy

Trust alone isn't enough to *act* — a high score built on shaky lineage and stale data shouldn't be auto-certified. So the agent computes a separate **confidence**, blending the normalized trust score with the two factors that matter most for automation (lineage $\ell$ and freshness $f$, each mapped $\text{pass}\!\to\!1,\ \text{warn}\!\to\!0.5,\ \text{fail}\!\to\!0$):

$$
\text{conf} = \left\lfloor 100\left( 0.5\cdot\frac{s}{100} + 0.3\,\ell + 0.2\,f \right) \right\rceil
$$

The policy then reduces to a small decision tree, gated by an action budget $B$ (quarantines cost 3, certifications cost 1):

$$
\text{action} = \begin{cases}
\textsf{QUARANTINE} & s < q \ \wedge\ B \geq 3 \\
\textsf{CERTIFY} & s \geq \tau \ \wedge\ \text{conf} \geq 64 \ \wedge\ B \geq 1 \\
\textsf{SKIP} & \text{otherwise (route to owner)}
\end{cases}
$$

where $q$ (quarantine floor) and $\tau$ (min trust to certify) are both dials the operator controls live. The budget is the safety rail: when it's exhausted, the agent stops acting and defers to a human instead of rubber-stamping.

## How I built it

Beacon started life as a **design prototype** in Claude's design tool (`Beacon.dc.html`) built on the *Nocturne* design system — a single self-contained component in a small reactive templating dialect (`sc-for`, `sc-if`, `{{ }}` bindings over a `DCLogic` class).

The build was a **design-to-code port**. I pulled the prototype and its imports through the design MCP, then re-implemented it as a real, runnable app:

- **Vite + React + TypeScript** as the shell.
- **`src/beacon.ts`** — I extracted the entire domain — the asset generator, the six-factor scoring, the agent policy, and every formatter — into a framework-agnostic module. Porting the logic *out* of the view first kept the math honest and testable.
- **`src/App.tsx`** — the React shell: all UI state, the realtime timers (feed tick, latency, freshness series), a per-render view-model builder (`renderVals`), and the six screens.
- **`src/nocturne.css`** — the Nocturne tokens and component classes, carried over **verbatim** so the port stayed pixel-faithful to the design.

Data is generated and streamed client-side on three independent intervals — a new asset every $\approx 2.8\text{s}$, a detection-latency reading, and a freshness datapoint — so the radar genuinely *lives*.

## Challenges I faced

**1. Porting a class component's `setState` into hooks — faithfully.** The original leaned hard on `this.setState(prev => …)` partial merges, and the agent reads state *imperatively* mid-tick (right after a feed update). Naïvely translating that to `useState` gives you stale closures inside `setInterval`. I solved it with a small class-style `setState` that merges patches **and** keeps a `ref` hot, so the agent's synchronous reads within a tick see current state — matching React's pre-commit semantics exactly.

**2. Keeping the prototype's inline styles.** The design used hundreds of inline `style="…"` strings, including dynamic ones and CSS custom properties. Rewriting each into a React style object by hand would've been a bug farm. Instead I wrote a tiny `css()` parser that turns `"a:b;c:d"` into a style object (preserving `--custom-props`), letting me carry every style string over **unchanged**.

**3. Verifying without a browser in the loop.** A green `npm run build` only proves it *compiles*, not that it *renders*. So I added a server-render smoke test with `renderToStaticMarkup` that asserts the first paint contains the brand, all nav items, the live indicator, and a full set of asset rows — catching any runtime throw from `css()` or the view-model before it ever hits the screen.

## What I learned

- **Separate the judgment from the view.** Lifting the scoring and agent policy into a pure module made the whole thing legible — the math above *is* the code, not a description of it.
- **Autonomy needs a budget.** The single most important design decision wasn't the scoring — it was giving the agent a finite, replenishing action budget so it fails *safe* (defer to a human) instead of failing *confident*.
- **Confidence ≠ trust.** Splitting "how good is this asset" from "how sure am I I should act on it" is what makes automated governance defensible rather than reckless.

Everything runs locally with generated data — but the scoring, the agent policy, and the DataHub/MCP connect-and-writeback flow are all modeled end-to-end, ready to be wired to a live graph.
