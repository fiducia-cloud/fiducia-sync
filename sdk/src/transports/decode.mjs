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

/** Supabase postgres_changes payload -> ChangeEvent (or null if unusable). */
export function decodeSupabaseChange(table, payload) {
  if (!payload || typeof payload !== "object") return null;
  const isDelete = payload.eventType === "DELETE";
  const row = (isDelete ? payload.old : payload.new) ?? null;
  if (!row || row.id == null) return null;
  return {
    table,
    op: isDelete ? "delete" : "upsert",
    id: String(row.id),
    version: row.version != null ? Number(row.version) : 0,
    row,
    at_ms: 0,
  };
}
