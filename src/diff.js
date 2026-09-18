// Compares snapshots and decides what is worth telling Slack about.

/** Fields we compare. "updated" is recorded but never alerted on: registries bump it for trivial reasons. */
export const TRACKED_FIELDS = ['expires', 'registrar', 'nameservers', 'status'];

export const EXPIRY_THRESHOLDS = [90, 30, 7];

/** Number of consecutive failed runs before we complain about a domain. */
export const ERROR_RUN_THRESHOLD = 3;

/**
 * RDAP registries spell statuses inconsistently: Verisign returns
 * "client transfer prohibited", other servers return "clientTransferProhibited".
 * Reduce both to a comparable key.
 */
export function statusKey(status) {
  return String(status).toLowerCase().replace(/[^a-z]/g, '');
}

const LOCK_KEYS = new Set([
  'clienttransferprohibited',
  'clientdeleteprohibited',
  'clientupdateprohibited',
  'clientrenewprohibited',
  'clientholdprohibited',
  'servertransferprohibited',
  'serverdeleteprohibited',
  'serverupdateprohibited',
  'serverrenewprohibited',
]);

const DROPPING_KEYS = new Set([
  'pendingdelete',
  'redemptionperiod',
  'suspended',
  'pendingdeleterestorable',
  'pendingdeletescheduledforrelease',
]);

export const isLock = (status) => LOCK_KEYS.has(statusKey(status));
export const isDropping = (status) => DROPPING_KEYS.has(statusKey(status));

const sameArray = (a, b) => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/**
 * Compares one field. Arrays are order insensitive, so a registry reordering
 * nameservers or statuses does not read as a change.
 */
function fieldChanged(field, before, after) {
  if (field === 'nameservers' || field === 'status') return !sameArray(before, after);
  return (before ?? null) !== (after ?? null);
}

/**
 * Compares two records for one domain and returns the list of tracked field changes.
 * Returns an empty array when the domain is new, because a first sighting is not a change.
 */
export function diffRecords(previous, current) {
  if (!previous || !current) return [];
  const changes = [];
  for (const field of TRACKED_FIELDS) {
    if (fieldChanged(field, previous[field], current[field])) {
      changes.push({ field, from: previous[field] ?? null, to: current[field] ?? null });
    }
  }
  return changes;
}

/** Whole days from `now` to an ISO date. Negative once the date has passed. */
export function daysUntil(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const target = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86400000);
}

/**
 * Which expiry thresholds have been crossed but not yet announced.
 * `alreadyFired` is carried in latest.json and reset whenever `expires` changes,
 * so each threshold produces one message rather than one a day.
 */
export function pendingThresholds(expires, alreadyFired = [], now = new Date()) {
  const days = daysUntil(expires, now);
  if (days === null || days < 0) return [];
  const fired = new Set((alreadyFired ?? []).map(Number));
  return EXPIRY_THRESHOLDS.filter((t) => days <= t && !fired.has(t));
}

/** Locks present in `after` but not `before`, and vice versa. */
export function lockDelta(before = [], after = []) {
  const beforeLocks = new Set((before ?? []).filter(isLock).map(statusKey));
  const afterLocks = new Set((after ?? []).filter(isLock).map(statusKey));
  return {
    gained: (after ?? []).filter((s) => isLock(s) && !beforeLocks.has(statusKey(s))),
    lost: (before ?? []).filter((s) => isLock(s) && !afterLocks.has(statusKey(s))),
  };
}

/**
 * The whole rule set for one domain: turns a pair of records plus the watch
 * config into the alerts that belong in this run's Slack message.
 *
 * Each alert is { domain, kind, label, priority, detail, watch }.
 * `priority` is "high" for a dropping domain, "normal" otherwise.
 */
export function alertsForDomain({ meta, previous, current, changes, now = new Date() }) {
  const alerts = [];
  const watch = meta?.watch ?? 'renewal';
  const push = (kind, label, detail, priority = 'normal') =>
    alerts.push({ domain: meta.domain, kind, label, detail, priority, watch });

  const changeFor = (field) => changes.find((c) => c.field === field);

  const expiryChange = changeFor('expires');
  if (expiryChange) {
    // For a domain we are trying to buy, a renewal by the holder is the news.
    push(
      'expires',
      watch === 'acquisition' ? 'Holder renewed' : 'Renewed',
      { from: expiryChange.from, to: expiryChange.to, registrar: current?.registrar ?? null },
    );
  }

  const registrarChange = changeFor('registrar');
  if (registrarChange) {
    push('registrar', 'Transferred', { from: registrarChange.from, to: registrarChange.to });
  }

  const nsChange = changeFor('nameservers');
  if (nsChange) {
    push('nameservers', 'Nameservers changed', { from: nsChange.from, to: nsChange.to });
  }

  const statusChange = changeFor('status');
  if (statusChange) {
    const { gained, lost } = lockDelta(statusChange.from, statusChange.to);
    if (gained.length || lost.length) {
      push('lock', 'Lock changed', { gained, lost });
    }
  }

  // Dropping is evaluated on the current status, not on the change, so a domain
  // that stays in redemption keeps being flagged while it matters.
  const dropping = (current?.status ?? []).filter(isDropping);
  const wasDropping = (previous?.status ?? []).filter(isDropping);
  if (dropping.length && !sameArray(dropping, wasDropping)) {
    push('dropping', 'Dropping', { status: dropping }, 'high');
  }

  return alerts;
}

/**
 * Runs the comparison across every domain and returns the new snapshot entries,
 * the history entries to append and the alerts to send.
 *
 * `results` is a Map of domain to { record, error, notFound }.
 */
export function buildRun({ domainList, previousLatest, results, now = new Date() }) {
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const previousDomains = previousLatest?.domains ?? {};
  const domains = {};
  const historyEntries = [];
  const alerts = [];

  for (const meta of domainList) {
    const name = meta.domain.toLowerCase();
    const before = previousDomains[name] ?? null;
    const result = results.get(name) ?? { error: 'No result for this domain' };

    // A failed or absent lookup keeps the last good record rather than blanking it.
    if (result.error || result.notFound) {
      const errorText = result.error ?? null;
      const consecutiveErrors = result.error ? (before?.consecutiveErrors ?? 0) + 1 : 0;
      const entry = {
        ...(before ?? { domain: name, registrar: null, created: null, updated: null, expires: null, nameservers: [], status: [], lastChanged: null, alertedThresholds: [] }),
        domain: name,
        status: result.notFound ? ['not found'] : (before?.status ?? []),
        lastChecked: at,
        error: errorText,
        consecutiveErrors,
      };
      domains[name] = entry;

      if (result.error && consecutiveErrors === ERROR_RUN_THRESHOLD) {
        alerts.push({
          domain: name,
          kind: 'error',
          label: 'Lookup failing',
          priority: 'normal',
          watch: meta.watch,
          detail: { runs: consecutiveErrors, message: errorText },
        });
      }
      continue;
    }

    const current = result.record;
    const changes = diffRecords(before, current);

    // Once the expiry moves, the thresholds we already announced no longer apply.
    const expiryMoved = changes.some((c) => c.field === 'expires');
    let alertedThresholds = expiryMoved ? [] : (before?.alertedThresholds ?? []);

    const domainAlerts = alertsForDomain({ meta, previous: before, current, changes, now });

    const due = pendingThresholds(current.expires, alertedThresholds, now);
    for (const threshold of due) {
      domainAlerts.push({
        domain: name,
        kind: 'threshold',
        label: `${threshold} days to expiry`,
        priority: threshold <= 7 ? 'high' : 'normal',
        watch: meta.watch,
        detail: { threshold, expires: current.expires, owner: meta.owner },
      });
    }
    alertedThresholds = [...new Set([...alertedThresholds, ...due])].sort((a, b) => b - a);

    if (changes.length) {
      historyEntries.push({ at, domain: name, changes });
    }
    alerts.push(...domainAlerts);

    domains[name] = {
      ...current,
      domain: name,
      lastChecked: at,
      lastChanged: changes.length ? at : (before?.lastChanged ?? at),
      alertedThresholds,
      error: null,
      consecutiveErrors: 0,
    };
  }

  return { at, latest: { checkedAt: at, domains }, historyEntries, alerts };
}
