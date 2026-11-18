// Collection status logic for PeekPanda competitor reads. No dependencies; runs in Node 18+ and in the browser.
// Input: the raw file the CLI saves (--save), with one entry per app holding up to four documented status reads:
//   adRefresh    GET /v1/competitors/ios/{storeId}/paid-ads/refresh   (MCP get_app ad_refresh_status)
//   aso          GET /v1/competitors/ios/{storeId}/aso/collection     (MCP get_app aso_status)
//   technology   GET /v1/competitors/ios/{storeId}/technology         (MCP get_app technology; only the status and date fields are used)
//   dataRequests GET /v1/competitors/ios/{storeId}/data-requests      (MCP get_app data_requests)
// None of these reads starts collection.

export const CHECKS = ['ads', 'aso', 'tech', 'requests'];
export const DEFAULT_STALE_DAYS = 30;
const DAY = 86400000;

// "1234567890", "1234567890=My label", "https://apps.apple.com/us/app/name/id1234567890" (optionally "=Label")
export function parseApp(token) {
  const s = String(token ?? '').trim();
  if (!s || s.startsWith('#')) return null;
  const eq = s.lastIndexOf('=');
  let ref = s, label = null;
  if (eq > 0) {
    const left = s.slice(0, eq).trim();
    if (/^\d{5,12}$/.test(left) || /\/id\d{5,12}\/?$/.test(left)) { ref = left; label = s.slice(eq + 1).trim() || null; }
  }
  let id = null;
  if (/^\d{5,12}$/.test(ref)) id = ref;
  else {
    const m = ref.match(/apps\.apple\.com\/.*?\bid(\d{5,12})\b/);
    if (m) id = m[1];
  }
  if (!id) throw new Error(`"${s}" is not an App Store id or an apps.apple.com link.`);
  return { storeId: id, label };
}

export function parseAppList(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const clean = line.replace(/(^|\s)#.*$/, '').trim();
    if (!clean) continue;
    for (const part of clean.split(',')) { const a = parseApp(part); if (a) out.push(a); }
  }
  const seen = new Map();
  for (const a of out) { const p = seen.get(a.storeId); if (!p) seen.set(a.storeId, a); else if (!p.label && a.label) p.label = a.label; }
  return [...seen.values()];
}

export function parseChecks(v) {
  if (v == null || v === '' || v === 'all') return [...CHECKS];
  const list = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of list) if (!CHECKS.includes(c)) throw new Error(`Unknown check "${c}". Use ${CHECKS.join(', ')}.`);
  return [...new Set(list)];
}

const ageDays = (iso, now) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
};
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

// verdicts: ok, stale, missing, running, problem, error (the read itself failed), skipped
export const RANK = { error: 0, problem: 1, missing: 2, stale: 3, running: 4, ok: 5, skipped: 6 };
const worst = (vs) => vs.filter((v) => v !== 'skipped').sort((a, b) => RANK[a] - RANK[b])[0] ?? 'skipped';

export function readAds(r, now, staleDays) {
  if (!r) return { verdict: 'skipped' };
  if (r.error) return { verdict: 'error', error: r.error };
  const l = r.latest ?? null;
  const quota = r.quota ? { kind: r.quota.kind ?? null, limit: r.quota.limit ?? null, used: r.quota.used ?? null, remaining: r.quota.remaining ?? null, resetAt: r.quota.resetAt ?? null } : null;
  const base = { quota, state: l?.state ?? null, requestedAt: l?.requestedAt ?? null, settledAt: l?.settledAt ?? null, newAdCount: l?.newAdCount ?? null };
  if (!l) return { ...base, verdict: 'missing', why: 'no requested refresh yet (latest is null)' };
  const age = ageDays(l.settledAt ?? l.requestedAt, now);
  if (l.state === 'running') return { ...base, ageDays: age, verdict: 'running', why: `walk running since ${day(l.requestedAt)}` };
  if (l.state === 'failed') return { ...base, ageDays: age, verdict: 'problem', why: 'last refresh failed (not counted; can be retried)' };
  if (l.state === 'not_matched') return { ...base, ageDays: age, verdict: 'problem', why: 'no advertiser has the exact app name, so no ads are attributed' };
  if (l.state === 'completed') {
    const n = l.newAdCount == null ? '' : `, ${l.newAdCount} new ad(s)`;
    if (age != null && age > staleDays) return { ...base, ageDays: age, verdict: 'stale', why: `last requested refresh settled ${age} days ago${n}` };
    return { ...base, ageDays: age, verdict: 'ok', why: `last requested refresh settled ${day(l.settledAt)}${n}` };
  }
  return { ...base, ageDays: age, verdict: 'problem', why: `unexpected state ${l.state}` };
}

export function readAso(r, now, staleDays) {
  if (!r) return { verdict: 'skipped' };
  if (r.error) return { verdict: 'error', error: r.error };
  const base = { status: r.status ?? null, country: r.country ?? null, language: r.language ?? null, updatedAt: r.updatedAt ?? null, retryAt: r.retryAt ?? null };
  const s = String(r.status ?? '').toLowerCase();
  const age = ageDays(r.updatedAt, now);
  const retry = r.retryAt ? `, retry after ${r.retryAt}` : '';
  if (s === 'completed' || s === 'complete') {
    if (age != null && age > staleDays) return { ...base, ageDays: age, verdict: 'stale', why: `completed, updated ${age} days ago` };
    return { ...base, ageDays: age, verdict: 'ok', why: r.updatedAt ? `completed, updated ${day(r.updatedAt)}` : 'completed (no updatedAt given)' };
  }
  if (s === 'queued' || s === 'running' || s === 'pending') return { ...base, ageDays: age, verdict: 'running', why: `${s}${retry}` };
  if (s === 'unavailable' || s === 'failed') return { ...base, ageDays: age, verdict: 'problem', why: `${s}${retry}` };
  if (!s || s === 'not_collected' || s === 'not_requested' || s === 'idle' || s === 'none') return { ...base, ageDays: age, verdict: 'missing', why: `${s || 'no status'}${retry}` };
  return { ...base, ageDays: age, verdict: 'problem', why: `status ${s}${retry}` };
}

// Only the documented parts: status observed|not_collected, and sdk / bestRanks each with their own status and date.
export function readTech(r, now, staleDays) {
  if (!r) return { verdict: 'skipped' };
  if (r.error) return { verdict: 'error', error: r.error };
  const part = (p) => ({ status: p?.status ?? null, collectedAt: p?.collectedAt ?? null, ageDays: ageDays(p?.collectedAt, now) });
  const base = { status: r.status ?? null, collectedAt: r.collectedAt ?? null, sdk: part(r.sdk), bestRanks: part(r.bestRanks) };
  if (r.status !== 'observed') return { ...base, verdict: 'missing', why: 'status not_collected; opening the read does not start collection' };
  const missing = ['sdk', 'bestRanks'].filter((k) => base[k].status !== 'observed');
  const ages = ['sdk', 'bestRanks'].map((k) => base[k].ageDays).filter((x) => x != null);
  const age = ages.length ? Math.max(...ages) : ageDays(r.collectedAt, now);
  const names = { sdk: 'SDK', bestRanks: 'best ranks' };
  if (missing.length) return { ...base, ageDays: age, verdict: 'missing', why: `observed, but ${missing.map((k) => names[k]).join(' and ')} not collected` };
  if (age != null && age > staleDays) return { ...base, ageDays: age, verdict: 'stale', why: `observed ${age} days ago` };
  return { ...base, ageDays: age, verdict: 'ok', why: `observed ${day(r.collectedAt) ?? ''}`.trim() };
}

export function readRequests(r, now) {
  if (!r) return { verdict: 'skipped' };
  if (r.error) return { verdict: 'error', error: r.error };
  const rows = (Array.isArray(r?.data) ? r.data : []).map((x) => ({ id: x.id ?? null, kind: x.kind ?? null, status: x.status ?? null, requestedAt: x.requestedAt ?? null, ageDays: ageDays(x.requestedAt, now) }));
  const open = rows.filter((x) => x.status === 'requested');
  // A request is account-scoped demand, not a collection, so it never makes an app worse than "ok".
  return { rows, open: open.length, verdict: 'ok', why: rows.length ? `${rows.length} request(s): ${rows.map((x) => `${x.kind} ${x.status} ${day(x.requestedAt) ?? ''}`.trim()).join(', ')}` : 'none filed' };
}

export function toReport(input, opts = {}) {
  if (input?.tool === 'competitor-collection-status') return input;
  if (input?.tool !== 'competitor-collection-status/raw') throw new Error('Expected the file this tool saves with --save, or a report it printed with --format json.');
  const staleDays = Number(opts.staleDays ?? input.staleDays ?? DEFAULT_STALE_DAYS);
  const now = Date.parse(input.fetchedAt) || Date.now();
  const apps = (input.apps ?? []).map((a) => {
    const checks = {
      ads: readAds(a.adRefresh, now, staleDays),
      aso: readAso(a.aso, now, staleDays),
      tech: readTech(a.technology, now, staleDays),
      requests: readRequests(a.dataRequests, now),
    };
    return { storeId: String(a.storeId), label: a.label ?? null, verdict: worst(Object.values(checks).map((c) => c.verdict)), checks };
  });
  const count = (k) => apps.filter((a) => a.verdict === k).length;
  const quota = apps.map((a) => a.checks.ads.quota).find(Boolean) ?? null;
  return {
    tool: 'competitor-collection-status',
    fetchedAt: input.fetchedAt,
    tenancy: input.tenancy ?? null,
    staleDays,
    checks: input.checks ?? CHECKS,
    adRefreshQuota: quota,
    summary: { apps: apps.length, ok: count('ok'), running: count('running'), stale: count('stale'), missing: count('missing'), problem: count('problem'), error: count('error'), openRequests: apps.reduce((n, a) => n + (a.checks.requests.open ?? 0), 0) },
    apps,
  };
}

export const needsAttention = (r) => r.apps.filter((a) => ['stale', 'missing', 'problem', 'error'].includes(a.verdict));

const nm = (a) => (a.label ? `${a.label} (${a.storeId})` : a.storeId);
const CHECK_NAMES = { ads: 'paid-ad refresh', aso: 'ASO collection', tech: 'technology', requests: 'data requests' };
export const VERDICT_LABEL = { ok: 'ok', running: 'running', stale: 'stale', missing: 'not collected', problem: 'problem', error: 'read failed', skipped: '–' };

export function diff(cur, prev) {
  if (prev?.tool !== 'competitor-collection-status') throw new Error('not a report');
  const before = new Map(prev.apps.map((a) => [a.storeId, a]));
  const out = { since: prev.fetchedAt, changes: [], added: [], dropped: [] };
  for (const a of cur.apps) {
    const p = before.get(a.storeId);
    if (!p) { out.added.push(a.storeId); continue; }
    for (const k of CHECKS) {
      const c = a.checks[k], q = p.checks?.[k];
      if (!q || c.verdict === 'skipped' || q.verdict === 'skipped') continue;
      if (c.verdict !== q.verdict) out.changes.push({ storeId: a.storeId, label: a.label, check: k, from: q.verdict, to: c.verdict, why: c.why ?? c.error ?? '' });
      else if (k === 'ads' && c.settledAt && c.settledAt !== q.settledAt) out.changes.push({ storeId: a.storeId, label: a.label, check: k, from: q.verdict, to: c.verdict, why: `refreshed again: ${c.why}` });
      else if (k === 'requests') {
        const old = new Set((q.rows ?? []).map((x) => `${x.kind}:${x.status}`));
        const fresh = (c.rows ?? []).filter((x) => !old.has(`${x.kind}:${x.status}`));
        if (fresh.length) out.changes.push({ storeId: a.storeId, label: a.label, check: k, from: q.verdict, to: c.verdict, why: `new or changed: ${fresh.map((x) => `${x.kind} ${x.status}`).join(', ')}` });
      }
    }
  }
  const now = new Set(cur.apps.map((a) => a.storeId));
  for (const p of prev.apps) if (!now.has(p.storeId)) out.dropped.push(p.storeId);
  return out;
}

export function diffLines(d) {
  const L = d.changes.map((c) => `${nm(c)} ${CHECK_NAMES[c.check]}: ${c.from === c.to ? VERDICT_LABEL[c.to] : `${VERDICT_LABEL[c.from]} → ${VERDICT_LABEL[c.to]}`}${c.why ? ` (${c.why})` : ''}`);
  if (d.added.length) L.push(`new in your list: ${d.added.join(', ')}`);
  if (d.dropped.length) L.push(`no longer in your list: ${d.dropped.join(', ')}`);
  return L;
}

// Requests worth sending for apps that need attention. Printed, never run (scope content:write).
export function refreshCommands(r, tenancy = null) {
  const hdr = `--header "Authorization: Bearer $PEEKPANDA_TOKEN"${tenancy ? ` --header 'x-genviral-tenancy: ${tenancy}'` : ''}`;
  const base = 'https://api.peekpanda.com/v1/competitors/ios';
  const out = [];
  for (const a of r.apps) {
    const c = a.checks;
    if (['missing', 'stale'].includes(c.ads.verdict) || (c.ads.verdict === 'problem' && c.ads.state === 'failed'))
      out.push(`# ${nm(a)}: paid-ad refresh (${c.ads.why}); counts toward the refresh limit unless it fails`, `curl --request POST '${base}/${a.storeId}/paid-ads/refresh' ${hdr} --header 'Idempotency-Key: ${a.storeId}-${String(r.fetchedAt).slice(0, 10)}'`);
    if (['missing', 'stale'].includes(c.aso.verdict) || (c.aso.verdict === 'problem' && String(c.aso.status).toLowerCase() === 'failed'))
      out.push(`# ${nm(a)}: ASO collection (${c.aso.why})`, `curl --request POST '${base}/${a.storeId}/aso/collection' ${hdr}`);
    if (['missing', 'stale'].includes(c.tech.verdict))
      out.push(`# ${nm(a)}: technology (${c.tech.why}); fresh observations are reused`, `curl --request POST '${base}/${a.storeId}/technology' ${hdr}`);
  }
  return out;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (c) => (c.verdict === 'skipped' ? '–' : c.verdict === 'error' ? `read failed: ${c.error}` : `${VERDICT_LABEL[c.verdict]}: ${c.why}`);

export function quotaLine(q) {
  if (!q) return null;
  if (q.kind === 'unlimited') return 'Paid-ad refresh quota: unlimited for this tenancy.';
  if (q.kind === 'daily') return `Paid-ad refresh quota: ${q.remaining} of ${q.limit} left${q.resetAt ? `, resets ${q.resetAt}` : ''}.`;
  return `Paid-ad refresh quota: ${q.kind}.`;
}

export function toMarkdown(r, d = null, opts = {}) {
  const s = r.summary;
  const L = ['## Competitor collection status', ''];
  L.push(`${s.apps} app(s) checked on ${day(r.fetchedAt)}: ${s.ok} ok, ${s.running} running, **${s.stale} stale** (older than ${r.staleDays} days), **${s.missing} not collected**, ${s.problem} with a problem${s.error ? `, ${s.error} read failed` : ''}. ${s.openRequests} open data request(s).${r.tenancy ? ` Tenancy ${r.tenancy}.` : ''}`);
  const q = quotaLine(r.adRefreshQuota);
  if (q) L.push('', q);
  if (d) {
    L.push('', `### Since the last check (${day(d.since)})`, '');
    const lines = diffLines(d);
    L.push(...(lines.length ? lines.map((x) => `- ${x}`) : ['- No changes.']));
  }
  const att = needsAttention(r);
  if (att.length) {
    L.push('', '### Needs attention', '');
    for (const a of att) {
      const bad = CHECKS.filter((k) => ['stale', 'missing', 'problem', 'error'].includes(a.checks[k].verdict));
      L.push(`- ${nm(a)}: ${bad.map((k) => `${CHECK_NAMES[k]} ${short(a.checks[k])}`).join('; ')}`);
    }
  }
  L.push('', '| App | Store id | Overall | Paid-ad refresh | ASO collection | Technology | Data requests |', '|---|---|---|---|---|---|---|');
  const order = [...r.apps].sort((a, b) => RANK[a.verdict] - RANK[b.verdict]);
  for (const a of order) L.push(`| ${cell(a.label ?? '')} | ${a.storeId} | ${VERDICT_LABEL[a.verdict]} | ${cell(short(a.checks.ads))} | ${cell(short(a.checks.aso))} | ${cell(short(a.checks.tech))} | ${cell(a.checks.requests.verdict === 'skipped' ? '–' : a.checks.requests.error ? `read failed: ${a.checks.requests.error}` : a.checks.requests.why)} |`);
  L.push('', 'Status reads only: none of them starts collection. "Stale" uses the dates in the payload, so a fresh HTTP answer about an old observation is still old.');
  if (opts.commands) {
    const cmds = refreshCommands(r, opts.tenancy);
    L.push('', '### Refresh requests (content:write, not run by this tool)', '');
    const ads = cmds.filter((x) => x.includes('/paid-ads/refresh')).length;
    const q = r.adRefreshQuota;
    if (q?.kind === 'daily' && ads > (q.remaining ?? 0)) L.push(`${ads} paid-ad refresh(es) listed but ${q.remaining} left in the refresh quota; the rest answer limited until ${q.resetAt ?? 'the quota resets'}.`, '');
    L.push(...(cmds.length ? ['```sh', ...cmds, '```'] : ['Nothing to refresh.']));
  }
  return L.join('\n');
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(r) {
  const out = [['store_id', 'label', 'overall', 'check', 'verdict', 'detail', 'status', 'date', 'age_days'].join(',')];
  for (const a of r.apps) {
    const c = a.checks;
    const rows = [
      ['ads', c.ads.verdict, c.ads.why ?? c.ads.error, c.ads.state, c.ads.settledAt ?? c.ads.requestedAt, c.ads.ageDays],
      ['aso', c.aso.verdict, c.aso.why ?? c.aso.error, c.aso.status, c.aso.updatedAt, c.aso.ageDays],
      ['tech', c.tech.verdict, c.tech.why ?? c.tech.error, c.tech.status, c.tech.collectedAt, c.tech.ageDays],
      ['requests', c.requests.verdict, c.requests.why ?? c.requests.error, c.requests.open != null ? `${c.requests.open} open` : '', '', ''],
    ];
    for (const row of rows) if (row[1] !== 'skipped') out.push([a.storeId, a.label, a.verdict, ...row].map(csvCell).join(','));
  }
  return out.join('\n');
}

export function toChat(r, d = null) {
  const s = r.summary;
  const lines = [`PeekPanda collection status: ${s.apps} apps, ${s.ok} ok, ${s.running} running, ${s.stale} stale, ${s.missing} not collected, ${s.problem} with a problem.`];
  const att = needsAttention(r);
  if (att.length) lines.push(`Needs attention: ${att.slice(0, 12).map(nm).join(', ')}${att.length > 12 ? ` and ${att.length - 12} more` : ''}`);
  if (d) for (const x of diffLines(d).slice(0, 10)) lines.push(`• ${x}`);
  return lines.join('\n');
}
