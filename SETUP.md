# Build your own domain monitor

A step by step guide to standing up a domain tracker of your own: it checks a
list of domains every day, posts to Slack when something changes, and publishes
a dashboard anyone on your team can open.

You do not need a server, a database or a paid account. It runs on GitHub's free
tier and costs nothing.

Allow about 30 minutes for your first run through.

## Contents

1. [What you end up with](#1-what-you-end-up-with)
2. [What you need before you start](#2-what-you-need-before-you-start)
3. [Get the code](#3-get-the-code)
4. [List the domains you care about](#4-list-the-domains-you-care-about)
5. [Run it once on your own machine](#5-run-it-once-on-your-own-machine)
6. [Put it on GitHub](#6-put-it-on-github)
7. [Turn on the dashboard](#7-turn-on-the-dashboard)
8. [Connect Slack](#8-connect-slack)
9. [Check the whole thing works](#9-check-the-whole-thing-works)
10. [Living with it](#10-living-with-it)
11. [How it works](#11-how-it-works)
12. [Changing how it behaves](#12-changing-how-it-behaves)
13. [When something goes wrong](#13-when-something-goes-wrong)
14. [Building it from scratch instead](#14-building-it-from-scratch-instead)

## 1. What you end up with

**A daily Slack message, but only when something actually happened.** Silence
means nothing changed, which is the point. A real message looks like this:

```
Domain monitor: 2 changes
• example.com: Holder renewed on 17 Sept 2026. Expiry 14 Apr 2027 -> 14 Apr 2028, now 574 days out. Registrar GoDaddy.
• example.co.uk: 90 days to expiry on 21 Dec 2026. Acquisition target, third party.
Checked 18 Sept 2026 at 06:00 UTC. Dashboard: https://yourname.github.io/your-repo/site/
```

**A dashboard** at `https://<your-account>.github.io/<your-repo>/site/`, showing
every domain sorted by how soon it expires, a twelve month timeline, and a log
of every change ever detected. It works on a phone and follows your system's
light or dark mode.

**A permanent record.** Every change is committed to git, so you can answer
"when did that transfer happen?" years later.

### What it watches

| It tells you when | Because |
|---|---|
| An expiry date moves | Someone renewed. On a domain you want to buy, the holder just committed for another year |
| The registrar changes | The domain was transferred |
| The nameservers change | The domain changed hands, or was parked, or went live |
| A transfer or delete lock appears or disappears | An unlocked domain is a domain that can move. On a target, that is a buying signal |
| Status hits `pendingDelete`, `redemptionPeriod` or `suspended` | It is dropping. This one is marked high priority |
| A domain reaches 90, 30 or 7 days to expiry | Your renewal deadline, once per threshold rather than once a day |
| A lookup fails three days running | Something is broken and you should know |

### What it deliberately does not do

It does not register, renew or buy anything. It only reads public registry data.
It will not stop you losing a domain, it will only tell you that you are about
to.

## 2. What you need before you start

**A GitHub account.** Free is fine. Sign up at https://github.com/signup.

**A Slack workspace where you can add an app.** In many workspaces any member
can, in some only admins can. You will find out at step 8. If you cannot, ask
whoever runs your Slack, or skip step 8 and the tool still works, it just prints
its messages into the run log instead of Slack.

**Node.js 20 or newer**, only if you want to test on your own machine first.
Check with `node --version`. Get it from https://nodejs.org if you need it.
You can skip this and let GitHub run everything, but testing locally first is
faster when something is wrong.

**The `gh` command line tool** makes several steps one line instead of several
clicks. Install from https://cli.github.com, then run `gh auth login` once.
Every step below also has a click through alternative, so `gh` is optional.

### One thing to decide now: public or private

GitHub Pages only works on private repositories if you pay for GitHub Pro, Team
or Enterprise. On a free account, **your repository must be public for the
dashboard to work**.

Everything this tool stores is already public information: registry data anyone
can look up, plus whatever notes you write in `domains.json`. The one thing a
public repository reveals is *which domains you are watching and why*. If you
are quietly circling a domain you hope to buy cheaply, that is worth thinking
about. Write your notes accordingly, or use a private repository and do without
the dashboard, or pay for Pro.

Your Slack webhook is never stored in the repository either way. It lives in
GitHub's encrypted secrets, which are not public even on a public repository.

## 3. Get the code

### The quick way

On https://github.com/Fabrik-UAE/fabrik-domain-monitor click **Use this
template**, then **Create a new repository**. Name it whatever you like,
`domain-monitor` is a reasonable choice. Set the visibility you decided on
above. Then clone it:

```bash
git clone https://github.com/YOUR-ACCOUNT/YOUR-REPO.git
cd YOUR-REPO
```

Or in one line with `gh`:

```bash
gh repo create YOUR-REPO --template Fabrik-UAE/fabrik-domain-monitor --public --clone
cd YOUR-REPO
```

Using the template rather than forking gives you a clean history with no link
back to the original, which is what you want for something you will run as your
own.

### If you would rather start from a copy

```bash
git clone https://github.com/Fabrik-UAE/fabrik-domain-monitor.git my-domain-monitor
cd my-domain-monitor
rm -rf .git
git init -b main
```

Then create an empty repository on GitHub and follow step 6.

### Clear out the previous occupant's data

Whichever route you took, the repository arrives carrying someone else's
domains. Reset it:

```bash
echo '[]' > data/history.json
rm -f data/latest.json
```

Leave `domains.json` for now, you are about to rewrite it.

## 4. List the domains you care about

Open `domains.json`. It is a plain list, and it is the only file you have to
edit. Replace what is there with your own:

```json
[
  {
    "domain": "yourcompany.com",
    "owner": "fabrik",
    "watch": "renewal",
    "notes": "Main site. Auto renew is on but verify annually."
  },
  {
    "domain": "yourcompany.co.uk",
    "owner": "third-party",
    "watch": "acquisition",
    "notes": "Held by someone else. We want it."
  },
  {
    "domain": "bigclient.com",
    "owner": "client",
    "watch": "client",
    "notes": "We manage DNS. Renewal is their responsibility, we just watch."
  }
]
```

Three fields control everything:

**`owner`** is `fabrik`, `client` or `third-party`. It only affects wording in
messages and a column on the dashboard, so if `fabrik` reads oddly for you,
rename it throughout the file and nothing breaks. It is a label, not a
behaviour.

**`watch`** does change behaviour. `acquisition` means you want to buy it, so an
expiry change is reported as "Holder renewed" and losing a transfer lock is
called out as a buying signal. `renewal` means it is yours to keep alive.
`client` means you manage it for someone else.

**`notes`** is free text shown on the dashboard. This is where you put the thing
future you will need, such as which account it is under or who to chase.

### Which domain endings work

`.com` and `.uk` including `.co.uk` are wired in directly. Everything else is
looked up automatically in IANA's registry list, which covers most modern
endings.

A handful of older country endings never joined RDAP and cannot be watched. If
yours is one, the checker tells you plainly rather than failing quietly:
`No RDAP server known for .xx`. To find out before you commit, run step 5.

## 5. Run it once on your own machine

Worth doing. It takes seconds and catches a typo in `domains.json` before
GitHub does.

```bash
node src/check.js --dry-run
```

`--dry-run` fetches and compares but writes nothing. You should see each domain
and its expiry date:

```
Checking 3 domains (dry run)
  yourcompany.com: expires 2027-04-14
  yourcompany.co.uk: expires 2026-12-21
  bigclient.com: expires 2028-01-30

0 domains changed, 0 alerts

Dry run, nothing written.
```

If a domain reports an error here, fix it now. A typo in the name is the usual
cause.

Now run it properly, which creates your first snapshot:

```bash
node src/check.js
```

`data/latest.json` now holds a record per domain. `data/history.json` is still
`[]`, and it should be: the first run establishes a baseline, and a first
sighting is never treated as a change. That is deliberate, so adding a domain
later does not spam you.

You can also look at the dashboard before anything is published. Serve the
**repository root**, not the `site` folder, because the page reads
`../data/latest.json` relative to itself:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/site/. The footer's repository link is hidden when
running locally, which is expected. It appears once the page is on GitHub Pages.

Run the tests too, if you want to confirm nothing is broken:

```bash
node --test
```

## 6. Put it on GitHub

If you used the template at step 3, your repository already exists and you only
need to push:

```bash
git add -A
git commit -m "Track my own domains"
git push
```

If you started from a copy, create the repository first:

```bash
gh repo create YOUR-REPO --public --source=. --remote=origin --push
```

Or make an empty repository through the website, then:

```bash
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPO.git
git add -A
git commit -m "Track my own domains"
git push -u origin main
```

### About permissions

The workflow commits updated data back to your repository, which needs write
access. It already asks for exactly that, in `.github/workflows/check.yml`:

```yaml
permissions:
  contents: write
```

**You do not need to change any repository setting for this.** A workflow can
request more than the repository default, and this one does. Guides that tell
you to switch Settings, Actions, General to "Read and write permissions" are
describing a different situation. Leave it alone.

## 7. Turn on the dashboard

Through the website: your repository, **Settings**, **Pages**. Under "Build and
deployment" set Source to **Deploy from a branch**, branch **main**, folder
**/ (root)**. Save.

Or with `gh`:

```bash
gh api -X POST repos/YOUR-ACCOUNT/YOUR-REPO/pages \
  -f 'source[branch]=main' -f 'source[path]=/'
```

Note **/ (root)**, not `/site`. The dashboard reads its data from `data/`, which
sits beside `site/`, so Pages has to serve the whole repository.

Give it a minute, then check:

```bash
gh api repos/YOUR-ACCOUNT/YOUR-REPO/pages --jq '.status, .html_url'
```

`built` means it is live. Your dashboard is at:

```
https://YOUR-ACCOUNT.github.io/YOUR-REPO/site/
```

Lowercase the account name in that URL even if your username has capitals.

If you skipped step 5, the dashboard will say "Could not load the data" until
the first run has happened, because `data/latest.json` does not exist yet. Step 9
creates it. That is expected, not a fault.

You do not need to put that URL anywhere. Slack messages work it out from the
repository name on their own.

> The empty `.nojekyll` file in the repository root stops Pages trying to run
> the content through Jekyll, its blog builder, which would otherwise interfere.
> Leave it there.

## 8. Connect Slack

This is the only part that needs credentials, and the only part where being
careless has consequences. **A Slack webhook URL is a password.** Anyone holding
it can post into your channel as your app. Do not put it in a file, do not
commit it, do not paste it into a chat or an issue.

### Create the webhook

1. Go to https://api.slack.com/apps and click **Create New App**.
2. Choose **From scratch**.
3. Name it something recognisable, such as `Domain monitor`. Pick your
   workspace. Click **Create App**.
4. In the left sidebar choose **Incoming Webhooks**.
5. Turn **Activate Incoming Webhooks** to **On**.
6. Click **Add New Webhook to Workspace** at the bottom.
7. Choose the channel the alerts should go to, and click **Allow**.
8. Copy the URL that appears. It starts `https://hooks.slack.com/services/`
   followed by three slash separated codes.

The channel is fixed when you create the webhook. To move the alerts later, add
a second webhook pointing at the new channel and replace the secret.

For a private channel, invite the app to it first with `/invite @Domain monitor`
typed in that channel.

### Store it in GitHub

Through the website: your repository, **Settings**, **Secrets and variables**,
**Actions**, **New repository secret**. Name it exactly:

```
SLACK_WEBHOOK_URL
```

Paste the URL as the value and save.

Or from a terminal, which prompts for the value rather than taking it as an
argument so it does not end up in your shell history:

```bash
gh secret set SLACK_WEBHOOK_URL --repo YOUR-ACCOUNT/YOUR-REPO
```

The name must match exactly. `SLACK_WEBHOOK` or `slack_webhook_url` will not be
found, and the tool will quietly print to the log instead of posting, which is
a confusing way to spend twenty minutes.

Confirm it registered, which shows the name and date but never the value:

```bash
gh secret list --repo YOUR-ACCOUNT/YOUR-REPO
```

### If you cannot create a Slack app

Skip this step. Everything else works, and messages appear in the workflow run
log instead. You can add the secret whenever you get permission, without
changing anything else.

## 9. Check the whole thing works

There is a built in test that sends one clearly labelled sample message and
writes nothing.

Through the website: **Actions**, **Domain check**, **Run workflow**, tick
**Send a test Slack message**, then **Run workflow**.

Or from a terminal:

```bash
gh workflow run check.yml --repo YOUR-ACCOUNT/YOUR-REPO --ref main -f test_alert=true
```

> If you are inside the repository folder you can drop `--repo`. If you are not,
> and you leave it out, `gh` fails with `not a git repository`. That error means
> your terminal is somewhere else, not that anything is wrong with your setup.

Watch it finish:

```bash
gh run watch --repo YOUR-ACCOUNT/YOUR-REPO
```

A message should arrive in your Slack channel within a few seconds, headed
**Domain monitor: test message, no real change**.

Your checklist:

- [ ] `node src/check.js` runs locally without errors
- [ ] `data/latest.json` lists your domains with correct expiry dates
- [ ] `data/history.json` is `[]` after the first run
- [ ] The workflow run finished green
- [ ] The dashboard loads and shows all your domains
- [ ] A test message arrived in Slack

If the last one did not arrive, go to [step 13](#13-when-something-goes-wrong).

That is everything. It now runs by itself at 06:00 UTC every day.

## 10. Living with it

**Adding a domain** means editing `domains.json` and committing. Nothing else.
The next run picks it up, records a baseline, and does not alert about it.

```bash
git add domains.json
git commit -m "Watch newdomain.com"
git push
```

**Removing one** means deleting its entry. Its history stays in
`data/history.json`, which is usually what you want.

**Expect one small commit a day** from `github-actions[bot]`, even when nothing
changed. That is not a bug. Every run rewrites the "last checked" timestamp, and
the dashboard reads that timestamp to tell you the monitor is still alive. The
commit message says which it was:

```
chore: domain check 2026-09-18, no change
chore: domain check 2026-09-19, 2 domains changed
```

If those commits bother you more than losing the liveness signal would, see
[section 12](#12-changing-how-it-behaves).

**Most days there will be no Slack message.** Domains are stable. Silence is the
normal state and does not mean it has stopped. The way to confirm it is alive is
the dashboard header, which shows when it last checked and displays a warning if
that goes past 48 hours.

**GitHub disables scheduled workflows in repositories with no activity for 60
days.** The daily commit counts as activity, so this will not happen to you
while it is running normally. It is worth knowing if you ever pause it.

## 11. How it works

Four small files, no dependencies, no build step, nothing to install.

```
domains.json                 your list, hand edited, the only file you maintain
data/latest.json             current state of each domain
data/history.json            every change ever detected, appended
src/rdap.js                  asks the registries
src/diff.js                  works out what changed and what is worth saying
src/notify.js                writes the Slack message
src/check.js                 runs the above in order
site/index.html              the dashboard, one file
test/                        unit tests, run with node --test
.github/workflows/check.yml  the daily schedule
```

A run goes: read your list, ask each registry for the current record, compare
against last time, append any changes to history, send one Slack message if
there is anything worth saying, write the new snapshot. The workflow commits the
result.

### Where the data comes from

RDAP, the modern replacement for WHOIS. It returns structured JSON instead of
text that has to be scraped, and it needs no account or API key.

`.com` goes to Verisign, `.uk` to Nominet, and anything else is resolved through
IANA's public list of registry servers, fetched once per run and reused.

Failed requests are retried three times with a growing gap, so a registry having
a bad minute does not produce a false alarm. A domain that returns "not found"
keeps its previous record rather than being blanked, because registries do
occasionally deny a domain exists and then change their mind.

### The rules that stop it crying wolf

A monitor you learn to ignore is worse than no monitor. Four rules keep the
noise down:

**Order is ignored.** Registries reshuffle nameserver and status lists for no
reason. Both are sorted before comparing, so a reshuffle is not a change.

**The `updated` field is recorded but never alerted on.** Registries bump it for
trivial internal reasons. It is used to tell you *when* something happened, not
as a trigger.

**Expiry thresholds fire once each.** Crossing 90 days produces one message, not
one every day for sixty days. Which thresholds have fired is remembered per
domain and reset if the expiry date moves, so a renewal restarts the sequence
properly.

**Errors need three consecutive failures.** One flaky lookup says nothing. Three
in a row is a real problem.

### Status spelling

Registries disagree on this. Verisign returns `client transfer prohibited` while
others return `clientTransferProhibited`. Both are reduced to a common form
before comparing, so a domain moving between registries does not look like every
lock changed at once.

## 12. Changing how it behaves

**The time it runs.** In `.github/workflows/check.yml`:

```yaml
- cron: '0 6 * * *'
```

That is 06:00 UTC. The five fields are minute, hour, day of month, month, day of
week. `'0 9 * * 1'` would be 09:00 UTC every Monday. GitHub runs scheduled jobs
in UTC all year and does not follow daylight saving, so a job pinned to your
local morning will drift by an hour twice a year. Scheduled runs are also queued
rather than exact, and can land ten or twenty minutes late under load.

**Which expiry thresholds fire.** In `src/diff.js`:

```js
export const EXPIRY_THRESHOLDS = [90, 30, 7];
```

Add or remove numbers freely. `[180, 90, 30, 14, 7, 1]` is reasonable if you
manage renewals yourself rather than watching someone else's.

**How many failures before it complains.** Also in `src/diff.js`:

```js
export const ERROR_RUN_THRESHOLD = 3;
```

**Which fields count as a change.** Also in `src/diff.js`:

```js
export const TRACKED_FIELDS = ['expires', 'registrar', 'nameservers', 'status'];
```

Removing `nameservers` is the usual edit, if you watch parked domains that
shuffle their parking providers often.

**The wording of messages** is all in `src/notify.js`, in `formatAlert`. Each
alert type is a separate `case`, so you can reword one without touching the
others.

**The dashboard** is `site/index.html`, a single file with its CSS and
JavaScript inline. The colour thresholds are in the `band` function: green
beyond 90 days, amber inside 90, red inside 30, grey once expired or errored.

**Stopping the daily commit.** If you would rather only commit on a real change,
add a condition to the commit step using the change count the checker already
reports:

```yaml
if: ${{ steps.check.outputs.changed != '0' }}
```

Understand the trade first. The dashboard will then show the date of the last
*change* rather than the last *check*, and its 48 hour staleness warning will be
on almost permanently, so you lose the ability to tell "nothing has changed"
apart from "it has been broken for a month". That warning is the only thing
telling you the monitor still works.

**A custom domain for the dashboard.** Set a `DASHBOARD_URL` environment
variable in the workflow and Slack messages will use it. Otherwise the URL is
worked out from your repository name automatically.

After any change, run `node --test` before pushing.

## 13. When something goes wrong

**The test message never arrived in Slack.**

First check whether GitHub thinks it sent one. In the run log, open the "Send a
test Slack message" step. `Test message sent to Slack.` means Slack accepted it,
`SLACK_WEBHOOK_URL is not set` means the secret is missing or misnamed.

If it says the secret is not set: check the spelling with
`gh secret list --repo YOUR-ACCOUNT/YOUR-REPO`. It must be exactly
`SLACK_WEBHOOK_URL`. Also check you added it under **Secrets**, not
**Variables**, and as a **repository** secret rather than an environment one.

If it says sent but nothing appeared: the webhook is pointing at a different
channel than you think. Slack returns success regardless of whether you are
watching that channel. Look at the webhook in https://api.slack.com/apps under
Incoming Webhooks, which lists the channel beside each URL.

**The workflow failed with a permissions error on push.** The
`permissions: contents: write` block should be in
`.github/workflows/check.yml`. If your organisation restricts Actions from
writing to repositories, an owner has to relax that at the organisation level,
which is a policy decision rather than something you can fix in the file.

**The dashboard shows "Could not load the data".** Pages is serving `site/`
rather than the repository root. Settings, Pages, folder must be **/ (root)**.
The page needs `../data/latest.json` to resolve.

**The dashboard 404s.** Either Pages has not finished its first build, which
takes a minute or two, or the repository is private on a free account, which
Pages does not support. Check with
`gh api repos/YOUR-ACCOUNT/YOUR-REPO/pages --jq .status`.

**A domain says `No RDAP server known for .xx`.** That ending has no RDAP
service. There is no fix within this tool, RDAP is the only data source it uses.
Remove the domain from `domains.json`.

**A domain reports "not found" but it clearly exists.** Nominet occasionally
does this. The tool already lowercases every domain before asking, and keeps the
last good record rather than blanking it, so this usually resolves itself on the
next run. If it persists for three runs you will get an alert.

**`gh` says `not a git repository`.** Your terminal is not inside the repository
folder. Either `cd` into it or add `--repo YOUR-ACCOUNT/YOUR-REPO` to the
command.

**Scheduled runs stopped happening.** Check Actions for a banner saying
scheduled workflows were disabled after 60 days of inactivity, and click to
re-enable. Also be aware scheduled runs only ever come from the default branch.

**Your push was rejected saying "Push cannot contain secrets".** GitHub scans
pushes for credentials and blocks anything that looks like one. If you genuinely
pasted your webhook into a file, good: remove it, and treat that webhook as
burned by following the entry below. If it was only ever an example in your own
documentation, reword it so it no longer resembles a real URL. GitHub does offer
a link to override the block. Do not take it out of impatience, it is easier to
reword the line than to rotate a leaked credential.

**You accidentally committed your webhook.** Treat it as leaked, because it is,
even if you delete the commit. Go to https://api.slack.com/apps, find the app,
and delete that webhook. Create a new one and update the secret. Removing it
from git history does not help, because anyone can read a public repository at
any moment and GitHub keeps commits reachable for a while after deletion.

## 14. Building it from scratch instead

If you would rather write it yourself, or have an AI agent write it, the
specification below is enough to reproduce it. It is what the original was built
from.

> Build a domain monitor. Node 20, ES modules, no dependencies beyond the
> standard library, no TypeScript, no bundler, no database, no framework.
>
> **Data source.** RDAP, not WHOIS, no API keys. `.com` from
> `https://rdap.verisign.com/com/v1/domain/{domain}`, `.uk` and `.co.uk` from
> `https://rdap.nominet.uk/uk/domain/{domain}`, anything else from the server
> listed in `https://data.iana.org/rdap/dns.json`, cached for the run, failing
> clearly when an ending has no server. Retry 429 and 5xx three times with
> backoff. Send a `User-Agent` header. Lowercase domains before querying.
> Treat 404 as "not found" and keep the previous good record rather than
> overwriting it with blanks.
>
> **From each response extract** the expiration, registration and last changed
> events as ISO dates, the registrar from the vCard `fn` of the entity with role
> `registrar` falling back to its handle, the nameservers lowercased with any
> trailing dot removed and sorted, and the status array sorted.
>
> **Files.** `domains.json` is the hand edited list, each entry having domain,
> owner (`fabrik`, `client` or `third-party`), watch (`renewal`, `acquisition`
> or `client`) and free text notes. `data/latest.json` holds a `checkedAt`
> timestamp and a record per domain. `data/history.json` is an array, newest
> last, one entry per domain per run that had changes, each with `at`, `domain`
> and a list of `{field, from, to}`. Split the code into `src/rdap.js` for
> fetching and parsing, `src/diff.js` for comparison and rules,
> `src/notify.js` for Slack, and `src/check.js` to run them.
>
> **Change detection.** Track `expires`, `registrar`, `nameservers` and
> `status`. Record `updated` but never alert on it, because registries bump it
> for trivial reasons. Compare arrays order insensitively. A first sighting is
> not a change.
>
> **Alert on** an expiry change, labelled "Holder renewed" for an acquisition
> target; a registrar change, labelled "Transferred"; a nameserver change; a
> lock gained or lost, noting that losing a transfer lock on an acquisition
> target is a buying signal; a status containing `pendingDelete`,
> `redemptionPeriod` or `suspended`, labelled "Dropping" and marked high
> priority; reaching 90, 30 or 7 days to expiry, once per threshold rather than
> once per day, tracked in `latest.json` and reset when the expiry moves; and a
> domain erroring three runs in a row. Normalise status spellings across
> registries, since some return `client transfer prohibited` and others
> `clientTransferProhibited`. Every alert line should carry a date.
>
> **Slack.** One message per run, plain text with mrkdwn, high priority first,
> ending with the dashboard link and the time of the check. Read the webhook
> from `SLACK_WEBHOOK_URL`. With no webhook set, print to stdout and exit 0 so
> local runs work. Provide a flag that sends one clearly labelled sample message
> so the webhook can be verified without waiting for a real change.
>
> **Workflow.** Schedule daily plus manual dispatch, `contents: write`,
> checkout, Node 20, run the checker, then commit `data/` if it changed using
> the `github-actions[bot]` identity. Derive the dashboard URL from
> `GITHUB_REPOSITORY` so a fork needs no editing.
>
> **Dashboard.** A single `site/index.html` with inline CSS and JS, fetching
> `../data/latest.json` and `../data/history.json` relative to itself, so Pages
> must serve the repository root. A table sorted by expiry ascending with
> columns for domain linking to the RDAP JSON and to who.is, owner, watch,
> registrar, expiry, days left, a status pill, notes and last changed. Pills
> green beyond 90 days, amber inside 90, red inside 30, grey if expired or
> errored. Above it a twelve month timeline with today at the left and a dot per
> domain. Below it a change log, newest first, filterable by domain. Show the
> last checked time, and warn if it is more than 48 hours old. System font,
> light and dark via `prefers-color-scheme`, works on a phone, no decorative
> gradients.
>
> **Tests** with `node --test` covering the parser against saved Verisign and
> Nominet responses, and the comparison logic across no change, expiry change,
> nameserver reorder which must not alert, lock removed, threshold crossing and
> threshold not re-firing.
>
> **Conventions.** British English. No em dashes anywhere, including generated
> messages. Commit in small logical steps.

## Licence and credit

Built by [Fabrik](https://github.com/Fabrik-UAE). Take it, change it, no
attribution needed.
