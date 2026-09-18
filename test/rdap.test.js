import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRdap, rdapUrlFor, tldOf, resetBootstrapCache } from '../src/rdap.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('parses a Verisign .com response', () => {
  const record = parseRdap(fixture('verisign-fabrikagency.com.json'), 'fabrikagency.com');

  assert.equal(record.domain, 'fabrikagency.com');
  assert.equal(record.registrar, 'GoDaddy.com, LLC');
  assert.equal(record.created, '2008-04-14');
  assert.equal(record.expires, '2027-04-14');
  assert.equal(record.updated, '2026-04-15');
  assert.deepEqual(record.nameservers, [
    'ns1.domain-is-4-sale-at-domainmarket.com',
    'ns2.domainmarket.com',
  ]);
  assert.deepEqual(record.status, [
    'client delete prohibited',
    'client renew prohibited',
    'client transfer prohibited',
    'client update prohibited',
  ]);
});

test('parses a Nominet .co.uk response', () => {
  const record = parseRdap(fixture('nominet-fabrik.co.uk.json'), 'fabrik.co.uk');

  assert.equal(record.domain, 'fabrik.co.uk');
  assert.equal(record.registrar, 'Behrendt Professional Corporation t/a Amazing Domains');
  assert.equal(record.created, '2015-12-21');
  assert.equal(record.expires, '2026-12-21');
  assert.deepEqual(record.status, ['active']);
});

test('strips the trailing dot Nominet puts on nameservers', () => {
  const record = parseRdap(fixture('nominet-fabrik.co.uk.json'), 'fabrik.co.uk');
  assert.ok(record.nameservers.length > 0);
  for (const ns of record.nameservers) {
    assert.ok(!ns.endsWith('.'), `${ns} still has a trailing dot`);
  }
  assert.equal(record.nameservers[0], 'freedns1.registrar-servers.com');
});

test('nameservers come back lowercased and sorted', () => {
  const record = parseRdap(
    {
      ldhName: 'EXAMPLE.COM',
      nameservers: [{ ldhName: 'NS2.Example.Net.' }, { ldhName: 'ns1.EXAMPLE.net' }],
      events: [],
    },
    'example.com',
  );
  assert.deepEqual(record.nameservers, ['ns1.example.net', 'ns2.example.net']);
  assert.equal(record.domain, 'example.com');
});

test('falls back to the entity handle when the registrar vCard is missing', () => {
  const record = parseRdap(
    { ldhName: 'example.co.uk', entities: [{ roles: ['registrar'], handle: 'BPC-CA' }] },
    'example.co.uk',
  );
  assert.equal(record.registrar, 'BPC-CA');
});

test('missing fields come back as null or empty rather than throwing', () => {
  const record = parseRdap({}, 'nothing.example');
  assert.equal(record.domain, 'nothing.example');
  assert.equal(record.registrar, null);
  assert.equal(record.expires, null);
  assert.deepEqual(record.nameservers, []);
  assert.deepEqual(record.status, []);
});

test('tldOf treats co.uk as uk', () => {
  assert.equal(tldOf('fabrik.co.uk'), 'uk');
  assert.equal(tldOf('fabrik.uk'), 'uk');
  assert.equal(tldOf('fabrik.com'), 'com');
});

test('routes .com and .uk without touching the IANA bootstrap', async () => {
  const fail = () => {
    throw new Error('bootstrap should not have been fetched');
  };
  assert.equal(
    await rdapUrlFor('FabrikAgency.com', fail),
    'https://rdap.verisign.com/com/v1/domain/fabrikagency.com',
  );
  assert.equal(
    await rdapUrlFor('fabrik.co.uk', fail),
    'https://rdap.nominet.uk/uk/domain/fabrik.co.uk',
  );
});

test('routes an unknown TLD through the IANA bootstrap', async () => {
  resetBootstrapCache();
  let calls = 0;
  const stub = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        services: [[['ae'], ['https://rdap.example-registry.ae/rdap/']]],
      }),
    };
  };

  assert.equal(
    await rdapUrlFor('fabrik.ae', stub),
    'https://rdap.example-registry.ae/rdap/domain/fabrik.ae',
  );
  // Second lookup reuses the cached index.
  await rdapUrlFor('other.ae', stub);
  assert.equal(calls, 1);
  resetBootstrapCache();
});

test('fails clearly when a TLD has no RDAP server', async () => {
  resetBootstrapCache();
  const stub = async () => ({ ok: true, status: 200, json: async () => ({ services: [] }) });
  await assert.rejects(() => rdapUrlFor('something.invalidtld', stub), /No RDAP server known/);
  resetBootstrapCache();
});
