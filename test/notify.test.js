import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, shortRegistrar, formatAlert, formatMessage, sendSlack } from '../src/notify.js';

const NOW = new Date('2026-09-18T06:00:00Z');

test('dates render in British short form', () => {
  assert.equal(formatDate('2026-12-21'), '21 Dec 2026');
  assert.equal(formatDate('2028-04-14'), '14 Apr 2028');
  assert.equal(formatDate(null), 'unknown');
});

test('registrar names lose their legal suffix', () => {
  assert.equal(shortRegistrar('GoDaddy.com, LLC'), 'GoDaddy');
  assert.equal(shortRegistrar('Namecheap, Inc.'), 'Namecheap');
  assert.equal(shortRegistrar(null), null);
});

test('an expiry alert says when it was renewed, the old and new dates, and how far off', () => {
  const line = formatAlert(
    {
      domain: 'fabrikagency.com',
      kind: 'expires',
      label: 'Holder renewed',
      watch: 'acquisition',
      detail: {
        updatedAt: '2026-09-17',
        from: '2027-04-14',
        to: '2028-04-14',
        registrar: 'GoDaddy.com, LLC',
      },
    },
    NOW,
  );
  assert.equal(
    line,
    'fabrikagency.com: Holder renewed on 17 Sept 2026. Expiry 14 Apr 2027 \u2192 14 Apr 2028, now 574 days out. Registrar GoDaddy.',
  );
});

test('an expiry alert still reads sensibly when the registry gave no change date', () => {
  const line = formatAlert(
    {
      domain: 'fabrikagency.com',
      kind: 'expires',
      label: 'Holder renewed',
      watch: 'acquisition',
      detail: { updatedAt: null, from: '2027-04-14', to: '2028-04-14', registrar: null },
    },
    NOW,
  );
  assert.equal(
    line,
    'fabrikagency.com: Holder renewed. Expiry 14 Apr 2027 \u2192 14 Apr 2028, now 574 days out.',
  );
});

test('a threshold alert reads as the spec describes', () => {
  const line = formatAlert({
    domain: 'fabrik.co.uk',
    kind: 'threshold',
    label: '90 days to expiry',
    watch: 'acquisition',
    detail: { threshold: 90, expires: '2026-12-21', owner: 'third-party' },
  });
  assert.equal(line, 'fabrik.co.uk: 90 days to expiry on 21 Dec 2026. Acquisition target, third party.');
});

test('losing a transfer lock on an acquisition target is called out as a buying signal', () => {
  const line = formatAlert({
    domain: 'fabrik.com',
    kind: 'lock',
    label: 'Lock changed',
    watch: 'acquisition',
    detail: { lost: ['client transfer prohibited'], gained: [] },
  });
  assert.match(line, /worth an approach now/);
});

test('losing a transfer lock on our own domain is not called a buying signal', () => {
  const line = formatAlert({
    domain: 'fabrik.ae',
    kind: 'lock',
    label: 'Lock changed',
    watch: 'renewal',
    detail: { lost: ['client transfer prohibited'], gained: [] },
  });
  assert.doesNotMatch(line, /worth an approach now/);
});

test('the message header counts the alerts and pluralises', () => {
  const one = formatMessage([
    { domain: 'a.com', kind: 'registrar', label: 'Transferred', detail: { from: 'X', to: 'Y' } },
  ]);
  assert.match(one, /^\*Domain monitor: 1 change\*/);

  const two = formatMessage([
    { domain: 'a.com', kind: 'registrar', label: 'Transferred', detail: { from: 'X', to: 'Y' } },
    { domain: 'b.com', kind: 'registrar', label: 'Transferred', detail: { from: 'X', to: 'Y' } },
  ]);
  assert.match(two, /^\*Domain monitor: 2 changes\*/);
});

test('high priority alerts lead the message', () => {
  const message = formatMessage([
    { domain: 'zed.com', kind: 'registrar', label: 'Transferred', priority: 'normal', detail: {} },
    { domain: 'alpha.com', kind: 'dropping', label: 'Dropping', priority: 'high', detail: { status: ['pendingDelete'] } },
  ]);
  const lines = message.split('\n');
  assert.match(lines[1], /^• alpha\.com: Dropping/);
});

test('the dashboard link closes the message', () => {
  const message = formatMessage(
    [{ domain: 'a.com', kind: 'registrar', label: 'Transferred', detail: {} }],
    { dashboardUrl: 'https://example.com/site/' },
  );
  assert.equal(message.split('\n').at(-1), 'Dashboard: https://example.com/site/');
});

test('no alerts means no message', () => {
  assert.equal(formatMessage([]), null);
  assert.equal(formatMessage(null), null);
});

test('no message contains an em dash', () => {
  const message = formatMessage([
    { domain: 'a.com', kind: 'expires', label: 'Holder renewed', detail: { from: '2027-04-14', to: '2028-04-14', registrar: 'GoDaddy.com, LLC' } },
    { domain: 'b.com', kind: 'dropping', label: 'Dropping', priority: 'high', detail: { status: ['pendingDelete'] } },
    { domain: 'c.com', kind: 'threshold', label: '30 days to expiry', watch: 'renewal', detail: { threshold: 30, expires: '2026-10-18', owner: 'fabrik' } },
  ]);
  assert.ok(!message.includes('\u2014'), 'message contains an em dash');
});

test('without a webhook the message is logged and the run still succeeds', async () => {
  const logged = [];
  const result = await sendSlack('hello', {
    webhookUrl: undefined,
    log: (line) => logged.push(line),
    fetchImpl: () => {
      throw new Error('should not have been called');
    },
  });
  assert.equal(result.sent, false);
  assert.ok(logged.join('\n').includes('hello'));
});

test('with a webhook the message is posted as JSON', async () => {
  let captured = null;
  const result = await sendSlack('hello', {
    webhookUrl: 'https://hooks.slack.test/abc',
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse(init.body), method: init.method };
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.sent, true);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.body.text, 'hello');
});

test('a webhook failure throws', async () => {
  await assert.rejects(
    () =>
      sendSlack('hello', {
        webhookUrl: 'https://hooks.slack.test/abc',
        fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'invalid_token' }),
      }),
    /HTTP 403/,
  );
});

test('a test message is labelled so nobody mistakes it for a real change', () => {
  const message = formatMessage(
    [{ domain: 'a.com', kind: 'registrar', label: 'Transferred', detail: {} }],
    { test: true },
  );
  assert.match(message, /^\*Domain monitor: test message, no real change\*/);
});

test('a dropping alert gives the status, when it appeared and the expiry', () => {
  const line = formatAlert(
    {
      domain: 'fabrikagency.co.uk',
      kind: 'dropping',
      label: 'Dropping',
      priority: 'high',
      watch: 'acquisition',
      detail: { updatedAt: '2026-09-15', status: ['redemptionPeriod'], expires: '2026-10-05' },
    },
    NOW,
  );
  assert.equal(
    line,
    'fabrikagency.co.uk: Dropping. Status redemptionPeriod since 15 Sept 2026. Expires 5 Oct 2026, 17 days out. High priority.',
  );
});

test('a transfer names the date it happened', () => {
  const line = formatAlert({
    domain: 'a.com',
    kind: 'registrar',
    label: 'Transferred',
    detail: { updatedAt: '2026-09-17', from: 'GoDaddy.com, LLC', to: 'Namecheap, Inc.' },
  });
  assert.equal(line, 'a.com: Transferred on 17 Sept 2026. GoDaddy \u2192 Namecheap');
});

test('lock clauses are capitalised as sentences', () => {
  const lostOnly = formatAlert({
    domain: 'a.com', kind: 'lock', label: 'Lock changed', watch: 'renewal',
    detail: { updatedAt: '2026-09-16', lost: ['client delete prohibited'], gained: [] },
  });
  assert.match(lostOnly, /\. Lost client delete prohibited/);

  const gainedOnly = formatAlert({
    domain: 'a.com', kind: 'lock', label: 'Lock changed', watch: 'renewal',
    detail: { updatedAt: '2026-09-16', lost: [], gained: ['clientUpdateProhibited'] },
  });
  assert.match(gainedOnly, /\. Gained clientUpdateProhibited/);

  const both = formatAlert({
    domain: 'a.com', kind: 'lock', label: 'Lock changed', watch: 'renewal',
    detail: { updatedAt: '2026-09-16', lost: ['client delete prohibited'], gained: ['clientUpdateProhibited'] },
  });
  assert.match(both, /Lost client delete prohibited; gained clientUpdateProhibited/);
});

test('the footer anchors the message to the time of the check', () => {
  const message = formatMessage(
    [{ domain: 'a.com', kind: 'registrar', label: 'Transferred', detail: {} }],
    { checkedAt: '2026-09-18T06:00:12Z', dashboardUrl: 'https://example.com/site/' },
  );
  assert.equal(
    message.split('\n').at(-1),
    'Checked 18 Sept 2026 at 06:00 UTC. Dashboard: https://example.com/site/',
  );
});

test('every alert type carries a date somewhere in its line', () => {
  const kinds = [
    { domain: 'a.com', kind: 'expires', label: 'Holder renewed', detail: { updatedAt: '2026-09-17', from: '2027-04-14', to: '2028-04-14', registrar: 'GoDaddy.com, LLC' } },
    { domain: 'b.com', kind: 'registrar', label: 'Transferred', detail: { updatedAt: '2026-09-17', from: 'X', to: 'Y' } },
    { domain: 'c.com', kind: 'nameservers', label: 'Nameservers changed', detail: { updatedAt: '2026-09-17', from: ['a.ns'], to: ['b.ns'] } },
    { domain: 'd.com', kind: 'lock', label: 'Lock changed', detail: { updatedAt: '2026-09-17', lost: ['client transfer prohibited'], gained: [] } },
    { domain: 'e.com', kind: 'dropping', label: 'Dropping', detail: { updatedAt: '2026-09-17', status: ['pendingDelete'], expires: '2026-10-05' } },
    { domain: 'f.com', kind: 'threshold', label: '30 days to expiry', watch: 'renewal', detail: { threshold: 30, expires: '2026-10-18', owner: 'fabrik' } },
  ];
  for (const alert of kinds) {
    const line = formatAlert(alert, NOW);
    assert.match(line, /\d{1,2} [A-Z][a-z]{2,4} 20\d{2}/, `no date in: ${line}`);
  }
});
