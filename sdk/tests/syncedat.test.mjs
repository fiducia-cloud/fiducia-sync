// synced_at semantics: per-row syncedAtMs marks "server-authoritative state
// landed HERE", per-plane syncInfo marks the last completed catch-up. Dirty
// optimistic writes must preserve the row's previous stamp; every
// server-adoption path (apply, refresh, echo, ack, conflict) must stamp.
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
  let currentNow = 100;
  const now = () => currentNow;
  const advanceTo = (value) => {
    currentNow = value;
  };
  const store = await openStore(`syncedat-test-${n}`, ["api_keys"], { now });
  const queue = makeQueue(store);
  const client = makeSyncClient({ store, queue, core, now });
  return { store, queue, client, advanceTo };
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

test("applyChange stamps syncedAtMs; a later refresh re-stamps", async (t) => {
  const { store, client, advanceTo } = await setup();
  t.after(() => store.close());

  await client.applyChange(change({ version: 1 }));
  assert.equal((await store.meta("api_keys", "k1")).syncedAtMs, 100);

  advanceTo(250);
  await client.applyChange(change({ version: 1, row: { name: "normalized" } })); // refresh
  assert.equal((await store.meta("api_keys", "k1")).syncedAtMs, 250);
});

test("a dirty optimistic write PRESERVES the last synced stamp; the ack re-stamps", async (t) => {
  const { store, client, advanceTo } = await setup();
  t.after(() => store.close());

  await client.applyChange(change({ version: 1 }));
  advanceTo(300);
  const result = await client.optimisticWrite("api_keys", "k1", { name: "mine" }, async () => {
    throw new Error("offline");
  });
  assert.equal(result.status, "queued");
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 1,
    dirty: true,
    syncedAtMs: 100, // editing on top of synced state does not un-sync it
  });

  advanceTo(400);
  const flushed = await client.flushQueue(async (w) => ({
    id: w.id,
    committed_version: w.base_version + 1,
  }));
  assert.equal(flushed, 1);
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 2,
    dirty: false,
    syncedAtMs: 400, // the server confirmed this state now
  });
});

test("a never-synced local draft has syncedAtMs null until the server confirms", async (t) => {
  const { store, client, advanceTo } = await setup();
  t.after(() => store.close());

  await client.optimisticWrite("api_keys", "fresh", { name: "draft" }, async () => {
    throw new Error("offline");
  });
  assert.deepEqual(await store.meta("api_keys", "fresh"), {
    version: 0,
    dirty: true,
    syncedAtMs: null,
  });

  advanceTo(900);
  const [queued] = await (async () => makeQueue(store).list())();
  await client.applyChange(
    change({ id: "fresh", version: 1, row: { name: "draft" }, write_key: queued.key }),
  );
  assert.deepEqual(await store.meta("api_keys", "fresh"), {
    version: 1,
    dirty: false,
    syncedAtMs: 900,
  });
});

test("server-wins conflict resolution stamps the adopted truth", async (t) => {
  const { store, client, advanceTo } = await setup();
  t.after(() => store.close());

  await client.optimisticWrite("api_keys", "k1", { name: "mine" }, async () => {
    throw new Error("offline");
  });
  advanceTo(777);
  await client.applyChange(change({ version: 9, row: { name: "theirs" } }));
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 9,
    dirty: false,
    syncedAtMs: 777,
  });
});

test("plane-level syncInfo: cursor advances stamp; markSynced stamps without one", async (t) => {
  const { store, advanceTo } = await setup();
  t.after(() => store.close());

  assert.deepEqual(await store.syncInfo(), { cursor: 0, lastSyncedAtMs: null });
  advanceTo(500);
  await store.setCursor(12);
  assert.deepEqual(await store.syncInfo(), { cursor: 12, lastSyncedAtMs: 500 });

  advanceTo(600);
  await store.markSynced();
  assert.deepEqual(await store.syncInfo(), { cursor: 12, lastSyncedAtMs: 600 });

  // Scopes are independent.
  assert.deepEqual(await store.syncInfo("other"), { cursor: 0, lastSyncedAtMs: null });
});
