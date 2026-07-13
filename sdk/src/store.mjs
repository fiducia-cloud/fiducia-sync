// IndexedDB persistence for the local-first sync SDK.
//
// One IndexedDB database PER PLANE (customer vs admin never share — a security
// boundary), one object store per synced table keyed by `id`, plus a durable
// `_queue` store for optimistic writes that survive reload. Each record wraps the
// row with its sync metadata: { id, row, version, dirty }.
//
// Reconcile DECISIONS live in the wasm core (fiducia-sync-core); this module is
// pure IO so it can be unit-tested with fake-indexeddb, no browser needed.

/** Promisify an IDBRequest. */
export function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const QUEUE_STORE = "_queue";

function ensureStores(db, tables) {
  for (const table of [...new Set([...tables, QUEUE_STORE])]) {
    if (!db.objectStoreNames.contains(table)) {
      db.createObjectStore(
        table,
        table === QUEUE_STORE
          ? { keyPath: "seq", autoIncrement: true }
          : { keyPath: "id" },
      );
    }
  }
}

function openDatabase(dbName, version, tables) {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(dbName)
        : indexedDB.open(dbName, version);
    let blocked = false;
    request.onupgradeneeded = () => ensureStores(request.result, tables);
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error(
          `IndexedDB upgrade for ${dbName} is blocked by another open page`,
        ),
      );
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

async function withStore(db, name, mode, operation) {
  const transaction = db.transaction(name, mode);
  const done = transactionDone(transaction);
  try {
    const result = await operation(transaction.objectStore(name));
    await done;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The request may already have aborted or completed the transaction.
    }
    await done.catch(() => {});
    throw error;
  }
}

/**
 * Open (or create) the per-plane store.
 * @param {string} dbName  e.g. "fiducia-customer" / "fiducia-admin"
 * @param {string[]} tables synced table names (one object store each)
 */
export async function openStore(dbName, tables) {
  const requiredStores = [...new Set([...tables, QUEUE_STORE])];
  let db = await openDatabase(dbName, undefined, tables);

  // IndexedDB only exposes schema changes during a version upgrade. Opening an
  // existing v1 database with a newly configured table does not fire
  // `onupgradeneeded`, so detect missing stores and advance from the live
  // version. Retry when another tab won the same upgrade race first.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const missing = requiredStores.filter(
      (name) => !db.objectStoreNames.contains(name),
    );
    if (missing.length === 0) break;

    const nextVersion = db.version + 1;
    db.close();
    try {
      db = await openDatabase(dbName, nextVersion, tables);
    } catch (error) {
      if (error?.name !== "VersionError") throw error;
      db = await openDatabase(dbName, undefined, tables);
    }
  }

  const stillMissing = requiredStores.filter(
    (name) => !db.objectStoreNames.contains(name),
  );
  if (stillMissing.length > 0) {
    db.close();
    throw new Error(
      `IndexedDB schema for ${dbName} is missing stores: ${stillMissing.join(", ")}`,
    );
  }

  // Cooperate with a later tab that needs to add another table instead of
  // indefinitely blocking its version upgrade.
  db.onversionchange = () => db.close();

  return {
    /** The stored row (or null). */
    async get(table, id) {
      const rec = await withStore(db, table, "readonly", (objectStore) =>
        promisify(objectStore.get(id)),
      );
      return rec ? rec.row : null;
    },

    /** Sync metadata { version, dirty } for a row (or null if absent). */
    async meta(table, id) {
      const rec = await withStore(db, table, "readonly", (objectStore) =>
        promisify(objectStore.get(id)),
      );
      return rec ? { version: rec.version, dirty: Boolean(rec.dirty) } : null;
    },

    /** Upsert a row with its version; `dirty` marks an un-acked optimistic write. */
    async put(table, id, row, { version, dirty = false }) {
      await withStore(db, table, "readwrite", (objectStore) =>
        promisify(objectStore.put({ id, row, version, dirty })),
      );
    },

    /** Mark an existing row clean/dirty and (optionally) adopt a new version. */
    async setMeta(table, id, { version, dirty }) {
      return withStore(db, table, "readwrite", async (objectStore) => {
        const rec = await promisify(objectStore.get(id));
        if (!rec) return false;
        if (version !== undefined) rec.version = version;
        if (dirty !== undefined) rec.dirty = dirty;
        await promisify(objectStore.put(rec));
        return true;
      });
    },

    async del(table, id) {
      await withStore(db, table, "readwrite", (objectStore) =>
        promisify(objectStore.delete(id)),
      );
    },

    /** All rows for a table (unwrapped). */
    async all(table) {
      const recs = await withStore(db, table, "readonly", (objectStore) =>
        promisify(objectStore.getAll()),
      );
      return recs.map((r) => r.row);
    },

    _db: db,
    close() {
      db.close();
    },
  };
}

/**
 * Durable optimistic write-queue, backed by the store's `_queue` object store.
 * Survives reloads so writes made offline are re-sent on reconnect.
 */
export function makeQueue(store) {
  const db = store._db;
  return {
    /** Append a write; returns its assigned seq. */
    async enqueue(write) {
      return withStore(db, QUEUE_STORE, "readwrite", (objectStore) =>
        promisify(objectStore.add({ ...write, attempts: 0 })),
      );
    },
    /**
     * All queued writes in insertion order, each carrying its `seq`. The store's
     * keyPath is "seq" with autoIncrement, so IndexedDB injects the generated key
     * into each record — no separate getAllKeys() round-trip needed.
     */
    async list() {
      return withStore(db, QUEUE_STORE, "readonly", (objectStore) =>
        promisify(objectStore.getAll()),
      );
    },
    async remove(seq) {
      await withStore(db, QUEUE_STORE, "readwrite", (objectStore) =>
        promisify(objectStore.delete(seq)),
      );
    },
    /** Increment and return the retry count for a queued write. */
    async bumpAttempts(seq) {
      return withStore(db, QUEUE_STORE, "readwrite", async (objectStore) => {
        const rec = await promisify(objectStore.get(seq));
        if (!rec) return 0;
        rec.attempts = (rec.attempts ?? 0) + 1;
        await promisify(objectStore.put(rec));
        return rec.attempts;
      });
    },
  };
}
