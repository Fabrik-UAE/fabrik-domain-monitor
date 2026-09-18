#!/usr/bin/env node
// Runs one check across every domain in domains.json.
//
//   node src/check.js              writes data/, sends or prints the Slack message
//   node src/check.js --dry-run    fetches and diffs but writes nothing
//   node src/check.js --test-alert sends one sample message, writes nothing

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchDomain } from './rdap.js';
import { buildRun } from './diff.js';
import { formatMessage, sendSlack, DEFAULT_DASHBOARD_URL } from './notify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  domains: join(root, 'domains.json'),
  latest: join(root, 'data', 'latest.json'),
  history: join(root, 'data', 'history.json'),
};

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** Looks every domain up in turn. One slow registry should not fail the others. */
async function lookupAll(domainList) {
  const results = new Map();
  for (const meta of domainList) {
    const name = meta.domain.toLowerCase();
    try {
      const { record, notFound } = await fetchDomain(name);
      results.set(name, notFound ? { notFound: true } : { record });
      console.log(`  ${name}: ${notFound ? 'not found' : `expires ${record.expires ?? 'unknown'}`}`);
    } catch (err) {
      results.set(name, { error: err.message });
      console.error(`  ${name}: lookup failed, ${err.message}`);
    }
  }
  return results;
}

/**
 * Builds a sample message off the real snapshot so the webhook can be checked
 * without waiting for a domain to actually change. Writes nothing.
 */
async function testAlert(dashboardUrl) {
  const latest = await readJson(paths.latest, null);
  const domainList = await readJson(paths.domains, []);
  const config = Object.fromEntries(domainList.map((d) => [d.domain.toLowerCase(), d]));

  const soonest = Object.values(latest?.domains ?? {})
    .filter((d) => d.expires)
    .sort((a, b) => a.expires.localeCompare(b.expires))[0];

  if (!soonest) throw new Error('No data yet, so run a real check first');
  const meta = config[soonest.domain] ?? {};
  const nextYear = `${Number(soonest.expires.slice(0, 4)) + 1}${soonest.expires.slice(4)}`;

  const message = formatMessage(
    [
      {
        domain: soonest.domain,
        kind: 'expires',
        label: meta.watch === 'acquisition' ? 'Holder renewed' : 'Renewed',
        priority: 'normal',
        watch: meta.watch,
        detail: { from: soonest.expires, to: nextYear, registrar: soonest.registrar },
      },
      {
        domain: soonest.domain,
        kind: 'threshold',
        label: '90 days to expiry',
        priority: 'normal',
        watch: meta.watch,
        detail: { threshold: 90, expires: soonest.expires, owner: meta.owner },
      },
    ],
    { dashboardUrl, test: true },
  );

  console.log('Sending a test message. Nothing is written and no real change occurred.\n');
  const { sent } = await sendSlack(message, { webhookUrl: process.env.SLACK_WEBHOOK_URL });
  console.log(sent ? '\nTest message sent to Slack.' : '\nSet SLACK_WEBHOOK_URL to deliver it to Slack.');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dashboardUrl = process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL;

  if (process.argv.includes('--test-alert')) {
    await testAlert(dashboardUrl);
    return;
  }

  const domainList = await readJson(paths.domains, null);
  if (!Array.isArray(domainList) || domainList.length === 0) {
    throw new Error('domains.json is missing or empty');
  }

  const previousLatest = await readJson(paths.latest, null);
  const previousHistory = await readJson(paths.history, []);

  console.log(`Checking ${domainList.length} domains${dryRun ? ' (dry run)' : ''}`);
  const results = await lookupAll(domainList);

  const { latest, historyEntries, alerts } = buildRun({ domainList, previousLatest, results });
  const message = formatMessage(alerts, { dashboardUrl });

  console.log(
    `\n${historyEntries.length} ${historyEntries.length === 1 ? 'domain' : 'domains'} changed, ` +
      `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}`,
  );

  if (dryRun) {
    console.log('\nDry run, nothing written.');
    if (message) console.log(`\n${message}`);
    return;
  }

  // Let the workflow describe the commit accurately. Every run rewrites the
  // checkedAt timestamp, so a diff in data/ does not by itself mean a change.
  if (process.env.GITHUB_OUTPUT) {
    const summary = historyEntries.length
      ? `${historyEntries.length} ${historyEntries.length === 1 ? 'domain' : 'domains'} changed`
      : 'no change';
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `changed=${historyEntries.length}\nsummary=${summary}\n`,
      { flag: 'a' },
    );
  }

  await mkdir(join(root, 'data'), { recursive: true });
  await writeJson(paths.latest, latest);
  await writeJson(paths.history, [...previousHistory, ...historyEntries]);
  console.log('Wrote data/latest.json and data/history.json');

  if (message) {
    const { sent } = await sendSlack(message, { webhookUrl: process.env.SLACK_WEBHOOK_URL });
    if (sent) console.log('Slack message sent.');
  } else {
    console.log('Nothing to report, so no Slack message.');
  }
}

main().catch((err) => {
  console.error(`Check failed: ${err.message}`);
  process.exitCode = 1;
});
