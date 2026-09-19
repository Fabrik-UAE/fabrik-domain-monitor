# Fabrik Domain Monitor

Internal tool for Fabrik (JMW Digital MENA LLC). It watches a list of domains, records their registration data daily, alerts Slack when anything changes, and publishes a dashboard on GitHub Pages. Build the whole thing in this session. Keep it small. No database, no auth, no framework.

## What it does

1. A checker script queries RDAP for every domain in `domains.json` and writes the results to `data/latest.json`, appending any changes to `data/history.json`.
2. A GitHub Actions workflow runs the checker daily. If any tracked field changed, it commits the new data and posts a Slack message. If nothing changed, it does nothing.
3. A static dashboard in `site/` reads `data/latest.json` and `data/history.json` and renders a table sorted by expiry, a 12-month timeline, and a per-domain change log. GitHub Pages serves it.

## Stack

- Node 20, ES modules, no dependencies beyond the standard library (`fetch` is built in). No TypeScript, no bundler.
- Dashboard is a single `site/index.html` with inline CSS and JS. It fetches `../data/latest.json` and `../data/history.json` relative to itself, so Pages must serve the repo root, not `site/` alone.
- GitHub Actions for scheduling. GitHub Pages for hosting. Slack incoming webhook for alerts.

## Data sources

Use RDAP, not WHOIS. No API keys.

- `.com` domains: `https://rdap.verisign.com/com/v1/domain/{domain}`
- `.co.uk` and `.uk` domains: `https://rdap.nominet.uk/uk/domain/{domain}`
- Anything else: look up the correct server from `https://data.iana.org/rdap/dns.json` (cache it for the run) and fail clearly if the TLD has no RDAP server.

From the RDAP response extract:

- `expires`: the `events` entry with `eventAction: "expiration"`, as an ISO date (YYYY-MM-DD)
- `created`: `eventAction: "registration"`
- `updated`: `eventAction: "last changed"`
- `registrar`: the entity with role `registrar`, from its vCard `fn`; fall back to the `handle`
- `nameservers`: `nameservers[].ldhName`, lowercased and sorted
- `status`: the `status` array, sorted

Nominet responses sometimes omit the registrar vCard and sometimes return 404 for domains that exist under a different label case. Lowercase the domain before querying. Treat a 404 as `status: "not found"` and keep the previous good record rather than overwriting it with blanks.

Retry each request up to 3 times with backoff on 429 or 5xx. Set a User-Agent header: `fabrik-domain-monitor/1.0`.

## Files

```
domains.json            list of domains to watch (hand edited)
data/latest.json        current snapshot per domain
data/history.json       one entry per detected change
src/check.js            the checker
src/rdap.js             RDAP fetch and parse
src/diff.js             compares snapshots, produces change list
src/notify.js           Slack message formatting and send
site/index.html         dashboard
.github/workflows/check.yml
.github/workflows/pages.yml (or use the check workflow to deploy)
test/                   node --test unit tests for rdap parsing and diff
README.md               short: what it is, how to add a domain, how to run locally
```

## domains.json schema

```json
[
  {
    "domain": "fabrik.co.uk",
    "owner": "third-party",
    "watch": "acquisition",
    "notes": "Held by a third party. Nameservers on registrar-servers.com."
  }
]
```

- `owner`: `"fabrik"`, `"client"`, or `"third-party"`
- `watch`: `"renewal"` (we must renew it), `"acquisition"` (we want to buy it), or `"client"` (we manage it for a client)
- `notes`: free text, shown on the dashboard

Seed it with these four:

| domain | owner | watch |
|---|---|---|
| fabrik.co.uk | third-party | acquisition |
| fabrikagency.co.uk | third-party | acquisition |
| fabrikagency.com | third-party | acquisition |
| fabrik.com | third-party | acquisition |

## data/latest.json schema

```json
{
  "checkedAt": "2026-09-18T06:00:12Z",
  "domains": {
    "fabrik.co.uk": {
      "domain": "fabrik.co.uk",
      "registrar": "Behrendt Professional Corporation t/a Amazing Domains",
      "created": "2015-12-21",
      "updated": "2025-12-20",
      "expires": "2026-12-21",
      "nameservers": ["freedns1.registrar-servers.com", "freedns2.registrar-servers.com"],
      "status": ["active"],
      "lastChecked": "2026-09-18T06:00:12Z",
      "lastChanged": "2026-09-18T06:00:12Z",
      "error": null
    }
  }
}
```

## data/history.json schema

An array, newest last. One entry per domain per run that had changes.

```json
[
  {
    "at": "2026-09-18T06:00:12Z",
    "domain": "fabrikagency.com",
    "changes": [
      { "field": "expires", "from": "2027-04-14", "to": "2028-04-14" }
    ]
  }
]
```

## Change detection and alert rules

Tracked fields: `expires`, `registrar`, `nameservers`, `status`. `updated` is recorded but not alerted on, because registries bump it for trivial reasons.

Alert to Slack when any of these happen:

- `expires` changes (renewal or extension). For `watch: "acquisition"` domains, label it "Holder renewed".
- `registrar` changes (transfer). Label it "Transferred".
- `nameservers` change. Label it "Nameservers changed".
- `status` gains or loses a lock (`clientTransferProhibited`, `clientDeleteProhibited`, and so on). Losing a transfer lock on an acquisition target is a buying signal, say so in the message.
- `status` contains `pendingDelete`, `redemptionPeriod`, or Nominet's `suspended`. Label it "Dropping" and mark it high priority.
- A domain reaches 90, 30, or 7 days to expiry. One message per threshold, not one per day. Track which thresholds have fired in `latest.json` under `alertedThresholds` and reset them when `expires` changes.
- A domain returns an error for 3 consecutive runs.

Slack message format, one message per run, plain text with Slack mrkdwn:

```
*Domain monitor: 2 changes*
• fabrikagency.com: Holder renewed. Expires 14 Apr 2027 → 14 Apr 2028 (GoDaddy)
• fabrik.co.uk: 90 days to expiry, 21 Dec 2026. Acquisition target, third party.
Dashboard: https://<org>.github.io/<repo>/site/
```

Webhook URL comes from the `SLACK_WEBHOOK_URL` secret. If the secret is missing, log the message to stdout and exit 0 so local runs work.

## Workflow

`.github/workflows/check.yml`:

- Trigger: `schedule` at `0 6 * * *` (06:00 UTC, 10:00 Dubai) and `workflow_dispatch`.
- Steps: checkout, setup Node 20, `node src/check.js`, then if `git status --porcelain data/` is non-empty, commit with message `chore: domain check YYYY-MM-DD` using the `github-actions[bot]` identity and push.
- Give the job `contents: write` permission.
- The checker itself sends the Slack message, so the workflow doesn't need a separate notify step.
- Deploy Pages from the same workflow after a successful commit, or set Pages to serve from the main branch root. Either is fine; pick the simpler one and document it in the README.

## Dashboard

Single page, no build step. Plain, clean, readable. Sorted by expiry ascending.

Table columns: domain (links to the RDAP JSON and to `https://who.is/whois/{domain}`), owner, watch, registrar, expires, days left, status pill, notes, last changed.

Status pill rules: green when more than 90 days to expiry, amber inside 90, red inside 30, grey if expired or errored.

Above the table, a horizontal 12-month timeline with today at the left edge and a dot per domain at its expiry date, coloured the same way.

Below the table, a change log from `history.json`, newest first, filterable by domain.

Show "Last checked" from `latest.json.checkedAt` in the header. If the data is more than 48 hours old, show a warning that the workflow may have stopped.

Style: system sans-serif or one Google Font, light and dark mode via `prefers-color-scheme`, works on a phone. No decorative gradients, no cards for the sake of cards.

## Local development

```
node src/check.js            # runs a check, writes data/, prints Slack message to stdout
node src/check.js --dry-run  # fetches and diffs but writes nothing
node --test                  # runs tests
npx serve .                  # or python3 -m http.server, then open /site/
```

## Conventions

- British English in copy and comments.
- No em dashes anywhere, including generated Slack messages and the dashboard. Use commas, full stops or a colon.
- Write "ecommerce" without a hyphen if it appears.
- Commit in small logical steps with clear messages.
- Never commit secrets. `.env` is gitignored; the checker reads `SLACK_WEBHOOK_URL` from the environment.

## Build order

1. Scaffold: `package.json` (type module, scripts for check and test), `.gitignore`, `README.md`, seed `domains.json`.
2. `src/rdap.js` with the fetch, TLD routing, retries, and parser. Unit test the parser against two saved fixtures, one Verisign response and one Nominet response (fetch real ones once and save them under `test/fixtures/`).
3. `src/diff.js` with tests covering: no change, expiry change, nameserver reorder (should not alert), lock removed, threshold crossing, threshold not re-firing.
4. `src/notify.js` and `src/check.js`. Run it for real once so `data/latest.json` is populated with the four seed domains. Confirm `history.json` is empty on a first run.
5. `site/index.html`. Test it against the real data with a local server. Check it on a narrow viewport.
6. Workflows. Push, trigger `workflow_dispatch` once, confirm the run passes and Pages is live.
7. Update the README with the Pages URL and the steps to add a domain and to add the Slack secret.

## Done means

- `node src/check.js` runs clean locally and populates `data/`.
- Tests pass.
- The scheduled workflow has completed at least one manual run on GitHub.
- The dashboard is reachable on GitHub Pages and shows all four domains with correct expiry dates.
- A test Slack message has been delivered (or, if the secret isn't set yet, the message is visible in the run log).
