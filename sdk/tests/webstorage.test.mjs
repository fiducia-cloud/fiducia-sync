// Web-Storage fallback store: the SAME client scenario battery must produce
// identical outcomes over the IndexedDB store (fake-indexeddb) and the
// localStorage-shaped store — settlement semantics are a contract, not an
// implementation detail. Plus webstorage-specific durability/corruption cases.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as wasm from "../../pkg-node/fiducia_sync_core.js";
import { openStore, makeQueue } from "../src/store.mjs";
import { openWebStorageStore, makeWebStorageQueue } from "../src/webstorage.mjs";
import { wrapCore } from "../src/core.mjs";
import { makeSyncClient } from "../src/client.mjs";

const core = wrapCore(wasm);

/** Minimal Storage impl (node has no localStorage). */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

let n = 0;
async function bothBackends() {
  n += 1;
  const idbStore = await openStore(`ws-contract-${n}`, ["api_keys"], { now: () => 42 });
  const storage = memoryStorage();
  const webStore = await openWebStorageStore(`ws-contract-${n}`, ["api_keys"], {
    storage,
    now: () => 42,
  });
  return [
    { label: "indexeddb", store: idbStore, queue: makeQueue(idbStore) },
    { label: "webstorage", store: webStore, queue: makeWebStorageQueue(webStore), storage },
  ];
}

const change = (over) => ({
  table: "api_keys",
  op: "upsert",
  id: "k1",
  version: 1,
  row: { name: "a" },
  at_ms: 0,
  ...over,
});

test("contract: optimistic write → ack settles identically on both backends", async (t) => {
  for (const { label, store, queue } of await bothBackends()) {
    t.after(() => store.close());
    const client = makeSyncClient({ store, queue, core, now: () => 42 });
    const result = await client.optimisticWrite("api_keys", "k1", { name: "x" }, async (w) => ({
      id: w.id,
      committed_version: w.base_version + 1,
    }));
    assert.equal(result.status, "acked", label);
    assert.deepEqual(
      await store.meta("api_keys", "k1"),
      { version: 1, dirty: false, syncedAtMs: 42 },
      label,
    );
    assert.equal((await queue.list()).length, 0, label);
  }
});

test("contract: own keyed echo adopts server payload and drains the queue", async (t) => {
  for (const { label, store, queue } of await bothBackends()) {
    t.after(() => store.close());
    const client = makeSyncClient({ store, queue, core, now: () => 42 });
    await client.optimisticWrite("api_keys", "k1", { name: "mine" }, async () => {
      throw new Error("offline");
    });
    const [queued] = await queue.list();
    assert.equal(
      await client.applyChange(
        change({ version: 1, row: { name: "normalized" }, write_key: queued.key }),
      ),
      "echo-adopted",
      label,
    );
    assert.deepEqual(await store.get("api_keys", "k1"), { name: "normalized" }, label);
    assert.deepEqual(
      await store.meta("api_keys", "k1"),
      { version: 1, dirty: false, syncedAtMs: 42 },
      label,
    );
    assert.equal((await queue.list()).length, 0, label);
  }
});

test("contract: server-wins conflict adopts truth and drops stale writes", async (t) => {
  for (const { label, store, queue } of await bothBackends()) {
    t.after(() => store.close());
    const client = makeSyncClient({ store, queue, core, now: () => 42 });
    await client.optimisticWrite("api_keys", "k1", { name: "mine" }, async () => {
      throw new Error("offline");
    });
    assert.equal(
      await client.applyChange(change({ version: 7, row: { name: "theirs" } })),
      "conflict-resolved",
      label,
    );
    assert.deepEqual(await store.get("api_keys", "k1"), { name: "theirs" }, label);
    assert.equal((await queue.list()).length, 0, label);
  }
});

test("contract: an out-of-order older ack is superseded, never a downgrade", async (t) => {
  for (const { label, store, queue } of await bothBackends()) {
    t.after(() => store.close());
    const client = makeSyncClient({ store, queue, core, now: () => 42 });
    const offline = async () => {
      throw new Error("offline");
    };
    await client.optimisticWrite("api_keys", "k1", { name: "first" }, offline);
    await client.optimisticWrite("api_keys", "k1", { name: "second" }, offline);
    const [first, second] = await queue.list();

    // The NEWER write's ack lands first and is adopted (row still dirty: the
    // older write is pending and got its superseded_version stamped)...
    assert.deepEqual(await queue.settleAck("api_keys", "k1", second.seq, 2), { Adopt: 2 }, label);
    assert.equal((await store.meta("api_keys", "k1")).dirty, true, label);
    assert.equal((await queue.list())[0].superseded_version, 2, label);

    // ...so the OLDER write's late ack cannot downgrade the committed version.
    assert.equal(await queue.settleAck("api_keys", "k1", first.seq, 1), "Superseded", label);
    assert.deepEqual(
      await store.meta("api_keys", "k1"),
      { version: 2, dirty: false, syncedAtMs: 42 },
      label,
    );
    assert.equal((await queue.list()).length, 0, label);
  }
});

test("contract: cursors, syncInfo, markSynced, and HLC state round-trip", async (t) => {
  for (const { label, store } of await bothBackends()) {
    t.after(() => store.close());
    assert.equal(await store.getCursor(), 0, label);
    await store.setCursor(9);
    await assert.rejects(store.setCursor(3), /cannot move backwards/, label);
    assert.deepEqual(await store.syncInfo(), { cursor: 9, lastSyncedAtMs: 42 }, label);
    await store.markSynced();
    assert.deepEqual(await store.syncInfo(), { cursor: 9, lastSyncedAtMs: 42 }, label);
    assert.equal(await store.getHlcState(), null, label);
    await store.setHlcState({ wallMs: 123, counter: 4 });
    assert.deepEqual(await store.getHlcState(), { wallMs: 123, counter: 4 }, label);
  }
});

test("webstorage survives reload from the same storage and rejects corruption", async (t) => {
  const storage = memoryStorage();
  const first = await openWebStorageStore("ws-reload", ["api_keys"], { storage, now: () => 1 });
  await first.put("api_keys", "k1", { name: "kept" }, { version: 3, dirty: false });
  const firstQueue = makeWebStorageQueue(first);
  await firstQueue.enqueue({ id: "k1", table: "api_keys", op: "upsert", payload: {}, base_version: 3, key: "w-1" });
  first.close();
  await assert.rejects(first.get("api_keys", "k1"), /closed/);

  const second = await openWebStorageStore("ws-reload", ["api_keys"], { storage, now: () => 2 });
  t.after(() => second.close());
  assert.deepEqual(await second.get("api_keys", "k1"), { name: "kept" });
  const queue = makeWebStorageQueue(second);
  const [queued] = await queue.list();
  assert.equal(queued.key, "w-1");
  assert.equal(queued.seq, 1);

  storage.setItem("fiducia-sync:ws-corrupt", "{not json");
  const corrupt = await openWebStorageStore("ws-corrupt", ["api_keys"], { storage });
  t.after(() => corrupt.close());
  await assert.rejects(corrupt.get("api_keys", "k1"), /corrupt/);
});

test("webstorage seq allocation never reuses a sequence after removal", async (t) => {
  const storage = memoryStorage();
  const store = await openWebStorageStore("ws-seq", ["api_keys"], { storage });
  t.after(() => store.close());
  const queue = makeWebStorageQueue(store);
  const write = { id: "k1", table: "api_keys", op: "upsert", payload: {}, base_version: 0, key: "w" };
  const a = await queue.enqueue({ ...write, key: "w-a" });
  await queue.remove(a);
  const b = await queue.enqueue({ ...write, key: "w-b" });
  assert.ok(b > a, "sequences must stay monotonic like IndexedDB autoIncrement");
});
