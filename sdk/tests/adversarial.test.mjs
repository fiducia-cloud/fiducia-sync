// Adversarial / edge-case tests for the reconcile client, against the REAL wasm
// core. These probe the corners of the hardened echo + queue logic: version
// monotonicity, own-echo vs third-party collisions at base+1, multi-write
// convergence, and hydrate/queue interaction. Written to assert the CONVERGENT
// (server-authoritative) outcome, so a failure here flags a real divergence.
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
  const store = await openStore(`adv-test-${n}`, ["api_keys"]);
  const queue = makeQueue(store);
  const client = makeSyncClient({ store, queue, core });
  return { store, queue, client };
}
const change = (over) => ({ table: "api_keys", op: "upsert", id: "k1", version: 1, row: { name: "a" }, at_ms: 0, ...over });

test("a duplicate own-echo after the queue drained never downgrades the version", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "mine" }, { version: 2, dirty: true });
  await queue.enqueue({ id: "k1", table: "api_keys", op: "upsert", payload: { name: "mine" }, base_version: 2 });

  // First echo (v3) adopts + drains the queue.
  assert.equal(await client.applyChange(change({ version: 3, row: { name: "mine" } })), "echo-adopted");
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 3, dirty: false });

  // A newer server change lands (v7), then the transport redelivers the STALE v3
  // echo. It must be ignored, not downgrade the row back to v3.
  assert.equal(await client.applyChange(change({ version: 7, row: { name: "seven" } })), "applied");
  const r = await client.applyChange(change({ version: 3, row: { name: "mine" } }));
  assert.equal(r, "ignored", "stale duplicate echo (queue empty) reconciles as stale");
  assert.equal((await store.meta("api_keys", "k1")).version, 7, "version stays monotonic (>=7)");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "seven" });
});

test("two optimistic writes to the same row before either acks converge to server truth", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "v2" }, { version: 2, dirty: false });
  // Both edits are based on v2 (neither acked yet), both sent; server commits them
  // in order → v3 then v4. Simulate the acks arriving via optimisticWrite.
  let committed = 2;
  const send = async () => ({ id: "k1", committed_version: ++committed });
  const r1 = await client.optimisticWrite("api_keys", "k1", { name: "edit-1" }, send);
  const r2 = await client.optimisticWrite("api_keys", "k1", { name: "edit-2" }, send);
  assert.equal(r1.status, "acked");
  assert.equal(r2.status, "acked");
  // Latest optimistic value wins locally; version is the last committed; clean; queue empty.
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "edit-2" });
  assert.equal((await store.meta("api_keys", "k1")).dirty, false);
  assert.equal((await queue.list()).length, 0);
});

test("hydrate that includes the committed version of a queued write dequeues it (no stuck dirty)", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  // An un-acked optimistic edit on top of v2 (queued + dirty).
  await store.put("api_keys", "k1", { id: "k1", name: "mine" }, { version: 2, dirty: true });
  await queue.enqueue({ id: "k1", table: "api_keys", op: "upsert", payload: { name: "mine" }, base_version: 2 });

  // Catch-up snapshot carries the committed row at v3 (= our base+1): hydrate feeds
  // it through applyChange, which should recognize the echo and drain the queue.
  const res = await client.hydrate("api_keys", [{ id: "k1", version: 3, name: "mine" }], { prune: true });
  assert.equal(res.applied, 1);
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 3, dirty: false });
  assert.equal((await queue.list()).length, 0, "the queued write was adopted, not left stuck");
});

test("a THIRD-PARTY change landing at our base+1 must not leave local showing our un-committed content", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  // Our optimistic edit on v2, whose SEND FAILED — so it never committed; it sits
  // queued (base_version 2, expected echo v3) with our local content.
  await store.put("api_keys", "k1", { name: "v2" }, { version: 2, dirty: false });
  const res = await client.optimisticWrite("api_keys", "k1", { name: "mine-uncommitted" }, async () => {
    throw new Error("offline");
  });
  assert.equal(res.status, "queued");

  // A DIFFERENT client commits v3 (also based on v2) with different content. Its
  // change arrives over the transport. isOwnEcho matches on id + version==base+1,
  // so it can be mistaken for our echo — but the CONVERGENT outcome is that local
  // reflects the server's v3 content, never our un-committed edit.
  await client.applyChange(change({ version: 3, row: { name: "theirs" } }));
  assert.deepEqual(
    await store.get("api_keys", "k1"),
    { name: "theirs" },
    "local must converge to the server's v3 content, not keep our un-committed edit",
  );
  assert.equal((await store.meta("api_keys", "k1")).version, 3);
});

test("openStore adds a new table to an existing database without losing prior data", async (t) => {
  const dbName = `adv-upgrade-${n++}`;
  const s1 = await openStore(dbName, ["api_keys"]);
  await s1.put("api_keys", "k1", { name: "persisted" }, { version: 5, dirty: false });
  s1.close();

  // Re-open the SAME database declaring an additional synced table. The store must
  // upgrade the schema (new object store) while preserving the existing rows.
  const s2 = await openStore(dbName, ["api_keys", "projects"]);
  t.after(() => s2.close());
  assert.deepEqual(await s2.get("api_keys", "k1"), { name: "persisted" }, "existing data survives the upgrade");
  await s2.put("projects", "p1", { name: "proj" }, { version: 1, dirty: false });
  assert.deepEqual(await s2.get("projects", "p1"), { name: "proj" }, "the new store is usable");
});
