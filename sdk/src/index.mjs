// @fiducia/sync — local-first sync SDK.
//
// Browser usage (per plane):
//   import { openStore, makeQueue, makeSyncClient, loadBrowserCore } from "@fiducia/sync";
//   const store  = await openStore("fiducia-customer", ["api_keys","customer_preferences"]);
//   const queue  = makeQueue(store);
//   const core   = await loadBrowserCore();        // the wasm reconcile core
//   const client = makeSyncClient({ store, queue, core });
//   // feed incoming changes from Supabase realtime OR the backend WS:
//   client.applyChange(changeEvent);
//   // optimistic write -> instant UI, synced to the backend:
//   client.optimisticWrite("api_keys", id, row, send);

//   // ...or wire BOTH transports into one client in a single call:
//   const sync = await startSync({
//     dbName: "fiducia-customer", tables: ["api_keys"],
//     backend: { baseUrl: location.origin, getToken, streamAuth: "cookie" },
//     supabase: { client: supabaseClient, filter: `org_id=eq.${orgId}` },
//     hydrateFetch: (table) => fetch(`/api/customer/${table}`).then((r) => r.json()),
//   });

export { openStore, makeQueue, promisify } from "./store.mjs";
export { deepMerge } from "./merge.mjs";
export { wrapCore, loadBrowserCore } from "./core.mjs";
export { makeSyncClient } from "./client.mjs";
export { startSync } from "./start.mjs";
export { connectBackend, backendSend, makeBackendSend } from "./transports/backend.mjs";
export { subscribeSupabase } from "./transports/supabase.mjs";
export { decodeBackendMessage, decodeSupabaseChange, isChangeEvent } from "./transports/decode.mjs";
export { optimisticIntent, registerOptimisticExtension } from "./htmx.mjs";
