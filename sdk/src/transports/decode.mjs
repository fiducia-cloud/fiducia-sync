// Pure transport decoders — payloads -> ChangeEvent(s). No IO, so unit-testable.
// A ChangeEvent is { table, op:"upsert"|"delete", id, version, row, at_ms }, the
// same envelope the wasm core + `@fiducia/interfaces` generated types use.

export function isChangeEvent(v) {
  return (
    v &&
    typeof v === "object" &&
    typeof v.table === "string" &&
    (v.op === "upsert" || v.op === "delete") &&
    typeof v.id === "string" &&
    typeof v.version === "number"
  );
}

/** Backend WS/SSE sync frame -> ChangeEvent[]. `[]` for any non-sync frame. */
export function decodeBackendMessage(data) {
  let msg;
  try {
    msg = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return [];
  }
  if (!msg || msg.event !== "fiducia:sync" || !Array.isArray(msg.changes)) return [];
  return msg.changes.filter(isChangeEvent);
}

/**
 * Supabase `postgres_changes` payload -> ChangeEvent (or null if unusable).
 *
 * IMPORTANT: Supabase realtime only includes the FULL row (with our monotonic
 * `version` column) when the table is `REPLICA IDENTITY FULL`. For DELETE events
 * without that, `payload.old` carries ONLY the primary key — no `version`. We do
 * NOT fabricate `version: 0` in that case: a 0 would reconcile as "stale" and the
 * delete would be silently dropped. Instead we return null so the caller ignores
 * this (unorderable) event and relies on the backend WS frame — which always
 * carries `version` — or on catch-up hydration. Set REPLICA IDENTITY FULL on
 * every synced table (see fiducia-interfaces) to make deletes flow over Supabase.
 */
export function decodeSupabaseChange(table, payload) {
  if (!payload || typeof payload !== "object") return null;
  const isDelete = payload.eventType === "DELETE";
  const row = (isDelete ? payload.old : payload.new) ?? null;
  if (!row || row.id == null) return null;

  // `version` must be a real number to order the change — bail rather than
  // invent a stale 0 that would drop the change.
  const rawVersion = row.version ?? payload.new?.version ?? payload.old?.version;
  if (rawVersion == null || Number.isNaN(Number(rawVersion))) return null;

  return {
    table,
    op: isDelete ? "delete" : "upsert",
    id: String(row.id),
    version: Number(rawVersion),
    row,
    at_ms: payload.commit_timestamp ? Date.parse(payload.commit_timestamp) || 0 : 0,
  };
}
