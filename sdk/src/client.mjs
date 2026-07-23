// The sync client: wires the IndexedDB store + durable write-queue to the tested
// WASM reconcile core. Transport-agnostic — callers feed it incoming ChangeEvents
// (from Supabase realtime OR the backend WS) via applyChange(), and perform
// optimistic writes via optimisticWrite(table, id, row, send).
//
// Isolation: one client per plane; the caller passes a store bound to that
// plane's IndexedDB database. Planes never share.

import { deepMerge } from "./merge.mjs";

const WRITE_STRATEGIES = new Set([
  "local_queue",
  "optimistic",
  "pessimistic",
]);
const FAILURE_MODES = new Set(["return_result", "throw_error", "emit_only"]);
const TELEMETRY_LEVELS = new Set(["off", "errors", "lifecycle", "verbose"]);

export const DEFAULT_WRITE_POLICY = Object.freeze({
  strategy: "optimistic",
  failure_mode: "return_result",
  telemetry: "errors",
});

export class SyncWriteError extends Error {
  constructor(message, { cause, result, write } = {}) {
    super(message, { cause });
    this.name = "SyncWriteError";
    this.result = result;
    this.write = write;
  }
}

function validateWritePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("sync write policy must be an object of enum values");
  }
  if (!WRITE_STRATEGIES.has(policy.strategy)) {
    throw new TypeError(`unsupported sync write strategy: ${policy.strategy}`);
  }
  if (!FAILURE_MODES.has(policy.failure_mode)) {
    throw new TypeError(
      `unsupported sync write failure mode: ${policy.failure_mode}`,
    );
  }
  if (!TELEMETRY_LEVELS.has(policy.telemetry)) {
    throw new TypeError(
      `unsupported sync write telemetry level: ${policy.telemetry}`,
    );
  }
  return Object.freeze({
    strategy: policy.strategy,
    failure_mode: policy.failure_mode,
    telemetry: policy.telemetry,
  });
}

function errorType(error) {
  return error instanceof Error && error.name ? error.name : typeof error;
}

/**
 * @param {object} deps
 * @param {object} deps.store  from openStore()
 * @param {object} deps.queue  from makeQueue(store)
 * @param {object} deps.core   from wrapCore(wasm) — { reconcile, isOwnEcho }
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
  writePolicy = DEFAULT_WRITE_POLICY,
  resolveWritePolicy,
  telemetry,
}) {
  const defaultPolicy = validateWritePolicy(writePolicy);

  function policyFor(context, override) {
    return validateWritePolicy(
      override ?? resolveWritePolicy?.(context) ?? defaultPolicy,
    );
  }

  function shouldEmit(level, phase) {
    if (level === "off") return false;
    if (level === "errors") {
      return phase === "failed" || phase === "retry_scheduled";
    }
    return true;
  }

  function telemetryContext(context, policy) {
    return {
      table: context.table,
      op: context.op,
      strategy: policy.strategy,
      storage: store.storageKind ?? "indexeddb",
    };
  }

  function beginTelemetry(context, policy) {
    if (
      policy.telemetry !== "lifecycle" &&
      policy.telemetry !== "verbose"
    ) {
      return undefined;
    }
    try {
      return telemetry?.startWrite?.(telemetryContext(context, policy));
    } catch {
      return undefined;
    }
  }

  function reportTelemetry(context, policy, phase, extra = {}, span) {
    if (!shouldEmit(policy.telemetry, phase)) return;
    const event = {
      phase,
      strategy: policy.strategy,
      table: context.table,
      op: context.op,
      at_ms: Date.now(),
      ...extra,
    };
    try {
      telemetry?.emit?.(event, telemetryContext(context, policy));
      span?.event?.(phase, {
        ...(extra.attempts === undefined
          ? {}
          : { "fiducia.sync.attempts": extra.attempts }),
        ...(extra.error_type === undefined
          ? {}
          : { "error.type": extra.error_type }),
      });
    } catch {
      // Observability must never change write durability or application flow.
    }
  }

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
      const context = { table: event.table, op: event.op, mutation: "replace" };
      try {
        const policy = policyFor(context);
        reportTelemetry(context, policy, "conflict_resolved");
      } catch {
        // A telemetry-policy resolver cannot undo an already-durable conflict.
      }
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

  function applyChange(event) {
    return mutate(() => _applyChange(event));
  }

  // Apply a server ack against current local state. Returns the AckOutcome so
  // callers can report the adopted version. `Superseded` means a newer change
  // already landed locally (via applyChange, which already cleared dirty), so we
  // leave local untouched; either way the queued write is done and dequeued.
  async function _applyAck(table, id, ack, settledSeq, strategy = "optimistic") {
    return strategy === "pessimistic"
      ? queue.settlePessimistic(
          table,
          id,
          settledSeq,
          ack.committed_version,
        )
      : queue.settleAck(table, id, settledSeq, ack.committed_version);
  }

  /**
   * Policy-driven write. Every strategy first persists a durable resend intent.
   *
   * local_queue: visible local mutation + queue, return without network IO.
   * optimistic: visible local mutation + queue, then await the immediate send.
   * pessimistic: queue + send first; make the acknowledged payload visible only
   * after the server accepts it.
   */
  async function write(
    table,
    id,
    row,
    send,
    { op = "upsert", mutation = "replace", policy: policyOverride } = {},
  ) {
    if (op !== "upsert" && op !== "delete") {
      throw new TypeError(`unsupported sync write operation: ${op}`);
    }
    if (mutation !== "replace" && mutation !== "merge") {
      throw new TypeError(`unsupported sync mutation mode: ${mutation}`);
    }
    const context = { table, op, mutation };
    const policy = policyFor(context, policyOverride);
    if (policy.strategy !== "local_queue" && typeof send !== "function") {
      throw new TypeError(
        `sync write strategy ${policy.strategy} requires a send function`,
      );
    }
    const span = beginTelemetry(context, policy);
    const { write, seq } = await mutate(async () => {
      const meta = await store.meta(table, id);
      const base_version = meta?.version ?? 0;
      const localRow =
        mutation === "merge" && op !== "delete"
          ? deepMerge(await store.get(table, id), row)
          : row;
      const payload = op === "delete" ? null : localRow;
      const write = {
        id,
        table,
        op,
        payload,
        base_version,
        key: mintWriteKey(),
        write_policy: policy,
      };
      const seq =
        policy.strategy === "pessimistic"
          ? await queue.enqueue(write)
          : await queue.enqueueOptimistic(write, localRow);
      return { write, seq };
    });
    reportTelemetry(context, policy, "local_queued", {}, span);

    if (policy.strategy === "local_queue") {
      span?.end?.();
      return { status: "queued", attempts: 0 };
    }
    try {
      reportTelemetry(context, policy, "send_started", {}, span);
      const ack = validateAck(write, await send(write));
      const outcome = await mutate(() =>
        _applyAck(table, id, ack, seq, policy.strategy),
      );
      reportTelemetry(context, policy, "acknowledged", {}, span);
      span?.end?.();
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
        attempts = await mutate(() => queue.bumpAttempts(seq));
      } catch (storageError) {
        const failure = new Error("sync write failed and retry state was not durable");
        failure.cause = storageError;
        failure.sendError = err;
        throw failure;
      }
      if (attempts === 0) {
        reportTelemetry(context, policy, "acknowledged", {}, span);
        span?.end?.();
        return { status: "acked", via: "echo" };
      }
      const result = {
        status: "queued",
        ...(policy.failure_mode === "emit_only"
          ? {}
          : { error: String(err) }),
        attempts,
      };
      const extra = { attempts, error_type: errorType(err) };
      reportTelemetry(context, policy, "failed", extra, span);
      reportTelemetry(context, policy, "retry_scheduled", extra, span);
      span?.error?.(extra.error_type);
      span?.end?.();
      if (policy.failure_mode === "throw_error") {
        throw new SyncWriteError("sync write failed; retry remains durable", {
          cause: err,
          result,
          write,
        });
      }
      return result;
    }
  }

  /**
   * Compatibility wrapper retaining the original optimistic API. New call sites
   * should prefer write(..., { policy }) so strategy and failure behavior are
   * explicit enum values rather than boolean switches.
   */
  async function optimisticWrite(
    table,
    id,
    row,
    send,
    op = "upsert",
    merge = false,
  ) {
    const context = {
      table,
      op,
      mutation: merge ? "merge" : "replace",
    };
    const configured = policyFor(context);
    return write(table, id, row, send, {
      op,
      mutation: merge ? "merge" : "replace",
      policy: { ...configured, strategy: "optimistic" },
    });
  }

  /** Optimistically delete a row (see optimisticWrite with op:"delete"). */
  function optimisticDelete(table, id, send) {
    return optimisticWrite(table, id, null, send, "delete");
  }

  /**
   * Optimistic PARTIAL update: deep-merge `patch` into the row already held (so a
   * single changed field or one key of a nested jsonb object keeps its siblings),
   * then queue and send that merged whole-row value. This is the right entry
   * point for form/single-field edits (e.g. the htmx extension).
   */
  function optimisticPatch(table, id, patch, send, op = "upsert") {
    return optimisticWrite(table, id, patch, send, op, true);
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
    for (const w of await mutate(() => queue.list())) {
      try {
        const ack = validateAck(w, await send(w));
        await mutate(() =>
          _applyAck(
            w.table,
            w.id,
            ack,
            w.seq,
            w.write_policy?.strategy,
          ),
        );
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

  function hydrate(table, rows, options) {
    return mutate(() => _hydrate(table, rows, options));
  }

  return {
    applyChange,
    write,
    optimisticWrite,
    optimisticPatch,
    optimisticDelete,
    flushQueue,
    hydrate,
  };
}
