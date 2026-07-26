// Beacon domain logic — ported 1:1 from the DCLogic component in Beacon.dc.html.
// Pure data model + scoring + formatting helpers, framework-agnostic.

export type FactorStatus = 'pass' | 'warn' | 'fail';

export interface Factor {
  label: string;
  status: FactorStatus;
  pts: number;
  detail: string;
  max: number;
}

export interface Asset {
  id: string;
  ts: number;
  name: string;
  kind: string;
  type: string;
  typeTag: string;
  changeLabel: string;
  platform: string;
  domain: string;
  factors: Factor[];
  score: number;
  rows: number;
  size: number;
  down: number;
  up: number;
  queries: number;
  fresh: number;
  owner: string;
  lat: number;
  fresh0: boolean;
}

export interface GovAction {
  id: string;
  name: string;
  kind: 'CERTIFY' | 'QUARANTINE';
  ts: number;
}

export interface LogEntry {
  id: string;
  action: 'CERTIFY' | 'QUARANTINE' | 'SKIP';
  name: string;
  reason: string;
  ts: number;
  fresh: boolean;
}

export interface BeaconState {
  view: string;
  feed: Asset[];
  selectedId: string | null;
  watch: Record<string, boolean>;
  feedFilter: string;
  signals: number;
  latency: number;
  paused: boolean;
  toast: string;
  series: number[];
  conn: { connected: boolean; instance: string; env: string };
  connModal: boolean;
  agent: {
    armed: boolean;
    minTrust: number;
    quarBar: number;
    autoTypes: Record<string, boolean>;
  };
  budget: number;
  budgetMax: number;
  certified: number;
  incidents: number;
  writebacks: number;
  actions: GovAction[];
  agentLog: LogEntry[];
  channels: Record<string, boolean>;
  gates: Record<string, boolean>;
  alertTrust: number;
  minDown: number;
}

// ── Reference data ─────────────────────────────────────────────────────────
export const DS: [string, string, string, string][] = [
  ['ANALYTICS.PUBLIC', 'USER_EVENTS', 'snowflake', 'Growth'],
  ['ANALYTICS.MARTS', 'REVENUE_DAILY', 'snowflake', 'Finance'],
  ['RAW.LANDING', 'STRIPE_CHARGES_TMP', 'bigquery', 'Payments'],
  ['CORE.DIM', 'CUSTOMERS', 'dbt', 'Core'],
  ['MARKETING.FCT', 'CAMPAIGN_SPEND', 'bigquery', 'Marketing'],
  ['ML.FEATURES', 'CHURN_FEATURES', 'databricks', 'ML Platform'],
  ['PRODUCT.EVENTS', 'SESSION_TRACE', 'snowflake', 'Product'],
  ['FINANCE.STG', 'LEDGER_ENTRIES', 'dbt', 'Finance'],
];
export const DASH: [string, string, string][] = [
  ['Executive Overview', 'looker', 'Exec'],
  ['Growth Funnel', 'looker', 'Growth'],
  ['Revenue by Region', 'looker', 'Finance'],
  ['Retention Cohorts', 'looker', 'Product'],
];
export const MODEL: [string, string, string][] = [
  ['churn_predictor', 'databricks', 'ML Platform'],
  ['ltv_regressor', 'databricks', 'ML Platform'],
  ['fraud_scorer_v', 'databricks', 'Payments'],
];
export const JOB: [string, string, string][] = [
  ['dbt run marts', 'dbt', 'Core'],
  ['ingest_stripe', 'airflow', 'Payments'],
  ['refresh_features', 'airflow', 'ML Platform'],
];

export const FACT = [
  { label: 'Ownership assigned', max: 18, p: 'Technical + business owner set', w: 'Only technical owner', f: 'No owner assigned' },
  { label: 'Lineage completeness', max: 20, p: 'Upstreams + downstreams resolved', w: 'Downstream only', f: 'Orphaned — no lineage' },
  { label: 'PII & sensitivity governed', max: 22, p: 'PII tagged + access-controlled', w: 'PII tagged, not restricted', f: 'Ungoverned PII detected' },
  { label: 'Documentation', max: 15, p: 'Dataset + column docs', w: 'Dataset described only', f: 'No documentation' },
  { label: 'Freshness / SLA', max: 13, p: 'Within cadence', w: 'Late vs SLA', f: 'Stale — SLA breached' },
  { label: 'Schema stability', max: 12, p: 'No drift vs prior', w: 'Additive change', f: 'Breaking schema drift' },
];

export const TYPES: Record<string, { label: string; tag: string; changes: string[] }> = {
  dataset: { label: 'Dataset', tag: 'tag-accent', changes: ['NEW ASSET', 'SCHEMA CHANGE'] },
  dashboard: { label: 'Dashboard', tag: 'tag-neutral', changes: ['NEW ASSET', 'QUERY SPIKE'] },
  model: { label: 'ML Model', tag: 'tag-accent-2', changes: ['NEW VERSION', 'NEW ASSET'] },
  job: { label: 'Data Job', tag: 'tag-neutral', changes: ['NEW ASSET', 'RUN FAILED'] },
};

const PLAT_MAP: Record<string, string> = {
  snowflake: 'Snowflake', bigquery: 'BigQuery', dbt: 'dbt',
  looker: 'Looker', databricks: 'Databricks', airflow: 'Airflow',
};

// ── Generators ─────────────────────────────────────────────────────────────
export function pick<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }
export function rid(): string { return 'as_' + Math.random().toString(36).slice(2, 9); }

export function make(ts: number): Asset {
  const kinds = ['dataset', 'dataset', 'dataset', 'dashboard', 'model', 'job'];
  const kind = pick(kinds);
  const T = TYPES[kind];
  let name: string, platform: string, domain: string;
  if (kind === 'dataset') { const d = pick(DS); name = d[0] + '.' + d[1]; platform = d[2]; domain = d[3]; }
  else if (kind === 'dashboard') { const d = pick(DASH); name = d[0]; platform = d[1]; domain = d[2]; }
  else if (kind === 'model') { const d = pick(MODEL); name = d[0] + Math.floor(2 + Math.random() * 8); platform = d[1]; domain = d[2]; }
  else { const d = pick(JOB); name = d[0]; platform = d[1]; domain = d[2]; }

  const factors: Factor[] = FACT.map((fd) => {
    const r = Math.random();
    let st: FactorStatus, pts: number, detail: string;
    if (r > 0.5) { st = 'pass'; pts = fd.max; detail = fd.p; }
    else if (r > 0.24) { st = 'warn'; pts = Math.round(fd.max * 0.5); detail = fd.w; }
    else { st = 'fail'; pts = 0; detail = fd.f; }
    return { label: fd.label, status: st, pts, detail, max: fd.max };
  });
  const score = factors.reduce((a, b) => a + b.pts, 0);

  return {
    id: rid(), ts, name, kind, type: T.label, typeTag: T.tag,
    changeLabel: pick(T.changes), platform: PLAT_MAP[platform] || platform, domain,
    factors, score, rows: Math.round(1000 + Math.random() * 90000000), size: Math.random() * 20e9,
    down: Math.round(Math.random() * 34), up: Math.round(Math.random() * 8),
    queries: Math.round(Math.random() * 8000), fresh: Math.round(Math.random() * 260 - 20),
    owner: pick(['@data-platform', '@growth-eng', 'unassigned', '@payments-data', '@ml-platform']),
    lat: Math.round(300 + Math.random() * 900), fresh0: true,
  };
}

// ── Formatting / classification helpers ─────────────────────────────────────
export const fc = (st: FactorStatus) => st === 'pass' ? 'var(--ok)' : st === 'warn' ? 'var(--warn)' : 'var(--risk)';
export const fcbg = (st: FactorStatus) => st === 'pass' ? 'var(--ok-bg)' : st === 'warn' ? 'var(--warn-bg)' : 'var(--risk-bg)';
export const tier = (s: number) => s >= 80 ? { c: 'var(--ok)', bg: 'var(--ok-bg)' } : s >= 55 ? { c: 'var(--warn)', bg: 'var(--warn-bg)' } : { c: 'var(--risk)', bg: 'var(--risk-bg)' };
export const verdict = (s: number) => s >= 80 ? 'TRUSTED' : s >= 55 ? 'REVIEW' : 'HIGH RISK';
export const changeC = (l: string) => l.includes('FAIL') || l.includes('LOST') ? 'var(--risk)' : l.includes('SCHEMA') || l.includes('SPIKE') ? 'var(--warn)' : 'var(--color-accent)';
export const num = (n: number) => { if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); };
export const bytes = (n: number) => { if (n >= 1e9) return (n / 1e9).toFixed(1) + 'GB'; if (n >= 1e6) return (n / 1e6).toFixed(0) + 'MB'; return (n / 1e3).toFixed(0) + 'KB'; };
export const ago = (ts: number) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60) + 's'; };
export const freshTxt = (m: number) => { if (m < 0) return 'live'; if (m < 60) return m + 'm'; return (m / 60).toFixed(1) + 'h'; };
export const freshC = (m: number) => m < 60 ? 'var(--ok)' : m < 180 ? 'var(--warn)' : 'var(--risk)';

// ── Autonomous agent policy (pure, side-effect-free) ────────────────────────
// Confidence blends normalized trust with the two factors that matter most for
// automation: lineage (factor index 1) and freshness/SLA (factor index 4).
export function agentConfidence(a: Asset): number {
  const map = (s: FactorStatus) => (s === 'pass' ? 1 : s === 'warn' ? 0.5 : 0);
  const linOk = map(a.factors[1].status);
  const frOk = map(a.factors[4].status);
  return Math.round((a.score / 100 * 0.5 + linOk * 0.3 + frOk * 0.2) * 100);
}

export type Decision =
  | { action: 'QUARANTINE'; cost: 3 }
  | { action: 'CERTIFY'; cost: 1 }
  | { action: 'SKIP'; why: 'quar-budget' | 'cert-budget' | 'routed' };

// Trust + confidence + action budget collapse to a single decision. Quarantines
// cost 3, certifications cost 1; when the budget can't cover the intended act,
// the agent defers to a human (SKIP) rather than acting.
export function agentDecision(
  a: Asset,
  cfg: { quarBar: number; minTrust: number; budget: number },
): Decision {
  if (a.score < cfg.quarBar) {
    return cfg.budget < 3 ? { action: 'SKIP', why: 'quar-budget' } : { action: 'QUARANTINE', cost: 3 };
  }
  if (a.score >= cfg.minTrust && agentConfidence(a) >= 64) {
    return cfg.budget < 1 ? { action: 'SKIP', why: 'cert-budget' } : { action: 'CERTIFY', cost: 1 };
  }
  return { action: 'SKIP', why: 'routed' };
}

// ── Initial state (seeds the feed + freshness series, like componentDidMount) ─
export function initialState(): BeaconState {
  const feed: Asset[] = [];
  for (let i = 0; i < 15; i++) feed.push(make(Date.now() - i * 9000 - Math.random() * 5000));
  let base = 1;
  const series: number[] = [];
  for (let i = 0; i < 48; i++) { base = Math.max(0.25, base * (1 + (Math.random() - 0.48) * 0.06)); series.push(base); }
  return {
    view: 'feed', feed, selectedId: feed[0].id, watch: {}, feedFilter: 'all',
    signals: 3184, latency: 640, paused: false, toast: '', series,
    conn: { connected: false, instance: '', env: 'Prod' }, connModal: false,
    agent: { armed: false, minTrust: 82, quarBar: 45, autoTypes: { dataset: true, dashboard: true, model: true, job: false } },
    budget: 50, budgetMax: 50, certified: 0, incidents: 0, writebacks: 0,
    actions: [], agentLog: [],
    channels: { slack: true, telegram: true, webhook: false },
    gates: { pii: true, owner: true, lineage: false },
    alertTrust: 55, minDown: 0,
  };
}
