import {
  startSync,
  makeHlc,
  makeValidator,
  otelTelemetry,
  zodSchemas,
  SyncWriteError,
  DEFAULT_WRITE_POLICY,
  type ErrorMode,
  type OptimisticResult,
  type OptimisticWriteOptions,
  type PullPage,
  type QueuedWrite,
  type SchemaViolation,
  type SendWrite,
  type SyncClient,
  type TelemetryEvent,
  type WriteAck,
  type WritePolicy,
} from "@fiducia/sync";

declare const sendWrite: SendWrite;
declare const pullFetch: (cursor: number, limit: number) => Promise<PullPage>;

const queued: QueuedWrite = {
  id: "operation-7",
  table: "infra_operations",
  op: "upsert",
  payload: { state: "queued" },
  base_version: 3,
  key: "write-operation-7-v4",
};

const sendResult: Promise<WriteAck> = sendWrite(queued);
void sendResult;

void startSync({
  dbName: "fiducia-admin",
  tables: ["infra_operations"],
  backend: false,
  supabase: false,
  pullFetch,
  telemetry: (event: TelemetryEvent) => void event.attributes,
  writePolicy: "server-first",
  errorMode: "throw",
});

// The write-policy vocabulary is a closed string-literal union (enum, not bool).
const policy: WritePolicy = DEFAULT_WRITE_POLICY;
const mode: ErrorMode = "emit";
const options: OptimisticWriteOptions = { op: "upsert", merge: true, policy, errorMode: mode };
declare const client: SyncClient;
const written: Promise<OptimisticResult> = client.optimisticWrite(
  "infra_operations",
  "operation-7",
  { state: "queued" },
  sendWrite,
  options,
);
void written.then((result) => {
  const status: "acked" | "queued" | "failed" = result.status;
  void status;
});
// local-only writes may omit `send` entirely.
void client.optimisticWrite("infra_operations", "operation-8", { state: "draft" }, undefined, {
  policy: "local-only",
});
void client.flushQueue(sendWrite, { errorMode: "emit" });

const writeError = new SyncWriteError("failed", { queued: true });
const queuedFlag: boolean = writeError.queued;
void queuedFlag;

// Telemetry adapters and the HLC/type-validation utilities type-check.
void otelTelemetry({ logger: console });
const clock = makeHlc({ state: { wallMs: 0, counter: 0 } });
const encoded: string = clock.tick().encoded;
void encoded;
const violations: SchemaViolation[] = makeValidator().validate("SyncChangeEvent", queued);
void violations;
declare const zodInstance: { object(shape: Record<string, unknown>): unknown };
void zodSchemas(zodInstance);
