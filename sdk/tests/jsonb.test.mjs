// JSONB coverage: the deepMerge semantics used to fold a partial optimistic write
// into the local row, plus end-to-end checks that a partial patch preserves
// sibling keys of a nested `jsonb` object (params/meta/scopes/preferences) through
// the sync client, and that reconcile/hydrate round-trip nested JSONB unchanged.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as wasm from "../../pkg-node/fiducia_sync_core.js";
import { deepMerge } from "../src/merge.mjs";
import { openStore, makeQueue } from "../src/store.mjs";
import { wrapCore } from "../src/core.mjs";
import { makeSyncClient } from "../src/client.mjs";

// ── deepMerge unit semantics ────────────────────────────────────────────────
test("deepMerge recurses plain objects and keeps sibling keys", () => {
  assert.deepEqual(
    deepMerge({ params: { a: 1, b: 2 }, name: "x" }, { params: { b: 3, c: 4 } }),
    { params: { a: 1, b: 3, c: 4 }, name: "x" },
  );
});

test("deepMerge replaces arrays wholesale (scopes are set, not concatenated)", () => {
  assert.deepEqual(deepMerge({ scopes: ["kv:read", "kv:write"] }, { scopes: ["kv:read"] }), {
    scopes: ["kv:read"],
  });
});

test("deepMerge: null clears, undefined is skipped", () => {
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { b: null }), { a: 1, b: null });
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { a: undefined, c: 3 }), { a: 1, b: 2, c: 3 });
});

test("deepMerge handles deep nesting and type transitions", () => {
  assert.deepEqual(
    deepMerge({ meta: { deep: { x: 1, keep: true } } }, { meta: { deep: { y: 2 } } }),
    { meta: { deep: { x: 1, keep: true, y: 2 } } },
  );
  assert.deepEqual(deepMerge({ a: { x: 1 } }, { a: 5 }), { a: 5 }); // object -> scalar
  assert.deepEqual(deepMerge({ a: 5 }, { a: { x: 1 } }), { a: { x: 1 } }); // scalar -> object
});

test("deepMerge is pure — neither input is mutated", () => {
  const base = { params: { a: 1 } };
  const patch = { params: { b: 2 } };
  const out = deepMerge(base, patch);
  assert.deepEqual(base, { params: { a: 1 } });
  assert.deepEqual(patch, { params: { b: 2 } });
  assert.deepEqual(out, { params: { a: 1, b: 2 } });
  out.params.a = 99;
  assert.equal(base.params.a, 1, "mutating the result must not reach back into base");
});

test("deepMerge: non-object base/patch degenerate sensibly", () => {
  assert.deepEqual(deepMerge(null, { a: 1 }), { a: 1 });
  assert.equal(deepMerge({ a: 1 }, null), null);
  assert.deepEqual(deepMerge(undefined, { a: 1 }), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
});

// ── end-to-end through the sync client ──────────────────────────────────────
const core = wrapCore(wasm);
let n = 0;
async function setup() {
  n += 1;
  const store = await openStore(`jsonb-test-${n}`, ["infra_operations"]);
  const queue = makeQueue(store);
  const client = makeSyncClient({ store, queue, core });
  return { store, queue, client };
}

test("optimisticPatch merges a partial jsonb patch into the stored row (siblings survive)", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());
  assert.equal(typeof client.optimisticPatch, "function", "client exposes optimisticPatch");

  // A row with a nested jsonb `params` object already in the store.
  await store.put(
    "infra_operations",
    "op1",
    { id: "op1", action: "scale", params: { target_nodes: 9, region: "iad1" } },
    { version: 3, dirty: false },
  );

  // Patch ONLY params.target_nodes (the shape an htmx form or a single-field edit
  // produces). params.region and the top-level action must survive locally.
  await client.optimisticPatch(
    "infra_operations",
    "op1",
    { params: { target_nodes: 12 } },
    async () => ({ id: "op1", committed_version: 4 }),
  );

  assert.deepEqual(await store.get("infra_operations", "op1"), {
    id: "op1",
    action: "scale",
    params: { target_nodes: 12, region: "iad1" },
  });
});

test("plain optimisticWrite still REPLACES the row (merge is opt-in via optimisticPatch)", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());

  await store.put(
    "infra_operations",
    "op1",
    { id: "op1", action: "scale", params: { target_nodes: 9, region: "iad1" } },
    { version: 3, dirty: false },
  );
  await client.optimisticWrite(
    "infra_operations",
    "op1",
    { id: "op1", params: { target_nodes: 12 } },
    async () => ({ id: "op1", committed_version: 4 }),
  );
  // Whole-row replacement: the un-sent fields are gone (caller owns full-row intent).
  assert.deepEqual(await store.get("infra_operations", "op1"), {
    id: "op1",
    params: { target_nodes: 12 },
  });
});

test("a patch sends the MERGED value (so the server's column-replace keeps sibling jsonb keys)", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put(
    "infra_operations",
    "op1",
    { id: "op1", params: { a: 1, b: 2 } },
    { version: 2, dirty: false },
  );
  await client.optimisticPatch(
    "infra_operations",
    "op1",
    { params: { b: 9 } },
    async () => {
      throw new Error("offline"); // keep it queued so we can inspect the payload
    },
  );
  const [queued] = await queue.list();
  // The backend COALESCEs the whole column, so it must receive the merged jsonb —
  // a bare {params:{b:9}} would drop params.a server-side and its echo would then
  // clobber our local merge. Client and server both end at {a:1,b:9}.
  assert.deepEqual(queued.payload, { id: "op1", params: { a: 1, b: 9 } });
  assert.deepEqual(await store.get("infra_operations", "op1"), { id: "op1", params: { a: 1, b: 9 } });
});

test("reconcile round-trips a nested jsonb row unchanged (server is authoritative whole-row)", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());

  const serverRow = { id: "op1", action: "scale", params: { target_nodes: 9, tags: ["a", "b"], nested: { x: 1 } } };
  assert.equal(
    await client.applyChange({ table: "infra_operations", op: "upsert", id: "op1", version: 5, row: serverRow, at_ms: 0 }),
    "applied",
  );
  assert.deepEqual(await store.get("infra_operations", "op1"), serverRow);

  // A newer server row REPLACES the whole jsonb (authoritative), not merges it.
  const replaced = { id: "op1", action: "scale", params: { region: "sfo1" } };
  await client.applyChange({ table: "infra_operations", op: "upsert", id: "op1", version: 6, row: replaced, at_ms: 0 });
  assert.deepEqual(await store.get("infra_operations", "op1"), replaced);
});
