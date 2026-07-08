// The sync client: wires the IndexedDB store + durable write-queue to the tested
// WASM reconcile core. Transport-agnostic — callers feed it incoming ChangeEvents
// (from Supabase realtime OR the backend WS) via applyChange(), and perform
// optimistic writes via optimisticWrite(table, id, row, send).
//
// Isolation: one client per plane; the caller passes a store bound to that
// plane's IndexedDB database. Planes never share.

/**
 * @param {object} deps
 * @param {object} deps.store  from openStore()
 * @param {object} deps.queue  from makeQueue(store)
 * @param {object} deps.core   from wrapCore(wasm) — { reconcile, onAck, isOwnEcho }
 */
export function makeSyncClient({ store, queue, core }) {
  async function applyServer(event) {
    if (event.op === "delete") {
      await store.del(event.table, event.id);
    } else {
      await store.put(event.table, event.id, event.row, {
        version: event.version,
        dirty: false,
      });
    }
  }

  /** Reconcile one incoming committed change against the local store. */
  async function applyChange(event) {
    const local = await store.meta(event.table, event.id); // {version,dirty}|null
    const decision = core.reconcile(local, event);

    if (decision === "Apply") {
      await applyServer(event);
      return "applied";
    }

    if (decision === "Conflict") {
      const items = await queue.list();
      const echo = items.find((w) => core.isOwnEcho(w, event));
      if (echo) {
        // The realtime echo of our OWN write — adopt server truth, dequeue.
        await applyServer(event);
        await queue.remove(echo.seq);
        return "echo-adopted";
      }
      // A genuine conflict (someone else advanced past our dirty edit).
      // Default policy is server-wins: apply server truth and drop our now-stale
      // queued write(s) for this row so we don't clobber newer data on retry.
      await applyServer(event);
      for (const w of items) {
        if (w.id === event.id && w.table === event.table) await queue.remove(w.seq);
      }
      return "conflict-resolved";
    }

    return "ignored"; // {Ignore: "Stale" | "AlreadyApplied"}
  }

  /**
   * Optimistic write: update IndexedDB instantly (dirty), enqueue durably, then
   * send to the backend. On ack, adopt the committed version and clear dirty; on
   * failure, stay queued + dirty for retry (offline-capable).
   * @param {(write:object)=>Promise<{id:string,committed_version:number}>} send
   */
  async function optimisticWrite(table, id, row, send) {
    const meta = await store.meta(table, id);
    const base_version = meta?.version ?? 0;

    await store.put(table, id, row, { version: base_version, dirty: true });
    const seq = await queue.enqueue({ id, table, op: "upsert", payload: row, base_version });

    try {
      const ack = await send({ id, table, op: "upsert", payload: row, base_version });
      const local = await store.meta(table, id);
      const outcome = core.onAck(local, ack);
      if (outcome && typeof outcome === "object" && "Adopt" in outcome) {
        await store.setMeta(table, id, { version: outcome.Adopt, dirty: false });
      }
      await queue.remove(seq);
      return { status: "acked", version: outcome?.Adopt };
    } catch (err) {
      return { status: "queued", error: String(err) };
    }
  }

  /** Re-send everything still queued (call on reconnect). */
  async function flushQueue(send) {
    for (const w of await queue.list()) {
      try {
        const ack = await send(w);
        const local = await store.meta(w.table, w.id);
        const outcome = core.onAck(local, ack);
        if (outcome && typeof outcome === "object" && "Adopt" in outcome) {
          await store.setMeta(w.table, w.id, { version: outcome.Adopt, dirty: false });
        }
        await queue.remove(w.seq);
      } catch {
        await queue.bumpAttempts(w.seq); // keep for the next flush
      }
    }
  }

  return { applyChange, optimisticWrite, flushQueue };
}
