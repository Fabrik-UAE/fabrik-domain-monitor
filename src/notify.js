// Slack message formatting and delivery.

import { daysUntil } from './diff.js';

/**
 * Where the dashboard lives. Derived from the repository so a fork needs no
 * editing: GitHub Actions sets GITHUB_REPOSITORY to "owner/name", and Pages
 * serves that at owner.github.io/name. DASHBOARD_URL overrides it for a custom
 * domain. With neither, the message simply omits the link.
 */
export function defaultDashboardUrl(env = process.env) {
  if (env.DASHBOARD_URL) return env.DASHBOARD_URL;
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) return null;
  const [owner, name] = repo.split('/');
  return `https://${owner.toLowerCase()}.github.io/${name}/site/`;
}

/** "2026-12-21" becomes "21 Dec 2026". */
export function formatDate(isoDate) {
  if (!isoDate) return 'unknown';
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Trims the legal boilerplate off a registrar name so the message stays readable. */
export function shortRegistrar(name) {
  if (!name) return null;
  return String(name)
    .replace(/,?\s+(LLC|Ltd\.?|Limited|Inc\.?|Corp\.?|Corporation|GmbH|B\.?V\.?|S\.?A\.?S?)\.?$/i, '')
    .replace(/\.com$/i, '')
    .trim();
}

const OWNER_WORDS = {
  fabrik: 'ours',
  client: 'client domain',
  'third-party': 'third party',
};

const WATCH_WORDS = {
  acquisition: 'Acquisition target',
  renewal: 'Renewal watch',
  client: 'Client domain',
};

/** "18 Sept 2026 at 13:21 UTC" for a full timestamp. */
export function formatStamp(iso) {
  if (!iso) return 'unknown';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  const date = parsed.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const time = parsed.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  return `${date} at ${time} UTC`;
}

/** " on 20 Dec 2025", or empty when the registry gave us no date. */
function onDate(iso) {
  return iso ? ` on ${formatDate(iso)}` : '';
}

/** "460 days out", or "today", or "42 days ago" once the date has passed. */
function howFarOff(iso, now = new Date()) {
  const days = daysUntil(iso, now);
  if (days === null) return null;
  if (days === 0) return 'today';
  if (days < 0) return `${Math.abs(days)} days ago`;
  return `${days} days out`;
}

/** Turns one alert into the text after the bullet. */
export function formatAlert(alert, now = new Date()) {
  const { domain, kind, label, detail = {}, watch } = alert;

  switch (kind) {
    case 'expires': {
      const registrar = shortRegistrar(detail.registrar);
      const suffix = registrar ? ` Registrar ${registrar}.` : '';
      const off = howFarOff(detail.to, now);
      const gap = off ? `, now ${off}` : '';
      return `${domain}: ${label}${onDate(detail.updatedAt)}. Expiry ${formatDate(detail.from)} → ${formatDate(detail.to)}${gap}.${suffix}`;
    }
    case 'registrar':
      return `${domain}: ${label}${onDate(detail.updatedAt)}. ${shortRegistrar(detail.from) ?? 'unknown'} → ${shortRegistrar(detail.to) ?? 'unknown'}`;
    case 'nameservers': {
      const from = (detail.from ?? []).join(', ') || 'none';
      const to = (detail.to ?? []).join(', ') || 'none';
      return `${domain}: ${label}${onDate(detail.updatedAt)}. ${from} → ${to}`;
    }
    case 'lock': {
      const parts = [];
      if (detail.lost?.length) parts.push(`Lost ${detail.lost.join(', ')}`);
      if (detail.gained?.length) parts.push(`${detail.lost?.length ? 'gained' : 'Gained'} ${detail.gained.join(', ')}`);
      let line = `${domain}: ${label}${onDate(detail.updatedAt)}. ${parts.join('; ')}`;
      // A transfer lock coming off a domain we want is the strongest signal we get.
      const lostTransferLock = (detail.lost ?? []).some((s) =>
        String(s).toLowerCase().replace(/[^a-z]/g, '').includes('transferprohibited'),
      );
      if (lostTransferLock && watch === 'acquisition') {
        line += '. Transfer lock is off an acquisition target, worth an approach now';
      }
      return line;
    }
    case 'dropping': {
      const off = howFarOff(detail.expires, now);
      const expiry = detail.expires ? ` Expires ${formatDate(detail.expires)}${off ? ', ' + off : ''}.` : '';
      const since = detail.updatedAt ? ` since ${formatDate(detail.updatedAt)}` : '';
      return `${domain}: ${label}. Status ${(detail.status ?? []).join(', ')}${since}.${expiry} High priority.`;
    }
    case 'threshold': {
      const owner = OWNER_WORDS[detail.owner] ?? detail.owner ?? 'unknown owner';
      const watchWord = WATCH_WORDS[watch] ?? 'Watched';
      return `${domain}: ${label} on ${formatDate(detail.expires)}. ${watchWord}, ${owner}.`;
    }
    case 'error':
      return `${domain}: ${label} for ${detail.runs} runs. ${detail.message ?? 'no detail'}`;
    default:
      return `${domain}: ${label}`;
  }
}

/**
 * Builds the single message for a run. High priority alerts lead.
 * Returns null when there is nothing to say.
 */
export function formatMessage(alerts, { dashboardUrl = defaultDashboardUrl(), test = false, checkedAt = null, now = new Date() } = {}) {
  if (!alerts?.length) return null;

  const ordered = [...alerts].sort((a, b) => {
    const priority = (x) => (x.priority === 'high' ? 0 : 1);
    return priority(a) - priority(b) || a.domain.localeCompare(b.domain);
  });

  const noun = ordered.length === 1 ? 'change' : 'changes';
  const heading = test
    ? '*Domain monitor: test message, no real change*'
    : `*Domain monitor: ${ordered.length} ${noun}*`;
  const lines = [
    heading,
    ...ordered.map((alert) => `• ${formatAlert(alert, now)}`),
  ];
  // Anchor every message to the moment it was checked, so a late or replayed
  // message is never mistaken for a fresh one.
  const footer = [];
  if (checkedAt) footer.push(`Checked ${formatStamp(checkedAt)}.`);
  if (dashboardUrl) footer.push(`Dashboard: ${dashboardUrl}`);
  if (footer.length) lines.push(footer.join(' '));
  return lines.join('\n');
}

/**
 * Posts to the incoming webhook. With no webhook configured the message goes to
 * stdout instead and the run still succeeds, so local runs work without secrets.
 */
export async function sendSlack(message, { webhookUrl = process.env.SLACK_WEBHOOK_URL, fetchImpl = fetch, log = console.log } = {}) {
  if (!message) return { sent: false, reason: 'nothing to report' };

  if (!webhookUrl) {
    log('SLACK_WEBHOOK_URL is not set, so the message is printed here instead:');
    log(message);
    return { sent: false, reason: 'no webhook configured' };
  }

  const res = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message, mrkdwn: true }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack webhook returned HTTP ${res.status} ${body}`.trim());
  }
  return { sent: true };
}

export { daysUntil };
