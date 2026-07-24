// A compact localStorage persistence adapter for browser/WebView environments
// where IndexedDB is unavailable. The entire plane is one JSON document, so each
// mutation (row + queue intent included) is committed by one synchronous
// setItem(). Prefer IndexedDB for large datasets and multi-tab applications.

import { openStore } from "./store.mjs";

const FORMAT_VERSION = 1;

function replicaRecord(existing, id, row, version, dirty, { synced = false } = {}) {
  const at = Date.now();
  const record = {
    id,
    row,
    version,
    dirty,
    created_at_ms: existing?.created_at_ms ?? at,
    updated_at_ms: at,
  };
  const syncedAt = synced ? at : existing?.synced_at_ms;
  if (syncedAt !== undefined) record.synced_at_ms = syncedAt;
  return record;
}

function touch(record, { version, dirty, synced = false } = {}) {
  const at = Date.now();
  if (version !== undefined) record.version = version;
  if (dirty !== undefined) record.dirty = dirty;
  record.created_at_ms ??= at;
  record.updated_at_ms = at;
  if (synced) record.synced_at_ms = at;
  return record;
}

function freshState() {
  return {
    format: FORMAT_VERSION,
    revision: 0,
    next_seq: 1,
    rows: [],
    queue: [],
    cursors: [],
  };
}

function rowIndex(state, table, id) {
  return state.rows.findIndex(
    (record) => record.table === table && record.id === id,
  );
}

function rowRecord(state, table, id) {
  const index = rowIndex(state, table, id);
  return index < 0 ? undefined : state.rows[index];
}

function putRow(state, table, record) {
  const index = rowIndex(state, table, record.id);
  const stored = { table, ...record };
  if (index < 0) state.rows.push(stored);
  else state.rows[index] = stored;
}

function deleteRow(state, table, id) {
  const index = rowIndex(state, table, id);
  if (index >= 0) state.rows.splice(index, 1);
}

/**
 * Open a small-dataset localStorage-backed store with the same public contract
 * as openStore(). `storage` is injectable for WebView wrappers and tests.
 */
export async function openLocalStorageStore(
  dbName,
  tables,
  { storage = globalThis.localStorage } = {},
) {
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function"
  ) {
    throw new Error("localStorage persistence is unavailable");
  }
  const configuredTables = new Set(tables);
  const storageKey = `fiducia-sync:${dbName}`;

  function assertTable(table) {
    if (!configuredTables.has(table)) {
      throw new Error(`sync table is not configured: ${table}`);
    }
  }

  function load() {
    const raw = storage.getItem(storageKey);
    if (raw == null) return freshState();
    const state = JSON.parse(raw);
    if (
      !state ||
      state.format !== FORMAT_VERSION ||
      !Array.isArray(state.rows) ||
      !Array.isArray(state.queue) ||
      !Array.isArray(state.cursors)
    ) {
      throw new Error(`localStorage sync state for ${dbName} is incompatible`);
    }
    return state;
  }

  function update(operation) {
    const state = load();
    const result = operation(state);
    state.revision = (state.revision ?? 0) + 1;
    storage.setItem(storageKey, JSON.stringify(state));
    return result;
  }

  const queue = {
    async enqueue(write) {
      return update((state) => {
        const seq = state.next_seq++;
        state.queue.push({ ...write, attempts: 0, seq });
        return seq;
      });
    },

    async enqueueOptimistic(write, row) {
      assertTable(write.table);
      return update((state) => {
        const existing = rowRecord(state, write.table, write.id);
        if (write.op === "delete") deleteRow(state, write.table, write.id);
        else {
          putRow(
            state,
            write.table,
            replicaRecord(
              existing,
              write.id,
              row,
              write.base_version,
              true,
            ),
          );
        }
        const seq = state.next_seq++;
        state.queue.push({ ...write, attempts: 0, seq });
        return seq;
      });
    },

    async list() {
      return load().queue;
    },

    async remove(seq) {
      update((state) => {
        state.queue = state.queue.filter((write) => write.seq !== seq);
      });
    },

    async settleAck(table, id, seq, committedVersion) {
      assertTable(table);
      return update((state) => {
        const write = state.queue.find((candidate) => candidate.seq === seq);
        if (!write) return "Missing";
        if (write.table !== table || write.id !== id) {
          throw new Error("queued write identity changed before acknowledgement");
        }
        const other = state.queue.filter(
          (candidate) =>
            candidate.seq !== seq &&
            candidate.table === table &&
            candidate.id === id,
        );
        for (const candidate of other) {
          if (candidate.seq < seq) {
            candidate.superseded_version = Math.max(
              candidate.superseded_version ?? Number.MIN_SAFE_INTEGER,
              committedVersion,
            );
          }
        }
        const record = rowRecord(state, table, id);
        let outcome = "Superseded";
        if (record) {
          if (record.version <= committedVersion) {
            record.version = committedVersion;
            outcome = { Adopt: committedVersion };
          }
          touch(record, { dirty: other.length > 0, synced: true });
        }
        state.queue = state.queue.filter((candidate) => candidate.seq !== seq);
        return outcome;
      });
    },

    async settlePessimistic(table, id, seq, committedVersion) {
      assertTable(table);
      return update((state) => {
        const write = state.queue.find((candidate) => candidate.seq === seq);
        if (!write) return "Missing";
        if (write.table !== table || write.id !== id) {
          throw new Error("queued write identity changed before acknowledgement");
        }
        const other = state.queue.filter(
          (candidate) =>
            candidate.seq !== seq &&
            candidate.table === table &&
            candidate.id === id,
        );
        for (const candidate of other) {
          if (candidate.seq < seq) {
            candidate.superseded_version = Math.max(
              candidate.superseded_version ?? Number.MIN_SAFE_INTEGER,
              committedVersion,
            );
          }
        }
        const existing = rowRecord(state, table, id);
        const preserveNewer =
          Boolean(existing?.dirty) &&
          other.some((candidate) => candidate.seq > seq);
        let outcome;
        if (preserveNewer) {
          touch(existing, {
            version: Math.max(existing.version, committedVersion),
            dirty: true,
            synced: true,
          });
          outcome = "Superseded";
        } else if (write.op === "delete") {
          deleteRow(state, table, id);
          outcome = { Adopt: committedVersion };
        } else {
          putRow(
            state,
            table,
            replicaRecord(
              existing,
              id,
              write.payload,
              committedVersion,
              other.length > 0,
              { synced: true },
            ),
          );
          outcome = { Adopt: committedVersion };
        }
        state.queue = state.queue.filter((candidate) => candidate.seq !== seq);
        return outcome;
      });
    },

    async adoptEcho(event, seq) {
      assertTable(event.table);
      return update((state) => {
        const echo = state.queue.find((candidate) => candidate.seq === seq);
        if (!echo) return false;
        if (echo.table !== event.table || echo.id !== event.id) {
          throw new Error("queued echo identity changed before reconciliation");
        }
        const remaining = state.queue.filter(
          (candidate) =>
            candidate.seq !== seq &&
            candidate.table === event.table &&
            candidate.id === event.id,
        );
        const newer = remaining.some((candidate) => candidate.seq > seq);
        const superseded =
          Number.isSafeInteger(echo.superseded_version) &&
          echo.superseded_version >= event.version;
        const existing = rowRecord(state, event.table, event.id);
        if (superseded) {
          if (existing) {
            touch(existing, { dirty: remaining.length > 0, synced: true });
          }
        } else if (!newer) {
          if (!existing || event.version >= existing.version) {
            if (event.op === "delete") deleteRow(state, event.table, event.id);
            else {
              putRow(
                state,
                event.table,
                replicaRecord(
                  existing,
                  event.id,
                  event.row,
                  event.version,
                  remaining.length > 0,
                  { synced: true },
                ),
              );
            }
          } else {
            touch(existing, { dirty: remaining.length > 0, synced: true });
          }
        } else if (existing) {
          touch(existing, {
            version: Math.max(existing.version, event.version),
            dirty: true,
            synced: true,
          });
        }
        for (const candidate of remaining) {
          if (candidate.seq < seq) {
            candidate.superseded_version = Math.max(
              candidate.superseded_version ?? Number.MIN_SAFE_INTEGER,
              event.version,
            );
          }
        }
        state.queue = state.queue.filter((candidate) => candidate.seq !== seq);
        return true;
      });
    },

    async resolveConflict(event, seqs) {
      assertTable(event.table);
      update((state) => {
        const stale = new Set(seqs);
        const newer = state.queue.some(
          (write) =>
            !stale.has(write.seq) &&
            write.table === event.table &&
            write.id === event.id,
        );
        const existing = rowRecord(state, event.table, event.id);
        if (!newer) {
          if (event.op === "delete") deleteRow(state, event.table, event.id);
          else {
            putRow(
              state,
              event.table,
              replicaRecord(
                existing,
                event.id,
                event.row,
                event.version,
                false,
                { synced: true },
              ),
            );
          }
        } else if (existing) {
          touch(existing, {
            version: Math.max(existing.version, event.version),
            dirty: true,
            synced: true,
          });
        }
        state.queue = state.queue.filter((write) => !stale.has(write.seq));
      });
    },

    async bumpAttempts(seq) {
      return update((state) => {
        const write = state.queue.find((candidate) => candidate.seq === seq);
        if (!write) return 0;
        write.attempts = (write.attempts ?? 0) + 1;
        return write.attempts;
      });
    },
  };

  return {
    storageKind: "local_storage",
    async get(table, id) {
      assertTable(table);
      return rowRecord(load(), table, id)?.row ?? null;
    },
    async meta(table, id) {
      assertTable(table);
      const record = rowRecord(load(), table, id);
      return record
        ? { version: record.version, dirty: Boolean(record.dirty) }
        : null;
    },
    async replicaMeta(table, id) {
      assertTable(table);
      const record = rowRecord(load(), table, id);
      if (!record) return null;
      return {
        version: record.version,
        dirty: Boolean(record.dirty),
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
        ...(record.synced_at_ms === undefined
          ? {}
          : { synced_at_ms: record.synced_at_ms }),
      };
    },
    async put(table, id, row, { version, dirty = false }) {
      assertTable(table);
      update((state) => {
        const existing = rowRecord(state, table, id);
        putRow(
          state,
          table,
          replicaRecord(existing, id, row, version, dirty, {
            synced: !dirty,
          }),
        );
      });
    },
    async setMeta(table, id, { version, dirty }) {
      assertTable(table);
      return update((state) => {
        const record = rowRecord(state, table, id);
        if (!record) return false;
        touch(record, { version, dirty, synced: dirty === false });
        return true;
      });
    },
    async del(table, id) {
      assertTable(table);
      update((state) => deleteRow(state, table, id));
    },
    async all(table) {
      assertTable(table);
      return load()
        .rows.filter((record) => record.table === table)
        .map((record) => record.row);
    },
    async getCursor(scope = "global") {
      return load().cursors.find((cursor) => cursor.scope === scope)?.value ?? 0;
    },
    async setCursor(cursor, scope = "global") {
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new Error("sync cursor must be a non-negative safe integer");
      }
      return update((state) => {
        const current = state.cursors.find((entry) => entry.scope === scope);
        if (current && cursor < current.value) {
          throw new Error("sync cursor cannot move backwards");
        }
        if (current) current.value = cursor;
        else state.cursors.push({ scope, value: cursor });
        return cursor;
      });
    },
    _queueApi: queue,
    close() {},
  };
}

/**
 * Select browser persistence with an enum, never a boolean capability switch.
 * Fallback is explicit because switching stores can expose an older local
 * snapshot if IndexedDB becomes temporarily blocked.
 */
export async function openBrowserStore(
  dbName,
  tables,
  {
    persistence = "indexeddb",
    storage,
    onFallback,
  } = {},
) {
  if (persistence === "indexeddb") return openStore(dbName, tables);
  if (persistence === "local_storage") {
    return openLocalStorageStore(dbName, tables, { storage });
  }
  if (persistence !== "indexeddb_with_local_storage_fallback") {
    throw new TypeError(`unsupported browser persistence mode: ${persistence}`);
  }
  try {
    return await openStore(dbName, tables);
  } catch (error) {
    onFallback?.(error);
    return openLocalStorageStore(dbName, tables, { storage });
  }
}
