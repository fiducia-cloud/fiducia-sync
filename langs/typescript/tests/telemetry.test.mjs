import assert from "node:assert/strict";
import test from "node:test";

import { makeOpenTelemetryTelemetry } from "../src/telemetry.mjs";

test("OpenTelemetry bridge records error type without message, row, or payload", () => {
  const calls = [];
  const telemetry = makeOpenTelemetryTelemetry({
    tracer: {
      startSpan(name, options) {
        calls.push({ name, options });
        return {
          setAttribute(key, value) {
            calls.push({ key, value });
          },
          setStatus(status) {
            calls.push({ status });
          },
          end() {},
        };
      },
    },
  });

  const span = telemetry.startWrite({
    table: "infra_operations",
    op: "upsert",
    strategy: "optimistic",
    storage: "indexeddb",
  });
  span.error("NetworkError");

  const serialized = JSON.stringify(calls);
  assert.match(serialized, /NetworkError/);
  assert.doesNotMatch(serialized, /secret-row|secret-payload|request failed/);
});
