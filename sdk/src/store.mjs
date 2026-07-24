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
const META_STORE = "_sync_meta";

function ensureStores(db, tables) {
  for (const table of [...new Set([...tables, QUEUE_STORE, META_STORE])]) {
    if (!db.objectStoreNames.contains(table)) {
      db.createObjectStore(
        table,
        table === QUEUE_STORE
          ? { keyPath: "seq", autoIncrement: true }
          : table === META_STORE
            ? { keyPath: "key" }
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

async function withTransaction(db, names, mode, operation) {
  const transaction = db.transaction(names, mode);
  const done = transactionDone(transaction);
  try {
    const result = await operation(transaction);
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

async function withStore(db, name, mode, operation) {
  return withTransaction(db, name, mode, (transaction) =>
    operation(transaction.objectStore(name)),
  );
}

/**
 * Open (or create) the per-plane store.
 *
 * Every record carries `synced_at_ms` — the LOCAL wall-clock moment this
 * device last adopted server-authoritative state for the row (`null` until it
 * has). It is deliberately per-device (a replica fact, not a server fact —
 * the server-side columns are `created_at`/`updated_at` plus the journal's
 * `changed_at`/`at_ms`), stamped whenever a clean/authoritative payload lands
 * and preserved across dirty optimistic writes.
 *
 * @param {string} dbName  e.g. "fiducia-customer" / "fiducia-admin"
 * @param {string[]} tables synced table names (one object store each)
 * @param {object} [options]
 * @param {() => number} [options.now] wall clock, injectable for tests
 */
export async function openStore(dbName, tables, { now = () => Date.now() } = {}) {
  const requiredStores = [...new Set([...tables, QUEUE_STORE, META_STORE])];
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

    /**
     * Sync metadata { version, dirty, syncedAtMs } for a row (or null if
     * absent). `syncedAtMs` is null until server-authoritative state has
     * landed for the row on THIS device.
     */
    async meta(table, id) {
      const rec = await withStore(db, table, "readonly", (objectStore) =>
        promisify(objectStore.get(id)),
      );
      return rec
        ? {
            version: rec.version,
            dirty: Boolean(rec.dirty),
            syncedAtMs: rec.synced_at_ms ?? null,
          }
        : null;
    },

    /**
     * Upsert a row with its version; `dirty` marks an un-acked optimistic
     * write. `syncedAtMs` may be forced; when omitted, a clean put stamps "the
     * server state landed here now" and a dirty put preserves the previous
     * stamp (an optimistic edit does not un-sync what it was based on).
     */
    async put(table, id, row, { version, dirty = false, syncedAtMs }) {
      await withStore(db, table, "readwrite", async (objectStore) => {
        let synced = syncedAtMs;
        if (synced === undefined) {
          synced = dirty
            ? ((await promisify(objectStore.get(id)))?.synced_at_ms ?? null)
            : now();
        }
        await promisify(
          objectStore.put({ id, row, version, dirty, synced_at_ms: synced ?? null }),
        );
      });
    },

    /** Mark an existing row clean/dirty and (optionally) adopt a new version. */
    async setMeta(table, id, { version, dirty, syncedAtMs }) {
      return withStore(db, table, "readwrite", async (objectStore) => {
        const rec = await promisify(objectStore.get(id));
        if (!rec) return false;
        if (version !== undefined) rec.version = version;
        if (dirty !== undefined) rec.dirty = dirty;
        if (syncedAtMs !== undefined) rec.synced_at_ms = syncedAtMs;
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

    /** Durable plane-wide catch-up cursor. */
    async getCursor(scope = "global") {
      const rec = await withStore(db, META_STORE, "readonly", (objectStore) =>
        promisify(objectStore.get(`cursor:${scope}`)),
      );
      return rec?.value ?? 0;
    },

    /**
     * Advance a durable cursor after every change in its page is reconciled.
     * Regressions are rejected because concurrent reconnects must not move a
     * plane behind work that was already durably applied.
     */
    async setCursor(cursor, scope = "global") {
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("sync cursor must be a non-negative safe integer");
      }
      return withStore(db, META_STORE, "readwrite", async (objectStore) => {
        const key = `cursor:${scope}`;
        const current = await promisify(objectStore.get(key));
        if (current && cursor < current.value) {
          throw new Error("sync cursor cannot move backwards");
        }
        await promisify(objectStore.put({ key, value: cursor, synced_at_ms: now() }));
        return cursor;
      });
    },

    /**
     * Record "this plane finished a successful catch-up now" (also stamped
     * implicitly by every cursor advance). Returns the stamp.
     */
    async markSynced(scope = "global") {
      const at = now();
      await withStore(db, META_STORE, "readwrite", (objectStore) =>
        promisify(objectStore.put({ key: `synced:${scope}`, value: at })),
      );
      return at;
    },

    /**
     * Plane-level sync freshness: the durable catch-up cursor and the last
     * wall-clock moment this device completed a catch-up for `scope`
     * (`lastSyncedAtMs` is null before the first one).
     */
    async syncInfo(scope = "global") {
      return withStore(db, META_STORE, "readonly", async (objectStore) => {
        const [cursorRec, syncedRec] = await Promise.all([
          promisify(objectStore.get(`cursor:${scope}`)),
          promisify(objectStore.get(`synced:${scope}`)),
        ]);
        const stamps = [cursorRec?.synced_at_ms, syncedRec?.value].filter(
          (v) => typeof v === "number",
        );
        return {
          cursor: cursorRec?.value ?? 0,
          lastSyncedAtMs: stamps.length > 0 ? Math.max(...stamps) : null,
        };
      });
    },

    /** Persisted Hybrid Logical Clock state (see hlc.mjs), or null. */
    async getHlcState() {
      const rec = await withStore(db, META_STORE, "readonly", (objectStore) =>
        promisify(objectStore.get("hlc:global")),
      );
      return rec ? { wallMs: rec.wallMs ?? 0, counter: rec.counter ?? 0 } : null;
    },

    /** Persist HLC state so device stamps stay monotonic across reloads. */
    async setHlcState({ wallMs, counter }) {
      await withStore(db, META_STORE, "readwrite", (objectStore) =>
        promisify(objectStore.put({ key: "hlc:global", wallMs, counter })),
      );
    },

    _db: db,
    _now: now,
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
  const now = store._now ?? (() => Date.now());
  return {
    /** Append a write; returns its assigned seq. */
    async enqueue(write) {
      return withStore(db, QUEUE_STORE, "readwrite", (objectStore) =>
        promisify(objectStore.add({ ...write, attempts: 0 })),
      );
    },
    /**
     * Atomically apply an optimistic row mutation and append its retry record.
     * A crash or IndexedDB abort can therefore leave neither change, but never
     * a dirty/deleted row whose only durable resend intent is missing.
     *
     * `hlcState` (when given) persists the write's Hybrid Logical Clock state
     * in the SAME transaction, so a stamp can never outlive a crash that its
     * clock state did not.
     */
    async enqueueOptimistic(write, row, { hlcState } = {}) {
      return withTransaction(
        db,
        hlcState
          ? [write.table, QUEUE_STORE, META_STORE]
          : [write.table, QUEUE_STORE],
        "readwrite",
        async (transaction) => {
          const rows = transaction.objectStore(write.table);
          const queued = transaction.objectStore(QUEUE_STORE);
          const requests = [];
          if (write.op === "delete") {
            requests.push(promisify(rows.delete(write.id)));
          } else {
            // A dirty write keeps the row's previous synced_at_ms — editing on
            // top of synced state does not un-sync it.
            const existing = await promisify(rows.get(write.id));
            requests.push(
              promisify(
                rows.put({
                  id: write.id,
                  row,
                  version: write.base_version,
                  dirty: true,
                  synced_at_ms: existing?.synced_at_ms ?? null,
                }),
              ),
            );
          }
          if (hlcState) {
            requests.push(
              promisify(
                transaction
                  .objectStore(META_STORE)
                  .put({ key: "hlc:global", ...hlcState }),
              ),
            );
          }
          const [seq] = await Promise.all([
            promisify(queued.add({ ...write, attempts: 0 })),
            ...requests,
          ]);
          return seq;
        },
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
    /**
     * Atomically retire an HTTP-acknowledged write and update the row metadata.
     *
     * Returning `Missing` is significant: an exact realtime echo or a
     * server-wins conflict already retired this sequence. A version-only HTTP
     * ack must not then advance whichever authoritative payload replaced it.
     */
    async settleAck(table, id, seq, committedVersion) {
      return withTransaction(
        db,
        [table, QUEUE_STORE],
        "readwrite",
        async (transaction) => {
          const rows = transaction.objectStore(table);
          const queued = transaction.objectStore(QUEUE_STORE);
          const [write, rec, writes] = await Promise.all([
            promisify(queued.get(seq)),
            promisify(rows.get(id)),
            promisify(queued.getAll()),
          ]);
          if (!write) return "Missing";
          if (write.table !== table || write.id !== id) {
            throw new Error("queued write identity changed before acknowledgement");
          }

          const hasOtherPendingWrite = writes.some(
            (candidate) =>
              candidate.seq !== seq &&
              candidate.table === table &&
              candidate.id === id,
          );
          let outcome = "Superseded";
          const requests = [];
          for (const candidate of writes) {
            if (
              candidate.seq < seq &&
              candidate.table === table &&
              candidate.id === id
            ) {
              candidate.superseded_version = Math.max(
                candidate.superseded_version ?? Number.MIN_SAFE_INTEGER,
                committedVersion,
              );
              requests.push(promisify(queued.put(candidate)));
            }
          }
          if (rec) {
            if (rec.version <= committedVersion) {
              rec.version = committedVersion;
              rec.synced_at_ms = now(); // the server confirmed this state
              outcome = { Adopt: committedVersion };
            }
            rec.dirty = hasOtherPendingWrite;
            requests.push(promisify(rows.put(rec)));
          }
          requests.push(promisify(queued.delete(seq)));
          await Promise.all(requests);
          return outcome;
        },
      );
    },
    /**
     * Atomically adopt an exact-key realtime echo and retire its queue entry.
     * The committed server payload wins when this was the last local write;
     * otherwise the newer optimistic value is preserved and remains dirty.
     */
    async adoptEcho(event, seq) {
      return withTransaction(
        db,
        [event.table, QUEUE_STORE],
        "readwrite",
        async (transaction) => {
          const rows = transaction.objectStore(event.table);
          const queued = transaction.objectStore(QUEUE_STORE);
          const [echo, rec, writes] = await Promise.all([
            promisify(queued.get(seq)),
            promisify(rows.get(event.id)),
            promisify(queued.getAll()),
          ]);
          if (!echo) return false;
          if (echo.table !== event.table || echo.id !== event.id) {
            throw new Error("queued echo identity changed before reconciliation");
          }

          const remainingRowWrites = writes.filter(
            (candidate) =>
              candidate.seq !== seq &&
              candidate.table === event.table &&
              candidate.id === event.id,
          );
          const hasNewerLocalWrite = remainingRowWrites.some(
            (candidate) => candidate.seq > seq,
          );
          const echoWasSuperseded =
            Number.isSafeInteger(echo.superseded_version) &&
            echo.superseded_version >= event.version;
          // Construct the possibly-uncloneable server row request before
          // issuing queue mutations. The transaction is atomic either way, but
          // this ordering also avoids orphaned rejected queue promises when an
          // IndexedDB implementation throws DataCloneError synchronously.
          let rowRequest;
          if (echoWasSuperseded) {
            if (rec) {
              rec.dirty = remainingRowWrites.length > 0;
              rowRequest = rows.put(rec);
            }
          } else if (!hasNewerLocalWrite) {
            if (!rec || event.version >= rec.version) {
              rowRequest =
                event.op === "delete"
                  ? rows.delete(event.id)
                  : rows.put({
                      id: event.id,
                      row: event.row,
                      version: event.version,
                      dirty: remainingRowWrites.length > 0,
                      synced_at_ms: now(),
                    });
            } else {
              rec.dirty = remainingRowWrites.length > 0;
              rowRequest = rows.put(rec);
            }
          } else if (rec) {
            rec.version = Math.max(rec.version, event.version);
            rec.dirty = true;
            rowRequest = rows.put(rec);
          }

          const requests = rowRequest ? [promisify(rowRequest)] : [];
          for (const candidate of remainingRowWrites) {
            if (candidate.seq < seq) {
              candidate.superseded_version = Math.max(
                candidate.superseded_version ?? Number.MIN_SAFE_INTEGER,
                event.version,
              );
              requests.push(promisify(queued.put(candidate)));
            }
          }
          requests.push(promisify(queued.delete(seq)));
          await Promise.all(requests);
          return true;
        },
      );
    },
    /**
     * Atomically adopt authoritative server state and discard stale writes for
     * the row. This closes the crash window where a server-wins conflict had
     * landed locally but an old queued write could still be retried after reload.
     */
    async resolveConflict(event, seqs) {
      await withTransaction(
        db,
        [event.table, QUEUE_STORE],
        "readwrite",
        async (transaction) => {
          const queued = transaction.objectStore(QUEUE_STORE);
          const rows = transaction.objectStore(event.table);
          const [rec, writes] = await Promise.all([
            promisify(rows.get(event.id)),
            promisify(queued.getAll()),
          ]);
          const stale = new Set(seqs);
          const hasNewerLocalWrite = writes.some(
            (write) =>
              !stale.has(write.seq) &&
              write.table === event.table &&
              write.id === event.id,
          );
          // Construct the possibly-uncloneable server row request before issuing
          // queue deletions. Either side still commits/aborts as one transaction,
          // and a synchronous DataCloneError cannot strand rejected promises.
          let rowRequest;
          if (!hasNewerLocalWrite) {
            rowRequest =
              event.op === "delete"
                ? rows.delete(event.id)
                : rows.put({
                    id: event.id,
                    row: event.row,
                    version: event.version,
                    dirty: false,
                    synced_at_ms: now(),
                  });
          } else if (rec) {
            rec.version = Math.max(rec.version, event.version);
            rec.dirty = true;
            rowRequest = rows.put(rec);
          }
          const requests = [];
          if (rowRequest) requests.push(promisify(rowRequest));
          requests.push(...seqs.map((seq) => promisify(queued.delete(seq))));
          await Promise.all(requests);
        },
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
