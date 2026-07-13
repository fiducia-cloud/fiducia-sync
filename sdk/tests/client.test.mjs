// Client tests run against the REAL Rust reconcile core (node-target wasm), so
// there is one source of truth for the sync logic. Build it first:
//   npm run build:wasm  (bundler) ; for these tests: wasm-pack build --target nodejs --out-dir pkg-node -- --features wasm --locked
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

  assert.equal(await client.applyChange(change({ version: 1, row: { name: "b" } })), "refreshed");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "b" }); // equal-version server truth refreshes
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
  assert.equal(res.attempts, 1);
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 2, dirty: true }); // awaiting retry
  assert.equal((await queue.list())[0].attempts, 1);
});

test("the echo of our own write is adopted, not flagged as a conflict", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  // We made an optimistic write on top of version 2 (still dirty + queued).
  await store.put("api_keys", "k1", { name: "b" }, { version: 2, dirty: true });
  await queue.enqueue({ id: "k1", table: "api_keys", op: "upsert", payload: { name: "b" }, base_version: 2 });

  // The realtime echo of our own commit arrives at version 3 (= base + 1).
  const r = await client.applyChange(
    change({ version: 3, row: { name: "server-normalized" } }),
  );
  assert.equal(r, "echo-adopted");
  // The exact echo is authoritative: server normalization replaces the
  // optimistic payload when no newer local edit remains.
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "server-normalized" });
  assert.deepEqual(await store.meta("api_keys", "k1"), { version: 3, dirty: false });
  assert.equal((await queue.list()).length, 0);
});

test("the echo of an optimistic delete dequeues even though the row is already absent", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "delete",
    payload: null,
    base_version: 2,
  });
  const result = await client.applyChange(
    change({ op: "delete", version: 3, row: null }),
  );
  assert.equal(result, "echo-adopted");
  assert.equal((await queue.list()).length, 0);
});

test("flushQueue persists failures and rejects with actionable details", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "mine" }, { version: 2, dirty: true });
  await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "upsert",
    payload: { name: "mine" },
    base_version: 2,
  });

  await assert.rejects(
    () =>
      client.flushQueue(async () => {
        throw new Error("offline");
      }),
    (error) => {
      assert.equal(error.name, "QueueFlushError");
      assert.equal(error.flushed, 0);
      assert.equal(error.failures.length, 1);
      assert.match(String(error.failures[0].error), /offline/);
      return true;
    },
  );
  assert.equal((await queue.list())[0].attempts, 1);
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

test("optimisticDelete removes the row locally and dequeues on ack", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "a" }, { version: 2, dirty: false });
  const send = async (w) => {
    assert.equal(w.op, "delete");
    assert.equal(w.base_version, 2);
    return { id: "k1", committed_version: 3 };
  };

  const res = await client.optimisticDelete("api_keys", "k1", send);
  assert.equal(res.status, "acked");
  assert.equal(await store.get("api_keys", "k1"), null); // gone locally
  assert.equal((await queue.list()).length, 0); // dequeued
});

test("hydrate catch-up applies newer rows, ignores stale, keeps dirty, prunes clean rows missing from a full snapshot", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { id: "k1", name: "old" }, { version: 1, dirty: false });
  await store.put("api_keys", "k2", { id: "k2", name: "mine" }, { version: 1, dirty: true }); // un-acked local edit
  await store.put("api_keys", "k3", { id: "k3", name: "gone-server-side" }, { version: 4, dirty: false });

  // Authoritative snapshot: k1 advanced to v2, k2 still at v1, k3 absent (deleted).
  const res = await client.hydrate(
    "api_keys",
    [
      { id: "k1", version: 2, name: "new" },
      { id: "k2", version: 1, name: "server" },
    ],
    { prune: true },
  );

  assert.deepEqual(await store.get("api_keys", "k1"), { id: "k1", version: 2, name: "new" }); // applied
  assert.deepEqual(await store.meta("api_keys", "k2"), { version: 1, dirty: true }); // dirty preserved
  assert.equal(await store.get("api_keys", "k3"), null); // pruned (clean + missing)
  assert.equal(res.applied, 1);
  assert.equal(res.ignored, 1);
  assert.equal(res.pruned, 1);
});

test("two edits to the same row before an ack carry DISTINCT idempotency keys; retries reuse them", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "a" }, { version: 2, dirty: false });
  const sent = [];
  const offline = async (w) => {
    sent.push(w);
    throw new Error("offline");
  };

  // Both edits are made on top of version 2 (the first is never acked), so a
  // key derived from (table,id,op,base_version) would collide and the server
  // would silently dedupe the second edit away.
  await client.optimisticWrite("api_keys", "k1", { name: "b" }, offline);
  await client.optimisticWrite("api_keys", "k1", { name: "c" }, offline);

  assert.equal(sent.length, 2);
  assert.ok(sent[0].key, "first write carries a key");
  assert.ok(sent[1].key, "second write carries a key");
  assert.notEqual(sent[0].key, sent[1].key);
  assert.equal(sent[0].base_version, sent[1].base_version); // the collision the key must survive

  // The queue persisted the same keys, so a flush (or a reload) retries each
  // write under its ORIGINAL key — a retry is deduped, a distinct write is not.
  const resent = [];
  let version = 2;
  await client.flushQueue(async (w) => {
    resent.push(w);
    version += 1;
    return { id: w.id, committed_version: version };
  });
  assert.deepEqual(
    resent.map((w) => w.key),
    sent.map((w) => w.key),
  );
  assert.equal((await queue.list()).length, 0);
});
