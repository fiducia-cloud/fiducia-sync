// Supabase realtime transport: postgres_changes -> ChangeEvent. Thin glue over
// decode.mjs; the caller passes an already-created supabase-js client so the SDK
// stays free of a hard supabase dependency (and of any credentials).

import { decodeSupabaseChange } from "./decode.mjs";

/**
 * Subscribe to Postgres change data capture for `tables` on one Supabase channel.
 * Calls `onChange(ChangeEvent)` per row change.
 */
export function subscribeSupabase({ client, tables, onChange, channelName = "fiducia-sync" }) {
  const channel = client.channel(channelName);
  for (const table of tables) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => {
      const change = decodeSupabaseChange(table, payload);
      if (change) onChange(change);
    });
  }
  channel.subscribe();
  return {
    stop() {
      client.removeChannel?.(channel);
    },
  };
}
