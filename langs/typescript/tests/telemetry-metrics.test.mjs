import assert from "node:assert/strict";
import test from "node:test";

import { makeOpenTelemetryTelemetry } from "../src/telemetry.mjs";

const context = {
  table: "infra_operations",
  op: "upsert",
  strategy: "optimistic",
  storage: "indexeddb",
};

test("OpenTelemetry bridge emits dashboardable bounded metrics and severity", () => {
  const counters = [];
  const logs = [];
  const telemetry = makeOpenTelemetryTelemetry({
    meter: {
      createCounter(name, options) {
        assert.equal(name, "fiducia.sync.write.events");
        assert.equal(options.unit, "{event}");
        return { add(value, attributes) { counters.push({ value, attributes }); } };
      },
    },
    logger: { emit(record) { logs.push(record); } },
  });

  for (const phase of [
    "acknowledged",
    "retry_scheduled",
    "conflict_resolved",
    "failed",
  ]) {
    telemetry.emit(
      { phase, attempts: 2, error_type: phase === "failed" ? "TypeError" : undefined },
      context,
    );
  }

  assert.equal(counters.length, 4);
  assert.deepEqual(logs.map(({ severityText }) => severityText), [
    "INFO", "WARN", "WARN", "ERROR",
  ]);
  assert.deepEqual(
    counters.map(({ attributes }) => attributes["fiducia.sync.phase"]),
    ["acknowledged", "retry_scheduled", "conflict_resolved", "failed"],
  );
  const serialized = JSON.stringify({ counters, logs });
  assert.doesNotMatch(serialized, /row-id|payload|idempotency|error message/);
});

test("a failing metrics exporter cannot suppress logs", () => {
  const logs = [];
  const telemetry = makeOpenTelemetryTelemetry({
    meter: {
      createCounter() {
        return { add() { throw new Error("metrics backend down"); } };
      },
    },
    logger: { emit(record) { logs.push(record); } },
  });
  assert.doesNotThrow(() => telemetry.emit(
    { phase: "failed", attempts: 1, error_type: "NetworkError" },
    context,
  ));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].severityText, "ERROR");
});

test("a failing logger remains isolated from the write path", () => {
  const telemetry = makeOpenTelemetryTelemetry({
    logger: { emit() { throw new Error("logger backend down"); } },
  });
  assert.doesNotThrow(() => telemetry.emit(
    { phase: "retry_scheduled", attempts: 1, error_type: "TimeoutError" },
    context,
  ));
});
