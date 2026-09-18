# Fabrik domain monitor

Internal tool for Fabrik (JMW Digital MENA LLC). It watches a list of domains,
records their registration data daily, alerts Slack when anything changes and
publishes a dashboard.

**Dashboard: https://fabrik-uae.github.io/fabrik-domain-monitor/site/**

Data comes from RDAP, so there are no API keys and no WHOIS scraping. Verisign
serves `.com`, Nominet serves `.uk` and `.co.uk`, and anything else is routed
through the IANA bootstrap file.

## How it works

A GitHub Actions workflow runs `src/check.js` at 06:00 UTC daily, which is 10:00
in Dubai. The checker looks every domain up, writes the current snapshot to
`data/latest.json` and appends any changes to `data/history.json`. If the data
changed, the workflow commits it and the checker posts one Slack message
summarising the run. If nothing changed, nothing is committed and nothing is
sent.

The dashboard is a single static page that reads those two JSON files plus
`domains.json`. GitHub Pages serves the repository root from `main`, so the
committed data updates the site with no build step.

## Adding a domain

Edit `domains.json` and commit. Nothing else needs changing.

```json
{
  "domain": "example.co.uk",
  "owner": "client",
  "watch": "client",
  "notes": "Free text, shown on the dashboard."
}
```

- `owner` is `fabrik`, `client` or `third-party`.
- `watch` is `renewal` (we must renew it), `acquisition` (we want to buy it) or
  `client` (we manage it for a client).

The next run picks it up. A first sighting is recorded but never alerted on, so
adding a domain does not produce noise.

## What triggers a Slack alert

Tracked fields are `expires`, `registrar`, `nameservers` and `status`. The
`updated` timestamp is recorded but never alerted on, because registries bump it
for trivial reasons. Nameserver and status order is ignored, so a registry
reshuffle does not read as a change.

| Trigger | Label |
|---|---|
| `expires` moves | "Holder renewed" on an acquisition target, "Renewed" otherwise |
| `registrar` changes | "Transferred" |
| `nameservers` change | "Nameservers changed" |
| A transfer or delete lock is gained or lost | "Lock changed". Losing a transfer lock on an acquisition target is flagged as a buying signal |
| Status hits `pendingDelete`, `redemptionPeriod` or Nominet's `suspended` | "Dropping", high priority |
| 90, 30 or 7 days to expiry | One message per threshold, not one per day |
| A domain fails to resolve on three consecutive runs | "Lookup failing" |

Fired thresholds are stored per domain in `latest.json` under
`alertedThresholds` and reset whenever the expiry date moves.

## Running it locally

Node 20 or newer. There are no dependencies to install.

```bash
node src/check.js            # runs a check, writes data/, prints or sends the Slack message
node src/check.js --dry-run  # fetches and diffs but writes nothing
node --test                  # runs the unit tests
```

With `SLACK_WEBHOOK_URL` unset the message is printed to stdout and the run
still exits 0, so local runs need no secrets.

To view the dashboard, serve the **repository root**, not `site/` on its own.
The page fetches `../data/latest.json` relative to itself.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/site/.

## Setting up the Slack alerts

1. Create an incoming webhook in Slack and copy the URL.
2. In this repository, go to Settings, then Secrets and variables, then Actions.
3. Add a repository secret named `SLACK_WEBHOOK_URL` with that URL.

Never commit the webhook. `.env` is gitignored and the checker reads the URL
from the environment.

## GitHub Pages

Pages serves the repository root from the `main` branch: Settings, then Pages,
source "Deploy from a branch", branch `main`, folder `/ (root)`. That was chosen
over a build-and-deploy workflow because the data is committed to the repository
anyway, so a branch deploy needs no second workflow. The empty `.nojekyll` file
stops Pages running the content through Jekyll.

## Files

```
domains.json                 the list of domains to watch, hand edited
data/latest.json             current snapshot per domain
data/history.json            one entry per detected change
src/check.js                 the checker
src/rdap.js                  RDAP fetch, TLD routing and parsing
src/diff.js                  snapshot comparison and alert rules
src/notify.js                Slack message formatting and delivery
site/index.html              the dashboard
test/                        unit tests, run with node --test
.github/workflows/check.yml  the daily run
```
