# sdk — `@fiducia/sync`

The TypeScript-typed browser half of the local-first sync SDK: a thin,
build-step-free ESM shim that wraps the `fiducia-sync-core` WASM (built from the
repo's Rust crate) and owns all the browser IO the core deliberately avoids.

- `src/` — the shim: migration-safe IndexedDB store + durable write-queue with
  atomic optimistic/ack/echo/conflict transitions, the serialized reconcile
  client, the two transports (Supabase realtime + backend WS/SSE), the wasm adapter, the
  `startSync` bring-up, and the htmx optimistic extension.
- `admin/` — esbuild entry that bundles the SDK (wasm inlined) into one file the
  `fiducia-admin.rs` server serves.
- `tests/` — `node --test` suites, run against the real node-target wasm core.
- `src/index.d.ts` — strict public declarations for every ESM export.
- `package.json` — publishable `@fiducia/sync` metadata plus the
  wasm/admin-bundle build scripts and TypeScript contract check.

The wasm reconcile logic lives in the Rust crate at the repo root (`../src`); this
package is `@fiducia/sync`, consumed by the fiducia.cloud frontends. Persisted
incremental cursors make `startSync({ pullFetch })` safe across reloads;
`FiduciaClient.syncPull()` and `syncSender()` provide directly assignable
callbacks backed by the canonical `fiducia-interfaces` envelopes.
