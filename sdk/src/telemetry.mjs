// Optional OpenTelemetry adapter. The sync SDK intentionally has no hard
// dependency on an OTel distribution: applications inject the tracer, logger,
// and meter from the provider they already configure.

const ERROR_STATUS = 2;
const SEVERITY = Object.freeze({
  failed: Object.freeze({ number: 17, text: "ERROR" }),
  retry_scheduled: Object.freeze({ number: 13, text: "WARN" }),
  conflict_resolved: Object.freeze({ number: 13, text: "WARN" }),
});

function attributes(context) {
  return {
    "db.system.name": context.storage ?? "indexeddb",
    "db.collection.name": context.table,
    "db.operation.name": context.op,
    "fiducia.sync.strategy": context.strategy,
  };
}

function severityFor(phase) {
  return SEVERITY[phase] ?? { number: 9, text: "INFO" };
}

/**
 * Adapt OpenTelemetry API-compatible tracer, logger, and meter objects to the
 * small dependency-free telemetry surface consumed by makeSyncClient().
 *
 * Row ids, payloads, idempotency keys, error messages, and arbitrary custom
 * error names are deliberately not recorded. This keeps cardinality bounded
 * and avoids leaking customer data.
 */
export function makeOpenTelemetryTelemetry({ tracer, logger, meter } = {}) {
  let eventCounter;
  try {
    eventCounter = meter?.createCounter?.("fiducia.sync.write.events", {
      description: "Count of bounded Fiducia sync write lifecycle events",
      unit: "{event}",
    });
  } catch {
    eventCounter = undefined;
  }

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
      const severity = severityFor(event.phase);
      const eventAttributes = {
        ...attributes(context),
        "fiducia.sync.phase": event.phase,
        "fiducia.sync.attempts": event.attempts ?? 0,
        ...(event.error_type ? { "error.type": event.error_type } : {}),
      };
      try {
        eventCounter?.add?.(1, eventAttributes);
      } catch {
        // A broken metrics exporter must not suppress logs or affect writes.
      }
      try {
        logger?.emit?.({
          severityNumber: severity.number,
          severityText: severity.text,
          body: `fiducia.sync.${event.phase}`,
          attributes: eventAttributes,
        });
      } catch {
        // Observability exporters are best-effort and isolated from durability.
      }
    },
  };
}
