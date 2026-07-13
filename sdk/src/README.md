# src — the JS shim

The build-step-free ESM shim around the `fiducia-sync-core` WASM. It owns the
browser IO (storage + sockets) while all correctness-critical reconcile decisions
stay in the Rust/WASM core.

- `index.mjs` — public package entry; re-exports the API of `@fiducia/sync`.
- `core.mjs` — adapts the wasm ABI (JSON string in/out) to object-in/out JS and
  loads the browser (bundler-target) wasm.
- `store.mjs` — IndexedDB persistence: one DB per plane, one object store per
  table, plus the durable `_queue` store for optimistic writes. It
  version-upgrades existing databases when tables are added and awaits
  transaction completion.
- `client.mjs` — the reconcile client: `applyChange`, `optimisticWrite/Delete`,
  observable/durable `flushQueue`, cold-start `hydrate`. Own echoes adopt only
  committed metadata rather than replaying local payloads. Transport-agnostic.
- `start.mjs` — `startSync`, the one-call bring-up that feeds BOTH transports into
  one client per plane, with catch-up hydration + queue flush on (re)connect.
- `htmx.mjs` — the `fiducia-optimistic` htmx extension (write-through local-first
  store on `hx-post`/`hx-put`).
- `transports/` — the two change sources (Supabase realtime + backend WS/SSE) and
  the pure decoders.
