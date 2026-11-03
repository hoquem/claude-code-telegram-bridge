import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFallbackLookup, parseFallbackIps, SEED_FALLBACK_IPS } from "../dns-fallback.mjs";

const dnsError = (code = "ENOTFOUND") => Object.assign(new Error(`getaddrinfo ${code} api.telegram.org`), { code });

// Fake resolver: answers from a queue of results, records calls.
function fakeLookup(results) {
  const calls = [];
  const fn = (hostname, options, cb) => {
    calls.push({ hostname, options });
    const r = results.shift();
    if (r instanceof Error) return cb(r);
    if (Array.isArray(r)) return cb(null, r);
    return cb(null, r, 4);
  };
  fn.calls = calls;
  return fn;
}

const call = (lookup, host, options = { family: 4 }) =>
  new Promise((resolve) => lookup(host, options, (err, address, family) => resolve({ err, address, family })));

test("passes a successful lookup through unchanged", async () => {
  const lookup = makeFallbackLookup({ lookup: fakeLookup(["149.154.166.1"]) });
  const r = await call(lookup, "api.telegram.org");
  assert.equal(r.err, null);
  assert.equal(r.address, "149.154.166.1");
  assert.equal(r.family, 4);
});

test("serves a seed IP on ENOTFOUND when nothing has resolved yet", async () => {
  const seen = [];
  const lookup = makeFallbackLookup({ lookup: fakeLookup([dnsError()]), onFallback: (e) => seen.push(e) });
  const r = await call(lookup, "api.telegram.org");
  assert.equal(r.err, null);
  assert.ok(SEED_FALLBACK_IPS.includes(r.address));
  assert.equal(seen[0].source, "seed");
  assert.equal(seen[0].code, "ENOTFOUND");
});

test("prefers the last-known-good IP over seeds", async () => {
  const lookup = makeFallbackLookup({ lookup: fakeLookup(["149.154.167.99", dnsError("EAI_AGAIN")]) });
  await call(lookup, "api.telegram.org");
  const r = await call(lookup, "api.telegram.org");
  assert.equal(r.address, "149.154.167.99");
});

test("rotates seeds across failures so one dead seed can't pin us", async () => {
  const lookup = makeFallbackLookup({ fallbackIps: ["1.1.1.1", "2.2.2.2"], lookup: fakeLookup([dnsError(), dnsError()]) });
  const a = await call(lookup, "api.telegram.org");
  const b = await call(lookup, "api.telegram.org");
  assert.notEqual(a.address, b.address);
});

test("answers in array form when the caller asks for all: true", async () => {
  const lookup = makeFallbackLookup({ lookup: fakeLookup([dnsError()]) });
  const r = await call(lookup, "api.telegram.org", { family: 4, all: true });
  assert.equal(r.err, null);
  assert.deepEqual(r.address, [{ address: r.address[0].address, family: 4 }]);
});

test("learns last-known-good from an all: true answer", async () => {
  const lookup = makeFallbackLookup({
    lookup: fakeLookup([[{ address: "::1", family: 6 }, { address: "149.154.166.7", family: 4 }]]),
  });
  await call(lookup, "api.telegram.org", { all: true });
  assert.equal(lookup.getLastGood(), "149.154.166.7");
});

test("does not touch other hostnames", async () => {
  const lookup = makeFallbackLookup({ lookup: fakeLookup([dnsError()]) });
  const r = await call(lookup, "github.com");
  assert.equal(r.err.code, "ENOTFOUND");
});

test("propagates non-DNS errors", async () => {
  const lookup = makeFallbackLookup({ lookup: fakeLookup([Object.assign(new Error("bad"), { code: "ERR_INVALID_ARG_TYPE" })]) });
  const r = await call(lookup, "api.telegram.org");
  assert.equal(r.err.code, "ERR_INVALID_ARG_TYPE");
});

test("returns the original error when there are no fallbacks", async () => {
  const lookup = makeFallbackLookup({ fallbackIps: [], lookup: fakeLookup([dnsError()]) });
  const r = await call(lookup, "api.telegram.org");
  assert.equal(r.err.code, "ENOTFOUND");
});

test("accepts the (hostname, callback) and (hostname, family, callback) forms", async () => {
  const lookup = makeFallbackLookup({ lookup: fakeLookup([dnsError(), dnsError()]) });
  const a = await new Promise((res) => lookup("api.telegram.org", (err, address) => res({ err, address })));
  const b = await new Promise((res) => lookup("api.telegram.org", 4, (err, address) => res({ err, address })));
  assert.equal(a.err, null);
  assert.equal(b.err, null);
});

test("parseFallbackIps keeps valid unique IPv4s only", () => {
  assert.deepEqual(parseFallbackIps("149.154.166.110, 149.154.166.110 bogus ::1,10.0.0.1"), ["149.154.166.110", "10.0.0.1"]);
  assert.deepEqual(parseFallbackIps(""), []);
  assert.deepEqual(parseFallbackIps(undefined), []);
});
