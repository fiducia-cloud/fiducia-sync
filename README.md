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

A thin **JS shim** (ESM `.mjs`, no build step) wraps the WASM core and owns the
browser IO:

```
@fiducia/sync
├── fiducia-sync-core (Rust)         # reconcile(), resolve_conflict(), on_ack(), QueuedWrite
│     └── wasm-bindgen  → pkg/       # wasm + JS glue
└── sdk/src/ (JS shim)
    ├── store.mjs       # IndexedDB persistence + the durable write-queue (per-plane DB,
    │                   #   one object store per table, `_queue` store survives reload)
    ├── client.mjs      # applyChange / optimisticWrite / optimisticDelete / flushQueue / hydrate
    ├── start.mjs       # startSync() — wire BOTH transports into one client (see below)
    ├── core.mjs        # wraps the wasm ABI (JSON in/out) as object-in/out JS
    ├── transports/
    │   ├── supabase.mjs # postgres_changes → ChangeEvent (with RLS-complementing filter)
    │   ├── backend.mjs  # WS (+ SSE fallback, auto-reconnect) reads; idempotent write path
    │   └── decode.mjs   # pure payload → ChangeEvent decoders
    └── htmx.mjs        # `hx-ext="fiducia-optimistic"` — intercept hx-post/hx-put:
                        #   write IndexedDB (instant DOM) → enqueue → POST backend
                        #   → reconcile on ack; offline-capable
```

## The ordering key

Every synced Postgres row carries a monotonic `version` (the `bump_row_version`
trigger in `fiducia-interfaces` — note it advances on UPDATE; INSERT lands at the
`default 1`). All reconcile decisions use `version` alone, so the two transports
can deliver the same change in any order and converge — duplicate delivery is a
no-op (a re-seen version is Ignored). Row shapes are the generated types from
`@fiducia/interfaces/db/*`; the `{table, op, id, version, row, at_ms}` change
envelope is this SDK's contract (it is distinct from the KV/election `ChangeEvent`
in `@fiducia/interfaces`).

### Supabase requires `REPLICA IDENTITY FULL`

Supabase realtime only includes the full row (with `version`) when the table is
`REPLICA IDENTITY FULL`. Without it, DELETE events carry only the primary key —
no `version` — so `decodeSupabaseChange` returns `null` rather than fabricate a
stale `version: 0` (which would silently drop the delete). The publication +
`REPLICA IDENTITY FULL` + RLS tenant policies live in `fiducia-interfaces`
(`sql/{customer,admin}.sql`). The backend WS frame always carries `version`, so
it is the reliable delete path even when a table is not yet FULL.

## Wiring both transports: `startSync`

`startSync` brings up one reconcile client per plane fed by **both** Supabase
realtime and the backend WS, and re-hydrates (catch-up) on every (re)connect:

```js
const sync = await startSync({
  dbName: "fiducia-customer",
  tables: ["api_keys"],
  backend:  { baseUrl: location.origin, getToken },           // WS reads + idempotent writes
  supabase: { client: supabaseClient, filter: `org_id=eq.${orgId}` }, // realtime, tenant-scoped
  hydrateFetch: (t) => fetch(`/api/customer/${t}`).then((r) => r.json()),
});
// sync.client.optimisticWrite(...), sync.send, sync.stop()
```

Writes carry a stable `Idempotency-Key` (`table:id:op:base_version`) so retried /
queued POSTs never double-apply, and an optional bearer token (Authorization on
fetch; `?access_token=` on WS/SSE, which can't set headers).

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

## Security & hardening

- **Dependency audit.** `cargo audit` is **clean** — no advisories across the 20
  resolved dependencies (`serde`, `serde_json`, and the optional `wasm-bindgen`
  tree). No accepted/ignored advisories.
- **Zero IO, no `unsafe`.** The core is pure decision logic — no filesystem,
  network, threads, or `unsafe` blocks. `unwrap()` appears only in `#[cfg(test)]`
  code, never on a runtime path.
- **Untrusted input at the wasm boundary.** `src/wasm.rs` is the only surface
  that sees untrusted bytes (JSON from the browser). Every parse goes through
  `serde_json::from_str(...).map_err(err)?`, so malformed input returns a
  `JsError` to the caller rather than panicking. Reconcile decisions are total
  over any `i64` `version`, so a hostile or stale change cannot wedge the engine.
- **No secrets, no logging.** The crate holds no credentials and emits no logs;
  tokens (bearer / `access_token`) live only in the JS shim's transport layer.
- **No env-var config surface.** This crate exposes no environment-variable or
  CLI configuration — it is a library linked into the wasm bundle and the Rust
  backends — so there is nothing here for the `flags-2-env` launcher to wrap.

## Status

- ✅ `fiducia-sync-core` — reconcile + write-queue ack rules, `cargo test` 7/7.
- ✅ wasm-bindgen bindings (`src/wasm.rs`) — `wasm-pack build` produces `pkg/`.
- ✅ JS shim — IndexedDB store + durable queue, both transports, hx-optimistic
  extension, `startSync`, catch-up hydration, idempotent/authed writes,
  WS auto-reconnect. `node --test` 20/20.

## Develop

```sh
./shell cargo test          # core logic (no browser/wasm needed)

# Browser WASM package. Needs a rustup toolchain WITH the wasm32-unknown-unknown
# target — a Homebrew-only rustc will not work (no wasm std in its sysroot). If
# `rustc` resolves to Homebrew, put the rustup toolchain first, e.g.:
#   PATH="$(dirname "$(rustup which rustc)"):$PATH" wasm-pack build ...
wasm-pack build --target bundler --out-dir pkg -- --features wasm
```

The `pkg/` output (gitignored) is the wasm module the TS shim imports.
