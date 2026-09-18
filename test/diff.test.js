import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffRecords,
  daysUntil,
  pendingThresholds,
  lockDelta,
  alertsForDomain,
  buildRun,
  isLock,
  isDropping,
  statusKey,
} from '../src/diff.js';

const base = {
  domain: 'fabrikagency.com',
  registrar: 'GoDaddy.com, LLC',
  created: '2008-04-14',
  updated: '2026-04-15',
  expires: '2027-04-14',
  nameservers: ['ns1.domainmarket.com', 'ns2.domainmarket.com'],
  status: ['client transfer prohibited'],
};

const meta = { domain: 'fabrikagency.com', owner: 'third-party', watch: 'acquisition' };
const NOW = new Date('2026-09-18T06:00:00Z');

test('no change produces no diff', () => {
  assert.deepEqual(diffRecords(base, { ...base }), []);
});

test('an updated timestamp alone is not a tracked change', () => {
  assert.deepEqual(diffRecords(base, { ...base, updated: '2026-09-01' }), []);
});

test('an expiry change is detected', () => {
  const changes = diffRecords(base, { ...base, expires: '2028-04-14' });
  assert.deepEqual(changes, [{ field: 'expires', from: '2027-04-14', to: '2028-04-14' }]);
});

test('reordered nameservers do not count as a change', () => {
  const reordered = { ...base, nameservers: ['ns2.domainmarket.com', 'ns1.domainmarket.com'] };
  assert.deepEqual(diffRecords(base, reordered), []);
});

test('a genuinely different nameserver set is a change', () => {
  const changes = diffRecords(base, { ...base, nameservers: ['ns1.cloudflare.com'] });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'nameservers');
});

test('a registrar change is detected', () => {
  const changes = diffRecords(base, { ...base, registrar: 'Namecheap, Inc.' });
  assert.deepEqual(changes, [
    { field: 'registrar', from: 'GoDaddy.com, LLC', to: 'Namecheap, Inc.' },
  ]);
});

test('a first sighting is not treated as a change', () => {
  assert.deepEqual(diffRecords(null, base), []);
});

test('status keys normalise across registry spellings', () => {
  assert.equal(statusKey('client transfer prohibited'), statusKey('clientTransferProhibited'));
  assert.ok(isLock('clientTransferProhibited'));
  assert.ok(isLock('client delete prohibited'));
  assert.ok(!isLock('active'));
  assert.ok(isDropping('pendingDelete'));
  assert.ok(isDropping('redemption period'));
  assert.ok(isDropping('suspended'));
});

test('lockDelta reports locks gained and lost', () => {
  const delta = lockDelta(
    ['client transfer prohibited', 'client delete prohibited'],
    ['client delete prohibited', 'clientUpdateProhibited'],
  );
  assert.deepEqual(delta.lost, ['client transfer prohibited']);
  assert.deepEqual(delta.gained, ['clientUpdateProhibited']);
});

test('losing a transfer lock raises an alert', () => {
  const current = { ...base, status: ['active'] };
  const changes = diffRecords(base, current);
  const alerts = alertsForDomain({ meta, previous: base, current, changes, now: NOW });
  const lock = alerts.find((a) => a.kind === 'lock');
  assert.ok(lock, 'expected a lock alert');
  assert.deepEqual(lock.detail.lost, ['client transfer prohibited']);
  assert.equal(lock.detail.gained.length, 0);
});

test('an expiry change on an acquisition target is labelled Holder renewed', () => {
  const current = { ...base, expires: '2028-04-14' };
  const changes = diffRecords(base, current);
  const alerts = alertsForDomain({ meta, previous: base, current, changes, now: NOW });
  assert.equal(alerts[0].label, 'Holder renewed');
});

test('an expiry change on a domain we own is labelled Renewed', () => {
  const ours = { ...meta, owner: 'fabrik', watch: 'renewal' };
  const current = { ...base, expires: '2028-04-14' };
  const changes = diffRecords(base, current);
  const alerts = alertsForDomain({ meta: ours, previous: base, current, changes, now: NOW });
  assert.equal(alerts[0].label, 'Renewed');
});

test('pendingDelete raises a high priority Dropping alert', () => {
  const current = { ...base, status: ['pendingDelete'] };
  const changes = diffRecords(base, current);
  const alerts = alertsForDomain({ meta, previous: base, current, changes, now: NOW });
  const dropping = alerts.find((a) => a.kind === 'dropping');
  assert.ok(dropping);
  assert.equal(dropping.priority, 'high');
});

test('daysUntil counts whole days and goes negative after expiry', () => {
  assert.equal(daysUntil('2026-09-18', NOW), 0);
  assert.equal(daysUntil('2026-12-17', NOW), 90);
  assert.equal(daysUntil('2026-09-11', NOW), -7);
  assert.equal(daysUntil(null, NOW), null);
});

test('crossing 90 days fires the 90 day threshold only', () => {
  assert.deepEqual(pendingThresholds('2026-12-17', [], NOW), [90]);
});

test('an already fired threshold does not fire again', () => {
  assert.deepEqual(pendingThresholds('2026-12-17', [90], NOW), []);
});

test('crossing 30 days fires 30 when 90 has already fired', () => {
  assert.deepEqual(pendingThresholds('2026-10-10', [90], NOW), [30]);
});

test('a domain already past every threshold fires all outstanding ones at once', () => {
  assert.deepEqual(pendingThresholds('2026-09-20', [], NOW), [90, 30, 7]);
});

test('an expired domain fires no thresholds', () => {
  assert.deepEqual(pendingThresholds('2026-09-01', [], NOW), []);
});

// buildRun ties the rules together across a whole run.

const domainList = [meta];

const runWith = (previousLatest, result, now = NOW) =>
  buildRun({
    domainList,
    previousLatest,
    results: new Map([['fabrikagency.com', result]]),
    now,
  });

test('a first run records the domain, writes no history and sends no change alert', () => {
  const run = runWith(null, { record: base });
  assert.equal(run.historyEntries.length, 0);
  assert.equal(run.alerts.filter((a) => a.kind !== 'threshold').length, 0);
  assert.equal(run.latest.domains['fabrikagency.com'].expires, '2027-04-14');
  assert.equal(run.latest.domains['fabrikagency.com'].error, null);
});

test('an unchanged run appends no history', () => {
  const previous = runWith(null, { record: base }).latest;
  const run = runWith(previous, { record: { ...base } });
  assert.equal(run.historyEntries.length, 0);
  assert.equal(run.alerts.length, 0);
});

test('a changed run appends one history entry and keeps lastChanged current', () => {
  const previous = runWith(null, { record: base }).latest;
  const later = new Date('2026-09-19T06:00:00Z');
  const run = runWith(previous, { record: { ...base, expires: '2028-04-14' } }, later);

  assert.equal(run.historyEntries.length, 1);
  assert.equal(run.historyEntries[0].domain, 'fabrikagency.com');
  assert.deepEqual(run.historyEntries[0].changes, [
    { field: 'expires', from: '2027-04-14', to: '2028-04-14' },
  ]);
  assert.equal(run.latest.domains['fabrikagency.com'].lastChanged, run.at);
});

test('a threshold does not re-fire on the following run', () => {
  const soon = { ...base, expires: '2026-12-17' };
  const first = runWith(null, { record: soon });
  assert.deepEqual(first.alerts.map((a) => a.kind), ['threshold']);
  assert.deepEqual(first.latest.domains['fabrikagency.com'].alertedThresholds, [90]);

  const second = runWith(first.latest, { record: soon });
  assert.equal(second.alerts.length, 0);
});

test('a moved expiry resets the fired thresholds', () => {
  const soon = { ...base, expires: '2026-12-17' };
  const first = runWith(null, { record: soon });
  assert.deepEqual(first.latest.domains['fabrikagency.com'].alertedThresholds, [90]);

  // The holder renews, pushing expiry a year out. Thresholds reset to empty.
  const renewed = { ...base, expires: '2027-12-17' };
  const second = runWith(first.latest, { record: renewed });
  assert.deepEqual(second.latest.domains['fabrikagency.com'].alertedThresholds, []);
  assert.equal(second.alerts.filter((a) => a.kind === 'expires').length, 1);
});

test('a not found domain keeps the previous record rather than blanking it', () => {
  const previous = runWith(null, { record: base }).latest;
  const run = runWith(previous, { notFound: true });
  const entry = run.latest.domains['fabrikagency.com'];

  assert.equal(entry.registrar, 'GoDaddy.com, LLC');
  assert.equal(entry.expires, '2027-04-14');
  assert.deepEqual(entry.status, ['not found']);
  assert.equal(run.historyEntries.length, 0);
});

test('an error alerts only on the third consecutive run', () => {
  let latest = runWith(null, { record: base }).latest;
  const failure = { error: 'HTTP 500 from rdap.example' };

  const first = runWith(latest, failure);
  assert.equal(first.alerts.length, 0);
  assert.equal(first.latest.domains['fabrikagency.com'].consecutiveErrors, 1);
  assert.equal(first.latest.domains['fabrikagency.com'].expires, '2027-04-14');

  const second = runWith(first.latest, failure);
  assert.equal(second.alerts.length, 0);

  const third = runWith(second.latest, failure);
  assert.deepEqual(third.alerts.map((a) => a.kind), ['error']);

  // It does not keep shouting on run four.
  const fourth = runWith(third.latest, failure);
  assert.equal(fourth.alerts.length, 0);
});

test('a recovered lookup clears the error counter', () => {
  const previous = runWith(null, { record: base }).latest;
  const failed = runWith(previous, { error: 'boom' });
  const recovered = runWith(failed.latest, { record: base });
  assert.equal(recovered.latest.domains['fabrikagency.com'].consecutiveErrors, 0);
  assert.equal(recovered.latest.domains['fabrikagency.com'].error, null);
});
