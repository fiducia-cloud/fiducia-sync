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

/**
 * Open (or create) the per-plane store.
 * @param {string} dbName  e.g. "fiducia-customer" / "fiducia-admin"
 * @param {string[]} tables synced table names (one object store each)
 */
export async function openStore(dbName, tables) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const d = request.result;
      for (const table of tables) {
        if (!d.objectStoreNames.contains(table)) {
          d.createObjectStore(table, { keyPath: "id" });
        }
      }
      if (!d.objectStoreNames.contains(QUEUE_STORE)) {
        d.createObjectStore(QUEUE_STORE, { keyPath: "seq", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const objStore = (name, mode) => db.transaction(name, mode).objectStore(name);

  return {
    /** The stored row (or null). */
    async get(table, id) {
      const rec = await promisify(objStore(table, "readonly").get(id));
      return rec ? rec.row : null;
    },

    /** Sync metadata { version, dirty } for a row (or null if absent). */
    async meta(table, id) {
      const rec = await promisify(objStore(table, "readonly").get(id));
      return rec ? { version: rec.version, dirty: Boolean(rec.dirty) } : null;
    },

    /** Upsert a row with its version; `dirty` marks an un-acked optimistic write. */
    async put(table, id, row, { version, dirty = false }) {
      await promisify(objStore(table, "readwrite").put({ id, row, version, dirty }));
    },

    /** Mark an existing row clean/dirty and (optionally) adopt a new version. */
    async setMeta(table, id, { version, dirty }) {
      const store = objStore(table, "readwrite");
      const rec = await promisify(store.get(id));
      if (!rec) return false;
      if (version !== undefined) rec.version = version;
      if (dirty !== undefined) rec.dirty = dirty;
      await promisify(store.put(rec));
      return true;
    },

    async del(table, id) {
      await promisify(objStore(table, "readwrite").delete(id));
    },

    /** All rows for a table (unwrapped). */
    async all(table) {
      const recs = await promisify(objStore(table, "readonly").getAll());
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
  const q = (mode) => db.transaction(QUEUE_STORE, mode).objectStore(QUEUE_STORE);
  return {
    /** Append a write; returns its assigned seq. */
    async enqueue(write) {
      return promisify(q("readwrite").add({ ...write, attempts: 0 }));
    },
    /**
     * All queued writes in insertion order, each carrying its `seq`. The store's
     * keyPath is "seq" with autoIncrement, so IndexedDB injects the generated key
     * into each record — no separate getAllKeys() round-trip needed.
     */
    async list() {
      return promisify(q("readonly").getAll());
    },
    async remove(seq) {
      await promisify(q("readwrite").delete(seq));
    },
    /** Increment and return the retry count for a queued write. */
    async bumpAttempts(seq) {
      const store2 = q("readwrite");
      const rec = await promisify(store2.get(seq));
      if (!rec) return 0;
      rec.attempts = (rec.attempts ?? 0) + 1;
      await promisify(store2.put(rec));
      return rec.attempts;
    },
  };
}
