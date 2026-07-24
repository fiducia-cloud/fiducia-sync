# Timestamps: `created_at`, `updated_at`, `synced_at`, and the HLC

Distributed databases learned long ago that wall clocks lie: NTP steps them,
VMs resume them into the past, users edit them. fiducia-sync borrows three of
their disciplines so the human-facing time columns "really work all the time",
while keeping the per-row `version` and plane-wide `sync_sequence` as the ONLY
authoritative ordering keys (nothing about reconciliation reads a clock).

## Server side: monotonic `updated_at`, immutable `created_at`

`fiducia_sync.install_timestamps(table)` (in `sql/postgres/001_fiducia_sync.sql`,
mirrored at `crates/postgres/migrations/`) attaches a BEFORE INSERT/UPDATE
trigger with CockroachDB-flavored rules:

- **`updated_at` is strictly monotonic per row** —
  `greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`.
  A stepped-back system clock can never produce an `updated_at` that regresses
  or repeats, so `ORDER BY updated_at` per row is always the true edit order
  (the microsecond bump is the "logical" part of a hybrid clock).
- **`created_at` is immutable after birth** — an UPDATE that tries to rewrite
  it is silently corrected back to the original value.
- **INSERT honors caller-supplied values** so imports/backfills keep their
  history, and fills both columns when absent.

The trigger is named `zzz_fiducia_sync_timestamps` on purpose: PostgreSQL fires
same-event row triggers in name order, so it runs LAST and corrects earlier
triggers that stamp a raw `now()` (e.g. fiducia-interfaces'
`bump_row_version`). Install it next to `install_table`:

```sql
select fiducia_sync.install_table('public.notes'::regclass);
select fiducia_sync.install_timestamps('public.notes'::regclass);
```

The change journal's `changed_at` (surfaced to clients as the envelope's
`at_ms`) remains the server-side commit clock.

## Client side: `synced_at` is a replica fact

"When was this row last synced?" is a **per-device** question — CouchDB models
the same idea with per-replica checkpoints — so `synced_at` deliberately does
NOT exist server-side. Each store records it locally:

- **Per row** — `meta(table, id).syncedAtMs` (JS) / `metadata.syncedAtMs`
  (Dart): the local wall-clock moment THIS device last adopted
  server-authoritative state for the row (apply, refresh, own-echo adoption,
  ack settlement, server-wins conflict). `null` until it has. A dirty
  optimistic write **preserves** the previous stamp — editing on top of synced
  state does not un-sync it.
- **Per plane** — `store.syncInfo(scope)` → `{cursor, lastSyncedAtMs}`: every
  durable cursor advance stamps it, and `startSync` marks it after each fully
  successful catch-up (`store.markSynced(scope)`). This is the value to show
  for "Last synced 2m ago" UI and staleness alarms.

## The Hybrid Logical Clock

`src/hlc.rs` (canonical), `sdk/src/hlc.mjs`, and `dart/lib/src/hlc.dart`
implement the same HLC (Kulkarni et al. — the scheme CockroachDB uses for
transaction timestamps), pinned to the shared vectors in
`schema/fixtures/hlc-vectors.json`:

- `tick()` stamps a local event; stamps are **strictly monotonic per device**
  even when the wall clock jumps backwards.
- `observe(at_ms)` folds in every incoming server commit time, so local stamps
  always sort after the last synced server change.
- Canonical encoding is a fixed-width sortable string
  (`"0197f3b2c4d1-0003"` — 12 hex digits of Unix-ms, a dash, 4 hex digits of
  logical counter): lexicographic order equals causal order in every language,
  and it stays clear of JS's 2^53 integer limit.

The HLC ships as a utility: apps stamp whatever local events they need ordered
(offline edits, journal entries) via `makeHlc()` / `Hlc` and persist
`state()` durably to keep stamps monotonic across restarts. Stamps are
**advisory local metadata**: they are never sent in the strict wire envelopes
and never participate in reconciliation — the row `version` stays the sole
conflict arbiter.

## What we deliberately did NOT copy

- **CouchDB revision trees / multi-master merge**: fiducia planes have one
  authoritative Postgres; server-wins (by `version`) is the default conflict
  policy, so a revision DAG would add cost without changing outcomes.
- **Vector clocks (Dynamo-style leaderless)**: with a single leader per plane,
  the total order from `sync_sequence` + per-row `version` already exists;
  vector clocks solve a concurrency-detection problem this topology doesn't
  have. The HLC gives us the useful residue — causally consistent local
  timestamps — without the merge machinery.
