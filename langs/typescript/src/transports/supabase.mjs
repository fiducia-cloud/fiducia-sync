// Supabase realtime transport: postgres_changes -> ChangeEvent. Thin glue over
// decode.mjs; the caller passes an already-created supabase-js client so the SDK
// stays free of a hard supabase dependency (and of any credentials).

import { decodeSupabaseChange } from "./decode.mjs";

/**
 * Subscribe to Postgres change data capture for `tables` on one Supabase channel.
 * Calls `onChange(ChangeEvent)` per row change.
 *
 * @param {object} o
 * @param {object}   o.client       an already-created supabase-js client
 * @param {string[]} o.tables       synced table names (one listener each)
 * @param {(change:object)=>void} o.onChange
 * @param {string}   [o.channelName="fiducia-sync"]
 * @param {string|Record<string,string>} [o.filter]  postgres_changes row filter,
 *   e.g. `"org_id=eq.<uuid>"` — a defense-in-depth complement to RLS so the
 *   client only receives its own tenant's rows. A string applies to every table;
 *   an object maps table -> filter.
 * @param {(status:string, err?:Error)=>void} [o.onStatus]  channel subscribe state
 *   ("SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED") — use it to trigger
 *   catch-up hydration on (re)subscribe.
 */
export function subscribeSupabase({
  client,
  tables,
  onChange,
  channelName = "fiducia-sync",
  filter,
  onStatus,
}) {
  const filterFor = (table) =>
    typeof filter === "string" ? filter : filter?.[table];

  const channel = client.channel(channelName);
  for (const table of tables) {
    const opts = { event: "*", schema: "public", table };
    const f = filterFor(table);
    if (f) opts.filter = f;
    channel.on("postgres_changes", opts, (payload) => {
      const change = decodeSupabaseChange(table, payload);
      if (change) onChange(change);
    });
  }
  channel.subscribe((status, err) => onStatus?.(status, err));
  return {
    stop() {
      client.removeChannel?.(channel);
    },
  };
}
