// OpenTelemetry-compatible observability for the sync SDK — with zero
// dependencies. The SDK emits plain event objects through a caller-provided
// sink; `otelTelemetry` adapts those events onto an INJECTED `@opentelemetry/api`
// tracer (the SDK never imports the OTel package itself, matching the repo's
// no-runtime-deps rule and the injectable-impl pattern used for sockets/timers).
//
// Event shape (stable contract, safe to index):
//   {
//     name:        "fiducia.sync.write" | ".apply" | ".flush" | ".hydrate"
//                  | ".pull" | ".conflict" | ".status",
//     at_ms:       wall-clock start of the operation,
//     duration_ms: elapsed time (0 for point events),
//     status:      "ok" | "error",
//     attributes:  flat bag of OTel-style attributes ("sync.table",
//                  "sync.policy", "sync.outcome", ...),
//     error:       the Error when status === "error" (never serialized here)
//   }
//
// Telemetry always observes every failure regardless of the write's errorMode —
// the mode only chooses the CALLER-facing channel. A sink must never throw; if
// it does, the SDK swallows the sink's error so observability can't corrupt
// sync state.

/** Event names the SDK emits (exported so dashboards/tests can enumerate). */
export const TELEMETRY_EVENTS = Object.freeze([
  "fiducia.sync.write",
  "fiducia.sync.apply",
  "fiducia.sync.flush",
  "fiducia.sync.hydrate",
  "fiducia.sync.pull",
  "fiducia.sync.conflict",
  "fiducia.sync.status",
]);

const NOOP = Object.freeze({ emit() {} });

/** The default sink: does nothing. */
export function noopTelemetry() {
  return NOOP;
}

/**
 * Accept a sink in any supported form: undefined (noop), a function (treated
 * as `emit`), or an object with `emit(event)`. The returned sink never throws.
 */
export function normalizeTelemetry(telemetry) {
  if (telemetry == null) return NOOP;
  const emit =
    typeof telemetry === "function"
      ? telemetry
      : typeof telemetry.emit === "function"
        ? telemetry.emit.bind(telemetry)
        : null;
  if (!emit) {
    throw new TypeError("telemetry must be a function or an object with emit(event)");
  }
  return {
    emit(event) {
      try {
        emit(event);
      } catch {
        // Observability must never break sync. Sink errors are dropped.
      }
    },
  };
}

/**
 * Adapt SDK events onto an injected OpenTelemetry API. Pass the objects your
 * app already has — none of them is required:
 *
 *   import { trace, logs } from "@opentelemetry/api"; // the APP's dependency
 *   const telemetry = otelTelemetry({
 *     tracer: trace.getTracer("fiducia-sync"),
 *     logger: console, // or an OTel Logs API logger with emit()
 *   });
 *
 * Each event becomes one span (`startSpan` with the event's start time and
 * attributes, `recordException`/error status on failure, ended at
 * start+duration). Errors are additionally reported to `logger.error` when a
 * logger is supplied.
 */
export function otelTelemetry({ tracer, logger } = {}) {
  if (!tracer && !logger) {
    throw new TypeError("otelTelemetry needs a tracer and/or a logger");
  }
  return normalizeTelemetry((event) => {
    if (tracer) {
      const span = tracer.startSpan(event.name, {
        startTime: event.at_ms,
        attributes: event.attributes,
      });
      if (event.status === "error") {
        if (event.error && typeof span.recordException === "function") {
          span.recordException(event.error);
        }
        // SpanStatusCode.ERROR === 2 in @opentelemetry/api; hard-coding the
        // number keeps the API package out of our dependency graph.
        span.setStatus?.({ code: 2, message: event.error?.message });
      }
      span.end(event.at_ms + (event.duration_ms ?? 0));
    }
    if (logger && event.status === "error") {
      logger.error?.(`[fiducia-sync] ${event.name}`, event.attributes, event.error);
    }
  });
}

/** Internal helper: emit one completed operation event. */
export function emitEvent(telemetry, name, { atMs, durationMs = 0, attributes = {}, error } = {}) {
  telemetry.emit({
    name,
    at_ms: atMs,
    duration_ms: durationMs,
    status: error ? "error" : "ok",
    attributes,
    ...(error ? { error } : {}),
  });
}
