export type ChangeOp = "upsert" | "delete";
export type SyncWriteStrategy =
  | "local_queue"
  | "optimistic"
  | "pessimistic";
export type SyncFailureMode =
  | "return_result"
  | "throw_error"
  | "emit_only";
export type SyncTelemetryLevel =
  | "off"
  | "errors"
  | "lifecycle"
  | "verbose";
export type SyncMutationMode = "replace" | "merge";
export type BrowserPersistence =
  | "indexeddb"
  | "local_storage"
  | "indexeddb_with_local_storage_fallback";

export interface SyncWritePolicy {
  strategy: SyncWriteStrategy;
  failure_mode: SyncFailureMode;
  telemetry: SyncTelemetryLevel;
}

export interface SyncWriteContext {
  table: string;
  op: ChangeOp;
  mutation: SyncMutationMode;
}

export interface ChangeEvent<Row = Record<string, unknown>> {
  table: string;
  op: ChangeOp;
  id: string;
  version: number;
  row: Row | null;
  at_ms: number;
  write_key?: string;
  sync_sequence?: number;
}

export interface LocalRowMeta {
  version: number;
  dirty: boolean;
}

export interface SyncReplicaMetadata extends LocalRowMeta {
  created_at_ms: number;
  updated_at_ms: number;
  synced_at_ms?: number;
}

export interface QueuedWrite<Row = Record<string, unknown>> {
  seq?: number;
  id: string;
  table: string;
  op: ChangeOp;
  payload: Row | null;
  base_version: number;
  key?: string;
  attempts?: number;
  write_policy?: SyncWritePolicy;
}

export interface WriteAck {
  id: string;
  committed_version: number;
}

export type ReconcileDecision =
  | "Apply"
  | "Conflict"
  | { Ignore: "Stale" | "AlreadyApplied" };

export type AckOutcome = "Superseded" | "Missing" | { Adopt: number };

export interface SyncCore {
  reconcile(local: LocalRowMeta | null, incoming: ChangeEvent): ReconcileDecision;
  onAck(local: LocalRowMeta, ack: WriteAck): AckOutcome;
  isOwnEcho(queued: QueuedWrite, incoming: ChangeEvent): boolean;
}

export interface SyncStore {
  get<Row = Record<string, unknown>>(table: string, id: string): Promise<Row | null>;
  meta(table: string, id: string): Promise<LocalRowMeta | null>;
  replicaMeta(table: string, id: string): Promise<SyncReplicaMetadata | null>;
  put<Row = Record<string, unknown>>(
    table: string,
    id: string,
    row: Row,
    meta: LocalRowMeta,
  ): Promise<void>;
  setMeta(
    table: string,
    id: string,
    meta: Partial<LocalRowMeta>,
  ): Promise<boolean>;
  del(table: string, id: string): Promise<void>;
  all<Row = Record<string, unknown>>(table: string): Promise<Row[]>;
  getCursor(scope?: string): Promise<number>;
  setCursor(cursor: number, scope?: string): Promise<number>;
  close(): void;
  readonly storageKind: "indexeddb" | "local_storage";
  readonly _db?: IDBDatabase;
}

export interface SyncQueue {
  enqueue(write: QueuedWrite): Promise<number>;
  enqueueOptimistic<Row = Record<string, unknown>>(
    write: QueuedWrite<Row>,
    row: Row | null,
  ): Promise<number>;
  list<Row = Record<string, unknown>>(): Promise<Array<QueuedWrite<Row> & { seq: number }>>;
  remove(seq: number): Promise<void>;
  settleAck(
    table: string,
    id: string,
    seq: number,
    committedVersion: number,
  ): Promise<AckOutcome>;
  settlePessimistic(
    table: string,
    id: string,
    seq: number,
    committedVersion: number,
  ): Promise<AckOutcome>;
  adoptEcho(event: ChangeEvent, seq: number): Promise<boolean>;
  resolveConflict(event: ChangeEvent, seqs: number[]): Promise<void>;
  bumpAttempts(seq: number): Promise<number>;
}

export type SendWrite<Row = Record<string, unknown>> = (
  write: QueuedWrite<Row>,
) => Promise<WriteAck>;

export interface OptimisticResult {
  status: "acked" | "queued";
  version?: number;
  via?: "echo";
  error?: string;
  attempts?: number;
}

export type SyncWriteResult = OptimisticResult;

export interface SyncTelemetryEvent {
  phase:
    | "local_queued"
    | "send_started"
    | "acknowledged"
    | "retry_scheduled"
    | "failed"
    | "conflict_resolved";
  strategy: SyncWriteStrategy;
  table: string;
  op: ChangeOp;
  at_ms: number;
  attempts?: number;
  error_type?: string;
}

export interface SyncTelemetrySpan {
  event?(phase: SyncTelemetryEvent["phase"], attributes?: Record<string, unknown>): void;
  error?(errorType: string): void;
  end?(): void;
}

export interface SyncTelemetry {
  startWrite?(context: {
    table: string;
    op: ChangeOp;
    strategy: SyncWriteStrategy;
    storage: "indexeddb" | "local_storage";
  }): SyncTelemetrySpan | undefined;
  emit?(
    event: SyncTelemetryEvent,
    context: {
      table: string;
      op: ChangeOp;
      strategy: SyncWriteStrategy;
      storage: "indexeddb" | "local_storage";
    },
  ): void;
}

export interface HydrateResult {
  applied: number;
  ignored: number;
  conflicts: number;
  pruned: number;
}

export interface SyncClient {
  applyChange(event: ChangeEvent): Promise<string>;
  write<Row = Record<string, unknown>>(
    table: string,
    id: string,
    row: Row | null,
    send: SendWrite<Row> | undefined,
    options?: {
      op?: ChangeOp;
      mutation?: SyncMutationMode;
      policy?: SyncWritePolicy;
    },
  ): Promise<SyncWriteResult>;
  optimisticWrite<Row = Record<string, unknown>>(
    table: string,
    id: string,
    row: Row | null,
    send: SendWrite<Row>,
    op?: ChangeOp,
    merge?: boolean,
  ): Promise<OptimisticResult>;
  optimisticPatch<Row = Record<string, unknown>>(
    table: string,
    id: string,
    patch: Partial<Row>,
    send: SendWrite<Row>,
    op?: ChangeOp,
  ): Promise<OptimisticResult>;
  optimisticDelete(table: string, id: string, send: SendWrite): Promise<OptimisticResult>;
  flushQueue(
    send: SendWrite,
    options?: {
      onError?: (error: unknown, write: QueuedWrite, attempts: number | null) => void;
    },
  ): Promise<number>;
  hydrate<Row = Record<string, unknown>>(
    table: string,
    rows: Row[],
    options?: { prune?: boolean },
  ): Promise<HydrateResult>;
}

export interface PullPage {
  changes: ChangeEvent[];
  next_cursor: number;
  has_more: boolean;
}

export interface BackendOptions {
  baseUrl: string;
  wsPath?: string;
  ssePath?: string;
  pathPrefix?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  csrfToken?: string | (() => string | undefined | Promise<string | undefined>);
  streamAuth?: "cookie" | "query-token";
}

export interface SupabaseChannelLike {
  on(
    event: "postgres_changes",
    options: Record<string, unknown>,
    callback: (payload: unknown) => void,
  ): SupabaseChannelLike;
  subscribe(callback?: (status: string, error?: Error) => void): SupabaseChannelLike;
}

export interface SupabaseClientLike {
  channel(name: string): SupabaseChannelLike;
  removeChannel?(channel: SupabaseChannelLike): unknown;
}

export interface StartSyncOptions {
  dbName: string;
  tables: string[];
  core?: SyncCore;
  backend?: BackendOptions | false;
  supabase?:
    | {
        client: SupabaseClientLike;
        filter?: string | Record<string, string>;
        channelName?: string;
      }
    | false;
  hydrateFetch?: (table: string) => Promise<Record<string, unknown>[]>;
  pullFetch?: (cursor: number, limit: number) => Promise<PullPage>;
  onStatus?: (status: string, error?: Error) => void;
  hydratePrune?: boolean;
  cursorScope?: string;
  pullPageSize?: number;
  writePolicy?: SyncWritePolicy;
  resolveWritePolicy?: (context: SyncWriteContext) => SyncWritePolicy;
  telemetry?: SyncTelemetry;
  persistence?: BrowserPersistence;
  localStorage?: Pick<Storage, "getItem" | "setItem">;
  onPersistenceFallback?: (error: unknown) => void;
}

export interface SyncHandle {
  client: SyncClient;
  store: SyncStore;
  queue: SyncQueue;
  send?: SendWrite;
  hydrate(): Promise<void>;
  pull(): Promise<void>;
  stop(): void;
}

export function openStore(dbName: string, tables: string[]): Promise<SyncStore>;
export function openLocalStorageStore(
  dbName: string,
  tables: string[],
  options?: { storage?: Pick<Storage, "getItem" | "setItem"> },
): Promise<SyncStore>;
export function openBrowserStore(
  dbName: string,
  tables: string[],
  options?: {
    persistence?: BrowserPersistence;
    storage?: Pick<Storage, "getItem" | "setItem">;
    onFallback?: (error: unknown) => void;
  },
): Promise<SyncStore>;
export function makeQueue(store: SyncStore): SyncQueue;
export function promisify<T = unknown>(request: IDBRequest<T>): Promise<T>;
export function deepMerge<T>(base: T, patch: unknown): T;
export function wrapCore(wasm: Record<string, (...args: never[]) => unknown>): SyncCore;
export function loadBrowserCore(): Promise<SyncCore>;
export function makeSyncClient(deps: {
  store: SyncStore;
  queue: SyncQueue;
  core: SyncCore;
  writePolicy?: SyncWritePolicy;
  resolveWritePolicy?: (context: SyncWriteContext) => SyncWritePolicy;
  telemetry?: SyncTelemetry;
}): SyncClient;
export function startSync(options: StartSyncOptions): Promise<SyncHandle>;

export const DEFAULT_WRITE_POLICY: Readonly<SyncWritePolicy>;
export class SyncWriteError extends Error {
  readonly result?: SyncWriteResult;
  readonly write?: QueuedWrite;
}

export function makeOpenTelemetryTelemetry(options?: {
  tracer?: {
    startSpan?(
      name: string,
      options?: { attributes?: Record<string, unknown> },
    ): {
      addEvent?(name: string, attributes?: Record<string, unknown>): void;
      setAttribute?(name: string, value: unknown): void;
      setStatus?(status: { code: number; message?: string }): void;
      end?(): void;
    };
  };
  logger?: {
    emit?(record: {
      severityNumber: number;
      severityText: string;
      body: string;
      attributes: Record<string, unknown>;
    }): void;
  };
}): SyncTelemetry;

export function subscribeSupabase(options: {
  client: SupabaseClientLike;
  tables: string[];
  onChange(change: ChangeEvent): void;
  channelName?: string;
  filter?: string | Record<string, string>;
  onStatus?(status: string, error?: Error): void;
}): { stop(): void };

export function decodeSupabaseChange(
  table: string,
  payload: unknown,
): ChangeEvent | null;
export function decodeBackendMessage(data: unknown): ChangeEvent[];
export function isChangeEvent(value: unknown): value is ChangeEvent;

export function backendSend(
  baseUrl: string,
  write: QueuedWrite,
  options?: Omit<BackendOptions, "baseUrl" | "wsPath" | "ssePath" | "streamAuth">,
): Promise<WriteAck>;
export function makeBackendSend(
  baseUrl: string,
  options?: Omit<BackendOptions, "baseUrl" | "wsPath" | "ssePath" | "streamAuth">,
): SendWrite;
export function connectBackend(options: Omit<BackendOptions, "pathPrefix" | "csrfToken"> & {
  onChanges(changes: ChangeEvent[]): void;
  onStatus?(status: string, error?: Error): void;
}): { stop(): void };

export function optimisticIntent(
  element: Element,
  values: Record<string, unknown>,
): { table: string; id: string; row: Record<string, unknown> } | null;
export function registerOptimisticExtension(
  htmx: unknown,
  client: SyncClient,
  send: SendWrite,
): void;

// --- Hybrid Logical Clock (hlc.mjs) — device-monotonic advisory stamps ---

export interface HlcStamp {
  wallMs: number;
  counter: number;
  encoded: string;
}

export const HLC_MAX_WALL_MS: number;
export const HLC_MAX_COUNTER: number;
export function encodeHlc(stamp: { wallMs: number; counter: number }): string;
export function decodeHlc(text: string): { wallMs: number; counter: number } | null;
export function makeHlc(options?: {
  state?: { wallMs: number; counter: number } | null;
  now?: () => number;
}): {
  tick(): HlcStamp;
  observe(remoteMs: number): HlcStamp;
  state(): { wallMs: number; counter: number };
};

// --- Canonical-schema runtime validation (validate.mjs / sync-schema.mjs) ---

export interface SchemaViolation {
  path: string;
  message: string;
}

export class SchemaValidationError extends Error {
  name: "SchemaValidationError";
  definition: string;
  violations: SchemaViolation[];
}

export const SYNC_SCHEMA: Record<string, unknown>;
export function makeValidator(schemaDocument?: Record<string, unknown>): {
  definitions(): string[];
  validate(definition: string, value: unknown): SchemaViolation[];
  assert<T>(definition: string, value: T): T;
};
export function validateSyncEnvelope(definition: string, value: unknown): SchemaViolation[];
export function assertSyncEnvelope<T>(definition: string, value: T): T;
/** Build Zod schemas (one per $def) with the CALLER's zod instance. */
export function zodSchemas<Z>(z: Z, schemaDocument?: Record<string, unknown>): Record<string, unknown>;
