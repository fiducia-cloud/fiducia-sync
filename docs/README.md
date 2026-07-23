# Fiducia Sync documentation

This directory records design decisions shared by the Rust core/Postgres
adapter, the TypeScript browser SDK, and the Dart/Flutter package.

## Repository boundaries

- `fiducia-sync` owns transport-agnostic reconciliation, the local write queue,
  optimistic client state, browser/mobile persistence, transport adapters, and
  the optional generic Postgres change-journal migration.
- `fiducia-interfaces` owns the shared database and generated interface
  contracts, including the canonical sync envelopes and domain-row version
  fields.
- Customer and admin services own persistence, authorization, and their
  separate databases. Sync never crosses those planes or grants access.
- Backend transports remain authoritative for committed rows. The generic
  migration can capture and expose authorized catch-up reads, but application
  services still own routing, domain writes, and authorization-aware write
  RPCs.

See [JSONB merge semantics](jsonb-merge.md) for the partial-update behavior and
its concurrency boundary.

See [write policies, timestamps, and replication authority](write-policies-and-replication.md)
for enum write behavior, OpenTelemetry, Supabase authority, causal multi-primary
requirements, and cross-language schema boundaries.
