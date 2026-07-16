# Fiducia Sync documentation

This directory records design decisions that cross the Rust sync core and the
JavaScript SDK without moving ownership into either transport or backend.

## Repository boundaries

- `fiducia-sync` owns transport-agnostic reconciliation, the local write queue,
  optimistic client state, and the SDK adapters that consume authoritative
  server events.
- `fiducia-interfaces` owns the shared database and generated interface
  contracts, including the version fields carried by sync events.
- Customer and admin services own persistence, authorization, and their
  separate databases. Sync never crosses those planes or grants access.
- Backend transports remain authoritative for committed rows; this repository
  does not own service routing, database migrations, or server authorization.

See [JSONB merge semantics](jsonb-merge.md) for the partial-update behavior and
its concurrency boundary.
