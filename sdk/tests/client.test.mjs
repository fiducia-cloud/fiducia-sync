// Client tests run against the REAL Rust reconcile core (node-target wasm), so
// there is one source of truth for the sync logic. Build it first:
//   npm run build:wasm  (bundler) ; for these tests: wasm-pack build --target nodejs --out-dir pkg-node -- --features wasm
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as wasm from "../../pkg-node/fiducia_sync_core.js";
import { openStore, makeQueue } from "../src/store.mjs";
import { wrapCore } from "../src/core.mjs";
import { makeSyncClient } from "../src/client.mjs";

const core = wrapCore(wasm);
let n = 0;
async function setup() {
  n += 1;
  const store = await openStore(`client-test-${n}`, ["api_keys"]);
  const queue = makeQueue(store);
  const client = makeSyncClient({ store, queue, core });
  return { store, queue, client };
}

const change = (over) => ({ table: "api_keys", op: "upsert", id: "k1", version: 1, row: { name: "a" }, at_ms: 0, ...over });

test("applyChange applies a newer server change (clean) and ignores a stale one", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());

  assert.equal(await client.applyChange(change({ version: 1, row: { name: "a" } })), "applied");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "a" });
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 1, dirty: false });

  assert.equal(await client.applyChange(change({ version: 1, row: { name: "b" } })), "ignored"); // already-applied
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "a" });
});

test("optimisticWrite is instant + dirty, then adopts the committed version on ack", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "a" }, { version: 2, dirty: false });
  const send = async () => ({ id: "k1", committed_version: 3 });

  const res = await client.optimisticWrite("api_keys", "k1", { name: "b" }, send);
  assert.equal(res.status, "acked");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "b" }); // optimistic value kept
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 3, dirty: false }); // adopted + clean
  assert.equal((await queue.list()).length, 0); // dequeued
});

test("optimisticWrite stays queued + dirty when the send fails (offline)", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "a" }, { version: 2, dirty: false });
  const send = async () => {
    throw new Error("offline");
  };

  const res = await client.optimisticWrite("api_keys", "k1", { name: "b" }, send);
  assert.equal(res.status, "queued");
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 2, dirty: true }); // awaiting retry
  assert.equal((await queue.list()).length, 1);
});

test("the echo of our own write is adopted, not flagged as a conflict", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  // We made an optimistic write on top of version 2 (still dirty + queued).
  await store.put("api_keys", "k1", { name: "b" }, { version: 2, dirty: true });
  await queue.enqueue({ id: "k1", table: "api_keys", op: "upsert", payload: { name: "b" }, base_version: 2 });

  // The realtime echo of our own commit arrives at version 3 (= base + 1).
  const r = await client.applyChange(change({ version: 3, row: { name: "b" } }));
  assert.equal(r, "echo-adopted");
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 3, dirty: false });
  assert.equal((await queue.list()).length, 0);
});

test("a genuine conflict (someone else's newer change) resolves server-wins and drops the stale queued write", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "mine" }, { version: 2, dirty: true });
  await queue.enqueue({ id: "k1", table: "api_keys", op: "upsert", payload: { name: "mine" }, base_version: 2 });

  // Not our echo (that would be version 3) — a third party committed version 5.
  const r = await client.applyChange(change({ version: 5, row: { name: "theirs" } }));
  assert.equal(r, "conflict-resolved");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "theirs" }); // server wins
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 5, dirty: false });
  assert.equal((await queue.list()).length, 0); // stale queued write dropped
});
