import assert from "node:assert/strict";
import { test } from "node:test";
import {
  openBrowserStore,
  openLocalStorageStore,
} from "../src/local-storage.mjs";
import { makeQueue } from "../src/store.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    failNextWrite: false,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error("quota exceeded");
      }
      values.set(key, String(value));
    },
  };
}

test("localStorage persists rows, replica metadata, queue intents, and cursors across reopen", async () => {
  const storage = memoryStorage();
  const first = await openLocalStorageStore("mobile", ["items"], { storage });
  const queue = makeQueue(first);
  await first.put(
    "items",
    "one",
    { name: "server" },
    { version: 2, dirty: false },
  );
  const sequence = await queue.enqueueOptimistic(
    {
      id: "one",
      table: "items",
      op: "upsert",
      payload: { name: "local" },
      base_version: 2,
    },
    { name: "local" },
  );
  await first.setCursor(9);
  first.close();

  const reopened = await openBrowserStore("mobile", ["items"], {
    persistence: "local_storage",
    storage,
  });
  const reopenedQueue = makeQueue(reopened);
  assert.equal(reopened.storageKind, "local_storage");
  assert.deepEqual(await reopened.get("items", "one"), { name: "local" });
  assert.equal((await reopened.replicaMeta("items", "one")).dirty, true);
  assert.equal((await reopenedQueue.list()).length, 1);
  assert.equal(await reopened.getCursor(), 9);

  assert.deepEqual(
    await reopenedQueue.settleAck("items", "one", sequence, 3),
    { Adopt: 3 },
  );
  assert.deepEqual(await reopened.meta("items", "one"), {
    version: 3,
    dirty: false,
  });
});

test("a failed localStorage commit leaves both the row and queue unchanged", async () => {
  const storage = memoryStorage();
  const store = await openLocalStorageStore("atomic", ["items"], { storage });
  const queue = makeQueue(store);
  await store.put(
    "items",
    "one",
    { name: "before" },
    { version: 1, dirty: false },
  );
  storage.failNextWrite = true;

  await assert.rejects(() =>
    queue.enqueueOptimistic(
      {
        id: "one",
        table: "items",
        op: "upsert",
        payload: { name: "after" },
        base_version: 1,
      },
      { name: "after" },
    ),
  );
  assert.deepEqual(await store.get("items", "one"), { name: "before" });
  assert.equal((await queue.list()).length, 0);
});
