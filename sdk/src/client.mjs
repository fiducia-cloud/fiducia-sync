// The sync client: wires the IndexedDB store + durable write-queue to the tested
// WASM reconcile core. Transport-agnostic — callers feed it incoming ChangeEvents
// (from Supabase realtime OR the backend WS) via applyChange(), and perform
// optimistic writes via optimisticWrite(table, id, row, send, options).
//
// Every write takes a WRITE POLICY (an enum, "local-only" → "server-only" — see
// policy.mjs for the semantics matrix) and an ERROR MODE ("return" | "throw" |
// "emit") choosing the caller-facing failure channel. Telemetry (telemetry.mjs,
// OpenTelemetry-adaptable) observes every operation regardless of either.
//
// Isolation: one client per plane; the caller passes a store bound to that
// plane's IndexedDB database. Planes never share.

import { deepMerge } from "./merge.mjs";
import { makeHlc } from "./hlc.mjs";
import {
  DEFAULT_ERROR_MODE,
  DEFAULT_WRITE_POLICY,
  SyncWriteError,
  assertErrorMode,
  assertWritePolicy,
  policyEnqueuesDurably,
} from "./policy.mjs";
import { emitEvent, normalizeTelemetry } from "./telemetry.mjs";

/**
 * @param {object} deps
 * @param {object} deps.store  from openStore()
 * @param {object} deps.queue  from makeQueue(store)
 * @param {object} deps.core   from wrapCore(wasm) — { reconcile, isOwnEcho }
 * @param {object|Function} [deps.telemetry] sink (see telemetry.mjs)
 * @param {() => number} [deps.now] wall clock, injectable for tests
 * @param {"local-only"|"local-first"|"server-first"|"server-only"} [deps.writePolicy]
 * @param {"return"|"throw"|"emit"} [deps.errorMode]
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

function validateAck(write, ack) {
  if (!ack || typeof ack !== "object") {
    throw new Error("sync write acknowledgement is not an object");
  }
  if (ack.id !== write.id) {
    throw new Error("sync write acknowledgement id does not match the queued write");
  }
  if (
    !Number.isSafeInteger(ack.committed_version) ||
    ack.committed_version < 0
  ) {
    throw new Error("sync write acknowledgement has an invalid committed_version");
  }
  return ack;
}

export function makeSyncClient({
  store,
  queue,
  core,
  telemetry,
  now = () => Date.now(),
  writePolicy = DEFAULT_WRITE_POLICY,
  errorMode = DEFAULT_ERROR_MODE,
}) {
  const defaultPolicy = assertWritePolicy(writePolicy);
  const defaultErrorMode = assertErrorMode(errorMode);
  const observe = normalizeTelemetry(telemetry);

  // Reconcile decisions span multiple IndexedDB reads/writes. Serialize those
  // local state transitions so two transport callbacks cannot both decide from
  // the same old version and land out of order. Network sends deliberately stay
  // outside the gate: their realtime echo must be able to reconcile while the
  // HTTP response is still in flight.
  let mutationTail = Promise.resolve();
  function mutate(operation) {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // The device Hybrid Logical Clock (hlc.mjs): stamps queued writes and folds
  // in every incoming commit time, so local stamps stay monotonic across clock
  // skew and always sort after the last synced server change. Restored lazily
  // from durable state; stores that predate getHlcState start fresh.
  let hlcPromise = null;
  const getClock = () =>
    (hlcPromise ??= Promise.resolve(
      typeof store.getHlcState === "function" ? store.getHlcState() : null,
    ).then(
      (state) => makeHlc({ state: state ?? undefined, now }),
      () => makeHlc({ now }),
    ));

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
  async function _applyChange(event) {
    const local = await store.meta(event.table, event.id); // {version,dirty}|null
    const items = await queue.list();
    const rowWrites = items.filter(
      (write) => write.table === event.table && write.id === event.id,
    );
    const echo = rowWrites.find((write) => core.isOwnEcho(write, event));

    if (echo) {
      // The exact-key echo is authoritative. Adopt its server-normalized payload
      // when it is the newest local intent, or preserve a later optimistic value;
      // row + queue changes commit in one IndexedDB transaction.
      if (await queue.adoptEcho(event, echo.seq)) return "echo-adopted";
      // Another tab may have retired the sequence after our queue snapshot. Run
      // the event through ordinary reconciliation against the now-current state.
      return _applyChange(event);
    }

    // The durable queue is the source of truth for pending intent. It also
    // represents optimistic deletes, for which no local row exists, and repairs
    // a crash window where committed metadata could precede queue cleanup.
    const reconcileLocal =
      rowWrites.length === 0
        ? local
        : {
            version:
              local?.version ??
              rowWrites.reduce(
                (latest, write) => Math.max(latest, write.base_version),
                rowWrites[0].base_version,
              ),
            dirty: true,
          };
    const decision = core.reconcile(reconcileLocal, event);

    if (decision === "Apply") {
      await applyServer(event);
      return "applied";
    }

    if (decision === "Conflict") {
      // A genuine conflict (someone else advanced past our dirty edit).
      // Default policy is server-wins. Adopt server truth and drop every stale
      // write for this row in ONE IndexedDB transaction, so a reload can never
      // retry an old write after the newer server state has landed locally.
      const staleSeqs = rowWrites.map((w) => w.seq);
      await queue.resolveConflict(event, staleSeqs);
      return "conflict-resolved";
    }

    if (
      decision &&
      typeof decision === "object" &&
      decision.Ignore === "AlreadyApplied" &&
      rowWrites.length === 0 &&
      (!local || !local.dirty)
    ) {
      // A version-only HTTP ack can arrive before its authoritative realtime
      // echo. Refresh equal-version clean state so server normalization (or an
      // equal-version catch-up row after reload) is never discarded.
      await applyServer(event);
      return "refreshed";
    }

    return "ignored"; // {Ignore: "Stale" | "AlreadyApplied"}
  }

  async function applyChange(event) {
    const clock = await getClock();
    clock.observe(event?.at_ms ?? 0);
    const startedAt = now();
    const attributes = {
      "sync.table": event?.table,
      "sync.row_id": event?.id,
      "sync.op": event?.op,
    };
    try {
      const outcome = await mutate(() => _applyChange(event));
      emitEvent(observe, "fiducia.sync.apply", {
        atMs: startedAt,
        durationMs: now() - startedAt,
        attributes: { ...attributes, "sync.outcome": outcome },
      });
      if (outcome === "conflict-resolved") {
        emitEvent(observe, "fiducia.sync.conflict", {
          atMs: startedAt,
          attributes: { ...attributes, "sync.resolution": "server-wins" },
        });
      }
      return outcome;
    } catch (error) {
      emitEvent(observe, "fiducia.sync.apply", {
        atMs: startedAt,
        durationMs: now() - startedAt,
        attributes,
        error,
      });
      throw error;
    }
  }

  // Apply a server ack against current local state. Returns the AckOutcome so
  // callers can report the adopted version. `Superseded` means a newer change
  // already landed locally (via applyChange, which already cleared dirty), so we
  // leave local untouched; either way the queued write is done and dequeued.
  async function _applyAck(table, id, ack, settledSeq) {
    return queue.settleAck(table, id, settledSeq, ack.committed_version);
  }

  /** Directly adopt a server-first/server-only ack when nothing newer landed. */
  async function _adoptServerAck(write, ack) {
    const meta = await store.meta(write.table, write.id);
    if (meta && meta.version > ack.committed_version) return; // superseded
    const items = await queue.list();
    const stillDirty = items.some(
      (queued) => queued.table === write.table && queued.id === write.id,
    );
    if (write.op === "delete") {
      await store.del(write.table, write.id);
    } else {
      await store.put(write.table, write.id, write.payload, {
        version: ack.committed_version,
        dirty: stillDirty,
        syncedAtMs: now(),
      });
    }
  }

  function normalizeWriteOptions(opOrOptions, legacyMerge) {
    // Back-compat: the 5th/6th positional args were (op, merge).
    if (opOrOptions == null || typeof opOrOptions === "string") {
      return {
        op: opOrOptions ?? "upsert",
        merge: Boolean(legacyMerge),
        policy: defaultPolicy,
        errorMode: defaultErrorMode,
      };
    }
    if (typeof opOrOptions !== "object") {
      throw new TypeError("write options must be an op string or an options object");
    }
    const {
      op = "upsert",
      merge = false,
      policy = defaultPolicy,
      errorMode: mode = defaultErrorMode,
    } = opOrOptions;
    if (op !== "upsert" && op !== "delete") {
      throw new TypeError(`unknown sync write op ${JSON.stringify(op)}`);
    }
    return {
      op,
      merge: Boolean(merge),
      policy: assertWritePolicy(policy),
      errorMode: assertErrorMode(mode),
    };
  }

  /**
   * Perform one write under a policy (default "local-first"):
   *
   *   local-only    mutate + enqueue durably; no network now (flushQueue later)
   *   local-first   mutate + enqueue durably, then send; failures stay queued
   *   server-first  send first; adopt the committed state locally on ack
   *   server-only   send only; the local store waits for the echo/catch-up
   *
   * The error mode picks the caller-facing channel for SEND failures ("return"
   * resolves `{status:"queued"|"failed", error}`, "throw" rejects with a typed
   * SyncWriteError, "emit" resolves quietly). Durability failures (retry state
   * could not be persisted) ALWAYS throw. Telemetry sees everything.
   *
   * With `merge:true` (see optimisticPatch) the local row is `deepMerge(existing,
   * row)` — the PARTIAL patch is folded into what's stored so sibling fields (and
   * sibling keys of a nested jsonb object) survive; the queued PAYLOAD stays the
   * partial patch (the backend COALESCEs it). Default is whole-row replace.
   *
   * @param {(write:object)=>Promise<{id:string,committed_version:number}>} send
   * @param {"upsert"|"delete"|{op?:string,merge?:boolean,policy?:string,errorMode?:string}} [opOrOptions]
   * @param {boolean} [legacyMerge=false]
   */
  async function optimisticWrite(table, id, row, send, opOrOptions = "upsert", legacyMerge = false) {
    const { op, merge, policy, errorMode: mode } = normalizeWriteOptions(opOrOptions, legacyMerge);
    if (policy !== "local-only" && typeof send !== "function") {
      throw new TypeError(`write policy ${policy} requires a send function`);
    }
    const startedAt = now();
    const attributes = {
      "sync.table": table,
      "sync.row_id": id,
      "sync.op": op,
      "sync.policy": policy,
      "sync.error_mode": mode,
    };
    const finish = (result, error) => {
      emitEvent(observe, "fiducia.sync.write", {
        atMs: startedAt,
        durationMs: now() - startedAt,
        attributes: {
          ...attributes,
          "sync.outcome": error ? "threw" : result.status,
          ...(result?.attempts != null ? { "sync.attempts": result.attempts } : {}),
        },
        error,
      });
      if (error) throw error;
      return result;
    };

    const clock = await getClock();

    if (policyEnqueuesDurably(policy)) {
      const { write, seq } = await mutate(async () => {
        const meta = await store.meta(table, id);
        const base_version = meta?.version ?? 0;
        // Merge mode: fold the partial patch into the row already held. The mutate
        // gate serializes this read+merge with every other client state transition,
        // so it can't race. We send the MERGED value (not the partial): the backend
        // COALESCEs at the column level, so a partial jsonb would clobber sibling
        // keys server-side and its authoritative echo would then overwrite our local
        // merge. Sending the merged whole value keeps client and server consistent.
        const localRow =
          merge && op !== "delete" ? deepMerge(await store.get(table, id), row) : row;
        const payload = op === "delete" ? null : localRow;
        // `key` rides along durably so every retry of this write (here or from
        // flushQueue after a reload) presents the same Idempotency-Key, while a
        // subsequent distinct write to the same row never shares it. `hlc` is the
        // device-monotonic creation stamp (advisory; stripped from the wire).
        const write = {
          id,
          table,
          op,
          payload,
          base_version,
          key: mintWriteKey(),
          hlc: clock.tick().encoded,
        };
        // The optimistic row mutation, queue append, and HLC state commit
        // atomically. Splitting them would allow a crash to leave a dirty row
        // (or a deleted row) with no durable retry intent.
        const seq = await queue.enqueueOptimistic(write, localRow, {
          hlcState: clock.state(),
        });
        return { write, seq };
      });

      if (policy === "local-only") {
        return finish({ status: "queued", attempts: 0, seq });
      }

      try {
        const ack = validateAck(write, await send(write));
        const outcome = await mutate(() => _applyAck(table, id, ack, seq));
        return finish({
          status: "acked",
          version: outcome && typeof outcome === "object" ? outcome.Adopt : undefined,
        });
      } catch (err) {
        // Persist the failed attempt before reporting it. If an own echo already
        // dequeued this seq concurrently, the write is committed despite the lost
        // HTTP ack and can be reported as acknowledged.
        let attempts;
        try {
          attempts = await mutate(() => queue.bumpAttempts(seq));
        } catch (storageError) {
          const failure = new SyncWriteError(
            "sync write failed and retry state was not durable",
            { write, policy, queued: false, cause: storageError },
          );
          failure.sendError = err;
          return finish(null, failure);
        }
        if (attempts === 0) return finish({ status: "acked", via: "echo" });
        // Stays queued (+ dirty for upserts) for the next flush. Offline-capable.
        if (mode === "throw") {
          return finish(
            null,
            new SyncWriteError("sync write failed and stays queued for retry", {
              write,
              policy,
              attempts,
              queued: true,
              cause: err,
            }),
          );
        }
        if (mode === "emit") return finish({ status: "queued", attempts, seq });
        return finish({ status: "queued", error: String(err), attempts, seq });
      }
    }

    // Pessimistic policies: no local mutation, no durable queue entry.
    const write = await mutate(async () => {
      const meta = await store.meta(table, id);
      const localRow =
        merge && op !== "delete" ? deepMerge(await store.get(table, id), row) : row;
      return {
        id,
        table,
        op,
        payload: op === "delete" ? null : localRow,
        base_version: meta?.version ?? 0,
        key: mintWriteKey(),
        hlc: clock.tick().encoded,
      };
    });
    // Best-effort HLC persistence (no queue transaction to ride along with).
    if (typeof store.setHlcState === "function") {
      void Promise.resolve(store.setHlcState(clock.state())).catch(() => {});
    }

    try {
      const ack = validateAck(write, await send(write));
      if (policy === "server-first") {
        await mutate(() => _adoptServerAck(write, ack));
      }
      return finish({ status: "acked", version: ack.committed_version });
    } catch (err) {
      if (mode === "throw") {
        return finish(
          null,
          new SyncWriteError("sync write failed and was not applied locally", {
            write,
            policy,
            queued: false,
            cause: err,
          }),
        );
      }
      if (mode === "emit") return finish({ status: "failed" });
      return finish({ status: "failed", error: String(err) });
    }
  }

  /** Optimistically delete a row (optimisticWrite with op:"delete"). */
  function optimisticDelete(table, id, send, options) {
    const base =
      options != null && typeof options === "object" ? options : {};
    return optimisticWrite(table, id, null, send, { ...base, op: "delete" });
  }

  /**
   * Optimistic PARTIAL update: deep-merge `patch` into the row already held (so a
   * single changed field or one key of a nested jsonb object keeps its siblings),
   * while sending only the partial `patch` to the backend to COALESCE. This is the
   * right entry point for form/single-field edits (e.g. the htmx extension).
   */
  function optimisticPatch(table, id, patch, send, opOrOptions = "upsert") {
    const base =
      opOrOptions != null && typeof opOrOptions === "object"
        ? opOrOptions
        : { op: opOrOptions };
    return optimisticWrite(table, id, patch, send, { ...base, merge: true });
  }

  /**
   * Re-send everything still queued (call on reconnect).
   *
   * Successful writes are removed only after their ack is applied durably.
   * Failed attempts remain queued with a durable counter. After processing the
   * batch, failures reject with a `QueueFlushError` carrying `failures` and the
   * successful `flushed` count — unless `errorMode` (per-call, else the client
   * default) is "emit", in which case failures surface only through `onError`,
   * telemetry, and status callbacks, and the flushed count resolves.
   */
  async function flushQueue(send, { onError, errorMode: flushMode } = {}) {
    const mode =
      flushMode !== undefined
        ? assertErrorMode(flushMode)
        : defaultErrorMode === "emit"
          ? "emit"
          : "throw";
    const startedAt = now();
    let flushed = 0;
    const failures = [];
    for (const w of await mutate(() => queue.list())) {
      try {
        const ack = validateAck(w, await send(w));
        await mutate(() => _applyAck(w.table, w.id, ack, w.seq));
        flushed += 1;
      } catch (error) {
        let attempts;
        try {
          attempts = await mutate(() => queue.bumpAttempts(w.seq)); // keep for the next flush
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
    emitEvent(observe, "fiducia.sync.flush", {
      atMs: startedAt,
      durationMs: now() - startedAt,
      attributes: { "sync.flushed": flushed, "sync.failures": failures.length },
      error: failures.length > 0 ? failures[0].error : undefined,
    });
    if (failures.length > 0 && mode !== "emit") {
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
  async function _hydrate(table, rows, { prune = false } = {}) {
    const res = { applied: 0, ignored: 0, conflicts: 0, pruned: 0 };
    const seen = new Set();
    for (const row of rows ?? []) {
      if (row == null || row.id == null) continue;
      const id = String(row.id);
      seen.add(id);
      const outcome = await _applyChange({
        table,
        op: "upsert",
        id,
        version: Number(row.version ?? 0),
        row,
        at_ms: 0,
      });
      if (
        outcome === "applied" ||
        outcome === "echo-adopted" ||
        outcome === "refreshed"
      ) {
        res.applied += 1;
      } else if (outcome === "conflict-resolved") res.conflicts += 1;
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

  async function hydrate(table, rows, options) {
    const startedAt = now();
    try {
      const result = await mutate(() => _hydrate(table, rows, options));
      emitEvent(observe, "fiducia.sync.hydrate", {
        atMs: startedAt,
        durationMs: now() - startedAt,
        attributes: {
          "sync.table": table,
          "sync.applied": result.applied,
          "sync.ignored": result.ignored,
          "sync.conflicts": result.conflicts,
          "sync.pruned": result.pruned,
        },
      });
      return result;
    } catch (error) {
      emitEvent(observe, "fiducia.sync.hydrate", {
        atMs: startedAt,
        durationMs: now() - startedAt,
        attributes: { "sync.table": table },
        error,
      });
      throw error;
    }
  }

  return { applyChange, optimisticWrite, optimisticPatch, optimisticDelete, flushQueue, hydrate };
}
