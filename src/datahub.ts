// Live DataHub client (browser side). Talks only to our own /api/assets proxy,
// never to DataHub directly — the access token stays server-side.
//
// Live mode is opt-in via a build-time flag so the mock demo is the default:
//   VITE_DATAHUB_LIVE=1   (set in .env.local or Vercel env)
// The proxy itself still needs DATAHUB_GMS_URL + DATAHUB_TOKEN configured.

import type { Asset } from './beacon';

export const LIVE = import.meta.env?.VITE_DATAHUB_LIVE === '1';

export async function fetchLiveAssets(): Promise<Asset[] | null> {
  try {
    const r = await fetch('/api/assets');
    if (!r.ok) return null; // 501 (unconfigured) / 502 (upstream) → caller falls back to mock
    const j = await r.json();
    return Array.isArray(j?.assets) ? (j.assets as Asset[]) : null;
  } catch {
    return null;
  }
}

// Write a governance decision back to DataHub (tags the asset; quarantine also
// deprecates it). Returns ok:false with a message on failure so the UI can toast.
export async function writeGovernance(
  urn: string,
  action: 'CERTIFY' | 'QUARANTINE',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch('/api/certify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urn, action }),
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { ok: false, error: j?.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
