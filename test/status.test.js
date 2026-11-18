import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseApp, parseAppList, parseChecks, toReport, diff, diffLines, toCsv, toMarkdown, toChat, refreshCommands, needsAttention, readAds, readAso, readTech } from '../status.js';

const run = JSON.parse(readFileSync(new URL('../examples/run.json', import.meta.url)));
const prev = JSON.parse(readFileSync(new URL('../examples/previous.json', import.meta.url)));
const now = Date.parse('2026-11-18T08:00:00.000Z');

test('parseApp and parseAppList take ids, links, labels and comments', () => {
  assert.deepEqual(parseApp('493145008=Headspace'), { storeId: '493145008', label: 'Headspace' });
  assert.deepEqual(parseApp('https://apps.apple.com/us/app/duolingo/id570060128?l=en'), { storeId: '570060128', label: null });
  assert.throws(() => parseApp('duolingo'), /not an App Store id/);
  const list = parseAppList(readFileSync(new URL('../examples/competitors.txt', import.meta.url), 'utf8'));
  assert.deepEqual(list.map((a) => a.storeId), ['493145008', '570060128', '1459969523']);
  assert.equal(list[1].label, 'Duolingo');
  assert.equal(parseAppList('1000000001\n1000000001=Again').length, 1);
});

test('parseChecks validates names', () => {
  assert.deepEqual(parseChecks(), ['ads', 'aso', 'tech', 'requests']);
  assert.deepEqual(parseChecks('aso,tech'), ['aso', 'tech']);
  assert.throws(() => parseChecks('ads,charts'), /Unknown check/);
});

test('paid-ad refresh states map to verdicts', () => {
  assert.equal(readAds({ latest: null }, now, 30).verdict, 'missing');
  assert.equal(readAds({ latest: { state: 'running', requestedAt: '2026-11-18T07:00:00Z' } }, now, 30).verdict, 'running');
  assert.equal(readAds({ latest: { state: 'not_matched', settledAt: '2026-11-17T00:00:00Z' } }, now, 30).verdict, 'problem');
  assert.equal(readAds({ latest: { state: 'completed', settledAt: '2026-11-10T00:00:00Z', newAdCount: 2 } }, now, 30).verdict, 'ok');
  assert.equal(readAds({ latest: { state: 'completed', settledAt: '2026-09-10T00:00:00Z' } }, now, 30).verdict, 'stale');
  assert.equal(readAds({ error: '404 not_found' }, now, 30).verdict, 'error');
});

test('ASO and technology read only the documented status and date fields', () => {
  assert.equal(readAso({ status: 'completed', updatedAt: null }, now, 30).verdict, 'ok');
  assert.equal(readAso({ status: 'queued' }, now, 30).verdict, 'running');
  assert.equal(readAso({ status: 'unavailable', retryAt: '2026-11-21T00:00:00Z' }, now, 30).verdict, 'problem');
  const t = readTech({ status: 'observed', collectedAt: '2026-11-01T00:00:00Z', sdk: { status: 'observed', collectedAt: '2026-11-01T00:00:00Z', sdkCategories: [{}] }, bestRanks: { status: 'not_collected' } }, now, 30);
  assert.equal(t.verdict, 'missing');
  assert.equal(t.sdk.sdkCategories, undefined);
  assert.equal(readTech({ status: 'not_collected', sdk: { status: 'not_collected' }, bestRanks: { status: 'not_collected' } }, now, 30).verdict, 'missing');
});

test('report summary and overall verdicts from the example run', () => {
  const r = toReport(run);
  assert.deepEqual(r.summary, { apps: 5, ok: 1, running: 0, stale: 1, missing: 1, problem: 1, error: 1, openRequests: 3 });
  assert.deepEqual(r.apps.map((a) => a.verdict), ['ok', 'stale', 'missing', 'problem', 'error']);
  assert.equal(needsAttention(r).length, 4);
  assert.equal(r.adRefreshQuota.remaining, 2);
  assert.equal(toReport(run, { staleDays: 120 }).apps[1].verdict, 'ok');
});

test('diff lists verdict changes, new requests and list changes', () => {
  const d = diff(toReport(run), prev);
  const lines = diffLines(d);
  assert.ok(lines.some((l) => l.includes('Example Meal Planner') && l.includes('stale → ok')));
  assert.ok(lines.some((l) => l.includes('new or changed: aso requested')));
  assert.deepEqual(d.added, ['1000000005']);
  assert.throws(() => diff(toReport(run), { tool: 'other' }));
});

test('refresh commands are printed for stale and missing checks only', () => {
  const cmds = refreshCommands(toReport(run)).filter((l) => l.startsWith('curl'));
  assert.equal(cmds.length, 7);
  assert.ok(cmds.every((c) => c.includes('$PEEKPANDA_TOKEN') && !/Bearer [A-Za-z0-9]{10}/.test(c)));
  assert.ok(!cmds.some((c) => c.includes('1000000001')));
  assert.ok(refreshCommands(toReport(run), 'personal')[1].includes("x-genviral-tenancy: personal"));
});

test('markdown, csv and chat render', () => {
  const r = toReport(run);
  const md = toMarkdown(r, diff(r, prev), { commands: true });
  assert.match(md, /Needs attention/);
  assert.match(md, /Refresh requests/);
  assert.doesNotMatch(md, /listed but/);
  const tight = { ...r, adRefreshQuota: { ...r.adRefreshQuota, remaining: 1 } };
  assert.match(toMarkdown(tight, null, { commands: true }), /2 paid-ad refresh\(es\) listed but 1 left/);
  const csv = toCsv(r).split('\n');
  assert.equal(csv[0], 'store_id,label,overall,check,verdict,detail,status,date,age_days');
  assert.equal(csv.length, 21);
  assert.match(toChat(r), /Needs attention: Example Recipe Box/);
});
