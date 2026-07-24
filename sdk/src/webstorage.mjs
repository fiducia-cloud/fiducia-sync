// Web-Storage (localStorage/sessionStorage) fallback persistence — the same
// store + queue contracts as store.mjs, for environments where IndexedDB is
// unavailable or unreliable (some private-browsing modes, constrained
// webviews, tests). IndexedDB remains the primary browser store.
//
// Layout: ONE JSON document per plane under `fiducia-sync:<dbName>`. Every
// mutation builds the next document and commits it with a single setItem, so
// each operation — including the multi-store ones (optimistic mutate+enqueue,
// ack settlement, echo adoption, conflict resolution) — is atomic exactly like
// its IndexedDB transaction counterpart: a crash leaves the old or the new
// document, never a torn one.
//
// Multi-tab caveat: unlike IndexedDB transactions, Web Storage has no
// cross-tab locking — two tabs mutating the SAME plane concurrently
// last-write-wins at document granularity. Use the IndexedDB store when
// multiple tabs write one plane. (Reads always re-load the committed document,
// so a single writer + many readers is fine.)
//
// The semantics of settleAck/adoptEcho/resolveConflict mirror store.mjs and
// are pinned to it by the contract battery in sdk/tests/store-contract.test.mjs.

const PREFIX = "fiducia-sync:";

function defaultStorage() {
  const storage = globalThis.localStorage;
  if (!storage) {
    throw new Error(
      "localStorage is not available; pass {storage} (e.g. sessionStorage or a shim)",
    );
  }
  return storage;
}

function emptyDocument(tables) {
  const doc = { tables: {}, queue: { nextSeq: 1, items: [] }, meta: {} };
  for (const table of tables) doc.tables[table] = {};
  return doc;
}

/**
 * Open the Web-Storage-backed per-plane store. Same surface as `openStore`
 * (rows, metadata incl. `synced_at_ms`, cursors, syncInfo, HLC state); pair it
 * with `makeWebStorageQueue` and pass both to `makeSyncClient`.
 *
 * @param {string} dbName   e.g. "fiducia-customer"
 * @param {string[]} tables synced table names
 * @param {object} [options]
 * @param {Storage} [options.storage] any {getItem,setItem,removeItem} impl
 * @param {() => number} [options.now] wall clock, injectable for tests
 */
export async function openWebStorageStore(
  dbName,
  tables,
  { storage = defaultStorage(), now = () => Date.now() } = {},
) {
  const key = `${PREFIX}${dbName}`;
  let closed = false;

  function load() {
    const raw = storage.getItem(key);
    let doc = null;
    if (raw != null) {
      try {
        doc = JSON.parse(raw);
      } catch {
        throw new Error(`web-storage sync document ${key} is corrupt`);
      }
    }
    if (!doc || typeof doc !== "object") doc = emptyDocument(tables);
    doc.tables ??= {};
    for (const table of tables) doc.tables[table] ??= {};
    doc.queue ??= { nextSeq: 1, items: [] };
    doc.meta ??= {};
    return doc;
  }

  function commit(doc) {
    storage.setItem(key, JSON.stringify(doc));
  }

  const guard = () => {
    if (closed) throw new Error("web-storage sync store is closed");
  };
  const tableOf = (doc, table) => {
    const rows = doc.tables[table];
    if (!rows) throw new Error(`unknown synced table ${JSON.stringify(table)}`);
    return rows;
  };

  // Serialize mutations so concurrent async callers in THIS tab compose the
  // same way IndexedDB transactions do.
  let tail = Promise.resolve();
  const mutateDoc = (operation) => {
    guard();
    const run = tail.then(() => {
      const doc = load();
      const result = operation(doc);
      commit(doc);
      return result;
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const readDoc = (operation) => {
    guard();
    return Promise.resolve().then(() => operation(load()));
  };

  const store = {
    async get(table, id) {
      return readDoc((doc) => tableOf(doc, table)[id]?.row ?? null);
    },

    async meta(table, id) {
      return readDoc((doc) => {
        const rec = tableOf(doc, table)[id];
        return rec
          ? {
              version: rec.version,
              dirty: Boolean(rec.dirty),
              syncedAtMs: rec.synced_at_ms ?? null,
            }
          : null;
      });
    },

    async put(table, id, row, { version, dirty = false, syncedAtMs }) {
      await mutateDoc((doc) => {
        const rows = tableOf(doc, table);
        const synced =
          syncedAtMs !== undefined
            ? (syncedAtMs ?? null)
            : dirty
              ? (rows[id]?.synced_at_ms ?? null)
              : now();
        rows[id] = { id, row, version, dirty, synced_at_ms: synced };
      });
    },

    async setMeta(table, id, { version, dirty, syncedAtMs }) {
      return mutateDoc((doc) => {
        const rec = tableOf(doc, table)[id];
        if (!rec) return false;
        if (version !== undefined) rec.version = version;
        if (dirty !== undefined) rec.dirty = dirty;
        if (syncedAtMs !== undefined) rec.synced_at_ms = syncedAtMs;
        return true;
      });
    },

    async del(table, id) {
      await mutateDoc((doc) => {
        delete tableOf(doc, table)[id];
      });
    },

    async all(table) {
      return readDoc((doc) => Object.values(tableOf(doc, table)).map((r) => r.row));
    },

    async getCursor(scope = "global") {
      return readDoc((doc) => doc.meta[`cursor:${scope}`]?.value ?? 0);
    },

    async setCursor(cursor, scope = "global") {
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("sync cursor must be a non-negative safe integer");
      }
      return mutateDoc((doc) => {
        const cursorKey = `cursor:${scope}`;
        const current = doc.meta[cursorKey];
        if (current && cursor < current.value) {
          throw new Error("sync cursor cannot move backwards");
        }
        doc.meta[cursorKey] = { value: cursor, synced_at_ms: now() };
        return cursor;
      });
    },

    async markSynced(scope = "global") {
      const at = now();
      await mutateDoc((doc) => {
        doc.meta[`synced:${scope}`] = { value: at };
      });
      return at;
    },

    async syncInfo(scope = "global") {
      return readDoc((doc) => {
        const cursorRec = doc.meta[`cursor:${scope}`];
        const syncedRec = doc.meta[`synced:${scope}`];
        const stamps = [cursorRec?.synced_at_ms, syncedRec?.value].filter(
          (v) => typeof v === "number",
        );
        return {
          cursor: cursorRec?.value ?? 0,
          lastSyncedAtMs: stamps.length > 0 ? Math.max(...stamps) : null,
        };
      });
    },

    async getHlcState() {
      return readDoc((doc) => {
        const rec = doc.meta["hlc:global"];
        return rec ? { wallMs: rec.wallMs ?? 0, counter: rec.counter ?? 0 } : null;
      });
    },

    async setHlcState({ wallMs, counter }) {
      await mutateDoc((doc) => {
        doc.meta["hlc:global"] = { wallMs, counter };
      });
    },

    _now: now,
    _mutateDoc: mutateDoc,
    _readDoc: readDoc,
    _tableOf: tableOf,
    close() {
      closed = true;
    },
  };
  return store;
}

/**
 * The durable optimistic write-queue over a `openWebStorageStore` store — the
 * same contract and settlement semantics as store.mjs's `makeQueue`.
 */
export function makeWebStorageQueue(store) {
  const { _mutateDoc: mutateDoc, _readDoc: readDoc, _tableOf: tableOf } = store;
  if (!mutateDoc || !readDoc) {
    throw new TypeError("makeWebStorageQueue needs a store from openWebStorageStore");
  }
  const now = store._now ?? (() => Date.now());
  const rowWritesOf = (doc, table, id, exceptSeq) =>
    doc.queue.items.filter(
      (item) => item.table === table && item.id === id && item.seq !== exceptSeq,
    );
  const takeSeq = (doc) => {
    const seq = doc.queue.nextSeq;
    doc.queue.nextSeq += 1;
    return seq;
  };

  return {
    async enqueue(write) {
      return mutateDoc((doc) => {
        const seq = takeSeq(doc);
        doc.queue.items.push({ ...write, seq, attempts: 0 });
        return seq;
      });
    },

    async enqueueOptimistic(write, row, { hlcState } = {}) {
      return mutateDoc((doc) => {
        const rows = tableOf(doc, write.table);
        if (write.op === "delete") {
          delete rows[write.id];
        } else {
          rows[write.id] = {
            id: write.id,
            row,
            version: write.base_version,
            dirty: true,
            synced_at_ms: rows[write.id]?.synced_at_ms ?? null,
          };
        }
        if (hlcState) doc.meta["hlc:global"] = { ...hlcState };
        const seq = takeSeq(doc);
        doc.queue.items.push({ ...write, seq, attempts: 0 });
        return seq;
      });
    },

    async list() {
      return readDoc((doc) => doc.queue.items.map((item) => ({ ...item })));
    },

    async remove(seq) {
      await mutateDoc((doc) => {
        doc.queue.items = doc.queue.items.filter((item) => item.seq !== seq);
      });
    },

    async settleAck(table, id, seq, committedVersion) {
      return mutateDoc((doc) => {
        const write = doc.queue.items.find((item) => item.seq === seq);
        if (!write) return "Missing";
        if (write.table !== table || write.id !== id) {
          throw new Error("queued write identity changed before acknowledgement");
        }
        const rows = tableOf(doc, table);
        const rec = rows[id];
        const others = rowWritesOf(doc, table, id, seq);
        for (const candidate of others) {
          if (candidate.seq < seq) {
            candidate.superseded_version = Math.max(
              candidate.superseded_version ?? Number.MIN_SAFE_INTEGER,
              committedVersion,
            );
          }
        }
        let outcome = "Superseded";
        if (rec) {
          if (rec.version <= committedVersion) {
            rec.version = committedVersion;
            rec.synced_at_ms = now();
            outcome = { Adopt: committedVersion };
          }
          rec.dirty = others.length > 0;
        }
        doc.queue.items = doc.queue.items.filter((item) => item.seq !== seq);
        return outcome;
      });
    },

    async adoptEcho(event, seq) {
      return mutateDoc((doc) => {
        const echo = doc.queue.items.find((item) => item.seq === seq);
        if (!echo) return false;
        if (echo.table !== event.table || echo.id !== event.id) {
          throw new Error("queued echo identity changed before reconciliation");
        }
        const rows = tableOf(doc, event.table);
        const rec = rows[event.id];
        const remaining = rowWritesOf(doc, event.table, event.id, seq);
        const hasNewerLocalWrite = remaining.some((item) => item.seq > seq);
        const echoWasSuperseded =
          Number.isSafeInteger(echo.superseded_version) &&
          echo.superseded_version >= event.version;

        if (echoWasSuperseded) {
          if (rec) rec.dirty = remaining.length > 0;
        } else if (!hasNewerLocalWrite) {
          if (!rec || event.version >= rec.version) {
            if (event.op === "delete") {
              delete rows[event.id];
            } else {
              rows[event.id] = {
                id: event.id,
                row: event.row,
                version: event.version,
                dirty: remaining.length > 0,
                synced_at_ms: now(),
              };
            }
          } else {
            rec.dirty = remaining.length > 0;
          }
        } else if (rec) {
          rec.version = Math.max(rec.version, event.version);
          rec.dirty = true;
        }

        for (const candidate of remaining) {
          if (candidate.seq < seq) {
            candidate.superseded_version = Math.max(
              candidate.superseded_version ?? Number.MIN_SAFE_INTEGER,
              event.version,
            );
          }
        }
        doc.queue.items = doc.queue.items.filter((item) => item.seq !== seq);
        return true;
      });
    },

    async resolveConflict(event, seqs) {
      await mutateDoc((doc) => {
        const stale = new Set(seqs);
        const rows = tableOf(doc, event.table);
        const rec = rows[event.id];
        const hasNewerLocalWrite = doc.queue.items.some(
          (item) =>
            !stale.has(item.seq) &&
            item.table === event.table &&
            item.id === event.id,
        );
        if (!hasNewerLocalWrite) {
          if (event.op === "delete") {
            delete rows[event.id];
          } else {
            rows[event.id] = {
              id: event.id,
              row: event.row,
              version: event.version,
              dirty: false,
              synced_at_ms: now(),
            };
          }
        } else if (rec) {
          rec.version = Math.max(rec.version, event.version);
          rec.dirty = true;
        }
        doc.queue.items = doc.queue.items.filter((item) => !stale.has(item.seq));
      });
    },

    async bumpAttempts(seq) {
      return mutateDoc((doc) => {
        const rec = doc.queue.items.find((item) => item.seq === seq);
        if (!rec) return 0;
        rec.attempts = (rec.attempts ?? 0) + 1;
        return rec.attempts;
      });
    },
  };
}
