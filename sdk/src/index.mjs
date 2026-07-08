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

export { openStore, makeQueue, promisify } from "./store.mjs";
export { wrapCore, loadBrowserCore } from "./core.mjs";
export { makeSyncClient } from "./client.mjs";
