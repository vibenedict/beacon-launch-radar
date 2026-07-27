// Vercel Serverless Function — governance write-back to a live DataHub instance.
//
// POST /api/certify  { "urn": "<entityUrn>", "action": "CERTIFY" | "QUARANTINE" }
//
// CERTIFY   → tags the asset `Beacon Certified` in the graph.
// QUARANTINE → tags it `Beacon Quarantined` and marks it deprecated.
//
// The DataHub token stays server-side (same as /api/assets). Reads
// DATAHUB_GMS_URL and optional DATAHUB_TOKEN from the environment.

type Action = 'CERTIFY' | 'QUARANTINE';

const TAGS: Record<Action, { id: string; name: string; urn: string; desc: string }> = {
  CERTIFY: { id: 'Beacon_Certified', name: 'Beacon Certified', urn: 'urn:li:tag:Beacon_Certified', desc: 'Certified by the Beacon governance radar' },
  QUARANTINE: { id: 'Beacon_Quarantined', name: 'Beacon Quarantined', urn: 'urn:li:tag:Beacon_Quarantined', desc: 'Quarantined by the Beacon governance radar' },
};

async function gql(gmsUrl: string, token: string | undefined, query: string, variables?: any) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${gmsUrl.replace(/\/$/, '')}/api/graphql`, {
    method: 'POST', headers, body: JSON.stringify({ query, variables }),
  });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`DataHub responded ${r.status}`);
  if (json.errors?.length) throw new Error(json.errors[0]?.message || 'GraphQL error');
  return json.data;
}

async function readBody(req: any): Promise<any> {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c: any) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const GMS = process.env.DATAHUB_GMS_URL;
  const TOKEN = process.env.DATAHUB_TOKEN;
  if (!GMS) { res.status(501).json({ error: 'DataHub not configured', hint: 'Set DATAHUB_GMS_URL to enable write-backs.' }); return; }

  const body = await readBody(req);
  const urn: string = body?.urn;
  const action: Action = body?.action === 'QUARANTINE' ? 'QUARANTINE' : 'CERTIFY';
  if (!urn || !/^urn:li:/.test(urn)) { res.status(400).json({ error: 'Missing or invalid `urn`' }); return; }

  const tag = TAGS[action];
  try {
    // Ensure the tag exists (idempotent — ignore "already exists" on repeat runs).
    await gql(GMS, TOKEN, `mutation Create($input: CreateTagInput!) { createTag(input: $input) }`,
      { input: { id: tag.id, name: tag.name, description: tag.desc } }
    ).catch((e) => { if (!/exist/i.test(String(e?.message))) throw e; });

    // Attach the tag to the asset.
    await gql(GMS, TOKEN, `mutation Add($input: AddTagsInput!) { addTags(input: $input) }`,
      { input: { tagUrns: [tag.urn], resourceUrn: urn } });

    // Quarantine additionally deprecates the asset.
    if (action === 'QUARANTINE') {
      await gql(GMS, TOKEN, `mutation Dep($input: UpdateDeprecationInput!) { updateDeprecation(input: $input) }`,
        { input: { urn, deprecated: true, note: 'Quarantined by Beacon — trust below threshold' } });
    }

    res.status(200).json({ ok: true, urn, action, tag: tag.urn });
  } catch (err: any) {
    res.status(502).json({ ok: false, error: String(err?.message ?? err) });
  }
}
