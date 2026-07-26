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
