# src — `fiducia-sync-core` (Rust)

The transport-agnostic, zero-IO heart of the local-first sync engine. Owns only
the correctness-critical logic — version-based reconciliation, conflict policy,
and the optimistic write-queue ack rules — so client and server can share one
sync protocol. Compiles native (for `cargo test` and server-side reuse) and to
wasm (feature `wasm`) for the browser.

- `lib.rs` — the core types and pure decision functions: `ChangeEvent`,
  `LocalRow`, `QueuedWrite`, `reconcile()`, `resolve_conflict()`, `on_ack()`, plus
  the full unit-test suite. Ordering is by a single monotonic Postgres `version`.
- `wasm.rs` — thin `wasm-bindgen` bindings (JSON string in/out) exposing
  `reconcile`, `on_ack`, and `is_own_echo` to the JS shim; compiled only under
  `--features wasm`.
