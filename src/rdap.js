// RDAP fetching and parsing. No dependencies, Node 20 built-in fetch.

const USER_AGENT = 'fabrik-domain-monitor/1.0';
const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

const KNOWN_SERVERS = {
  com: 'https://rdap.verisign.com/com/v1/',
  uk: 'https://rdap.nominet.uk/uk/',
};

// Cached for the lifetime of the process, so one run makes at most one bootstrap request.
let bootstrapPromise = null;

/** Returns the registry suffix we route on: "co.uk" and "uk" both route as "uk". */
export function tldOf(domain) {
  const labels = domain.toLowerCase().split('.');
  return labels[labels.length - 1];
}

async function loadBootstrap(fetchImpl) {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const res = await fetchImpl(IANA_BOOTSTRAP_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`IANA bootstrap returned HTTP ${res.status}`);
      const body = await res.json();
      const index = new Map();
      for (const [tlds, urls] of body.services ?? []) {
        const base = urls.find((u) => u.startsWith('https://')) ?? urls[0];
        if (!base) continue;
        for (const tld of tlds) index.set(tld.toLowerCase(), base);
      }
      return index;
    })();
  }
  return bootstrapPromise;
}

/** Only used by the tests, so a stubbed bootstrap does not leak between cases. */
export function resetBootstrapCache() {
  bootstrapPromise = null;
}

/**
 * Works out the RDAP query URL for a domain.
 * .com and .uk are hard coded, everything else comes from the IANA bootstrap file.
 */
export async function rdapUrlFor(domain, fetchImpl = fetch) {
  const name = domain.toLowerCase();
  const tld = tldOf(name);
  let base = KNOWN_SERVERS[tld];
  if (!base) {
    const index = await loadBootstrap(fetchImpl);
    base = index.get(tld);
  }
  if (!base) {
    throw new Error(`No RDAP server known for .${tld} (domain ${name})`);
  }
  if (!base.endsWith('/')) base += '/';
  return `${base}domain/${name}`;
}

function isoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function eventDate(events, action) {
  const match = (events ?? []).find(
    (e) => typeof e?.eventAction === 'string' && e.eventAction.toLowerCase() === action,
  );
  return isoDate(match?.eventDate);
}

/** Pulls "fn" out of a vCard array, which is the registrar's display name. */
function vcardFullName(entity) {
  const fields = entity?.vcardArray?.[1];
  if (!Array.isArray(fields)) return null;
  const fn = fields.find((f) => Array.isArray(f) && f[0] === 'fn');
  const value = fn?.[3];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function findRegistrar(entities) {
  for (const entity of entities ?? []) {
    const roles = (entity?.roles ?? []).map((r) => String(r).toLowerCase());
    if (roles.includes('registrar')) {
      // Nominet sometimes omits the vCard, so fall back to the handle.
      return vcardFullName(entity) ?? (entity.handle ? String(entity.handle) : null);
    }
  }
  return null;
}

/**
 * Turns an RDAP domain response into the flat record we store.
 * Nameservers lose their trailing dot and are lowercased and sorted, so a
 * registry reordering them does not read as a change.
 */
export function parseRdap(body, domain) {
  const nameservers = (body?.nameservers ?? [])
    .map((ns) => (typeof ns?.ldhName === 'string' ? ns.ldhName : ''))
    .filter(Boolean)
    .map((name) => name.toLowerCase().replace(/\.$/, ''))
    .sort();

  const status = (body?.status ?? [])
    .map((s) => String(s))
    .sort();

  return {
    domain: (body?.ldhName ? String(body.ldhName) : domain).toLowerCase().replace(/\.$/, ''),
    registrar: findRegistrar(body?.entities),
    created: eventDate(body?.events, 'registration'),
    updated: eventDate(body?.events, 'last changed'),
    expires: eventDate(body?.events, 'expiration'),
    nameservers,
    status,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches one domain. Retries up to three times on 429 and 5xx with a growing
 * backoff. A 404 is not an error: the domain is simply absent from the registry.
 */
export async function fetchDomain(domain, { fetchImpl = fetch, retries = 3, baseDelay = 1000 } = {}) {
  const name = domain.toLowerCase();
  const url = await rdapUrlFor(name, fetchImpl);
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/rdap+json, application/json' },
      });

      if (res.status === 404) {
        return { notFound: true, url, record: null };
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
      } else if (!res.ok) {
        // 4xx other than 404 will not improve on a retry.
        throw new Error(`HTTP ${res.status} from ${url}`);
      } else {
        return { notFound: false, url, record: parseRdap(await res.json(), name) };
      }
    } catch (err) {
      lastError = err;
    }

    if (attempt < retries) await sleep(baseDelay * attempt);
  }

  throw lastError ?? new Error(`RDAP lookup failed for ${name}`);
}

export { USER_AGENT, IANA_BOOTSTRAP_URL };
