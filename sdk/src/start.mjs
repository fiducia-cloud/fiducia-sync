// startSync — the one-call bring-up that wires BOTH transports into a SINGLE
// reconcile client, per plane. This is how Supabase realtime and the backend WS
// are meant to be used together: they feed the same client.applyChange(), and
// because reconcile is idempotent (a re-seen version is Ignored) it does not
// matter if both transports deliver the same change, or in what order.
//
// On every (re)connect — WS "open" or Supabase "SUBSCRIBED" — we run catch-up
// hydration (fetch authoritative rows over HTTP and reconcile them) so anything
// missed while offline lands, and we flush the durable write-queue.

import { openStore, makeQueue } from "./store.mjs";
import { loadBrowserCore } from "./core.mjs";
import { makeSyncClient } from "./client.mjs";
import { emitEvent, normalizeTelemetry } from "./telemetry.mjs";
import { connectBackend, makeBackendSend } from "./transports/backend.mjs";
import { isChangeEvent } from "./transports/decode.mjs";
import { subscribeSupabase } from "./transports/supabase.mjs";

/**
 * @param {object} o
 * @param {string}   o.dbName            per-plane IndexedDB name ("fiducia-customer"/"fiducia-admin")
 * @param {string[]} o.tables            synced tables
 * @param {object}   [o.core]            a wrapped core; defaults to loadBrowserCore()
 * @param {object|false} [o.backend]     { baseUrl, wsPath?, ssePath?, pathPrefix?, getToken?, csrfToken?, streamAuth? }
 * @param {object|false} [o.supabase]    { client, filter?, channelName? }
 * @param {(table:string)=>Promise<object[]>} [o.hydrateFetch] catch-up snapshot fetch
 * @param {(cursor:number,limit:number)=>Promise<{changes:object[],next_cursor:number,has_more:boolean}>} [o.pullFetch]
 *   incremental Postgres/Supabase cursor fetch; the cursor advances only after
 *   every change in a page has reconciled durably
 * @param {(status:string, err?:Error)=>void} [o.onStatus]
 * @param {object|Function} [o.telemetry] OpenTelemetry-adaptable sink (telemetry.mjs)
 * @param {"local-only"|"local-first"|"server-first"|"server-only"} [o.writePolicy]
 *   client-wide default write policy (per-write options still override)
 * @param {"return"|"throw"|"emit"} [o.errorMode] client-wide default error mode
 * @param {boolean} [o.hydratePrune=true] treat hydrate snapshots as the complete set
 * @param {string} [o.cursorScope="global"] durable cursor namespace
 * @param {number} [o.pullPageSize=500] incremental page size
 * @returns {Promise<{client,store,queue,send,hydrate,pull,stop}>}
 */
export async function startSync({
  dbName,
  tables,
  core,
  backend,
  supabase,
  hydrateFetch,
  pullFetch,
  onStatus,
  telemetry,
  writePolicy,
  errorMode,
  hydratePrune = true,
  cursorScope = "global",
  pullPageSize = 500,
}) {
  const resolvedCore = core ?? (await loadBrowserCore());
  const store = await openStore(dbName, tables);
  const queue = makeQueue(store);
  const observe = normalizeTelemetry(telemetry);
  const client = makeSyncClient({
    store,
    queue,
    core: resolvedCore,
    telemetry: observe,
    ...(writePolicy !== undefined ? { writePolicy } : {}),
    ...(errorMode !== undefined ? { errorMode } : {}),
  });
  const stops = [];

  const report = (status, error) => {
    emitEvent(observe, "fiducia.sync.status", {
      atMs: Date.now(),
      attributes: { "sync.status": status },
      error: error ?? undefined,
    });
    if (onStatus) onStatus(status, error);
    else if (error) console.error(`[fiducia-sync] ${status}: ${error.message ?? String(error)}`);
  };

  const send = backend
    ? makeBackendSend(backend.baseUrl, {
        pathPrefix: backend.pathPrefix,
        getToken: backend.getToken,
        csrfToken: backend.csrfToken,
      })
    : undefined;

  let hydrating = false;
  async function pullAll() {
    if (!pullFetch) return;
    const startedAt = Date.now();
    try {
      const applied = await pullAllPages();
      emitEvent(observe, "fiducia.sync.pull", {
        atMs: startedAt,
        durationMs: Date.now() - startedAt,
        attributes: { "sync.applied": applied ?? 0, "sync.scope": cursorScope },
      });
    } catch (error) {
      emitEvent(observe, "fiducia.sync.pull", {
        atMs: startedAt,
        durationMs: Date.now() - startedAt,
        attributes: { "sync.scope": cursorScope },
        error,
      });
      throw error;
    }
  }

  async function pullAllPages() {
    if (!Number.isSafeInteger(pullPageSize) || pullPageSize < 1 || pullPageSize > 1000) {
      throw new Error("pullPageSize must be an integer between 1 and 1000");
    }
    let applied = 0;
    let cursor = await store.getCursor(cursorScope);
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      const page = await pullFetch(cursor, pullPageSize);
      if (
        !page ||
        typeof page !== "object" ||
        !Array.isArray(page.changes) ||
        !Number.isSafeInteger(page.next_cursor) ||
        page.next_cursor < cursor ||
        typeof page.has_more !== "boolean"
      ) {
        throw new Error("incremental sync returned an invalid cursor page");
      }
      if (
        (page.has_more || page.changes.length > 0) &&
        page.next_cursor === cursor
      ) {
        throw new Error("incremental sync cursor made no progress");
      }
      for (const change of page.changes) {
        if (!isChangeEvent(change)) {
          throw new Error("incremental sync page contains an invalid change event");
        }
        await client.applyChange(change);
        applied += 1;
      }
      // Applying first and advancing second makes a crash replay the page.
      // Reconciliation is idempotent, so replay is safe; skipping is not.
      await store.setCursor(page.next_cursor, cursorScope);
      cursor = page.next_cursor;
      if (!page.has_more) return applied;
    }
    throw new Error("incremental sync exceeded the catch-up page limit");
  }

  async function hydrateAll() {
    if ((!hydrateFetch && !pullFetch) || hydrating) return;
    hydrating = true;
    try {
      try {
        await pullAll();
      } catch (e) {
        report("pull-error", e);
        return;
      }
      let hydrated = true;
      for (const table of tables) {
        if (!hydrateFetch) break;
        try {
          const rows = await hydrateFetch(table);
          await client.hydrate(table, rows, { prune: hydratePrune });
        } catch (e) {
          hydrated = false;
          report("hydrate-error", e);
        }
      }
      // A fully successful catch-up stamps plane-level sync freshness
      // (store.syncInfo(cursorScope).lastSyncedAtMs).
      if (hydrated && typeof store.markSynced === "function") {
        try {
          await store.markSynced(cursorScope);
        } catch (e) {
          report("mark-synced-error", e);
        }
      }
    } finally {
      hydrating = false;
    }
  }

  const applyIncoming = (change) => {
    void client.applyChange(change).catch((error) => {
      report("apply-error", error);
    });
  };

  const flushQueued = () => {
    if (!send) return;
    void client.flushQueue(send).catch((error) => {
      report("flush-error", error);
    });
  };

  if (backend) {
    let conn;
    try {
      conn = connectBackend({
        baseUrl: backend.baseUrl,
        wsPath: backend.wsPath,
        ssePath: backend.ssePath,
        getToken: backend.getToken,
        streamAuth: backend.streamAuth,
        onChanges: (changes) => {
          for (const change of changes) applyIncoming(change);
        },
        onStatus: (status, error) => {
          report(`backend:${status}`, error);
          if (status === "open") {
            void hydrateAll();
            flushQueued();
          }
        },
      });
    } catch (error) {
      store.close();
      throw error;
    }
    stops.push(() => conn.stop());
  }

  if (supabase) {
    const sub = subscribeSupabase({
      client: supabase.client,
      tables,
      filter: supabase.filter,
      channelName: supabase.channelName,
      onChange: applyIncoming,
      onStatus: (s, error) => {
        report(`supabase:${s}`, error);
        if (s === "SUBSCRIBED") void hydrateAll();
      },
    });
    stops.push(() => sub.stop());
  }

  // Safety-net initial hydrate (covers the no-transport / HTTP-only case).
  await hydrateAll();

  return {
    client,
    store,
    queue,
    send,
    hydrate: hydrateAll,
    pull: pullAll,
    stop() {
      for (const s of stops) {
        try {
          s();
        } catch (error) {
          report("stop-error", error);
        }
      }
      store.close();
    },
  };
}
