# sdk — `@fiducia/sync`

The TypeScript-typed browser half of the local-first sync SDK: a thin,
build-step-free ESM shim that wraps the `fiducia-sync-core` WASM (built from the
repo's Rust crate) and owns all the browser IO the core deliberately avoids.

- `src/` — the shim: migration-safe IndexedDB or explicitly selected
  localStorage persistence, a durable write queue with atomic
  local/ack/echo/conflict transitions, policy-driven local-queue, optimistic,
  and pessimistic writes, a privacy-safe OpenTelemetry bridge, both transports
  (Supabase realtime + backend WS/SSE), the wasm adapter, `startSync`, and the
  htmx optimistic extension.
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

Every `write()` selects enum values for `strategy`, `failure_mode`, and
`telemetry`; a client default, per-table/operation resolver, and per-call
override are supported. `optimisticWrite()` and `optimisticDelete()` remain
compatibility wrappers. `startSync()` defaults to IndexedDB and accepts
`persistence: "local_storage"` or the explicit
`"indexeddb_with_local_storage_fallback"` mode for constrained WebViews.

Replica `created_at_ms`, `updated_at_ms`, and `synced_at_ms` are local metadata;
only the server-owned row `version` participates in conflict resolution. See
[`../docs/write-policies-and-replication.md`](../docs/write-policies-and-replication.md).
