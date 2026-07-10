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
import { connectBackend, makeBackendSend } from "./transports/backend.mjs";
import { subscribeSupabase } from "./transports/supabase.mjs";

/**
 * @param {object} o
 * @param {string}   o.dbName            per-plane IndexedDB name ("fiducia-customer"/"fiducia-admin")
 * @param {string[]} o.tables            synced tables
 * @param {object}   [o.core]            a wrapped core; defaults to loadBrowserCore()
 * @param {object|false} [o.backend]     { baseUrl, wsPath?, ssePath?, pathPrefix?, getToken? }
 * @param {object|false} [o.supabase]    { client, filter?, channelName? }
 * @param {(table:string)=>Promise<object[]>} [o.hydrateFetch] catch-up snapshot fetch
 * @param {(status:string, err?:Error)=>void} [o.onStatus]
 * @param {boolean} [o.hydratePrune=true] treat hydrate snapshots as the complete set
 * @returns {Promise<{client,store,queue,send,hydrate,stop}>}
 */
export async function startSync({
  dbName,
  tables,
  core,
  backend,
  supabase,
  hydrateFetch,
  onStatus,
  hydratePrune = true,
}) {
  const resolvedCore = core ?? (await loadBrowserCore());
  const store = await openStore(dbName, tables);
  const queue = makeQueue(store);
  const client = makeSyncClient({ store, queue, core: resolvedCore });
  const stops = [];

  const send = backend
    ? makeBackendSend(backend.baseUrl, {
        pathPrefix: backend.pathPrefix,
        getToken: backend.getToken,
      })
    : undefined;

  let hydrating = false;
  async function hydrateAll() {
    if (!hydrateFetch || hydrating) return;
    hydrating = true;
    try {
      for (const table of tables) {
        try {
          const rows = await hydrateFetch(table);
          await client.hydrate(table, rows, { prune: hydratePrune });
        } catch (e) {
          onStatus?.("hydrate-error", e);
        }
      }
    } finally {
      hydrating = false;
    }
  }

  if (backend) {
    const conn = connectBackend({
      baseUrl: backend.baseUrl,
      wsPath: backend.wsPath,
      ssePath: backend.ssePath,
      getToken: backend.getToken,
      onChanges: (changes) => {
        for (const c of changes) void client.applyChange(c);
      },
      onStatus: (s) => {
        onStatus?.(`backend:${s}`);
        if (s === "open") {
          void hydrateAll();
          if (send) void client.flushQueue(send);
        }
      },
    });
    stops.push(() => conn.stop());
  }

  if (supabase) {
    const sub = subscribeSupabase({
      client: supabase.client,
      tables,
      filter: supabase.filter,
      channelName: supabase.channelName,
      onChange: (c) => void client.applyChange(c),
      onStatus: (s) => {
        onStatus?.(`supabase:${s}`);
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
    stop() {
      for (const s of stops) {
        try {
          s();
        } catch {
          /* best-effort */
        }
      }
      store.close();
    },
  };
}
