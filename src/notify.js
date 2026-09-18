// Slack message formatting and delivery.

import { daysUntil } from './diff.js';

const DEFAULT_DASHBOARD_URL = 'https://fabrik-uae.github.io/fabrik-domain-monitor/site/';

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

/** Turns one alert into the text after the bullet. */
export function formatAlert(alert) {
  const { domain, kind, label, detail = {}, watch } = alert;

  switch (kind) {
    case 'expires': {
      const registrar = shortRegistrar(detail.registrar);
      const suffix = registrar ? ` (${registrar})` : '';
      return `${domain}: ${label}. Expires ${formatDate(detail.from)} → ${formatDate(detail.to)}${suffix}`;
    }
    case 'registrar':
      return `${domain}: ${label}. ${shortRegistrar(detail.from) ?? 'unknown'} → ${shortRegistrar(detail.to) ?? 'unknown'}`;
    case 'nameservers': {
      const from = (detail.from ?? []).join(', ') || 'none';
      const to = (detail.to ?? []).join(', ') || 'none';
      return `${domain}: ${label}. ${from} → ${to}`;
    }
    case 'lock': {
      const parts = [];
      if (detail.lost?.length) parts.push(`lost ${detail.lost.join(', ')}`);
      if (detail.gained?.length) parts.push(`gained ${detail.gained.join(', ')}`);
      let line = `${domain}: ${label}. ${parts.join('; ')}`;
      // A transfer lock coming off a domain we want is the strongest signal we get.
      const lostTransferLock = (detail.lost ?? []).some((s) =>
        String(s).toLowerCase().replace(/[^a-z]/g, '').includes('transferprohibited'),
      );
      if (lostTransferLock && watch === 'acquisition') {
        line += '. Transfer lock is off an acquisition target, worth an approach now';
      }
      return line;
    }
    case 'dropping':
      return `${domain}: ${label}. Status ${(detail.status ?? []).join(', ')}. High priority`;
    case 'threshold': {
      const owner = OWNER_WORDS[detail.owner] ?? detail.owner ?? 'unknown owner';
      const watchWord = WATCH_WORDS[watch] ?? 'Watched';
      return `${domain}: ${label}, ${formatDate(detail.expires)}. ${watchWord}, ${owner}.`;
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
export function formatMessage(alerts, { dashboardUrl = DEFAULT_DASHBOARD_URL } = {}) {
  if (!alerts?.length) return null;

  const ordered = [...alerts].sort((a, b) => {
    const priority = (x) => (x.priority === 'high' ? 0 : 1);
    return priority(a) - priority(b) || a.domain.localeCompare(b.domain);
  });

  const noun = ordered.length === 1 ? 'change' : 'changes';
  const lines = [
    `*Domain monitor: ${ordered.length} ${noun}*`,
    ...ordered.map((alert) => `• ${formatAlert(alert)}`),
  ];
  if (dashboardUrl) lines.push(`Dashboard: ${dashboardUrl}`);
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

export { DEFAULT_DASHBOARD_URL, daysUntil };
