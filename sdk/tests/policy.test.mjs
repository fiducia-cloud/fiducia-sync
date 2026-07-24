// Write-policy, error-mode, and telemetry behavior of the sync client, against
// the REAL wasm reconcile core + fake-indexeddb. Pins the semantics matrix
// documented in policy.mjs / src/policy.rs.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as wasm from "../../pkg-node/fiducia_sync_core.js";
import { openStore, makeQueue } from "../src/store.mjs";
import { wrapCore } from "../src/core.mjs";
import { makeSyncClient } from "../src/client.mjs";
import { SyncWriteError, WRITE_POLICIES, ERROR_MODES } from "../src/policy.mjs";

const core = wrapCore(wasm);
let n = 0;
async function setup(clientOptions = {}) {
  n += 1;
  const events = [];
  const store = await openStore(`policy-test-${n}`, ["api_keys"], { now: () => 7_000 });
  const queue = makeQueue(store);
  const client = makeSyncClient({
    store,
    queue,
    core,
    telemetry: (event) => events.push(event),
    now: () => 7_000,
    ...clientOptions,
  });
  return { store, queue, client, events };
}

const okSend = (committed_version) => async (write) => ({ id: write.id, committed_version });
const failSend = async () => {
  throw new Error("offline");
};

test("the vocabulary is enums, not booleans, and rejects unknown values", async (t) => {
  assert.deepEqual([...WRITE_POLICIES], ["local-only", "local-first", "server-first", "server-only"]);
  assert.deepEqual([...ERROR_MODES], ["return", "throw", "emit"]);
  const { store, client } = await setup();
  t.after(() => store.close());
  await assert.rejects(
    client.optimisticWrite("api_keys", "k1", { name: "x" }, okSend(1), { policy: "yolo" }),
    /unknown write policy/,
  );
  await assert.rejects(
    client.optimisticWrite("api_keys", "k1", { name: "x" }, okSend(1), { errorMode: "panic" }),
    /unknown error mode/,
  );
  assert.throws(() => makeSyncClient({ writePolicy: "nope" }), /unknown write policy/);
});

test("local-only: mutates + enqueues durably, never sends; flushQueue sends later", async (t) => {
  const { store, queue, client, events } = await setup();
  t.after(() => store.close());

  let sends = 0;
  const spy = async (write) => {
    sends += 1;
    return { id: write.id, committed_version: write.base_version + 1 };
  };
  const result = await client.optimisticWrite("api_keys", "k1", { name: "draft" }, spy, {
    policy: "local-only",
  });
  assert.equal(result.status, "queued");
  assert.equal(result.attempts, 0);
  assert.equal(sends, 0, "local-only must not touch the network");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "draft" });
  assert.equal((await store.meta("api_keys", "k1")).dirty, true);
  assert.equal((await queue.list()).length, 1);

  // send may be omitted entirely for local-only writes
  const second = await client.optimisticWrite("api_keys", "k2", { name: "later" }, undefined, {
    policy: "local-only",
  });
  assert.equal(second.status, "queued");

  assert.equal(await client.flushQueue(spy), 2);
  assert.equal(sends, 2);
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 1,
    dirty: false,
    syncedAtMs: 7_000,
  });
  const write = events.find((e) => e.name === "fiducia.sync.write");
  assert.equal(write.attributes["sync.policy"], "local-only");
  assert.equal(write.attributes["sync.outcome"], "queued");
});

test("local-first + errorMode throw: rejects typed, write stays queued", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await assert.rejects(
    client.optimisticWrite("api_keys", "k1", { name: "x" }, failSend, {
      errorMode: "throw",
    }),
    (error) => {
      assert.ok(error instanceof SyncWriteError);
      assert.equal(error.queued, true);
      assert.equal(error.attempts, 1);
      assert.equal(error.policy, "local-first");
      assert.match(String(error.cause), /offline/);
      return true;
    },
  );
  assert.equal((await queue.list()).length, 1, "write must stay durably queued");
  assert.equal((await store.meta("api_keys", "k1")).dirty, true);
});

test("local-first + errorMode emit: resolves quietly, telemetry sees the failure", async (t) => {
  const { store, client, events } = await setup({ errorMode: "emit" });
  t.after(() => store.close());

  const result = await client.optimisticWrite("api_keys", "k1", { name: "x" }, failSend);
  assert.equal(result.status, "queued");
  assert.equal(result.error, undefined, "emit mode keeps the error out of the result");
  assert.equal(result.attempts, 1);
  const write = events.find((e) => e.name === "fiducia.sync.write");
  assert.equal(write.status, "ok"); // resolved path; failure detail rides on attributes
  assert.equal(write.attributes["sync.outcome"], "queued");
});

test("server-first: sends first, adopts the committed state locally, no queue entry", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  const result = await client.optimisticWrite("api_keys", "k1", { name: "safe" }, okSend(4), {
    policy: "server-first",
  });
  assert.deepEqual(result, { status: "acked", version: 4 });
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "safe" });
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 4,
    dirty: false,
    syncedAtMs: 7_000,
  });
  assert.equal((await queue.list()).length, 0, "pessimistic writes never enqueue");
});

test("server-first failure leaves local state completely untouched", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());
  await store.put("api_keys", "k1", { name: "committed" }, { version: 2, dirty: false });

  const result = await client.optimisticWrite("api_keys", "k1", { name: "nope" }, failSend, {
    policy: "server-first",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /offline/);
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "committed" });
  assert.equal((await queue.list()).length, 0);

  await assert.rejects(
    client.optimisticWrite("api_keys", "k1", { name: "nope" }, failSend, {
      policy: "server-first",
      errorMode: "throw",
    }),
    (error) => error instanceof SyncWriteError && error.queued === false,
  );
});

test("server-first never downgrades a newer local version (superseded ack)", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());
  await store.put("api_keys", "k1", { name: "newer" }, { version: 9, dirty: false });

  const result = await client.optimisticWrite("api_keys", "k1", { name: "old" }, okSend(4), {
    policy: "server-first",
  });
  assert.deepEqual(result, { status: "acked", version: 4 });
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "newer" });
  assert.equal((await store.meta("api_keys", "k1")).version, 9);
});

test("server-only: local store untouched until the echo/catch-up lands it", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  const result = await client.optimisticWrite("api_keys", "k1", { name: "pure" }, okSend(1), {
    policy: "server-only",
  });
  assert.deepEqual(result, { status: "acked", version: 1 });
  assert.equal(await store.get("api_keys", "k1"), null, "server-only must not write locally");
  assert.equal((await queue.list()).length, 0);

  // The realtime echo (or catch-up pull) is what lands the row.
  await client.applyChange({
    table: "api_keys",
    op: "upsert",
    id: "k1",
    version: 1,
    row: { name: "pure" },
    at_ms: 5,
  });
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "pure" });
});

test("server-first delete removes the row only after the ack", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());
  await store.put("api_keys", "k1", { name: "x" }, { version: 1, dirty: false });

  const failed = await client.optimisticDelete("api_keys", "k1", failSend, {
    policy: "server-first",
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "x" });

  const ok = await client.optimisticDelete("api_keys", "k1", okSend(2), {
    policy: "server-first",
  });
  assert.equal(ok.status, "acked");
  assert.equal(await store.get("api_keys", "k1"), null);
});

test("client-level defaults apply; per-write options override them", async (t) => {
  const { store, queue, client } = await setup({ writePolicy: "server-only" });
  t.after(() => store.close());

  await client.optimisticWrite("api_keys", "k1", { name: "a" }, okSend(1));
  assert.equal(await store.get("api_keys", "k1"), null, "default server-only applied");

  await client.optimisticWrite("api_keys", "k1", { name: "b" }, okSend(1), {
    policy: "local-first",
  });
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "b" });
  assert.equal((await queue.list()).length, 0, "acked local-first write is dequeued");
});

test("legacy positional (op, merge) arguments keep working", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());
  await store.put("api_keys", "k1", { a: 1, b: 2 }, { version: 1, dirty: false });

  await client.optimisticWrite("api_keys", "k1", { b: 3 }, okSend(2), "upsert", true);
  assert.deepEqual(await store.get("api_keys", "k1"), { a: 1, b: 3 });

  const del = await client.optimisticWrite("api_keys", "k1", null, okSend(3), "delete");
  assert.equal(del.status, "acked");
  assert.equal(await store.get("api_keys", "k1"), null);
});

test("flushQueue: errorMode emit resolves despite failures; default still throws", async (t) => {
  const { store, client, events } = await setup();
  t.after(() => store.close());

  await client.optimisticWrite("api_keys", "k1", { name: "x" }, failSend);
  await assert.rejects(client.flushQueue(failSend), /queue flush failed/);

  const flushed = await client.flushQueue(failSend, { errorMode: "emit" });
  assert.equal(flushed, 0);
  const flush = events.filter((e) => e.name === "fiducia.sync.flush").at(-1);
  assert.equal(flush.status, "error");
  assert.equal(flush.attributes["sync.failures"], 1);
});

test("telemetry observes every operation and a throwing sink cannot break sync", async (t) => {
  n += 1;
  const store = await openStore(`policy-test-${n}`, ["api_keys"], { now: () => 7_000 });
  t.after(() => store.close());
  const queue = makeQueue(store);
  const client = makeSyncClient({
    store,
    queue,
    core,
    telemetry: () => {
      throw new Error("sink exploded");
    },
    now: () => 7_000,
  });
  const result = await client.optimisticWrite("api_keys", "k1", { name: "x" }, okSend(1));
  assert.equal(result.status, "acked");

  const { store: s2, client: c2, events } = await setup();
  t.after(() => s2.close());
  await c2.optimisticWrite("api_keys", "k1", { name: "y" }, okSend(1));
  await c2.applyChange({ table: "api_keys", op: "upsert", id: "k1", version: 2, row: { name: "z" }, at_ms: 9 });
  await c2.hydrate("api_keys", [{ id: "k1", version: 2, name: "z" }]);
  const names = events.map((e) => e.name);
  assert.ok(names.includes("fiducia.sync.write"));
  assert.ok(names.includes("fiducia.sync.apply"));
  assert.ok(names.includes("fiducia.sync.hydrate"));
  for (const event of events) {
    assert.equal(typeof event.at_ms, "number");
    assert.equal(typeof event.duration_ms, "number");
    assert.ok(event.status === "ok" || event.status === "error");
  }
});

test("a conflict emits a dedicated conflict event with server-wins resolution", async (t) => {
  const { store, client, events } = await setup();
  t.after(() => store.close());

  await client.optimisticWrite("api_keys", "k1", { name: "mine" }, failSend);
  await client.applyChange({
    table: "api_keys",
    op: "upsert",
    id: "k1",
    version: 5,
    row: { name: "theirs" },
    at_ms: 11,
  });
  const conflict = events.find((e) => e.name === "fiducia.sync.conflict");
  assert.ok(conflict, "conflict event must be emitted");
  assert.equal(conflict.attributes["sync.resolution"], "server-wins");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "theirs" });
});
