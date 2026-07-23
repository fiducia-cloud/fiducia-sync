// Optional OpenTelemetry adapter. The sync SDK intentionally has no hard
// dependency on an OTel distribution: applications inject the tracer/logger
// from the provider they already configure.

const ERROR_STATUS = 2;

function attributes(context) {
  return {
    "db.system.name": context.storage ?? "indexeddb",
    "db.collection.name": context.table,
    "db.operation.name": context.op,
    "fiducia.sync.strategy": context.strategy,
  };
}

/**
 * Adapt OpenTelemetry API-compatible tracer and logger objects to the small,
 * dependency-free telemetry surface consumed by makeSyncClient().
 *
 * Row ids, payloads, idempotency keys, and error messages are deliberately not
 * recorded. This keeps cardinality bounded and avoids leaking customer data.
 */
export function makeOpenTelemetryTelemetry({ tracer, logger } = {}) {
  return {
    startWrite(context) {
      const span = tracer?.startSpan?.("fiducia.sync.write", {
        attributes: attributes(context),
      });
      if (!span) return undefined;
      return {
        event(phase, eventAttributes = {}) {
          span.addEvent?.(`fiducia.sync.${phase}`, eventAttributes);
        },
        error(type) {
          span.setAttribute?.("error.type", type);
          span.setStatus?.({ code: ERROR_STATUS });
        },
        end() {
          span.end?.();
        },
      };
    },

    emit(event, context) {
      const failed = event.phase === "failed";
      logger?.emit?.({
        severityNumber: failed ? 17 : 9,
        severityText: failed ? "ERROR" : "INFO",
        body: `fiducia.sync.${event.phase}`,
        attributes: {
          ...attributes(context),
          "fiducia.sync.phase": event.phase,
          "fiducia.sync.attempts": event.attempts ?? 0,
          ...(event.error_type ? { "error.type": event.error_type } : {}),
        },
      });
    },
  };
}
