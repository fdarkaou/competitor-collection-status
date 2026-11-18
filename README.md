# competitor-collection-status

Every competitor in a case file is only as current as the dates on its evidence. Before you build a report, a deck or an agent answer on top of a competitor's paid ads, keywords or SDKs, it helps to know which of those were collected last week, which are two months old, which are still running and which were never collected at all.

This tool asks PeekPanda four status questions about each app on your list: when the last paid-ad refresh you asked for settled (and how many new ads it found), where the US ASO collection stands, whether technology evidence (SDKs and best chart positions) has been observed and when, and which data requests you have filed. It sorts every app into ok, running, stale, not collected or problem, prints the refresh requests worth sending (it never sends them), and with `--state` tells you what changed since the last check. `--fail-on-stale` fails a CI job, and it can post a short summary to Slack or Discord.

Output is Markdown, CSV or JSON. Node 18+, no dependencies, read-only: none of the four reads starts collection. There is also a [browser version](https://fdarkaou.github.io/competitor-collection-status/) that reads pasted JSON and never sends anything anywhere.

```
## Competitor collection status

5 app(s) checked on 2026-11-18: 1 ok, 0 running, **1 stale** (older than 30 days), **1 not collected**, 1 with a problem, 1 read failed. 3 open data request(s).

Paid-ad refresh quota: 2 of 3 left, resets 2026-11-19T08:00:00.000Z.

### Since the last check (2026-11-11)

- Example Meal Planner (1000000001) paid-ad refresh: stale → ok (last requested refresh settled 2026-11-12, 4 new ad(s))
- Example Grocery List (1000000003) paid-ad refresh: not collected → running (walk running since 2026-11-18)
- Example Grocery List (1000000003) ASO collection: not collected → running (queued)
- Example Grocery List (1000000003) data requests: ok (new or changed: aso requested)
- Example Macro Coach (1000000004) paid-ad refresh: not collected → problem (no advertiser has the exact app name, so no ads are attributed)
- Example Macro Coach (1000000004) ASO collection: running → problem (unavailable, retry after 2026-11-21T00:00:00.000Z)
- Example Macro Coach (1000000004) data requests: ok (new or changed: paid_ads requested)
- new in your list: 1000000005

### Needs attention

- Example Recipe Box (1000000002): paid-ad refresh stale: last requested refresh settled 58 days ago, 11 new ad(s); ASO collection stale: completed, updated 80 days ago; technology stale: observed 77 days ago
- Example Grocery List (1000000003): technology not collected: observed, but best ranks not collected
- Example Macro Coach (1000000004): paid-ad refresh problem: no advertiser has the exact app name, so no ads are attributed; ASO collection problem: unavailable, retry after 2026-11-21T00:00:00.000Z; technology not collected: status not_collected; opening the read does not start collection
- Example Meal Kit (1000000005): paid-ad refresh not collected: no requested refresh yet (latest is null); ASO collection read failed: 404 not_found The requested resource was not found; technology not collected: status not_collected; opening the read does not start collection

| App | Store id | Overall | Paid-ad refresh | ASO collection | Technology | Data requests |
|---|---|---|---|---|---|---|
| Example Meal Kit | 1000000005 | read failed | not collected: no requested refresh yet (latest is null) | read failed: 404 not_found The requested resource was not found | not collected: status not_collected; opening the read does not start collection | none filed |
| Example Macro Coach | 1000000004 | problem | problem: no advertiser has the exact app name, so no ads are attributed | problem: unavailable, retry after 2026-11-21T00:00:00.000Z | not collected: status not_collected; opening the read does not start collection | 1 request(s): paid_ads requested 2026-11-14 |
| Example Grocery List | 1000000003 | not collected | running: walk running since 2026-11-18 | running: queued | not collected: observed, but best ranks not collected | 1 request(s): aso requested 2026-11-18 |
| Example Recipe Box | 1000000002 | stale | stale: last requested refresh settled 58 days ago, 11 new ad(s) | stale: completed, updated 80 days ago | stale: observed 77 days ago | 1 request(s): history requested 2026-10-01 |
| Example Meal Planner | 1000000001 | ok | ok: last requested refresh settled 2026-11-12, 4 new ad(s) | ok: completed, updated 2026-11-10 | ok: observed 2026-11-01 | none filed |

Status reads only: none of them starts collection. "Stale" uses the dates in the payload, so a fresh HTTP answer about an old observation is still old.
```

(Example data from `examples/`, not real apps.)

## Run it

```sh
export PEEKPANDA_TOKEN=...   # PeekPanda API key; never commit it

# Three apps by id or App Store link: 4 calls each (12 calls)
node cli.js --apps "493145008=Headspace,https://apps.apple.com/us/app/duolingo-language-lessons/id570060128=Duolingo,1459969523"

# Your list file with a weekly diff and the refresh requests to review, failing CI when something needs attention
node cli.js --apps-file competitors.txt --state status-state.json --commands --fail-on-stale

# Only ASO and technology, with a 14-day threshold (2 calls per app)
node cli.js --apps-file competitors.txt --checks aso,tech --stale-days 14

# Save the raw answers, then re-render without calling the API
node cli.js --apps-file competitors.txt --save run.json
node cli.js --file examples/run.json --format csv
```

`examples/competitors.txt` shows the list format: one App Store id or `apps.apple.com` link per line, an optional `=Label`, and `#` comments. `node cli.js --help` lists every option. `node --test test/` runs the tests. `.github/workflows/collection-status.yml` is a weekly GitHub Actions example that reads `competitors.txt` from the repository root. It is off until you set the repository variable `ENABLE_COLLECTION_STATUS=true`.

A live run on 2026-11-18 for Headspace, Duolingo and one smaller app used 12 calls: both big apps had a completed ASO collection, technology observed in September (stale at 30 days) and a last requested paid-ad refresh from October; the smaller app's paid-ad refresh had settled as `not_matched` and its technology was `not_collected`.

## Where the data comes from

The data comes from [PeekPanda](https://peekpanda.com), an iOS competitor catalogue where every app has a case file of dated, stored evidence. The tool calls these reads per app, all scope `context:read`:

- [`GET /v1/competitors/ios/{storeId}/paid-ads/refresh`](https://peekpanda.com/docs/get-competitor-paid-ad-refresh) (MCP `get_app`, action `ad_refresh_status`): `latest` is null until the app has been refreshed on request; `latest.state` is `running`, `completed`, `not_matched` or `failed`, with `requestedAt`, `settledAt` and `newAdCount`; `quota` is `daily` (`limit`, `used`, `remaining`, `resetAt`) or `unlimited`.
- [`GET /v1/competitors/ios/{storeId}/aso/collection`](https://peekpanda.com/docs/get-competitor-aso-collection) (MCP `get_app`, action `aso_status`): the US/en_us ASO collection lifecycle, `status`, `updatedAt`, `retryAt`.
- [`GET /v1/competitors/ios/{storeId}/technology`](https://peekpanda.com/docs/get-competitor-technology) (MCP `get_app`, action `technology`): `status` is `observed` or `not_collected`, and SDK and best-rank evidence each have their own status and date. The tool reads only those status and date fields; it does not list SDKs.
- [`GET /v1/competitors/ios/{storeId}/data-requests`](https://peekpanda.com/docs/list-competitor-data-requests) (MCP `get_app`, action `data_requests`): your account's requests for missing data, with `kind`, `status` and `requestedAt`.

Each call counts toward your plan's daily API and MCP allowance: 30 a day on Peek, 1,000 a day on Panda, reset at 00:00 UTC ([plans](https://peekpanda.com/docs/plans-and-refreshes)). At four reads per app, a Peek key covers seven apps a day; `--checks` trims that. The tool prints how many calls it used, warns when a run plans more than 30, retries once on `429 rate_limited` or `503 timeout` with a short `Retry-After`, and stops on `daily_call_limit`, reporting the apps it already read. A `404 not_found` (app outside the accessible catalogue) is kept as "read failed" for that check and the run goes on.

How it reads the answers:

- Stale means the date in the payload is older than `--stale-days` (default 30). That is this tool's threshold, not PeekPanda's own freshness expectation, and as [freshness and source dates](https://peekpanda.com/docs/freshness-and-source-dates) puts it, an old observation is not false; it is evidence of the date it was recorded.
- The paid-ad refresh date is the last refresh someone asked for, not the age of the ads. PeekPanda's scheduled collection runs without it, so "no requested refresh yet" does not mean no ads were collected. `not_matched` means no advertiser has the exact app name, so no ads are attributed to the app.
- A completed ASO collection without `updatedAt` counts as ok, with the missing date said out loud.
- Technology counts as not collected until both SDK and best-rank evidence are observed. Best ranks cover a rolling 90-day window, per the docs.
- Data requests never make an app worse; they are listed so you can see what you already asked for.
- The overall verdict is the worst of the checks: read failed, problem, not collected, stale, running, ok.

With `--commands` it prints, for review, the requests that would start collection (scope `content:write`): [`POST …/paid-ads/refresh`](https://peekpanda.com/docs/refresh-competitor-paid-ads) with an `Idempotency-Key` (this has its own small daily limit, 1 on Peek and 3 on Panda in a rolling 24 hours, and the tool says when the list is longer than what is left), [`POST …/aso/collection`](https://peekpanda.com/docs/refresh-competitor-aso-collection) and [`POST …/technology`](https://peekpanda.com/docs/refresh-competitor-technology) (existing fresh observations are reused). Always inspect `state` in their answers, even after HTTP success.

## Use it from an AI agent (MCP)

The PeekPanda MCP server at `https://mcp.peekpanda.com/mcp` exposes the same reads ([tool reference](https://peekpanda.com/docs/mcp-tools)): `get_app` with actions `ad_refresh_status`, `aso_status`, `technology` and `data_requests`, each with `{"params": {"platform": "ios", "storeId": "493145008"}}`. Clients sign in with OAuth (the server's OAuth metadata lists PKCE `S256` and dynamic client registration; scopes `context:read` and `content:write`) or send an API key as a bearer token on the same URL ([get started](https://peekpanda.com/docs/mcp), [OAuth reference](https://peekpanda.com/docs/mcp-oauth)). Either way you need a PeekPanda account, and the tokens stay in your client, never in this repo. An agent can collect the four answers per app into `{"storeId": "…", "adRefresh": …, "aso": …, "technology": …, "dataRequests": …}` and paste them into the browser version, or call `node cli.js` directly.

## Licence

MIT. Example data in `examples/` is made up.
