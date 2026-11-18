#!/usr/bin/env node
// Competitor collection status for PeekPanda. Node 18+, no dependencies. Read-only.
// Per app, up to four status reads (scope context:read), none of which starts collection:
//   GET /v1/competitors/ios/{storeId}/paid-ads/refresh   latest requested paid-ad refresh + refresh quota (MCP get_app ad_refresh_status)
//   GET /v1/competitors/ios/{storeId}/aso/collection     US/en_us ASO collection lifecycle (MCP get_app aso_status)
//   GET /v1/competitors/ios/{storeId}/technology         technology status and dates only (MCP get_app technology)
//   GET /v1/competitors/ios/{storeId}/data-requests      your recorded data requests for the app (MCP get_app data_requests)
import { readFile, writeFile } from 'node:fs/promises';
import { parseApp, parseAppList, parseChecks, toReport, toMarkdown, toCsv, toChat, diff, needsAttention, DEFAULT_STALE_DAYS } from './status.js';

const HELP = `Usage:
  PEEKPANDA_TOKEN=... node cli.js --apps <ids|links> [opts]       status of each collection for these apps
  PEEKPANDA_TOKEN=... node cli.js --apps-file competitors.txt     one id or apps.apple.com link per line (optional =Label, # comments)
  node cli.js --file run.json [opts]                              re-render a saved run or report

Options:
  --apps <list>          comma-separated App Store ids or apps.apple.com links, "id=Label" allowed; repeatable
  --apps-file <path>     a list file (see above); can be combined with --apps
  --checks <list>        ads,aso,tech,requests (default all four; each is one call per app)
  --stale-days <n>       call an observation stale when its payload date is older than this (default ${DEFAULT_STALE_DAYS})
  --tenancy <selector>   send x-genviral-tenancy (personal or a workspace id). Left out by default: a key pinned to a
                         workspace reads that workspace, and naming one it cannot reach answers 403 workspace_not_accessible.
  --commands             print the POST refresh requests for apps that are stale or not collected (content:write, not run)
  --fail-on-stale        exit with code 2 when an app is stale, not collected or has a problem (for CI)
  --state <path>         compare with the report saved at this path, then save this run there
  --save <path>          save the raw responses (re-render later with --file)
  --format md|csv|json   output format (default md; json is this tool's report)
  --webhook <url>        also POST a short summary to a Slack or Discord incoming webhook
  --api <url>            API base (default https://api.peekpanda.com)

Calls per run: one per app per check (4 per app by default).
Every call counts toward your plan's daily API and MCP allowance (Peek 30, Panda 1,000, reset 00:00 UTC).`;

const FLAGS = new Set(['--help', '-h', '--commands', '--fail-on-stale']);
function parse(argv) {
  const o = { format: 'md', api: 'https://api.peekpanda.com', apps: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) o[a === '-h' ? 'help' : a.slice(2)] = true;
    else if (a === '--apps') {
      const v = argv[++i];
      if (v == null) throw new Error('--apps needs a value.');
      o.apps.push(...String(v).split(',').map(parseApp).filter(Boolean));
    } else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value. See --help.`);
      o[a.slice(2)] = v;
    } else throw new Error(`Unexpected argument "${a}". See --help.`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

class StopError extends Error {}

async function call(o, path, retried = false) {
  const token = process.env.PEEKPANDA_TOKEN;
  if (!token) throw new StopError('Set PEEKPANDA_TOKEN to a PeekPanda API key (Account → API keys). Never commit it.');
  calls++;
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (o.tenancy) headers['x-genviral-tenancy'] = o.tenancy;
  const res = await fetch(new URL(path, o.api), { headers });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  const code = body?.error?.code ?? '';
  const retry = Number(res.headers.get('retry-after') ?? body?.error?.retryAfterSeconds);
  // 429 rate_limited and 503 timeout: honor a short Retry-After once. daily_call_limit: stop the run.
  if ((code === 'rate_limited' || res.status === 503) && !retried && retry > 0 && retry <= 70) {
    await sleep(retry * 1000);
    return call(o, path, true);
  }
  const msg = `${res.status} ${code}`.trim();
  if (code === 'daily_call_limit') throw new StopError(`PeekPanda API ${msg}: the daily API and MCP allowance is used until 00:00 UTC; stopping.`);
  if ([401, 402].includes(res.status) || code === 'authorization_required' || code === 'workspace_not_accessible') {
    const hint = { workspace_not_accessible: ' The key cannot reach that tenancy; leave out --tenancy or use a selector from GET /v1/workspaces.', authorization_required: ' Check the key scopes (context:read).', subscription_required: ' These reads need a plan with API access.' }[code] ?? '';
    throw new StopError(`PeekPanda API ${msg} (GET ${path}): ${String(body?.error?.message ?? res.statusText).replace(/\.$/, '')}.${hint}`);
  }
  // 404 (outside the accessible catalogue) and other per-app failures are kept in the report.
  return { error: `${msg}${body?.error?.message ? ` ${String(body.error.message).replace(/\.$/, '')}` : ''}` };
}

const PATHS = { ads: 'paid-ads/refresh', aso: 'aso/collection', tech: 'technology', requests: 'data-requests' };
const KEYS = { ads: 'adRefresh', aso: 'aso', tech: 'technology', requests: 'dataRequests' };

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  if (!['md', 'csv', 'json'].includes(o.format)) throw new Error('--format must be md, csv or json');
  const staleDays = o['stale-days'] != null ? Number(o['stale-days']) : DEFAULT_STALE_DAYS;
  if (!Number.isFinite(staleDays) || staleDays < 0) throw new Error('--stale-days must be a number of days');

  let input;
  if (o.file) input = JSON.parse(await readFile(o.file, 'utf8'));
  else {
    let apps = [...o.apps];
    if (o['apps-file']) apps.push(...parseAppList(await readFile(o['apps-file'], 'utf8')));
    apps = parseAppList(apps.map((a) => (a.label ? `${a.storeId}=${a.label}` : a.storeId)).join('\n'));
    if (!apps.length) throw new Error('Name apps with --apps or --apps-file. See --help.');
    const checks = parseChecks(o.checks);
    const planned = apps.length * checks.length;
    if (planned > 30) console.error(`Note: this run plans ${planned} calls; Peek allows 30 API and MCP calls a UTC day.`);
    const fetchedAt = new Date().toISOString();
    const rows = [];
    let stopped = null;
    outer: for (const a of apps) {
      const row = { storeId: a.storeId, label: a.label };
      for (const c of checks) {
        try { row[KEYS[c]] = await call(o, `/v1/competitors/ios/${a.storeId}/${PATHS[c]}`); }
        catch (e) { if (e instanceof StopError) { stopped = e.message; if (Object.keys(row).length > 2) rows.push(row); break outer; } throw e; }
      }
      rows.push(row);
    }
    if (stopped && !rows.length) throw new Error(stopped);
    if (stopped) console.error(`${stopped} Reporting the ${rows.length} app(s) read so far.`);
    input = { tool: 'competitor-collection-status/raw', fetchedAt, tenancy: o.tenancy ?? null, staleDays, checks, apps: rows };
    if (o.save) await writeFile(o.save, JSON.stringify(input, null, 2));
    console.error(`${calls} API call(s) used.`);
  }
  const report = toReport(input, o['stale-days'] != null ? { staleDays } : {});

  let d = null;
  if (o.state) {
    const prev = await readFile(o.state, 'utf8').then(JSON.parse).catch(() => null);
    if (prev) { try { d = diff(report, prev); } catch { console.error(`Note: ${o.state} is not a competitor-collection-status report, so no comparison was made. It will be replaced.`); } }
    await writeFile(o.state, JSON.stringify(report, null, 2));
  }

  if (o.format === 'json') console.log(JSON.stringify(report, null, 2));
  else if (o.format === 'csv') console.log(toCsv(report));
  else console.log(toMarkdown(report, d, { commands: o.commands, tenancy: o.tenancy }));

  if (o.webhook) {
    const text = toChat(report, d);
    const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(o.webhook);
    const r = await fetch(o.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isDiscord ? { content: text.slice(0, 1900) } : { text }) });
    if (!r.ok) throw new Error(`Webhook returned ${r.status}`);
  }
  if (o['fail-on-stale'] && needsAttention(report).length) process.exitCode = 2;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
