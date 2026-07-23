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
