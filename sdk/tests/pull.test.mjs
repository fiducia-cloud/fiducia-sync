import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";

import { startSync } from "../src/start.mjs";
import { openStore } from "../src/store.mjs";

const core = {
  reconcile(local, incoming) {
    if (!local) return incoming.op === "upsert" ? "Apply" : { Ignore: "AlreadyApplied" };
    if (incoming.version < local.version) return { Ignore: "Stale" };
    if (incoming.version === local.version) return { Ignore: "AlreadyApplied" };
    return local.dirty ? "Conflict" : "Apply";
  },
  isOwnEcho() {
    return false;
  },
};

const change = (id, version) => ({
  table: "items",
  op: "upsert",
  id,
  version,
  row: { id, version },
  at_ms: 0,
});

test("incremental pull persists its cursor only after each page reconciles", async () => {
  const cursors = [];
  const sync = await startSync({
    dbName: "pull-pages",
    tables: ["items"],
    core,
    pullPageSize: 2,
    pullFetch: async (cursor, limit) => {
      cursors.push([cursor, limit]);
      if (cursor === 0) {
        return {
          changes: [change("a", 1), change("b", 1)],
          next_cursor: 2,
          has_more: true,
        };
      }
      return {
        changes: [change("a", 2)],
        next_cursor: 3,
        has_more: false,
      };
    },
  });

  assert.deepEqual(cursors, [
    [0, 2],
    [2, 2],
  ]);
  assert.equal(await sync.store.getCursor(), 3);
  assert.deepEqual(await sync.store.get("items", "a"), { id: "a", version: 2 });
  assert.deepEqual(await sync.store.get("items", "b"), { id: "b", version: 1 });
  await assert.rejects(() => sync.store.setCursor(2), /cannot move backwards/);
  sync.stop();
});

test("a bad page never advances the cursor and its safe prefix can replay", async () => {
  const statuses = [];
  const first = await startSync({
    dbName: "pull-replay",
    tables: ["items"],
    core,
    pullFetch: async () => ({
      changes: [change("a", 1), { table: "items", op: "bogus" }],
      next_cursor: 2,
      has_more: false,
    }),
    onStatus: (status, error) => statuses.push([status, error]),
  });

  assert.equal(await first.store.getCursor(), 0);
  assert.deepEqual(await first.store.get("items", "a"), { id: "a", version: 1 });
  assert.equal(statuses[0][0], "pull-error");
  first.stop();

  const replay = await startSync({
    dbName: "pull-replay",
    tables: ["items"],
    core,
    pullFetch: async (cursor) => {
      assert.equal(cursor, 0);
      return {
        changes: [change("a", 1), change("b", 1)],
        next_cursor: 2,
        has_more: false,
      };
    },
  });
  assert.equal(await replay.store.getCursor(), 2);
  assert.deepEqual(await replay.store.get("items", "b"), { id: "b", version: 1 });
  replay.stop();
});

test("cursor storage survives a close and schema reopen", async () => {
  const first = await openStore("cursor-reopen", ["items"]);
  await first.setCursor(9, "tenant-a");
  first.close();

  const reopened = await openStore("cursor-reopen", ["items", "other"]);
  assert.equal(await reopened.getCursor("tenant-a"), 9);
  assert.equal(await reopened.getCursor("tenant-b"), 0);
  reopened.close();
});
