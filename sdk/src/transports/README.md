# transports

The change sources that feed reconciled events into the sync client. Sync never
depends on a single channel — both transports deliver the same
`{table, op, id, version, row, at_ms}` envelope, and reconcile is idempotent, so
duplicate/out-of-order delivery across them is harmless.

- `decode.mjs` — pure payload → `ChangeEvent` decoders (no IO). Notably refuses
  to fabricate a `version` for a Supabase DELETE lacking `REPLICA IDENTITY FULL`,
  returning `null` so the change isn't silently dropped as stale.
- `backend.mjs` — the Rust backend's own WebSocket (with SSE fallback and capped
  auto-reconnect) for reads, plus the HTTP write path with a stable
  `Idempotency-Key` and optional bearer auth. HTTP tokens use `Authorization`;
  streams default to cookie auth and require explicit opt-in before a token can
  appear in a URL. Plane-agnostic paths.
- `supabase.mjs` — Supabase realtime `postgres_changes` → `ChangeEvent`, over a
  caller-provided supabase-js client (with an RLS-complementing tenant filter).
