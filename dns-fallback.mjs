/**
 * DNS fallback for api.telegram.org.
 *
 * macOS mDNSResponder can cache a negative answer for api.telegram.org and
 * keep serving it long after every upstream resolver answers correctly
 * (2026-10-06 → 10-14, 8 days down; recurred 2026-11-03). Polling then fails
 * with ENOTFOUND, the network-error watchdog exits, launchd respawns, and the
 * respawned process hits the same poisoned cache — a crash loop no restart
 * can fix. Only a manual cache flush (admin password) ended it.
 *
 * makeFallbackLookup() returns a drop-in for dns.lookup, passed to the HTTP
 * agent via `agentOptions.lookup`. Only the address resolution changes: the
 * request still targets https://api.telegram.org, so the Host header and TLS
 * SNI/certificate check are untouched and a wrong IP fails TLS loudly rather
 * than talking to the wrong server.
 *
 * Behaviour, for the fallback hostname only (everything else passes through):
 *   - system lookup succeeds → use it, and remember the IPv4 as last-known-good
 *   - system lookup fails with a DNS-class error → serve last-known-good, else
 *     the seed IPs (rotating per call, so a dead seed doesn't pin us to it)
 *   - non-DNS errors propagate unchanged
 *
 * The seeds are Telegram's published Bot API front ends in 149.154.160.0/20
 * (same list Hermes uses); override with TELEGRAM_FALLBACK_IPS.
 */

import dns from "node:dns";
import { isIPv4 } from "node:net";

export const FALLBACK_HOSTNAME = "api.telegram.org";
export const SEED_FALLBACK_IPS = ["149.154.166.110", "149.154.167.220"];

// Errors meaning "the resolver gave no usable answer", as opposed to e.g. a
// bad argument. ESERVFAIL/ETIMEOUT come from c-ares paths; harmless to include.
export const DNS_FAILURE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "ENODATA",
  "ESERVFAIL",
  "ETIMEOUT",
]);

/**
 * Parse a comma- or space-separated IPv4 list.
 *
 * :param value: Raw string, typically ``TELEGRAM_FALLBACK_IPS``.
 * :returns: Unique valid IPv4 addresses; invalid entries are dropped.
 */
export function parseFallbackIps(value) {
  if (!value) return [];
  return [...new Set(String(value).split(/[\s,]+/).filter((ip) => isIPv4(ip)))];
}

/**
 * Build a ``dns.lookup``-compatible resolver with an IPv4 fallback.
 *
 * :param fallbackIps: Seed IPv4s, used when no lookup has succeeded yet.
 * :param hostname: The one host to protect; all others pass straight through.
 * :param lookup: Underlying resolver (``dns.lookup``; injectable for tests).
 * :param onFallback: Called with ``{hostname, ip, source, code}`` each time a
 *   fallback address is served, so the caller can log it.
 * :returns: The lookup function. ``getLastGood()`` exposes the remembered IP.
 */
export function makeFallbackLookup({
  fallbackIps = SEED_FALLBACK_IPS,
  hostname: protectedHost = FALLBACK_HOSTNAME,
  lookup = dns.lookup,
  onFallback = () => {},
} = {}) {
  const seeds = fallbackIps.filter((ip) => isIPv4(ip));
  let lastGood = null;
  let rotation = 0;

  function fallbackLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if (typeof options === "number") {
      options = { family: options };
    }
    options = options || {};

    if (String(hostname).toLowerCase() !== protectedHost) {
      return lookup(hostname, options, callback);
    }

    lookup(hostname, options, (err, address, family) => {
      if (!err) {
        const first = Array.isArray(address) ? address.find((a) => a.family === 4)?.address : family === 4 ? address : null;
        if (first) lastGood = first;
        return callback(null, address, family);
      }
      if (!DNS_FAILURE_CODES.has(err.code)) return callback(err);

      let ip, source;
      if (lastGood) {
        ip = lastGood;
        source = "last-known-good";
      } else if (seeds.length) {
        ip = seeds[rotation++ % seeds.length];
        source = "seed";
      } else {
        return callback(err);
      }
      onFallback({ hostname, ip, source, code: err.code });

      // We only hold IPv4 answers; an IPv6-only request can't be served.
      if (options.family === 6) return callback(err);
      if (options.all) return callback(null, [{ address: ip, family: 4 }]);
      return callback(null, ip, 4);
    });
  }

  fallbackLookup.getLastGood = () => lastGood;
  return fallbackLookup;
}
