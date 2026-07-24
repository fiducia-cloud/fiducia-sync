import {
  startSync,
  type PullPage,
  type QueuedWrite,
  type SendWrite,
  type WriteAck,
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
});

// --- additive: Hybrid Logical Clock + canonical-schema validation types ---
import {
  makeHlc,
  makeValidator,
  zodSchemas,
  type SchemaViolation,
} from "@fiducia/sync";

const clock = makeHlc({ state: { wallMs: 0, counter: 0 } });
const encoded: string = clock.tick().encoded;
void encoded;
void clock.observe(1_000);
const violations: SchemaViolation[] = makeValidator().validate("SyncChangeEvent", {});
void violations;
declare const zodInstance: { object(shape: Record<string, unknown>): unknown };
void zodSchemas(zodInstance);
