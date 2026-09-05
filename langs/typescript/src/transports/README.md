# transports

The change sources that feed reconciled events into the sync client. Sync never
depends on a single channel — both transports deliver the same
`{table, op, id, version, row, at_ms, write_key?}` envelope, and reconcile is
idempotent, so duplicate/out-of-order delivery across them is harmless. The
optional `write_key` authoritatively distinguishes a keyed write's own echo from
a third-party commit at the same version.

- `decode.mjs` — pure payload → `ChangeEvent` decoders (no IO). Notably refuses
  to fabricate a `version` for a Supabase DELETE lacking `REPLICA IDENTITY FULL`,
  returning `null` so the change isn't silently dropped as stale.
- `backend.mjs` — the Rust backend's own WebSocket (with SSE fallback and capped
  auto-reconnect) for reads, plus the HTTP write path with a stable
  per-write `Idempotency-Key`, optional bearer auth, and optional
  `x-fiducia-csrf`. HTTP tokens use `Authorization`; streams default to cookie
  auth and require explicit opt-in before a token can appear in a URL. Response
  ids/versions are validated, and header/body write identities cannot disagree.
  Plane-agnostic paths.
- `supabase.mjs` — Supabase realtime `postgres_changes` → `ChangeEvent`, over a
  caller-provided supabase-js client (with an RLS-complementing tenant filter).
