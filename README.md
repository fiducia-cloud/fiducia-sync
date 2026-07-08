# fiducia-sync → `@fiducia/sync`

The local-first sync SDK for fiducia.cloud. Optimistic reads/writes against an
IndexedDB store, reconciled with Postgres over **two transports** — Supabase
realtime **and** the backend's own WS/HTTP — so sync never depends on a single
channel. Published as the npm package `@fiducia/sync`.

## Shape: Rust core → WASM, thin TS shim

The correctness-critical logic lives in **`fiducia-sync-core`** (this crate) —
version reconciliation, conflict policy, and the optimistic write-queue ack
rules, with **zero IO**. It builds:

- **native** (`cargo test`) — verified here, and reusable **server-side** so the
  Rust backends and the browser agree on one sync protocol; and
- **wasm** (`--features wasm`, via `wasm-bindgen`) — the browser core.

A thin **TypeScript shim** wraps the WASM core and owns the browser IO:

```
@fiducia/sync
├── fiducia-sync-core (Rust)         # reconcile(), resolve_conflict(), on_ack(), QueuedWrite
│     └── wasm-bindgen  → pkg/       # wasm + JS glue
└── src/ (TS shim)
    ├── store.ts        # IndexedDB persistence (per-plane DB, one object store per table)
    ├── transports/
    │   ├── supabase.ts # postgres_changes → ChangeEvent
    │   └── backend.ts  # /app/ws + SSE     → ChangeEvent (fallback + write path)
    ├── queue.ts        # durable write-queue (survives reload), retry/backoff
    └── htmx.ts         # `hx-ext="fiducia-optimistic"` — intercept hx-post/hx-put:
                        #   write IndexedDB (instant DOM) → enqueue → POST backend
                        #   → reconcile on ack; offline-capable
```

## The ordering key

Every synced Postgres row carries a monotonic `version` (the `bump_row_version`
trigger in `fiducia-interfaces`). All reconcile decisions use `version` alone, so
the two transports can deliver the same change in any order and converge. Row and
change-event shapes are the generated types from `@fiducia/interfaces/db/*`.

## Reconcile rules (implemented + tested in `src/lib.rs`)

| Local state | Incoming | Result |
|---|---|---|
| none | upsert | **Apply** |
| none | delete | Ignore (nothing to delete) |
| `version` ≥ incoming | any | Ignore (stale / already-applied) |
| clean, older than incoming | any | **Apply** |
| **dirty**, older than incoming | any | **Conflict** → `resolve_conflict` (default: server wins) |

Echoes of our own in-flight write (`incoming.version == queued.base_version + 1`)
are matched via `QueuedWrite::is_echo_of` and adopted, never treated as conflicts.

## Isolation

Sync runs **per plane** — the customer client syncs the customer DB, the admin
client syncs the admin DB; same code, separate instances, data never crosses.
See `docs/repo-boundaries.md`.

## Status

- ✅ `fiducia-sync-core` — reconcile + write-queue ack rules, `cargo test` 7/7.
- ▶ wasm-bindgen wrapper + TS shim (IndexedDB, transports, hx-optimistic) — next.

## Develop

```sh
./shell cargo test          # core logic (no browser/wasm needed)
```
