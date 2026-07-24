# Write policies, timestamps, and replication authority

## Client write policy

Every write selects enum values; there is no optimism boolean:

| `strategy` | Local visibility | Network behavior |
| --- | --- | --- |
| `local_queue` | Apply immediately and mark dirty | Persist the retry intent and return; reconnect/`flushQueue` sends it |
| `optimistic` | Apply immediately and mark dirty | Send immediately; acknowledgement clears dirty |
| `pessimistic` | Keep the current authoritative row visible | Persist intent, send, then reveal the acknowledged payload |

`failure_mode` is `return_result`, `throw_error`, or `emit_only`. A failed send
always persists its retry count before applying that caller-facing behavior.
`telemetry` is `off`, `errors`, `lifecycle`, or `verbose`. Applications may set
one default, resolve a policy per table/operation, or override one write.

The JavaScript and Dart OpenTelemetry bridges use the low-cardinality operation
name `fiducia.sync.write` and database attributes such as `db.system.name`,
`db.collection.name`, and `db.operation.name`. Row ids, payloads, idempotency
keys, and error messages are excluded.

## Local persistence

Browser persistence is selected with `indexeddb`, `local_storage`, or
`indexeddb_with_local_storage_fallback`. IndexedDB is the default and the right
choice for normal or multi-tab datasets. The localStorage adapter commits the
plane's small row/queue document with one `setItem` and is intended for constrained
WebViews or an explicitly selected fallback. Because changing stores can expose
an older snapshot after a temporary IndexedDB failure, fallback is never a
boolean and is not silently enabled.

Flutter uses SQLite schema version 2. Row mutation plus queue intent,
acknowledgement plus queue retirement, and conflict resolution are transactions.

## Timestamp contract

Postgres owns business-row timestamps:

- `created_at` is stamped on insert and preserved on every update, even if an
  ORM or REST payload supplies another value.
- `updated_at` advances strictly on every update. The trigger uses the greater
  of the wall clock and the prior value plus one microsecond.
- `version` is the authoritative per-row conflict and compare-and-swap clock.
- `sync_sequence` is the plane-wide, transactionally ordered catch-up cursor.

Each device separately stores `created_at_ms`, `updated_at_ms`, and optional
`synced_at_ms` for its replica record. These describe when that device first
stored, locally changed, and last durably adopted authoritative state. They are
observability/UI metadata only. `synced_at_ms` is never sent as a conflict clock,
and wall-clock last-writer-wins is not used.

## Supabase and Postgres

In the supported topology, Supabase is the Postgres authority and Realtime is
one delivery transport for that same committed database. Backend HTTP writes,
the global pull cursor, WebSocket/SSE, and Supabase Realtime all converge on the
same `version` and tombstone history. This is not two databases synchronizing
with each other.

A separate Postgres primary writing bidirectionally is a different,
explicitly-causal design. It needs at least stable replica/origin identity,
globally unique change ids, a hybrid-logical or vector causal revision,
idempotent journal exchange, tombstone retention, and a declared conflict/CRDT
policy. Until that metadata and protocol exist, do not configure active/active
writers or infer order from `updated_at`/`synced_at`.

## Schema boundary

`fiducia-interfaces/schema/*.schema.json` (Draft 2020-12) is the wire/I/O source
of truth. TypeScript's Zod-compatible schemas delegate exact validation to AJV
2020, Rust uses the `jsonschema` Draft 2020-12 validator with external resolving
disabled, and generated Dart embeds the canonical bundle plus its tested
validator. No converter copies schemas from another repository.

Database row types are generated separately from the canonical SQL DDL. Validate
untrusted REST, realtime, and queued blobs against JSON Schema at ingress/egress;
use SQL-generated row types at the ORM boundary. A row type and a public wire
projection are not assumed to be interchangeable.
