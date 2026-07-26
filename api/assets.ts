// Vercel Serverless Function — server-side proxy to a live DataHub instance.
//
// Keeps the DataHub access token OFF the client: the browser calls /api/assets,
// this function queries DataHub's GraphQL API with the secret token, maps the
// real metadata into Beacon's six-factor trust model, and returns Asset[] JSON.
//
// Configure with project env vars (Vercel → Settings → Environment Variables):
//   DATAHUB_GMS_URL   e.g. https://your-company.acryl.io/gms   (or http://localhost:8080)
//   DATAHUB_TOKEN     a DataHub Personal Access Token
//
// Until those are set the endpoint returns 501 and the app falls back to the
// built-in mock generator, so the demo always works.

type FactorStatus = 'pass' | 'warn' | 'fail';

const FACT_MAX = [18, 20, 22, 15, 13, 12]; // ownership, lineage, pii, docs, freshness, schema
const PLAT_LABEL: Record<string, string> = {
  snowflake: 'Snowflake', bigquery: 'BigQuery', dbt: 'dbt',
  looker: 'Looker', databricks: 'Databricks', airflow: 'Airflow', redshift: 'Redshift',
};
const KIND_BY_TYPE: Record<string, { kind: string; type: string; tag: string }> = {
  DATASET: { kind: 'dataset', type: 'Dataset', tag: 'tag-accent' },
  DASHBOARD: { kind: 'dashboard', type: 'Dashboard', tag: 'tag-neutral' },
  MLMODEL: { kind: 'model', type: 'ML Model', tag: 'tag-accent-2' },
  DATA_JOB: { kind: 'job', type: 'Data Job', tag: 'tag-neutral' },
};

// GraphQL: recent entities with the aspects the six factors are derived from.
const QUERY = /* GraphQL */ `
  query BeaconRecent($count: Int!) {
    searchAcrossEntities(input: {
      types: [DATASET, DASHBOARD, MLMODEL, DATA_JOB],
      query: "*",
      count: $count,
      sortInput: { sortCriterion: { field: "lastOperationTime", sortOrder: DESCENDING } }
    }) {
      searchResults {
        entity {
          urn
          type
          ... on Dataset {
            name
            platform { name }
            properties { name description lastModified { time } }
            editableProperties { description }
            ownership { owners { owner { urn } ownershipType { info { name } } } }
            glossaryTerms { terms { term { urn } } }
            tags { tags { tag { urn } } }
            schemaMetadata { fields { fieldPath description } }
            upstream: lineage(input: { direction: UPSTREAM, start: 0, count: 1 }) { total }
            downstream: lineage(input: { direction: DOWNSTREAM, start: 0, count: 1 }) { total }
          }
          ... on Dashboard { properties { name description lastModified { time } } platform { name } ownership { owners { owner { urn } } } }
          ... on MLModel { name properties { description } platform { name } ownership { owners { owner { urn } } } }
          ... on DataJob { jobId properties { name description } ownership { owners { owner { urn } } } }
        }
      }
    }
  }
`;

function p111(n: number): FactorStatus { return n >= 2 ? 'pass' : n === 1 ? 'warn' : 'fail'; }

function scoreFactors(e: any): { status: FactorStatus; pts: number }[] {
  const owners = e?.ownership?.owners ?? [];
  const upstream = e?.upstream?.total ?? 0;
  const downstream = e?.downstream?.total ?? 0;
  const terms = e?.glossaryTerms?.terms ?? [];
  const tags = e?.tags?.tags ?? [];
  const isPii = [...terms, ...tags].some((t: any) => JSON.stringify(t).toLowerCase().includes('pii'));
  const desc = e?.properties?.description || e?.editableProperties?.description || '';
  const fields = e?.schemaMetadata?.fields ?? [];
  const documentedCols = fields.filter((f: any) => f?.description).length;
  const lastMs = e?.properties?.lastModified?.time ?? 0;
  const ageMin = lastMs ? (Date.now() - lastMs) / 60000 : 999;

  const statuses: FactorStatus[] = [
    // ownership: 2+ owners (technical + business) pass, 1 warn, 0 fail
    p111(owners.length),
    // lineage completeness: both directions resolved
    upstream > 0 && downstream > 0 ? 'pass' : upstream > 0 || downstream > 0 ? 'warn' : 'fail',
    // pii & sensitivity: tagged = governed (best-effort; refine per instance)
    isPii ? 'pass' : fields.length ? 'warn' : 'fail',
    // documentation: dataset + column docs
    desc && documentedCols > 0 ? 'pass' : desc ? 'warn' : 'fail',
    // freshness / SLA
    ageMin < 60 ? 'pass' : ageMin < 180 ? 'warn' : 'fail',
    // schema stability: no drift signal available from a single query → optimistic
    'pass',
  ];
  return statuses.map((status, i) => ({
    status,
    pts: status === 'pass' ? FACT_MAX[i] : status === 'warn' ? Math.round(FACT_MAX[i] * 0.5) : 0,
  }));
}

const FACT_LABELS = ['Ownership assigned', 'Lineage completeness', 'PII & sensitivity governed', 'Documentation', 'Freshness / SLA', 'Schema stability'];

function mapEntity(e: any): any {
  const meta = KIND_BY_TYPE[e?.type] ?? KIND_BY_TYPE.DATASET;
  const factors = scoreFactors(e).map((f, i) => ({ label: FACT_LABELS[i], status: f.status, pts: f.pts, max: FACT_MAX[i], detail: '' }));
  const score = factors.reduce((a, b) => a + b.pts, 0);
  const platformKey = (e?.platform?.name || '').toLowerCase();
  const name = e?.properties?.name || e?.name || e?.jobId || (e?.urn?.split(',')[1] ?? e?.urn ?? 'unknown');
  return {
    id: e?.urn ?? 'as_' + Math.random().toString(36).slice(2, 9),
    ts: e?.properties?.lastModified?.time || Date.now(),
    name, kind: meta.kind, type: meta.type, typeTag: meta.tag,
    changeLabel: 'NEW ASSET', platform: PLAT_LABEL[platformKey] || e?.platform?.name || '—',
    domain: '—', factors, score,
    rows: 0, size: 0,
    down: e?.downstream?.total ?? 0, up: e?.upstream?.total ?? 0,
    queries: 0, fresh: 0,
    owner: e?.ownership?.owners?.[0]?.owner?.urn?.split(':').pop() ?? 'unassigned',
    lat: 0, fresh0: true, urn: e?.urn,
  };
}

export default async function handler(req: any, res: any) {
  const GMS = process.env.DATAHUB_GMS_URL;
  const TOKEN = process.env.DATAHUB_TOKEN;
  if (!GMS || !TOKEN) {
    res.status(501).json({
      error: 'DataHub not configured',
      hint: 'Set DATAHUB_GMS_URL and DATAHUB_TOKEN in the Vercel project env to enable live mode. The app uses mock data until then.',
    });
    return;
  }
  try {
    const r = await fetch(`${GMS.replace(/\/$/, '')}/api/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ query: QUERY, variables: { count: 25 } }),
    });
    if (!r.ok) { res.status(502).json({ error: `DataHub responded ${r.status}` }); return; }
    const json: any = await r.json();
    if (json.errors) { res.status(502).json({ error: 'GraphQL error', detail: json.errors }); return; }
    const results = json?.data?.searchAcrossEntities?.searchResults ?? [];
    const assets = results.map((s: any) => mapEntity(s.entity)).filter((a: any) => a.name);
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json({ assets, source: 'datahub', gms: GMS });
  } catch (err: any) {
    res.status(502).json({ error: 'Failed to reach DataHub', detail: String(err?.message ?? err) });
  }
}
