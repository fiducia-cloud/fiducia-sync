// Hardening tests for the JSONB deep-merge: prototype-pollution resistance (the
// lodash CVE-2019-10744 class), recursion-depth safety (DoS), and the documented
// semantics (null sets vs RFC 7386 delete; arrays/opaque objects replace). Pure —
// deepMerge has no IO — plus one end-to-end check that a hostile patch can't
// pollute through the optimistic-write path.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as wasm from "../../pkg-node/fiducia_sync_core.js";
import { deepMerge } from "../src/merge.mjs";
import { openStore, makeQueue } from "../src/store.mjs";
import { wrapCore } from "../src/core.mjs";
import { makeSyncClient } from "../src/client.mjs";

// ── Prototype pollution ─────────────────────────────────────────────────────
test("a __proto__ patch key cannot pollute the global prototype or the result", () => {
  // JSON.parse makes __proto__ an OWN enumerable key — the exact vector.
  const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"real":1}');
  const out = deepMerge({ keep: true }, hostile);
  assert.equal({}.polluted, undefined, "global Object.prototype must be untouched");
  assert.equal(out.polluted, undefined, "the merged object must not inherit the injected key");
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "result keeps a clean prototype");
  assert.deepEqual(out, { keep: true, real: 1 }, "only the safe key is merged");
});

test("a constructor.prototype patch cannot pollute the global prototype", () => {
  const hostile = JSON.parse('{"constructor":{"prototype":{"polluted":"yes"}}}');
  deepMerge({}, hostile);
  assert.equal({}.polluted, undefined, "constructor.prototype route is blocked");
  assert.equal(({}).constructor, Object, "Object.constructor is intact");
});

test("a NESTED __proto__ patch key is skipped too", () => {
  const hostile = JSON.parse('{"params":{"__proto__":{"polluted":"yes"},"ok":1}}');
  const out = deepMerge({ params: { existing: true } }, hostile);
  assert.equal({}.polluted, undefined);
  assert.equal(out.params.polluted, undefined);
  assert.deepEqual(out, { params: { existing: true, ok: 1 } });
});

// ── Recursion depth (DoS) ───────────────────────────────────────────────────
test("a pathologically deep patch does not overflow the stack", () => {
  let deep = {};
  let cur = deep;
  for (let i = 0; i < 50_000; i += 1) {
    cur.n = {};
    cur = cur.n;
  }
  // Must return (bounded recursion), not throw a RangeError.
  assert.doesNotThrow(() => deepMerge({ a: 1 }, deep));
  assert.doesNotThrow(() => deepMerge(deep, deep));
});

test("merges below the depth cap still recurse fully", () => {
  assert.deepEqual(
    deepMerge({ a: { b: { c: { d: 1, keep: 1 } } } }, { a: { b: { c: { d: 2 } } } }),
    { a: { b: { c: { d: 2, keep: 1 } } } },
  );
});

// ── Documented semantics ────────────────────────────────────────────────────
test("null SETS the field to null (deliberate divergence from RFC 7386 delete)", () => {
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { b: null }), { a: 1, b: null });
});

test("undefined is skipped; arrays and opaque objects replace (not merge)", () => {
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined, b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(deepMerge({ t: [1, 2, 3] }, { t: [9] }), { t: [9] });
  const d = new Date(1000);
  assert.equal(deepMerge({ when: new Date(0) }, { when: d }).when, d);
});

test("deepMerge is pure and does not mutate either argument", () => {
  const base = { params: { a: 1 } };
  const patch = { params: { b: 2 } };
  const out = deepMerge(base, patch);
  assert.deepEqual(base, { params: { a: 1 } });
  assert.deepEqual(patch, { params: { b: 2 } });
  out.params.a = 99;
  assert.equal(base.params.a, 1);
});

// ── End-to-end: a hostile patch through the sync client is inert ─────────────
const core = wrapCore(wasm);
let n = 0;
test("optimisticPatch with a hostile __proto__ key stores an un-polluted row", async (t) => {
  n += 1;
  const store = await openStore(`hardening-${n}`, ["infra_operations"]);
  const queue = makeQueue(store);
  const client = makeSyncClient({ store, queue, core });
  t.after(() => store.close());

  await store.put("infra_operations", "op1", { id: "op1", params: { a: 1 } }, { version: 2, dirty: false });
  const hostile = JSON.parse('{"params":{"__proto__":{"polluted":"yes"},"b":2}}');
  await client.optimisticPatch("infra_operations", "op1", hostile, async () => ({
    id: "op1",
    committed_version: 3,
  }));

  const row = await store.get("infra_operations", "op1");
  assert.equal({}.polluted, undefined, "no global pollution via the sync path");
  assert.equal(row.params.polluted, undefined);
  assert.deepEqual(row, { id: "op1", params: { a: 1, b: 2 } }, "siblings kept, hostile key dropped");
});
