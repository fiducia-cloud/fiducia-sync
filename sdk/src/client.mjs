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
// A per-write idempotency identity, minted once when the write is enqueued and
// persisted with it. Retries of the SAME queued write (flushQueue, reload) reuse
// it, while DISTINCT writes always differ — unlike a key derived from
// (table,id,op,base_version), which collides when two edits to the same row are
// made before the first is acked (the second POST would be deduplicated away and
// silently lost, while the client believes it committed).
const mintWriteKey = () =>
  globalThis.crypto?.randomUUID?.() ??
  `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

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
    const items = await queue.list();
    const echo = items.find((write) => core.isOwnEcho(write, event));

    if (echo) {
      // This is the transport echo of a write already applied optimistically.
      // Adopt only its committed version instead of writing the same payload
      // through IndexedDB a second time. This also catches delete echoes, where
      // the optimistic delete means `local` is already absent and reconcile()
      // would otherwise return AlreadyApplied without dequeuing the write.
      const hasNewerLocalWrite = items.some(
        (write) =>
          write.seq !== echo.seq &&
          write.table === event.table &&
          write.id === event.id,
      );
      if (event.op === "delete") {
        if (local && !hasNewerLocalWrite) await store.del(event.table, event.id);
      } else if (local) {
        await store.setMeta(event.table, event.id, {
          version: event.version,
          dirty: hasNewerLocalWrite,
        });
      } else {
        // The optimistic row disappeared independently; restore convergence
        // from server truth because there is no local write left to re-apply.
        await applyServer(event);
      }
      // Metadata first, dequeue second: a crash can cause a harmless idempotent
      // retry, but can never lose the only durable record of an un-applied write.
      await queue.remove(echo.seq);
      return "echo-adopted";
    }

    const decision = core.reconcile(local, event);

    if (decision === "Apply") {
      await applyServer(event);
      return "applied";
    }

    if (decision === "Conflict") {
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

  // Apply a server ack against current local state. Returns the AckOutcome so
  // callers can report the adopted version. `Superseded` means a newer change
  // already landed locally (via applyChange, which already cleared dirty), so we
  // leave local untouched; either way the queued write is done and dequeued.
  async function _applyAck(table, id, ack) {
    const local = await store.meta(table, id);
    // No local row (e.g. an optimistic delete already removed it): nothing to adopt.
    if (!local) return "Superseded";
    const outcome = core.onAck(local, ack);
    if (outcome && typeof outcome === "object" && "Adopt" in outcome) {
      await store.setMeta(table, id, { version: outcome.Adopt, dirty: false });
    }
    return outcome;
  }

  /**
   * Optimistic write: update IndexedDB instantly (dirty), enqueue durably, then
   * send to the backend. On ack, adopt the committed version and clear dirty; on
   * failure, stay queued + dirty for retry (offline-capable).
   *
   * `op:"delete"` optimistically removes the row locally and queues a delete; the
   * row reappears only if the send fails and a later reconcile re-adds it.
   *
   * @param {(write:object)=>Promise<{id:string,committed_version:number}>} send
   * @param {"upsert"|"delete"} [op="upsert"]
   */
  async function optimisticWrite(table, id, row, send, op = "upsert") {
    const meta = await store.meta(table, id);
    const base_version = meta?.version ?? 0;

    if (op === "delete") {
      await store.del(table, id);
    } else {
      await store.put(table, id, row, { version: base_version, dirty: true });
    }
    const payload = op === "delete" ? null : row;
    const seq = await queue.enqueue({ id, table, op, payload, base_version });

    try {
      const ack = await send({ id, table, op, payload, base_version });
      const outcome = await _applyAck(table, id, ack);
      await queue.remove(seq);
      return {
        status: "acked",
        version: outcome && typeof outcome === "object" ? outcome.Adopt : undefined,
      };
    } catch (err) {
      // Persist the failed attempt before reporting it. If an own echo already
      // dequeued this seq concurrently, the write is committed despite the lost
      // HTTP ack and can be reported as acknowledged.
      let attempts;
      try {
        attempts = await queue.bumpAttempts(seq);
      } catch (storageError) {
        const failure = new Error("sync write failed and retry state was not durable");
        failure.cause = storageError;
        failure.sendError = err;
        throw failure;
      }
      if (attempts === 0) return { status: "acked", via: "echo" };
      // Stays queued (+ dirty for upserts) for the next flush. Offline-capable.
      return { status: "queued", error: String(err), attempts };
    }
  }

  /** Optimistically delete a row (see optimisticWrite with op:"delete"). */
  function optimisticDelete(table, id, send) {
    return optimisticWrite(table, id, null, send, "delete");
  }

  /**
   * Re-send everything still queued (call on reconnect).
   *
   * Successful writes are removed only after their ack is applied durably.
   * Failed attempts remain queued with a durable counter. After processing the
   * batch, failures reject with a `QueueFlushError` carrying `failures` and the
   * successful `flushed` count instead of disappearing silently.
   */
  async function flushQueue(send, { onError } = {}) {
    let flushed = 0;
    const failures = [];
    for (const w of await queue.list()) {
      try {
        const ack = await send(w);
        await _applyAck(w.table, w.id, ack);
        await queue.remove(w.seq);
        flushed += 1;
      } catch (error) {
        let attempts;
        try {
          attempts = await queue.bumpAttempts(w.seq); // keep for the next flush
        } catch (storageError) {
          const durabilityError = new Error(
            "queue retry attempt could not be persisted",
          );
          durabilityError.cause = storageError;
          durabilityError.sendError = error;
          failures.push({ write: w, error: durabilityError, attempts: null });
          onError?.(durabilityError, w, null);
          continue;
        }
        if (attempts === 0) {
          // A realtime own echo removed this queue entry while the HTTP request
          // lost its ack. The committed version has already been adopted.
          flushed += 1;
          continue;
        }
        failures.push({ write: w, error, attempts });
        onError?.(error, w, attempts);
      }
    }
    if (failures.length > 0) {
      const error = new Error(
        `queue flush failed for ${failures.length} write(s); ${flushed} flushed`,
      );
      error.name = "QueueFlushError";
      error.failures = failures;
      error.flushed = flushed;
      throw error;
    }
    return flushed;
  }

  /**
   * Cold-start catch-up: reconcile a snapshot of authoritative rows fetched over
   * HTTP (e.g. on connect / after a reconnect) so changes missed while offline
   * land. Each row is run through the same reconcile path as a live change, so
   * stale/duplicate rows are ignored and dirty local edits are never clobbered
   * silently (they go through conflict resolution).
   *
   * With `prune:true` the snapshot is treated as the COMPLETE set for the table:
   * clean local rows absent from it were deleted server-side and are removed.
   * (Dirty rows — un-acked optimistic inserts — are kept.)
   *
   * @returns {Promise<{applied:number, ignored:number, conflicts:number, pruned:number}>}
   */
  async function hydrate(table, rows, { prune = false } = {}) {
    const res = { applied: 0, ignored: 0, conflicts: 0, pruned: 0 };
    const seen = new Set();
    for (const row of rows ?? []) {
      if (row == null || row.id == null) continue;
      const id = String(row.id);
      seen.add(id);
      const outcome = await applyChange({
        table,
        op: "upsert",
        id,
        version: Number(row.version ?? 0),
        row,
        at_ms: 0,
      });
      if (outcome === "applied" || outcome === "echo-adopted") res.applied += 1;
      else if (outcome === "conflict-resolved") res.conflicts += 1;
      else res.ignored += 1;
    }
    if (prune) {
      for (const local of await store.all(table)) {
        const id = local?.id != null ? String(local.id) : null;
        if (!id || seen.has(id)) continue;
        const meta = await store.meta(table, id);
        if (meta && !meta.dirty) {
          await store.del(table, id);
          res.pruned += 1;
        }
      }
    }
    return res;
  }

  return { applyChange, optimisticWrite, optimisticDelete, flushQueue, hydrate };
}
