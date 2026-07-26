import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  type Asset, type BeaconState, type GovAction,
  initialState, make, tier, verdict, changeC, fc, fcbg,
  num, bytes, ago, freshTxt, freshC, rid,
  agentConfidence, agentDecision,
} from './beacon';
import { LIVE, fetchLiveAssets } from './datahub';

// Component props mirror the design component's `data-props`.
const ACCENT = '#9184d9';
const FEED_INTERVAL_MS = 2800;

// Parse an inline CSS string ("a:b;c:d") into a React style object. Lets us
// keep the prototype's inline styles verbatim, including CSS custom props.
function css(s: string): CSSProperties {
  const o: Record<string, string> = {};
  if (!s) return o;
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    const v = decl.slice(i + 1).trim();
    if (!k) continue;
    const key = k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    o[key] = v;
  }
  return o as CSSProperties;
}

type Patch = Partial<BeaconState> | ((prev: BeaconState) => Partial<BeaconState>);

export default function App() {
  const [state, setReact] = useState<BeaconState>(initialState);
  const ref = useRef(state);
  ref.current = state;

  // class-style setState: merges partial updates and keeps the ref hot so
  // imperative reads within the same tick (evalAgent) see current state.
  const setState = (patch: Patch) => {
    setReact((prev) => {
      const next = typeof patch === 'function' ? patch(prev) : patch;
      const merged = { ...prev, ...next };
      ref.current = merged;
      return merged;
    });
  };

  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const toastMsg = (m: string) => {
    clearTimeout(toastTimer.current);
    setState({ toast: m });
    toastTimer.current = setTimeout(() => setState({ toast: '' }), 1900);
  };

  // ── governance actions ────────────────────────────────────────────────────
  const applyAction = (asset: Asset, kind: 'CERTIFY' | 'QUARANTINE'): number => {
    const cost = kind === 'QUARANTINE' ? 3 : 1;
    setState((p) => {
      if (p.budget < cost) return {};
      const act: GovAction = { id: rid(), name: asset.name, kind, ts: Date.now() };
      return {
        actions: [act, ...p.actions].slice(0, 20),
        budget: p.budget - cost,
        writebacks: p.writebacks + cost,
        certified: p.certified + (kind === 'CERTIFY' ? 1 : 0),
        incidents: p.incidents + (kind === 'QUARANTINE' ? 1 : 0),
      };
    });
    return cost;
  };

  const resolveAction = (id: string) => {
    setState((p) => {
      const a = p.actions.find((x) => x.id === id);
      return {
        actions: p.actions.filter((x) => x.id !== id),
        budget: Math.min(p.budgetMax, p.budget + 1),
        incidents: a && a.kind === 'QUARANTINE' ? Math.max(0, p.incidents - 1) : p.incidents,
      };
    });
    toastMsg('Action resolved · budget restored');
  };

  const evalAgent = (a: Asset) => {
    const st = ref.current, agent = st.agent;
    if (!agent.armed || !st.conn.connected) return;
    if (!agent.autoTypes[a.kind]) return;
    const conf = agentConfidence(a);
    const d = agentDecision(a, { quarBar: agent.quarBar, minTrust: agent.minTrust, budget: st.budget });
    let reason: string, cost = 0;
    if (d.action === 'QUARANTINE') {
      reason = 'trust ' + a.score + ' · ' + (a.factors.find((x) => x.status === 'fail')?.detail || 'multiple failures') + ' · incident opened';
      cost = applyAction(a, 'QUARANTINE');
    } else if (d.action === 'CERTIFY') {
      reason = 'trust ' + a.score + ' · confidence ' + conf + ' · certified + tagged';
      cost = applyAction(a, 'CERTIFY');
    } else if (d.why === 'quar-budget') {
      reason = 'action budget exhausted — needs human review';
    } else if (d.why === 'cert-budget') {
      reason = 'action budget exhausted';
    } else {
      reason = 'trust ' + a.score + ' / conf ' + conf + ' — routed to owner';
    }
    if (d.action === 'SKIP' && Math.random() > 0.4) return;
    const entry = { id: rid(), action: d.action, name: a.name, reason: reason + (cost ? ' · −' + cost + ' budget' : ''), ts: Date.now(), fresh: true };
    setState((p) => ({ agentLog: [entry, ...p.agentLog.map((x) => x.fresh ? { ...x, fresh: false } : x)].slice(0, 40) }));
  };

  const tick = () => {
    if (ref.current.paused) return;
    const a = make(Date.now());
    a.fresh0 = true;
    setState((s) => ({ feed: [a, ...s.feed.map((x) => x.fresh0 ? { ...x, fresh0: false } : x)].slice(0, 42), signals: s.signals + 1 }));
    evalAgent(a);
  };

  // ── connection ────────────────────────────────────────────────────────────
  const connect = () => {
    setState((s) => ({ conn: { connected: true, instance: 'datahub.acme.io', env: s.conn.env }, connModal: false }));
    toastMsg('Connected to datahub.acme.io');
  };
  const disconnect = () => {
    setState((s) => ({ conn: { ...s.conn, connected: false }, agent: { ...s.agent, armed: false } }));
    toastMsg('Disconnected from DataHub');
  };
  const toggleArm = () => {
    if (!ref.current.conn.connected) { setState({ connModal: true }); toastMsg('Connect DataHub to arm the agent'); return; }
    const next = !ref.current.agent.armed;
    setState((s) => ({ agent: { ...s.agent, armed: next } }));
    toastMsg(next ? 'Agent armed · auto-governance live' : 'Agent disarmed');
  };

  // Live poll: pull recent assets from the DataHub proxy and merge new ones in.
  const pollLive = async () => {
    if (ref.current.paused) return;
    const live = await fetchLiveAssets();
    if (!live || !live.length) return;
    const known = new Set(ref.current.feed.map((x) => x.id));
    const fresh = live.filter((a) => !known.has(a.id)).map((a) => ({ ...a, fresh0: true }));
    if (!fresh.length) return;
    setState((s) => ({
      feed: [...fresh, ...s.feed.map((x) => x.fresh0 ? { ...x, fresh0: false } : x)].slice(0, 42),
      signals: s.signals + fresh.length,
      selectedId: s.selectedId || fresh[0].id,
    }));
    fresh.forEach((a) => evalAgent(a));
  };

  // ── timers (componentDidMount / componentWillUnmount) ──────────────────────
  useEffect(() => {
    // In live mode, drive the feed from DataHub; otherwise generate mock assets.
    let timer: ReturnType<typeof setInterval>;
    if (LIVE) {
      setState({ feed: [], selectedId: null, signals: 0 });
      timer = setInterval(pollLive, FEED_INTERVAL_MS);
      void pollLive();
    } else {
      timer = setInterval(tick, FEED_INTERVAL_MS);
    }
    const lt = setInterval(() => setState({ latency: Math.round(420 + Math.random() * 520) }), 950);
    const ct = setInterval(() => setState((s) => {
      const l = s.series[s.series.length - 1] || 1;
      const nx = Math.max(0.25, l * (1 + (Math.random() - 0.48) * 0.06));
      return { series: [...s.series, nx].slice(-48) };
    }), 700);
    return () => { [timer, lt, ct].forEach(clearInterval); clearTimeout(toastTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── view model (renderVals) ────────────────────────────────────────────────
  const v = renderVals();
  function renderVals() {
    const st = state;
    const setView = (view: string) => () => setState({ view });

    const navDef = [
      { key: 'feed', label: 'Launch Feed', dot: 'var(--ok)', badge: String(st.feed.length) },
      { key: 'agent', label: 'Governance Agent', dot: 'var(--color-accent)', badge: String(st.actions.length) },
      { key: 'watch', label: 'Watchlist', dot: 'var(--color-accent-2)', badge: String(Object.keys(st.watch).length) },
      { key: 'rules', label: 'Alert Rules', dot: 'var(--warn)', badge: '' },
      { key: 'sources', label: 'Source Health', dot: 'var(--color-neutral-400)', badge: '' },
      { key: 'slack', label: 'Alert Preview', dot: 'var(--color-accent-300)', badge: '' },
    ];
    const nav = navDef.map((n) => {
      const a = st.view === n.key;
      return {
        label: n.label, dot: n.dot, onClick: setView(n.key), hasBadge: !!n.badge && n.badge !== '0', badge: n.badge,
        style: `display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--radius-md);cursor:pointer;font-size:13px;font-weight:${a ? 500 : 400};color:${a ? 'var(--color-text)' : 'var(--color-neutral-400)'};background:${a ? 'var(--color-surface)' : 'transparent'};box-shadow:${a ? 'inset 2px 0 0 var(--color-accent)' : 'none'}`,
      };
    });

    const filt = st.feedFilter;
    const fbtn = (k: string, l: string) => ({
      label: l, onClick: () => setState({ feedFilter: k }),
      style: `font-size:11px;letter-spacing:.04em;padding:6px 12px;border-radius:var(--radius-md);cursor:pointer;border:1px solid ${filt === k ? 'var(--color-accent)' : 'var(--color-divider)'};background:transparent;color:${filt === k ? 'var(--color-accent)' : 'var(--color-neutral-400)'};font-family:inherit`,
    });
    const filters = [fbtn('all', 'All'), fbtn('dataset', 'Datasets'), fbtn('dashboard', 'Dashboards'), fbtn('model', 'Models')];
    const visible = st.feed.filter((r) => filt === 'all' || r.kind === filt);
    const rows = visible.map((r) => {
      const t = tier(r.score), selq = r.id === st.selectedId;
      return {
        name: r.name, changeLabel: r.changeLabel, changeC: changeC(r.changeLabel), domain: r.domain, platform: r.platform, type: r.type, typeTag: r.typeTag,
        ago: ago(r.ts), lat: r.lat, latColor: r.lat < 500 ? 'var(--ok)' : r.lat < 800 ? 'var(--warn)' : 'var(--color-neutral-500)',
        rows: num(r.rows), down: String(r.down), fresh: freshTxt(r.fresh), freshC: freshC(r.fresh),
        score: r.score, scoreC: t.c, scoreBg: t.bg, onSelect: () => setState({ selectedId: r.id, view: 'feed' }),
        style: `display:grid;grid-template-columns:76px minmax(150px,1fr) 118px 96px 84px 66px 82px 84px;gap:9px;align-items:center;padding:11px 18px;border-bottom:1px solid var(--color-divider);cursor:pointer;${selq ? 'background:var(--color-surface);box-shadow:inset 3px 0 0 var(--color-accent);' : 'background:transparent;'}${r.fresh0 ? 'animation:flashIn 1s ease;' : ''}`,
      };
    });

    const s = st.feed.find((x) => x.id === st.selectedId);
    let sel: any = null;
    if (s) {
      const t = tier(s.score), watched = !!st.watch[s.id];
      sel = {
        name: s.name, type: s.type, typeTag: s.typeTag, platform: s.platform, domain: s.domain, owner: s.owner, changeLabel: s.changeLabel,
        score: s.score, scoreC: t.c, verdict: verdict(s.score),
        gauge: `conic-gradient(${t.c} ${Math.round(s.score * 3.6)}deg, var(--color-neutral-800) 0deg)`,
        metrics: [
          { k: 'Rows', v: num(s.rows), c: 'var(--color-text)' }, { k: 'Size', v: bytes(s.size), c: 'var(--color-text)' },
          { k: 'Downstream', v: s.down + ' assets', c: 'var(--color-text)' }, { k: 'Upstream', v: s.up + ' sources', c: 'var(--color-text)' },
          { k: 'Last updated', v: freshTxt(s.fresh) + ' ago', c: freshC(s.fresh) }, { k: 'Owner', v: s.owner, c: s.owner === 'unassigned' ? 'var(--risk)' : 'var(--color-text)' },
          { k: 'Queries · 7d', v: num(s.queries), c: 'var(--color-text)' }, { k: 'Detect latency', v: s.lat + 'ms', c: 'var(--ok)' },
        ],
        factors: s.factors.map((f) => ({ label: f.label, detail: f.detail, pts: f.pts, max: f.max, c: fc(f.status), tagBg: fcbg(f.status), statusLabel: f.status === 'pass' ? 'PASS' : f.status === 'warn' ? 'WARN' : 'FAIL' })),
        watchLabel: watched ? '★ Watching' : '☆ Watch', watchExtra: watched ? 'color:var(--color-accent);border-color:var(--color-accent)' : '',
        onCertify: () => { if (!st.conn.connected) { setState({ connModal: true }); toastMsg('Connect DataHub to write back'); return; } if (st.budget < 1) { toastMsg('Action budget exhausted'); return; } applyAction(s, 'CERTIFY'); toastMsg('Certified ' + s.name + ' in DataHub'); },
        onWatch: () => { const w = { ...st.watch }; if (w[s.id]) { delete w[s.id]; toastMsg(s.name + ' unpinned'); } else { w[s.id] = true; toastMsg(s.name + ' added to watchlist'); } setState({ watch: w }); },
        onNotify: () => toastMsg('Notified ' + s.owner + ' via Slack'),
        onExplorer: () => toastMsg('Opening ' + s.name + ' in DataHub…'),
        onSnooze: () => { toastMsg('Snoozed ' + s.name); setState((p) => ({ feed: p.feed.filter((x) => x.id !== s.id), selectedId: p.feed.find((x) => x.id !== s.id)?.id || null })); },
      };
    }

    const ser = st.series.length > 1 ? st.series : [1, 1];
    const W = 356, HH = 88, mn = Math.min(...ser), mx = Math.max(...ser), rng = (mx - mn) || 1, nn = ser.length;
    const X = (i: number) => (nn <= 1 ? 0 : (i / (nn - 1)) * W), Y = (val: number) => (HH - 7) - ((val - mn) / rng) * (HH - 14);
    const pts = ser.map((val, i) => X(i).toFixed(1) + ',' + Y(val).toFixed(1)).join(' ');
    const pI = ser.indexOf(mx), lI = ser.indexOf(mn), up = ser[nn - 1] >= ser[0];
    const chart = {
      pts, area: '0,' + HH + ' ' + pts + ' ' + W + ',' + HH, col: up ? 'var(--ok)' : 'var(--risk)',
      peakX: X(pI).toFixed(1), peakY: Y(mx).toFixed(1), peakV: mx.toFixed(2), lowX: X(lI).toFixed(1), lowY: Y(mn).toFixed(1), lowV: mn.toFixed(2),
      lastX: X(nn - 1).toFixed(1), lastY: Y(ser[nn - 1]).toFixed(1),
    };

    const watchList = st.feed.filter((r) => st.watch[r.id]);
    const watchRows = watchList.map((r) => {
      const t = tier(r.score);
      return { name: r.name, platform: r.platform, type: r.type, down: String(r.down), fresh: freshTxt(r.fresh), freshC: freshC(r.fresh), score: r.score, scoreC: t.c, scoreBg: t.bg, onSelect: () => setState({ selectedId: r.id, view: 'feed' }) };
    });

    const sw = (on: boolean) => ({
      trackStyle: `width:38px;height:22px;border-radius:20px;cursor:pointer;padding:2px;background:${on ? 'var(--color-accent)' : 'var(--color-neutral-800)'};transition:background .15s`,
      knobStyle: `width:18px;height:18px;border-radius:50%;background:${on ? 'var(--color-bg)' : 'var(--color-neutral-500)'};transform:translateX(${on ? '16px' : '0'});transition:transform .15s`,
    });
    const chDef: [string, string, string][] = [['slack', 'Slack', 'Push to #data-governance'], ['telegram', 'Telegram', 'Push to @beacon_alerts'], ['webhook', 'Team webhook', 'POST to your internal endpoint']];
    const channels = chDef.map(([k, label, sub]) => ({ label, sub, onToggle: () => setState((p) => ({ channels: { ...p.channels, [k]: !p.channels[k] } })), ...sw(st.channels[k]) }));
    const gaDef: [string, string][] = [['pii', 'Block ungoverned PII'], ['owner', 'Require an assigned owner'], ['lineage', 'Require resolved lineage']];
    const gates = gaDef.map(([k, label]) => ({ label, onToggle: () => setState((p) => ({ gates: { ...p.gates, [k]: !p.gates[k] } })), ...sw(st.gates[k]) }));

    const ttDef: [string, string][] = [['dataset', 'Datasets'], ['dashboard', 'Dashboards'], ['model', 'Models'], ['job', 'Jobs']];
    const typeToggles = ttDef.map(([k, label]) => {
      const on = st.agent.autoTypes[k];
      return {
        label, onClick: () => setState((p) => ({ agent: { ...p.agent, autoTypes: { ...p.agent.autoTypes, [k]: !p.agent.autoTypes[k] } } })),
        style: `font-size:11px;padding:5px 11px;border-radius:var(--radius-md);cursor:pointer;font-family:inherit;border:1px solid ${on ? 'var(--color-accent)' : 'var(--color-divider)'};background:${on ? 'var(--color-accent-900)' : 'transparent'};color:${on ? 'var(--color-accent-200)' : 'var(--color-neutral-400)'}`,
      };
    });

    const actions = st.actions.map((a) => ({
      name: a.name, kind: a.kind, kindTag: a.kind === 'CERTIFY' ? 'tag-accent' : 'tag-neutral', ago: ago(a.ts) + ' ago',
      status: a.kind === 'CERTIFY' ? 'Certified' : 'Incident open', statusC: a.kind === 'CERTIFY' ? 'var(--ok)' : 'var(--risk)', onResolve: () => resolveAction(a.id),
    }));
    const agentLog = st.agentLog.map((d) => {
      const c = d.action === 'CERTIFY' ? 'var(--ok)' : d.action === 'QUARANTINE' ? 'var(--risk)' : 'var(--color-neutral-500)';
      return {
        action: d.action, name: d.name, reason: d.reason, time: ago(d.ts) + ' ago', badgeC: c, badgeBg: d.action === 'CERTIFY' ? 'var(--ok-bg)' : d.action === 'QUARANTINE' ? 'var(--risk-bg)' : 'var(--color-neutral-800)',
        style: `border-left:2px solid ${c};padding:9px 11px;background:var(--color-bg);border-radius:0 var(--radius-md) var(--radius-md) 0;${d.fresh ? 'animation:flashIn 1s ease;' : ''}`,
      };
    });

    const srcDef: [string, string][] = [['Snowflake · PROD', 'Ingestion · REST'], ['BigQuery · PROD', 'Ingestion · REST'], ['dbt Cloud', 'Ingestion · REST'], ['Looker', 'Ingestion · REST'], ['Databricks', 'Ingestion · REST'], ['Airflow', 'Ingestion · REST'], ['DataHub MCP Server', 'Context · MCP'], ['Kafka MCL stream', 'Events · WS'], ['Slack Bot API', 'Delivery · REST']];
    const sources = srcDef.map((sc, idx) => {
      const degraded = sc[0].startsWith('Looker'), ping = degraded ? 1240 : Math.round(120 + idx * 40 + Math.random() * 60);
      return { name: sc[0], type: sc[1], ping, pingC: ping < 400 ? 'var(--ok)' : ping < 800 ? 'var(--warn)' : 'var(--risk)', last: (idx * 4 + 2) + 's ago', dot: degraded ? 'var(--warn)' : 'var(--ok)', status: degraded ? 'RECONNECT' : 'ONLINE', badgeC: degraded ? 'var(--warn)' : 'var(--ok)', badgeBg: degraded ? 'var(--warn-bg)' : 'var(--ok-bg)' };
    });

    const slackMsgs = st.feed.slice(0, 3).map((r) => {
      const t = tier(r.score), risky = r.score < 55;
      return {
        head: risky ? '◆ HIGH-RISK ASSET LANDED' : '▲ NEW ASSET DETECTED', headC: risky ? 'var(--risk)' : 'var(--color-accent-300)',
        name: r.name, platform: r.platform, domain: r.domain, score: r.score, scoreC: t.c, verdict: verdict(r.score),
        why: risky ? (r.factors.find((x) => x.status === 'fail')?.detail || 'multiple governance failures') : (r.changeLabel === 'SCHEMA CHANGE' ? 'schema drift vs prior version' : 'awaiting certification'),
        lat: r.lat, cta: risky ? 'Acknowledge' : 'Certify', time: ago(r.ts) + ' ago',
      };
    });

    const conn = st.conn, mtT = tier(st.agent.minTrust), atT = tier(st.alertTrust);
    return {
      accent: ACCENT, signals: st.signals.toLocaleString(), latency: st.latency, latColor: st.latency < 600 ? 'var(--ok)' : 'var(--warn)',
      nav, filters, rows, chart,
      isFeed: st.view === 'feed', isAgent: st.view === 'agent', isWatch: st.view === 'watch', isRules: st.view === 'rules', isSources: st.view === 'sources', isSlack: st.view === 'slack',
      hasSel: !!sel, sel,
      paused: st.paused, togglePause: () => setState((p) => ({ paused: !p.paused })),
      pauseLabel: st.paused ? '▶ Resume' : '❚❚ Pause',
      pauseStyle: `font-size:11px;letter-spacing:.04em;padding:6px 12px;border-radius:var(--radius-md);cursor:pointer;font-family:inherit;border:1px solid ${st.paused ? 'var(--color-accent)' : 'var(--color-divider)'};background:transparent;color:${st.paused ? 'var(--color-accent)' : 'var(--color-neutral-400)'}`,
      connected: conn.connected, connLabel: conn.connected ? conn.instance : 'Connect DataHub', connSub: conn.connected ? ('MCP · ' + conn.env) : 'Enable write-backs', connDot: conn.connected ? 'var(--ok)' : 'var(--color-neutral-600)',
      connBtnStyle: `display:flex;align-items:center;gap:8px;padding:6px 13px;border-radius:var(--radius-md);cursor:pointer;border:1px solid ${conn.connected ? 'var(--color-accent-700)' : 'var(--color-divider)'};background:${conn.connected ? 'var(--color-accent-900)' : 'transparent'}`,
      onConnClick: conn.connected ? () => disconnect() : () => setState({ connModal: true }),
      connModal: st.connModal, openConn: () => setState({ connModal: true }), closeConn: () => setState({ connModal: false }), doConnect: () => connect(), stop: (e: any) => e.stopPropagation(),
      needConn: !conn.connected,
      agentStatus: st.agent.armed ? 'ARMED' : 'DISARMED', agentTag: st.agent.armed ? 'tag-accent' : 'tag-neutral',
      armLabel: st.agent.armed ? '❚❚ Disarm agent' : '▶ Arm agent', armVariant: st.agent.armed ? 'btn-secondary' : 'btn-primary', toggleArm: () => toggleArm(),
      agentLiveDot: st.agent.armed ? 'var(--ok)' : 'var(--color-neutral-500)', agentLiveLabel: st.agent.armed ? 'evaluating' : 'idle',
      budget: st.budget, budgetMax: st.budgetMax, certified: st.certified, incidents: st.incidents, writebacks: st.writebacks,
      minTrust: st.agent.minTrust, minTrustC: mtT.c, quarBar: st.agent.quarBar,
      msDown: () => setState((p) => ({ agent: { ...p.agent, minTrust: Math.max(0, p.agent.minTrust - 2) } })), msUp: () => setState((p) => ({ agent: { ...p.agent, minTrust: Math.min(100, p.agent.minTrust + 2) } })),
      qbDown: () => setState((p) => ({ agent: { ...p.agent, quarBar: Math.max(0, p.agent.quarBar - 2) } })), qbUp: () => setState((p) => ({ agent: { ...p.agent, quarBar: Math.min(100, p.agent.quarBar + 2) } })),
      typeToggles, actions, hasActions: actions.length > 0, noActions: actions.length === 0,
      agentLog, hasLog: agentLog.length > 0, noLog: agentLog.length === 0,
      watchRows, hasWatch: watchRows.length > 0, noWatch: watchRows.length === 0,
      channels, gates, alertTrust: st.alertTrust, alertTrustC: atT.c, minDown: st.minDown,
      atDown: () => setState((p) => ({ alertTrust: Math.max(0, p.alertTrust - 5) })), atUp: () => setState((p) => ({ alertTrust: Math.min(100, p.alertTrust + 5) })),
      dsDown: () => setState((p) => ({ minDown: Math.max(0, p.minDown - 1) })), dsUp: () => setState((p) => ({ minDown: p.minDown + 1 })),
      sources, slackMsgs, hasToast: !!st.toast, toast: st.toast,
    };
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div style={css('height:100vh;display:grid;grid-template-rows:54px 1fr;background:var(--color-bg)')}>

      {/* TOP BAR */}
      <header style={css('display:flex;align-items:center;justify-content:space-between;padding:0 20px;border-bottom:1px solid var(--color-divider);background:var(--color-bg)')}>
        <div style={css('display:flex;align-items:center;gap:12px')}>
          <div style={css('position:relative;width:22px;height:22px;display:grid;place-items:center')}>
            <span style={css('position:absolute;inset:0;border-radius:50%;border:1.5px solid var(--color-accent);box-shadow:0 0 12px var(--color-accent-700)')}></span>
            <span style={css('width:6px;height:6px;border-radius:50%;background:var(--color-accent)')}></span>
          </div>
          <div style={css('display:flex;flex-direction:column;line-height:1.1')}>
            <span style={css('font-family:var(--font-heading);font-size:17px;font-weight:600;letter-spacing:-.01em')}>Beacon</span>
            <span style={css('font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:var(--color-neutral-500)')}>Launch Radar · DataHub</span>
          </div>
        </div>
        <div style={css('display:flex;align-items:center;gap:8px;font-size:13px')}>
          <div style={css('display:flex;flex-direction:column;align-items:flex-end;padding:5px 13px;border-radius:var(--radius-md);background:var(--color-surface)')}>
            <span style={css('font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500)')}>Assets · 24h</span>
            <span style={css('font-size:14px;font-weight:600')}>{v.signals}</span>
          </div>
          <div style={css('display:flex;flex-direction:column;align-items:flex-end;padding:5px 13px;border-radius:var(--radius-md);background:var(--color-surface)')}>
            <span style={css('font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500)')}>Avg detect</span>
            <span style={css('font-size:14px;font-weight:600;color:' + v.latColor)}>{v.latency}<span style={css('font-size:10px;color:var(--color-neutral-500)')}> ms</span></span>
          </div>
          <div onClick={v.onConnClick} style={css(v.connBtnStyle)}>
            <span style={css('width:7px;height:7px;border-radius:50%;background:' + v.connDot)}></span>
            <div style={css('display:flex;flex-direction:column;align-items:flex-start;line-height:1.15')}><span style={css('font-size:12px;font-weight:500')}>{v.connLabel}</span><span style={css('font-size:9px;color:var(--color-neutral-500)')}>{v.connSub}</span></div>
          </div>
          <div style={css('display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:var(--radius-md);border:1px solid var(--color-accent-700);background:var(--color-accent-900)')}>
            <span style={css('position:relative;width:8px;height:8px')}><span style={css('position:absolute;inset:0;border-radius:50%;background:var(--ok);animation:pulse 1.5s infinite')}></span></span>
            <span style={css('font-size:11px;letter-spacing:.12em;font-weight:600;color:var(--color-accent-200)')}>LIVE</span>
          </div>
        </div>
      </header>

      {/* BODY */}
      <div style={css('display:grid;grid-template-columns:214px 1fr;overflow:hidden')}>

        {/* NAV */}
        <aside style={css('border-right:1px solid var(--color-divider);background:var(--color-bg);padding:16px 11px;display:flex;flex-direction:column;gap:3px')}>
          <div style={css('font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-neutral-600);padding:4px 11px 9px')}>Monitoring</div>
          {v.nav.map((n, i) => (
            <div key={i} onClick={n.onClick} style={css(n.style)}>
              <span style={css('width:6px;height:6px;border-radius:50%;background:' + n.dot)}></span>
              <span style={css('flex:1')}>{n.label}</span>
              {n.hasBadge && <span style={css('font-size:10px;padding:1px 7px;border-radius:20px;background:var(--color-neutral-800);color:var(--color-neutral-300)')}>{n.badge}</span>}
            </div>
          ))}
          <div style={css('margin-top:auto;padding:12px;border-radius:var(--radius-md);background:var(--color-surface)')}>
            <div style={css('font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:9px')}>Infrastructure</div>
            <div style={css('display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px')}><span style={css('color:var(--color-neutral-400)')}>MCP Server</span><span style={css('color:var(--ok)')}>connected</span></div>
            <div style={css('display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px')}><span style={css('color:var(--color-neutral-400)')}>Graph uptime</span><span>99.98%</span></div>
            <div style={css('display:flex;justify-content:space-between;font-size:12px')}><span style={css('color:var(--color-neutral-400)')}>Plan</span><span style={css('color:var(--color-accent-300)')}>Enterprise</span></div>
          </div>
        </aside>

        {/* CONTENT */}
        <section style={css('overflow:hidden;display:flex;flex-direction:column;position:relative')}>

          {/* ===== LAUNCH FEED ===== */}
          {v.isFeed && (
            <div data-screen-label="Launch Feed" style={css('display:flex;flex-direction:column;height:100%;overflow:hidden')}>
              <div style={css('display:flex;align-items:center;justify-content:space-between;padding:13px 20px;border-bottom:1px solid var(--color-divider)')}>
                <div style={css('display:flex;align-items:baseline;gap:12px')}>
                  <h5 style={css('margin:0')}>Launch Feed</h5>
                  <span style={css('font-size:12px;color:var(--color-neutral-500)')}>New &amp; changed assets across the DataHub graph · realtime</span>
                </div>
                <div style={css('display:flex;align-items:center;gap:6px')}>
                  {v.filters.map((fl, i) => (<button key={i} onClick={fl.onClick} style={css(fl.style)}>{fl.label}</button>))}
                  <button onClick={v.togglePause} style={css(v.pauseStyle)}>{v.pauseLabel}</button>
                </div>
              </div>
              <div style={css('display:grid;grid-template-columns:1fr 404px;overflow:hidden;flex:1')}>
                <div style={css('overflow-y:auto;border-right:1px solid var(--color-divider)')}>
                  <div style={css('position:sticky;top:0;z-index:2;display:grid;grid-template-columns:76px minmax(150px,1fr) 118px 96px 84px 66px 82px 84px;gap:9px;padding:10px 18px;background:var(--color-bg);border-bottom:1px solid var(--color-divider);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-500)')}>
                    <span>Detected</span><span>Asset</span><span>Platform</span><span>Type</span><span style={css('text-align:right')}>Rows</span><span style={css('text-align:right')}>Down</span><span style={css('text-align:right')}>Fresh</span><span style={css('text-align:right')}>Trust</span>
                  </div>
                  {v.rows.map((r, i) => (
                    <div key={i} onClick={r.onSelect} style={css(r.style)}>
                      <div style={css('display:flex;flex-direction:column;line-height:1.3')}><span style={css('font-size:12px')}>{r.ago}</span><span style={css('font-size:10px;color:' + r.latColor)}>{r.lat}ms</span></div>
                      <div style={css('display:flex;flex-direction:column;line-height:1.3;min-width:0')}><div style={css('display:flex;align-items:center;gap:6px')}><span style={css('width:6px;height:6px;border-radius:2px;background:' + r.changeC)}></span><span style={css('font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{r.name}</span></div><span style={css('font-size:10.5px;color:var(--color-neutral-500)')}>{r.changeLabel} · {r.domain}</span></div>
                      <div style={css('display:flex;align-items:center;gap:7px')}><span style={css('width:5px;height:5px;border-radius:50%;background:var(--color-neutral-500)')}></span><span style={css('font-size:12px;color:var(--color-neutral-300)')}>{r.platform}</span></div>
                      <div><span className={'tag ' + r.typeTag} style={css('font-size:10px')}>{r.type}</span></div>
                      <span style={css('font-size:12px;text-align:right;color:var(--color-neutral-300)')}>{r.rows}</span>
                      <span style={css('font-size:12px;text-align:right;color:var(--color-neutral-300)')}>{r.down}</span>
                      <span style={css('font-size:12px;text-align:right;color:' + r.freshC)}>{r.fresh}</span>
                      <div style={css('text-align:right')}><span style={css('font-size:12px;font-weight:600;padding:2px 9px;border-radius:6px;background:' + r.scoreBg + ';color:' + r.scoreC)}>{r.score}</span></div>
                    </div>
                  ))}
                </div>

                {/* DETAIL */}
                <div style={css('overflow-y:auto;background:var(--color-bg)')}>
                  {v.hasSel && (
                    <div style={css('padding:18px 20px')}>
                      <div style={css('display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px')}>
                        <div style={css('min-width:0')}>
                          <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:5px')}><span className={'tag ' + v.sel.typeTag} style={css('font-size:10px')}>{v.sel.type}</span><span style={css('font-size:11px;color:var(--color-neutral-500)')}>{v.sel.platform}</span></div>
                          <h4 style={css('margin:0;font-size:18px;word-break:break-all')}>{v.sel.name}</h4>
                          <div style={css('font-size:12px;color:var(--color-neutral-400);margin-top:4px')}>{v.sel.changeLabel} · {v.sel.domain} · owner {v.sel.owner}</div>
                        </div>
                        <div style={css('display:flex;flex-direction:column;align-items:center;gap:4px;flex:none')}>
                          <div style={css('width:68px;height:68px;border-radius:50%;display:grid;place-items:center;background:' + v.sel.gauge)}><div style={css('width:54px;height:54px;border-radius:50%;background:var(--color-bg);display:grid;place-items:center')}><span style={css('font-size:20px;font-weight:600;color:' + v.sel.scoreC)}>{v.sel.score}</span></div></div>
                          <span style={css('font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:' + v.sel.scoreC)}>{v.sel.verdict}</span>
                        </div>
                      </div>

                      <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--color-divider);border-radius:var(--radius-md);overflow:hidden;margin-bottom:16px')}>
                        {v.sel.metrics.map((m: any, i: number) => (
                          <div key={i} style={css('background:var(--color-surface);padding:9px 12px')}><div style={css('font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-500)')}>{m.k}</div><div style={css('font-size:13px;font-weight:500;color:' + m.c + ';margin-top:2px')}>{m.v}</div></div>
                        ))}
                      </div>

                      <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:10px')}>Governance breakdown · {v.sel.score}/100</div>
                      <div style={css('display:flex;flex-direction:column;gap:8px;margin-bottom:18px')}>
                        {v.sel.factors.map((f: any, i: number) => (
                          <div key={i} style={css('border-radius:var(--radius-md);padding:10px 12px;background:var(--color-surface)')}>
                            <div style={css('display:flex;align-items:center;justify-content:space-between;margin-bottom:6px')}>
                              <div style={css('display:flex;align-items:center;gap:8px')}><span style={css('width:7px;height:7px;border-radius:50%;background:' + f.c)}></span><span style={css('font-size:12px;font-weight:500')}>{f.label}</span></div>
                              <span style={css('font-size:11px;color:' + f.c)}>+{f.pts}/{f.max}</span>
                            </div>
                            <div style={css('display:flex;align-items:center;justify-content:space-between;gap:8px')}><span style={css('font-size:11px;color:var(--color-neutral-400)')}>{f.detail}</span><span style={css('font-size:9px;letter-spacing:.06em;padding:1px 7px;border-radius:5px;background:' + f.tagBg + ';color:' + f.c)}>{f.statusLabel}</span></div>
                          </div>
                        ))}
                      </div>

                      <div style={css('border-radius:var(--radius-md);background:var(--color-surface);padding:11px 12px 9px;margin-bottom:16px')}>
                        <div style={css('display:flex;align-items:center;justify-content:space-between;margin-bottom:7px')}>
                          <span style={css('font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-500)')}>Freshness / volume · 30s</span>
                          <span style={css('display:flex;align-items:center;gap:5px')}><span style={css('position:relative;width:7px;height:7px')}><span style={css('position:absolute;inset:0;border-radius:50%;background:var(--color-accent);animation:pulse 1.4s infinite')}></span></span><span style={css('font-size:10px;color:var(--color-accent-300)')}>streaming</span></span>
                        </div>
                        <svg viewBox="0 0 356 88" preserveAspectRatio="none" style={css('width:100%;height:88px;display:block;overflow:visible')}>
                          <defs><linearGradient id="bcArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={v.chart.col} stopOpacity="0.28"></stop><stop offset="100%" stopColor={v.chart.col} stopOpacity="0"></stop></linearGradient></defs>
                          <polygon points={v.chart.area} fill="url(#bcArea)"></polygon>
                          <polyline points={v.chart.pts} fill="none" stroke={v.chart.col} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"></polyline>
                          <line x1={v.chart.peakX} y1="0" x2={v.chart.peakX} y2="88" stroke="var(--ok)" strokeWidth="0.6" strokeDasharray="2 3" opacity="0.45"></line>
                          <line x1={v.chart.lowX} y1="0" x2={v.chart.lowX} y2="88" stroke="var(--risk)" strokeWidth="0.6" strokeDasharray="2 3" opacity="0.45"></line>
                          <circle cx={v.chart.peakX} cy={v.chart.peakY} r="3" fill="var(--ok)"></circle>
                          <circle cx={v.chart.lowX} cy={v.chart.lowY} r="3" fill="var(--risk)"></circle>
                          <circle cx={v.chart.lastX} cy={v.chart.lastY} r="4.5" fill="none" stroke={v.chart.col} strokeWidth="1.4"><animate attributeName="r" values="4.5;9;4.5" dur="1.4s" repeatCount="indefinite"></animate><animate attributeName="opacity" values="1;0;1" dur="1.4s" repeatCount="indefinite"></animate></circle>
                          <circle cx={v.chart.lastX} cy={v.chart.lastY} r="3" fill={v.chart.col}></circle>
                        </svg>
                        <div style={css('display:flex;justify-content:space-between;margin-top:5px;font-size:10px')}><span style={css('color:var(--ok)')}>▲ peak {v.chart.peakV}</span><span style={css('color:var(--risk)')}>▼ low {v.chart.lowV}</span></div>
                      </div>

                      <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:8px')}>
                        <button onClick={v.sel.onCertify} className="btn btn-primary btn-block" style={css('grid-column:1/3;margin-top:0')}>✓ Certify &amp; tag in DataHub</button>
                        <button onClick={v.sel.onWatch} className="btn btn-secondary" style={css(v.sel.watchExtra)}>{v.sel.watchLabel}</button>
                        <button onClick={v.sel.onNotify} className="btn btn-secondary">Notify owner</button>
                        <button onClick={v.sel.onExplorer} className="btn btn-secondary">Open in DataHub ↗</button>
                        <button onClick={v.sel.onSnooze} className="btn btn-secondary">Snooze</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ===== GOVERNANCE AGENT ===== */}
          {v.isAgent && (
            <div data-screen-label="Governance Agent" style={css('height:100%;overflow-y:auto;padding:20px 22px')}>
              <div style={css('display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px')}>
                <div>
                  <div style={css('display:flex;align-items:center;gap:10px')}><h5 style={css('margin:0')}>Autonomous Governance Agent</h5><span className={'tag ' + v.agentTag} style={css('font-size:10px')}>{v.agentStatus}</span></div>
                  <p style={css('font-size:12px;color:var(--color-neutral-500);margin:5px 0 0;max-width:640px')}>Scores every incoming asset on trust + lineage + freshness and auto-certifies high-confidence assets or quarantines risky ones — writing each decision back to the graph.</p>
                </div>
                <button onClick={v.toggleArm} className={'btn ' + v.armVariant}>{v.armLabel}</button>
              </div>

              {v.needConn && (
                <div style={css('border:1px solid var(--color-accent-700);background:var(--color-accent-900);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between')}>
                  <span style={css('font-size:13px;color:var(--color-accent-200)')}>Connect to a DataHub instance to arm the agent and enable write-backs.</span>
                  <button onClick={v.openConn} className="btn btn-primary">Connect DataHub</button>
                </div>
              )}

              <div style={css('display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px')}>
                <div className="card"><span className="card-kicker">Action budget</span><span style={css('font-size:22px;font-weight:600;color:var(--color-accent-300)')}>{v.budget}<span style={css('font-size:12px;color:var(--color-neutral-500)')}> / {v.budgetMax}</span></span></div>
                <div className="card"><span className="card-kicker">Assets certified</span><span style={css('font-size:22px;font-weight:600;color:var(--ok)')}>{v.certified}</span></div>
                <div className="card"><span className="card-kicker">Open incidents</span><span style={css('font-size:22px;font-weight:600;color:var(--risk)')}>{v.incidents}</span></div>
                <div className="card"><span className="card-kicker">Write-backs</span><span style={css('font-size:22px;font-weight:600')}>{v.writebacks}</span></div>
              </div>

              <div className="card" style={css('margin-bottom:18px;padding:16px')}>
                <div style={css('display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:24px;align-items:center')}>
                  <div>
                    <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:10px')}>Min trust to certify</div>
                    <div style={css('display:flex;align-items:center;justify-content:space-between')}>
                      <button onClick={v.msDown} className="btn btn-secondary btn-icon">–</button>
                      <span style={css('font-size:20px;font-weight:600;color:' + v.minTrustC)}>{v.minTrust}</span>
                      <button onClick={v.msUp} className="btn btn-secondary btn-icon">+</button>
                    </div>
                  </div>
                  <div>
                    <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:10px')}>Quarantine below</div>
                    <div style={css('display:flex;align-items:center;justify-content:space-between')}>
                      <button onClick={v.qbDown} className="btn btn-secondary btn-icon">–</button>
                      <span style={css('font-size:20px;font-weight:600;color:var(--risk)')}>{v.quarBar}</span>
                      <button onClick={v.qbUp} className="btn btn-secondary btn-icon">+</button>
                    </div>
                  </div>
                  <div>
                    <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:10px')}>Auto-act on entity types</div>
                    <div style={css('display:flex;flex-wrap:wrap;gap:8px')}>
                      {v.typeToggles.map((tt, i) => (<button key={i} onClick={tt.onClick} style={css(tt.style)}>{tt.label}</button>))}
                    </div>
                  </div>
                </div>
              </div>

              <div style={css('display:grid;grid-template-columns:1fr 396px;gap:18px;align-items:start')}>
                <div style={css('border-radius:var(--radius-md);overflow:hidden;background:var(--color-surface)')}>
                  <div style={css('display:grid;grid-template-columns:minmax(130px,1fr) 108px 96px 90px 40px;gap:9px;padding:11px 15px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-500);border-bottom:1px solid var(--color-divider)')}><span>Governance action</span><span>Kind</span><span>Opened</span><span style={css('text-align:right')}>Status</span><span></span></div>
                  {v.hasActions && v.actions.map((a, i) => (
                    <div key={i} style={css('display:grid;grid-template-columns:minmax(130px,1fr) 108px 96px 90px 40px;gap:9px;align-items:center;padding:11px 15px;border-bottom:1px solid var(--color-divider)')}>
                      <span style={css('font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{a.name}</span>
                      <span className={'tag ' + a.kindTag} style={css('font-size:10px')}>{a.kind}</span>
                      <span style={css('font-size:11px;color:var(--color-neutral-400)')}>{a.ago}</span>
                      <span style={css('font-size:11px;text-align:right;color:' + a.statusC)}>{a.status}</span>
                      <button onClick={a.onResolve} className="btn btn-secondary btn-icon" style={css('width:26px;height:26px;justify-self:end')}>×</button>
                    </div>
                  ))}
                  {v.noActions && (
                    <div style={css('padding:36px;text-align:center;font-size:12px;color:var(--color-neutral-500)')}>No open governance actions. Arm the agent to auto-certify and quarantine incoming assets.</div>
                  )}
                </div>

                <div style={css('border-radius:var(--radius-md);background:var(--color-surface);padding:14px')}>
                  <div style={css('display:flex;align-items:center;justify-content:space-between;margin-bottom:12px')}><span style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500)')}>Decision log</span><span style={css('display:flex;align-items:center;gap:5px')}><span style={css('position:relative;width:6px;height:6px')}><span style={css('position:absolute;inset:0;border-radius:50%;background:' + v.agentLiveDot + ';animation:pulse 1.5s infinite')}></span></span><span style={css('font-size:10px;color:' + v.agentLiveDot)}>{v.agentLiveLabel}</span></span></div>
                  {v.hasLog && (
                    <div style={css('display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto')}>
                      {v.agentLog.map((d, i) => (
                        <div key={i} style={css(d.style)}>
                          <div style={css('display:flex;align-items:center;justify-content:space-between;margin-bottom:4px')}><span style={css('font-size:9px;letter-spacing:.06em;padding:1px 7px;border-radius:5px;background:' + d.badgeBg + ';color:' + d.badgeC)}>{d.action}</span><span style={css('font-size:10px;color:var(--color-neutral-500)')}>{d.time}</span></div>
                          <div style={css('font-size:12px')}><span style={css('font-weight:500')}>{d.name}</span></div>
                          <div style={css('font-size:11px;color:var(--color-neutral-400);margin-top:1px')}>{d.reason}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {v.noLog && (
                    <div style={css('padding:26px 10px;text-align:center;font-size:11px;color:var(--color-neutral-500);line-height:1.6')}>Agent idle. Arm it and incoming assets are evaluated here in real time.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ===== WATCHLIST ===== */}
          {v.isWatch && (
            <div data-screen-label="Watchlist" style={css('height:100%;overflow-y:auto;padding:20px 22px')}>
              <h5 style={css('margin:0 0 3px')}>Watchlist</h5>
              <p style={css('font-size:12px;color:var(--color-neutral-500);margin-bottom:16px')}>Assets you pinned from the feed · re-scored every graph update</p>
              {v.hasWatch && (
                <div style={css('display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px')}>
                  {v.watchRows.map((w, i) => (
                    <div key={i} onClick={w.onSelect} className="card" style={css('cursor:pointer;gap:10px')}>
                      <div style={css('display:flex;align-items:center;justify-content:space-between;gap:8px')}>
                        <span style={css('font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}>{w.name}</span>
                        <span style={css('font-size:12px;font-weight:600;padding:2px 9px;border-radius:6px;background:' + w.scoreBg + ';color:' + w.scoreC + ';flex:none')}>{w.score}</span>
                      </div>
                      <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:8px')}>
                        <div><div style={css('font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--color-neutral-500)')}>Platform</div><div style={css('font-size:12px;color:var(--color-neutral-300)')}>{w.platform}</div></div>
                        <div><div style={css('font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--color-neutral-500)')}>Type</div><div style={css('font-size:12px;color:var(--color-neutral-300)')}>{w.type}</div></div>
                        <div><div style={css('font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--color-neutral-500)')}>Downstream</div><div style={css('font-size:12px;color:var(--color-neutral-300)')}>{w.down}</div></div>
                        <div><div style={css('font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--color-neutral-500)')}>Fresh</div><div style={css('font-size:12px;color:' + w.freshC)}>{w.fresh}</div></div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {v.noWatch && (
                <div style={css('border:1px dashed var(--color-divider);border-radius:var(--radius-md);padding:44px;text-align:center')}><div style={css('font-size:13px;color:var(--color-neutral-300);margin-bottom:4px')}>No assets pinned yet</div><div style={css('font-size:12px;color:var(--color-neutral-500)')}>Open an asset in the Launch Feed and hit “Watch” to pin it here.</div></div>
              )}
            </div>
          )}

          {/* ===== ALERT RULES ===== */}
          {v.isRules && (
            <div data-screen-label="Alert Rules" style={css('height:100%;overflow-y:auto;padding:20px 22px;max-width:780px')}>
              <h5 style={css('margin:0 0 3px')}>Alert Rules</h5>
              <p style={css('font-size:12px;color:var(--color-neutral-500);margin-bottom:18px')}>Only assets passing every rule below are pushed to your channels</p>

              <div className="card" style={css('margin-bottom:14px;padding:16px')}>
                <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:8px')}>Delivery channels</div>
                {v.channels.map((c, i) => (
                  <div key={i} style={css('display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--color-divider)')}>
                    <div><div style={css('font-size:13px;font-weight:500')}>{c.label}</div><div style={css('font-size:11px;color:var(--color-neutral-500)')}>{c.sub}</div></div>
                    <div onClick={c.onToggle} style={css(c.trackStyle)}><div style={css(c.knobStyle)}></div></div>
                  </div>
                ))}
              </div>

              <div style={css('display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px')}>
                <div className="card" style={css('padding:16px')}>
                  <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:12px')}>Min trust to alert</div>
                  <div style={css('display:flex;align-items:center;justify-content:space-between')}>
                    <button onClick={v.atDown} className="btn btn-secondary btn-icon">–</button>
                    <span style={css('font-size:22px;font-weight:600;color:' + v.alertTrustC)}>{v.alertTrust}</span>
                    <button onClick={v.atUp} className="btn btn-secondary btn-icon">+</button>
                  </div>
                </div>
                <div className="card" style={css('padding:16px')}>
                  <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:12px')}>Min downstream impact</div>
                  <div style={css('display:flex;align-items:center;justify-content:space-between')}>
                    <button onClick={v.dsDown} className="btn btn-secondary btn-icon">–</button>
                    <span style={css('font-size:22px;font-weight:600;color:var(--color-accent-300)')}>{v.minDown}</span>
                    <button onClick={v.dsUp} className="btn btn-secondary btn-icon">+</button>
                  </div>
                </div>
              </div>

              <div className="card" style={css('padding:16px')}>
                <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:8px')}>Governance gates</div>
                {v.gates.map((g, i) => (
                  <div key={i} style={css('display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--color-divider)')}>
                    <div style={css('font-size:13px')}>{g.label}</div>
                    <div onClick={g.onToggle} style={css(g.trackStyle)}><div style={css(g.knobStyle)}></div></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ===== SOURCE HEALTH ===== */}
          {v.isSources && (
            <div data-screen-label="Source Health" style={css('height:100%;overflow-y:auto;padding:20px 22px')}>
              <h5 style={css('margin:0 0 3px')}>Source Health</h5>
              <p style={css('font-size:12px;color:var(--color-neutral-500);margin-bottom:16px')}>DataHub ingestion sources + MCP Server connection status</p>
              <div style={css('border-radius:var(--radius-md);overflow:hidden;background:var(--color-surface)')}>
                <div style={css('display:grid;grid-template-columns:1fr 150px 110px 120px 120px;gap:9px;padding:11px 16px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--color-neutral-500);border-bottom:1px solid var(--color-divider)')}><span>Source</span><span>Type</span><span style={css('text-align:right')}>Latency</span><span style={css('text-align:right')}>Last event</span><span style={css('text-align:right')}>Status</span></div>
                {v.sources.map((s, i) => (
                  <div key={i} style={css('display:grid;grid-template-columns:1fr 150px 110px 120px 120px;gap:9px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--color-divider)')}>
                    <div style={css('display:flex;align-items:center;gap:9px')}><span style={css('width:7px;height:7px;border-radius:50%;background:' + s.dot)}></span><span style={css('font-size:13px;font-weight:500')}>{s.name}</span></div>
                    <span style={css('font-size:11.5px;color:var(--color-neutral-400)')}>{s.type}</span>
                    <span style={css('font-size:12px;text-align:right;color:' + s.pingC)}>{s.ping}ms</span>
                    <span style={css('font-size:12px;text-align:right;color:var(--color-neutral-400)')}>{s.last}</span>
                    <div style={css('text-align:right')}><span style={css('font-size:9px;letter-spacing:.06em;padding:2px 9px;border-radius:5px;background:' + s.badgeBg + ';color:' + s.badgeC)}>{s.status}</span></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ===== SLACK PREVIEW ===== */}
          {v.isSlack && (
            <div data-screen-label="Alert Preview" style={css('height:100%;overflow-y:auto;padding:20px 22px;display:flex;gap:30px')}>
              <div style={css('flex:0 0 340px')}>
                <div style={css('width:340px;border-radius:var(--radius-lg);background:var(--color-surface);overflow:hidden;box-shadow:var(--shadow-md)')}>
                  <div style={css('padding:13px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--color-divider)')}>
                    <div style={css('width:34px;height:34px;border-radius:9px;background:var(--color-accent);display:grid;place-items:center;color:var(--color-bg);font-weight:600;font-size:15px')}>B</div>
                    <div style={css('line-height:1.2')}><div style={css('font-size:13px;font-weight:600')}>Beacon</div><div style={css('font-size:10px;color:var(--color-neutral-500)')}>app · #data-governance</div></div>
                  </div>
                  <div style={css('padding:14px;display:flex;flex-direction:column;gap:12px;min-height:440px')}>
                    {v.slackMsgs.map((t, i) => (
                      <div key={i} style={css('background:var(--color-bg);border-radius:var(--radius-md);padding:12px;box-shadow:var(--shadow-sm)')}>
                        <div style={css('font-size:10px;font-weight:600;color:' + t.headC + ';letter-spacing:.04em;margin-bottom:7px')}>{t.head}</div>
                        <div style={css('font-size:13px;font-weight:500;margin-bottom:2px;word-break:break-all')}>{t.name}</div>
                        <div style={css('font-size:11px;color:var(--color-neutral-300);line-height:1.8;margin-top:5px')}>
                          <div>Platform · {t.platform} · {t.domain}</div>
                          <div>Trust · <span style={css('color:' + t.scoreC)}>{t.score}/100 {t.verdict}</span></div>
                          <div>{t.why}</div>
                          <div>Detected · <span style={css('color:var(--ok)')}>{t.lat}ms</span></div>
                        </div>
                        <div style={css('display:flex;gap:6px;margin-top:9px')}><span style={css('font-size:10px;border:1px solid var(--color-accent);color:var(--color-accent);padding:4px 10px;border-radius:6px')}>{t.cta}</span><span style={css('font-size:10px;border:1px solid var(--color-divider);color:var(--color-neutral-300);padding:4px 10px;border-radius:6px')}>Open in DataHub</span></div>
                        <div style={css('font-size:9px;color:var(--color-neutral-600);text-align:right;margin-top:6px')}>{t.time}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={css('flex:1;max-width:400px')}>
                <h5 style={css('margin:0 0 8px')}>Alert delivery</h5>
                <p style={css('font-size:13px;color:var(--color-neutral-400);line-height:1.6;margin-bottom:16px')}>Every asset that clears your rules is pushed to Slack or Telegram as a formatted card with inline actions. Median push latency after detection is <span style={css('color:var(--ok)')}>310ms</span>.</p>
                <div className="card" style={css('padding:15px')}>
                  <div style={css('font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-neutral-500);margin-bottom:8px')}>Connected</div>
                  <div style={css('display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-divider)')}><span style={css('font-size:13px')}>#data-governance</span><span className="tag tag-accent" style={css('font-size:10px')}>SLACK</span></div>
                  <div style={css('display:flex;align-items:center;justify-content:space-between;padding:8px 0')}><span style={css('font-size:13px')}>@beacon_alerts</span><span className="tag tag-neutral" style={css('font-size:10px')}>TELEGRAM</span></div>
                </div>
              </div>
            </div>
          )}

          {/* CONNECT MODAL */}
          {v.connModal && (
            <div onClick={v.closeConn} className="dialog-backdrop" style={css('position:absolute')}>
              <div onClick={v.stop} className="dialog">
                <div className="dialog-title">Connect to DataHub</div>
                <div className="dialog-body">The agent reads context and writes governance actions through this instance.</div>
                <div className="field"><label>GMS URL</label><input className="input" defaultValue="https://datahub.acme.io/api/gms" readOnly /></div>
                <div className="field"><label>Environment</label>
                  <div className="seg" style={css('width:100%')}>
                    <label className="seg-opt" style={css('flex:1;justify-content:center')}><input type="radio" name="env" defaultChecked />Prod</label>
                    <label className="seg-opt" style={css('flex:1;justify-content:center')}><input type="radio" name="env" />Staging</label>
                  </div>
                </div>
                <div className="dialog-actions"><button onClick={v.closeConn} className="btn btn-secondary">Cancel</button><button onClick={v.doConnect} className="btn btn-primary">Connect</button></div>
              </div>
            </div>
          )}

          {/* TOAST */}
          {v.hasToast && (
            <div style={css('position:absolute;bottom:20px;left:50%;transform:translateX(-50%);background:var(--color-surface);box-shadow:var(--shadow-md);font-size:12.5px;padding:10px 18px;border-radius:var(--radius-md);animation:toastIn .2s ease;z-index:20')}>{v.toast}</div>
          )}

        </section>
      </div>
    </div>
  );
}
