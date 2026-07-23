// Tests for the IndexedDB store + durable write-queue (store.mjs), run against
// fake-indexeddb so no browser is needed.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore, makeQueue } from "../src/store.mjs";

let dbCounter = 0;
async function freshStore(tables = ["api_keys"]) {
  dbCounter += 1;
  return openStore(`fiducia-test-${dbCounter}`, tables);
}

test("put/get/meta round-trips a row with its version + dirty flag", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());

  assert.equal(await store.get("api_keys", "k1"), null);
  assert.equal(await store.meta("api_keys", "k1"), null);

  await store.put("api_keys", "k1", { name: "prod" }, { version: 3, dirty: true });
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "prod" });
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 3, dirty: true });
});

test("replica lifecycle timestamps survive optimistic updates and advance on sync", async (t) => {
  const store = await freshStore();
  const queue = makeQueue(store);
  t.after(() => store.close());

  await store.put(
    "api_keys",
    "k1",
    { name: "server" },
    { version: 2, dirty: false },
  );
  const initial = await store.replicaMeta("api_keys", "k1");
  assert.ok(Number.isSafeInteger(initial.created_at_ms));
  assert.ok(Number.isSafeInteger(initial.updated_at_ms));
  assert.ok(Number.isSafeInteger(initial.synced_at_ms));

  const seq = await queue.enqueueOptimistic(
    {
      id: "k1",
      table: "api_keys",
      op: "upsert",
      payload: { name: "local" },
      base_version: 2,
    },
    { name: "local" },
  );
  const dirty = await store.replicaMeta("api_keys", "k1");
  assert.equal(dirty.created_at_ms, initial.created_at_ms);
  assert.equal(dirty.synced_at_ms, initial.synced_at_ms);
  assert.equal(dirty.dirty, true);
  assert.ok(dirty.updated_at_ms >= initial.updated_at_ms);

  await queue.settleAck("api_keys", "k1", seq, 3);
  const synced = await store.replicaMeta("api_keys", "k1");
  assert.equal(synced.version, 3);
  assert.equal(synced.dirty, false);
  assert.ok(synced.synced_at_ms >= initial.synced_at_ms);
});

test("setMeta adopts a new version and clears dirty; del removes", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "prod" }, { version: 3, dirty: true });
  assert.equal(await store.setMeta("api_keys", "k1", { version: 4, dirty: false }), true);
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 4, dirty: false });
  assert.equal(await store.setMeta("api_keys", "missing", { dirty: false }), false);

  await store.del("api_keys", "k1");
  assert.equal(await store.get("api_keys", "k1"), null);
});

test("all returns every row for a table", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "a" }, { version: 1 });
  await store.put("api_keys", "k2", { name: "b" }, { version: 1 });
  const rows = await store.all("api_keys");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.name).sort(), ["a", "b"]);
});

test("write-queue enqueues durably, lists in order, bumps attempts, removes", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());
  const queue = makeQueue(store);

  const seq1 = await queue.enqueue({ id: "k1", table: "api_keys", op: "upsert", base_version: 2 });
  await queue.enqueue({ id: "k2", table: "api_keys", op: "delete", base_version: 5 });

  let items = await queue.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "k1");
  assert.equal(items[0].attempts, 0);

  assert.equal(await queue.bumpAttempts(seq1), 1);
  assert.equal(await queue.bumpAttempts(seq1), 2);

  await queue.remove(seq1);
  items = await queue.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "k2");
});

test("optimistic row mutation and queue append commit atomically", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());
  const queue = makeQueue(store);

  await store.put("api_keys", "k1", { name: "before" }, { version: 2 });
  const occupiedSeq = await queue.enqueue({
    id: "occupied",
    table: "api_keys",
    op: "upsert",
    base_version: 0,
  });

  // Force the queue half to fail after the row mutation was issued by reusing
  // an occupied auto-increment key. The shared transaction must roll back both.
  await assert.rejects(() =>
    queue.enqueueOptimistic(
      {
        seq: occupiedSeq,
        id: "k1",
        table: "api_keys",
        op: "upsert",
        base_version: 2,
        key: "write-will-abort",
      },
      { name: "must-not-land" },
    ),
  );
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "before" });
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 2,
    dirty: false,
  });
  assert.equal((await queue.list()).length, 1);

  const seq = await queue.enqueueOptimistic(
    {
      id: "k1",
      table: "api_keys",
      op: "upsert",
      base_version: 2,
      key: "write-commits",
    },
    { name: "after" },
  );
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "after" });
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 2,
    dirty: true,
  });
  assert.equal((await queue.list()).some((write) => write.seq === seq), true);
});

test("server-wins state and stale queue removal commit together", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());
  const queue = makeQueue(store);

  await store.put("api_keys", "k1", { name: "mine" }, { version: 2, dirty: true });
  const seq = await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "upsert",
    base_version: 2,
    key: "stale-write",
  });
  await queue.resolveConflict(
    {
      table: "api_keys",
      id: "k1",
      op: "upsert",
      version: 3,
      row: { name: "server" },
    },
    [seq],
  );

  assert.deepEqual(await store.get("api_keys", "k1"), { name: "server" });
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 3,
    dirty: false,
  });
  assert.equal((await queue.list()).length, 0);
});

test("ack settlement is atomic and a retired sequence cannot relabel server state", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());
  const queue = makeQueue(store);

  await store.put("api_keys", "k1", { name: "optimistic" }, { version: 2, dirty: true });
  const seq = await queue.enqueue({
    id: "k1", table: "api_keys", op: "upsert", base_version: 2, key: "write-1",
  });
  assert.deepEqual(await queue.settleAck("api_keys", "k1", seq, 3), { Adopt: 3 });
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 3, dirty: false });
  assert.equal((await queue.list()).length, 0);

  await store.put("api_keys", "k1", { name: "server-conflict" }, { version: 4, dirty: false });
  assert.equal(await queue.settleAck("api_keys", "k1", seq, 5), "Missing");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "server-conflict" });
  assert.equal((await store.meta("api_keys", "k1")).version, 4);
});

test("an echo transaction abort restores both the row and queue entry", async (t) => {
  const store = await freshStore();
  t.after(() => store.close());
  const queue = makeQueue(store);

  await store.put("api_keys", "k1", { name: "optimistic" }, { version: 2, dirty: true });
  const seq = await queue.enqueue({
    id: "k1", table: "api_keys", op: "upsert", base_version: 2, key: "write-1",
  });
  await assert.rejects(() =>
    queue.adoptEcho(
      {
        table: "api_keys",
        id: "k1",
        op: "upsert",
        version: 3,
        // Functions cannot be structured-cloned into IndexedDB, forcing the row
        // half to fail. The shared transaction must preserve both old records.
        row: { invalid: () => {} },
      },
      seq,
    ),
  );
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "optimistic" });
  assert.equal((await queue.list()).length, 1);
  assert.equal((await queue.list())[0].seq, seq);
});

test("openStore upgrades an existing database without losing rows or queued writes", async (t) => {
  dbCounter += 1;
  const dbName = `fiducia-upgrade-test-${dbCounter}`;
  const first = await openStore(dbName, ["api_keys"]);
  const firstQueue = makeQueue(first);
  await first.put("api_keys", "k1", { name: "preserved" }, { version: 4 });
  await firstQueue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "upsert",
    base_version: 4,
  });

  // Keep `first` open: its versionchange handler must cooperate with the
  // upgrade instead of leaving the new table blocked forever.
  const upgraded = await openStore(dbName, ["api_keys", "customer_preferences"]);
  t.after(() => {
    first.close();
    upgraded.close();
  });

  assert.ok(upgraded._db.version > 1);
  assert.deepEqual(await upgraded.get("api_keys", "k1"), { name: "preserved" });
  assert.equal((await makeQueue(upgraded).list()).length, 1);
  await upgraded.put(
    "customer_preferences",
    "p1",
    { theme: "dark" },
    { version: 1 },
  );
  assert.deepEqual(await upgraded.get("customer_preferences", "p1"), {
    theme: "dark",
  });
});
