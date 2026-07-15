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

test("acking an older write keeps a newer queued edit dirty and conflict-visible", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "v2" }, { version: 2, dirty: false });
  let acknowledgeFirst;
  const first = client.optimisticWrite(
    "api_keys",
    "k1",
    { name: "edit-1" },
    () => new Promise((resolve) => {
      acknowledgeFirst = resolve;
    }),
  );
  // Let the first write commit its IndexedDB transaction and enter send().
  while (!acknowledgeFirst) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const second = await client.optimisticWrite(
    "api_keys",
    "k1",
    { name: "edit-2" },
    async () => {
      throw new Error("offline");
    },
  );
  assert.equal(second.status, "queued");
  acknowledgeFirst({ id: "k1", committed_version: 3 });
  assert.equal((await first).status, "acked");

  assert.deepEqual(await store.get("api_keys", "k1"), { name: "edit-2" });
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 3,
    dirty: true,
  });
  assert.equal((await queue.list()).length, 1);

  // A third-party v4 must resolve against the still-pending second edit, not be
  // mistaken for a clean apply that leaves a stale queue entry behind.
  const outcome = await client.applyChange(change({
    version: 4,
    row: { name: "server-v4" },
    write_key: "third-party-v4",
  }));
  assert.equal(outcome, "conflict-resolved");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "server-v4" });
  assert.equal((await queue.list()).length, 0);
});

test("out-of-order keyed echoes never downgrade a newer committed version", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "edit-2" }, { version: 2, dirty: true });
  await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "upsert",
    payload: { name: "edit-1" },
    base_version: 2,
    key: "write-1",
  });
  await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "upsert",
    payload: { name: "edit-2" },
    base_version: 2,
    key: "write-2",
  });

  assert.equal(
    await client.applyChange(change({ version: 4, write_key: "write-2" })),
    "echo-adopted",
  );
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 4,
    dirty: true,
  });

  assert.equal(
    await client.applyChange(change({ version: 3, write_key: "write-1" })),
    "echo-adopted",
  );
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 4,
    dirty: false,
  });
  assert.equal((await queue.list()).length, 0);
});

test("an older upsert echo cannot resurrect a newer queued optimistic delete", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "upsert",
    payload: { name: "older" },
    base_version: 2,
    key: "older-upsert",
  });
  await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "delete",
    payload: null,
    base_version: 2,
    key: "newer-delete",
  });

  assert.equal(
    await client.applyChange(change({
      version: 3,
      row: { name: "older" },
      write_key: "older-upsert",
    })),
    "echo-adopted",
  );
  assert.equal(await store.get("api_keys", "k1"), null);
  const remaining = await queue.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].key, "newer-delete");
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

test("a THIRD-PARTY change landing at our base+1 cannot impersonate our keyed echo", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  // Our optimistic edit on v2, whose SEND FAILED — so it never committed; it sits
  // queued (base_version 2, expected echo v3) with our local content.
  await store.put("api_keys", "k1", { name: "v2" }, { version: 2, dirty: false });
  const res = await client.optimisticWrite("api_keys", "k1", { name: "mine-uncommitted" }, async () => {
    throw new Error("offline");
  });
  assert.equal(res.status, "queued");
  const [ours] = await queue.list();
  assert.ok(ours.key, "new queue rows carry an authoritative echo token");

  // A DIFFERENT client commits v3 (also based on v2) with different content. Its
  // event carries that client's token. Even though v3 equals our expected legacy
  // echo version, the token mismatch forces ordinary conflict reconciliation.
  const outcome = await client.applyChange(change({
    version: 3,
    row: { name: "theirs" },
    write_key: "someone-elses-write",
  }));
  assert.equal(outcome, "conflict-resolved");
  assert.deepEqual(
    await store.get("api_keys", "k1"),
    { name: "theirs" },
    "local must converge to the server's v3 content, not keep our un-committed edit",
  );
  assert.equal((await store.meta("api_keys", "k1")).version, 3);
  assert.equal((await queue.list()).length, 0, "the stale local write is retired");
});

test("a keyed own echo matches by token even when its committed version drifted", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "mine" }, { version: 2, dirty: true });
  await queue.enqueue({
    id: "k1",
    table: "api_keys",
    op: "upsert",
    payload: { name: "mine" },
    base_version: 2,
    key: "our-write",
  });

  // Other commits may advance the row before our write is serialized. The
  // echoed token, not base+1, authoritatively identifies our eventual commit.
  const outcome = await client.applyChange(change({
    version: 7,
    row: { name: "mine" },
    write_key: "our-write",
  }));
  assert.equal(outcome, "echo-adopted");
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 7,
    dirty: false,
  });
  assert.equal((await queue.list()).length, 0);
});

test("concurrent transport callbacks are serialized and cannot downgrade a row", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "v2" }, { version: 2, dirty: false });
  const older = client.applyChange(change({ version: 3, row: { name: "v3" } }));
  const newer = client.applyChange(change({ version: 4, row: { name: "v4" } }));
  await Promise.all([older, newer]);

  assert.deepEqual(await store.get("api_keys", "k1"), { name: "v4" });
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 4,
    dirty: false,
  });
});

test("an ack cannot relabel a conflict payload before its exact echo arrives", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "v2" }, { version: 2, dirty: false });
  let acknowledge;
  let sent;
  const pending = client.optimisticWrite(
    "api_keys",
    "k1",
    { name: "mine-v4" },
    (write) => {
      sent = write;
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    },
  );
  while (!acknowledge) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    await client.applyChange(change({
      version: 3,
      row: { name: "theirs-v3" },
      write_key: "third-party",
    })),
    "conflict-resolved",
  );
  assert.equal((await queue.list()).length, 0);

  acknowledge({ id: "k1", committed_version: 4 });
  assert.equal((await pending).status, "acked");
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "theirs-v3" });
  assert.equal((await store.meta("api_keys", "k1")).version, 3);

  assert.equal(
    await client.applyChange(change({
      version: 4,
      row: { name: "mine-v4-normalized" },
      write_key: sent.key,
    })),
    "applied",
  );
  assert.deepEqual(await store.get("api_keys", "k1"), {
    name: "mine-v4-normalized",
  });
});

test("ack-before-echo still adopts the authoritative equal-version payload", async (t) => {
  const { store, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "v2" }, { version: 2, dirty: false });
  let writeKey;
  await client.optimisticWrite("api_keys", "k1", { name: "optimistic" }, async (write) => {
    writeKey = write.key;
    return { id: "k1", committed_version: 3 };
  });
  assert.deepEqual(await store.get("api_keys", "k1"), { name: "optimistic" });

  assert.equal(
    await client.applyChange(change({
      version: 3,
      row: { name: "server-normalized" },
      write_key: writeKey,
    })),
    "refreshed",
  );
  assert.deepEqual(await store.get("api_keys", "k1"), {
    name: "server-normalized",
  });
});

test("a malformed acknowledgement stays durable for retry", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  const result = await client.optimisticWrite(
    "api_keys",
    "k1",
    { name: "mine" },
    async () => ({ id: "wrong-row", committed_version: 1 }),
  );
  assert.equal(result.status, "queued");
  assert.equal((await queue.list()).length, 1);
  assert.deepEqual(await store.meta("api_keys", "k1"), {
    version: 0,
    dirty: true,
  });
});

test("a newer delete echo cannot be undone by an older out-of-order upsert", async (t) => {
  const { store, queue, client } = await setup();
  t.after(() => store.close());

  await store.put("api_keys", "k1", { name: "latest" }, { version: 2, dirty: true });
  await queue.enqueue({
    id: "k1", table: "api_keys", op: "upsert", payload: { name: "older" },
    base_version: 2, key: "older-upsert",
  });
  await queue.enqueue({
    id: "k1", table: "api_keys", op: "delete", payload: null,
    base_version: 2, key: "newer-delete",
  });

  assert.equal(
    await client.applyChange(change({
      op: "delete", version: 4, row: null, write_key: "newer-delete",
    })),
    "echo-adopted",
  );
  assert.equal(await store.get("api_keys", "k1"), null);
  assert.equal(
    await client.applyChange(change({
      version: 3, row: { name: "older" }, write_key: "older-upsert",
    })),
    "echo-adopted",
  );
  assert.equal(await store.get("api_keys", "k1"), null);
  assert.equal((await queue.list()).length, 0);
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
