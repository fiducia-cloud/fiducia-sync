// Admin browser bundle entry for @fiducia/sync.
//
// fiducia-admin.rs is a server-rendered Maud+htmx app with NO bundler — it vendors
// its JS as single files served via include_str! (like htmx.min.js). This entry is
// esbuild-bundled (see package.json "build:admin-bundle") into ONE self-contained
// file with the wasm inlined as bytes (no separate .wasm fetch, no CDN), which the
// admin binary serves at /assets/fiducia-sync.js.
//
// It wires @fiducia/sync to the ADMIN plane: IndexedDB db "fiducia-admin", the
// backend WS at /admin/ws, and the write path /api/admin/sync/{table}. Supabase
// realtime is not used on the admin plane (the backend WS is the transport), so
// only the backend transport is wired here.

import initWasm, * as wasm from "../../pkg-web/fiducia_sync_core.js";
// esbuild `binary` loader: imports the wasm module as a Uint8Array (inlined).
import wasmBytes from "../../pkg-web/fiducia_sync_core_bg.wasm";
import { wrapCore } from "../src/core.mjs";
import { startSync } from "../src/start.mjs";
import { registerOptimisticExtension } from "../src/htmx.mjs";

let corePromise = null;
async function loadAdminCore() {
  if (!corePromise) {
    corePromise = initWasm({ module_or_path: wasmBytes }).then(() => wrapCore(wasm));
  }
  return corePromise;
}

/**
 * Bring up admin-plane sync. Returns the startSync handle
 * ({ client, store, queue, send, hydrate, stop }).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.tables=["infra_operations"]]
 * @param {object}   [opts.htmx]   the htmx instance — if given, registers the
 *                                  `fiducia-optimistic` extension bound to this client
 * @param {()=>(string|Promise<string|null>)} [opts.getToken]  bearer for WS/writes
 * @param {(table:string)=>Promise<object[]>} [opts.hydrateFetch]  catch-up snapshot
 * @param {(status:string)=>void} [opts.onStatus]
 */
export async function initAdminSync(opts = {}) {
  const core = await loadAdminCore();
  const sync = await startSync({
    dbName: "fiducia-admin",
    tables: opts.tables ?? ["infra_operations"],
    core,
    backend: {
      baseUrl: location.origin,
      wsPath: "/admin/ws", // admin's WS path (customer default is /app/ws)
      pathPrefix: "/api/admin/sync",
      getToken: opts.getToken,
    },
    // Admin has no Supabase realtime consumer — backend WS only.
    supabase: false,
    hydrateFetch: opts.hydrateFetch,
    onStatus: opts.onStatus,
  });

  const htmx = opts.htmx ?? (typeof window !== "undefined" ? window.htmx : undefined);
  if (htmx) registerOptimisticExtension(htmx, sync.client, sync.send);
  return sync;
}

if (typeof window !== "undefined") {
  window.FiduciaSyncAdmin = { init: initAdminSync };
}
