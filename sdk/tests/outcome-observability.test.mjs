import assert from "node:assert/strict";
import test from "node:test";

import { makeSyncClient, SyncWriteError } from "../src/client.mjs";

function memoryHarness() {
  const rows = new Map();
  const metas = new Map();
  const writes = [];
  let nextSeq = 1;
  const key = (table, id) => `${table}:${id}`;
  const store = {
    storageKind: "local_storage",
    async get(table, id) { return rows.get(key(table, id)) ?? null; },
    async meta(table, id) { return metas.get(key(table, id)) ?? null; },
    async put(table, id, row, meta) {
      rows.set(key(table, id), structuredClone(row));
      metas.set(key(table, id), { ...meta });
    },
    async del(table, id) {
      rows.delete(key(table, id));
      metas.delete(key(table, id));
    },
  };
  const queue = {
    async enqueue(write) {
      const seq = nextSeq++;
      writes.push({ ...structuredClone(write), seq, attempts: 0 });
      return seq;
    },
    async enqueueOptimistic(write, row) {
      const seq = await this.enqueue(write);
      if (write.op === "delete") await store.del(write.table, write.id);
      else await store.put(write.table, write.id, row, {
        version: write.base_version,
        dirty: true,
      });
      return seq;
    },
    async list() { return structuredClone(writes); },
    async bumpAttempts(seq) {
      const found = writes.find((write) => write.seq === seq);
      if (!found) return 0;
      found.attempts += 1;
      return found.attempts;
    },
  };
  return { rows, metas, store, queue };
}

const policy = (failure_mode, telemetry = "errors") => ({
  strategy: "optimistic",
  failure_mode,
  telemetry,
});

async function failedWrite(failureMode) {
  const harness = memoryHarness();
  const events = [];
  const client = makeSyncClient({
    store: harness.store,
    queue: harness.queue,
    core: {},
    telemetry: { emit(event, context) { events.push({ event, context }); } },
  });
  const transportError = new Error("tenant-42 secret transport message");
  transportError.name = "tenant-42/offline-secret";
  let result;
  let thrown;
  try {
    result = await client.write(
      "api_keys",
      "secret-row-id",
      { token: "secret-payload" },
      async () => { throw transportError; },
      { policy: policy(failureMode) },
    );
  } catch (error) {
    thrown = error;
    result = error.result;
  }
  return { ...harness, events, result, thrown };
}

test("all failure modes preserve one durable retry while exposing distinct caller outcomes", async () => {
  const returned = await failedWrite("return_result");
  const thrown = await failedWrite("throw_error");
  const emitted = await failedWrite("emit_only");

  assert.equal(thrown.thrown instanceof SyncWriteError, true);
  assert.equal(returned.thrown, undefined);
  assert.equal(emitted.thrown, undefined);
  assert.match(returned.result.error, /tenant-42 secret transport message/);
  assert.match(thrown.result.error, /tenant-42 secret transport message/);
  assert.deepEqual(emitted.result, { status: "queued", attempts: 1 });

  for (const outcome of [returned, thrown, emitted]) {
    const queued = await outcome.queue.list();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].attempts, 1);
    assert.equal(queued[0].base_version, 0);
    assert.deepEqual(queued[0].payload, { token: "secret-payload" });
    assert.deepEqual(await outcome.store.meta("api_keys", "secret-row-id"), {
      version: 0,
      dirty: true,
    });
    assert.deepEqual(
      outcome.events.map(({ event }) => event.phase),
      ["failed", "retry_scheduled"],
    );
    assert.deepEqual(
      outcome.events.map(({ event }) => event.error_type),
      ["Error", "Error"],
    );
    const serialized = JSON.stringify(outcome.events);
    assert.doesNotMatch(
      serialized,
      /secret-row-id|secret-payload|tenant-42|transport message|offline-secret/,
    );
  }
});

test("emit_only cannot be combined with telemetry off", async () => {
  const harness = memoryHarness();
  let sends = 0;
  const client = makeSyncClient({
    store: harness.store,
    queue: harness.queue,
    core: {},
  });
  await assert.rejects(
    () => client.write(
      "api_keys",
      "k1",
      { name: "silent" },
      async () => { sends += 1; throw new Error("offline"); },
      { policy: policy("emit_only", "off") },
    ),
    /emit_only requires telemetry/,
  );
  assert.equal(sends, 0);
  assert.equal((await harness.queue.list()).length, 0);
  assert.equal(await harness.store.get("api_keys", "k1"), null);
});
