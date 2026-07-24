export type ChangeOp = "upsert" | "delete";

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
  /** When THIS device last adopted server-authoritative state for the row. */
  syncedAtMs?: number | null;
}

/** Optimism spectrum for one write — see policy.mjs for the semantics matrix. */
export type WritePolicy = "local-only" | "local-first" | "server-first" | "server-only";

/** Caller-facing failure channel; telemetry always observes regardless. */
export type ErrorMode = "return" | "throw" | "emit";

export const WRITE_POLICIES: readonly WritePolicy[];
export const ERROR_MODES: readonly ErrorMode[];
export const DEFAULT_WRITE_POLICY: WritePolicy;
export const DEFAULT_ERROR_MODE: ErrorMode;
export function assertWritePolicy(policy: string): WritePolicy;
export function assertErrorMode(mode: string): ErrorMode;

export class SyncWriteError extends Error {
  constructor(
    message: string,
    options?: {
      write?: QueuedWrite;
      policy?: WritePolicy;
      attempts?: number | null;
      queued?: boolean;
      cause?: unknown;
    },
  );
  name: "SyncWriteError";
  write?: QueuedWrite;
  policy?: WritePolicy;
  attempts: number | null;
  queued: boolean;
  cause?: unknown;
  sendError?: unknown;
}

export interface OptimisticWriteOptions {
  op?: ChangeOp;
  merge?: boolean;
  policy?: WritePolicy;
  errorMode?: ErrorMode;
}

export interface TelemetryEvent {
  name: string;
  at_ms: number;
  duration_ms: number;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
  error?: unknown;
}

export type TelemetrySink =
  | ((event: TelemetryEvent) => void)
  | { emit(event: TelemetryEvent): void };

export const TELEMETRY_EVENTS: readonly string[];
export function noopTelemetry(): { emit(event: TelemetryEvent): void };
export function normalizeTelemetry(
  telemetry?: TelemetrySink | null,
): { emit(event: TelemetryEvent): void };
export function otelTelemetry(options: {
  tracer?: {
    startSpan(
      name: string,
      options?: { startTime?: number; attributes?: Record<string, unknown> },
    ): {
      end(endTime?: number): void;
      setStatus?(status: { code: number; message?: string }): void;
      recordException?(error: unknown): void;
    };
  };
  logger?: { error?(...args: unknown[]): void };
}): { emit(event: TelemetryEvent): void };

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

export interface QueuedWrite<Row = Record<string, unknown>> {
  seq?: number;
  id: string;
  table: string;
  op: ChangeOp;
  payload: Row | null;
  base_version: number;
  key?: string;
  attempts?: number;
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

export interface SyncInfo {
  cursor: number;
  /** Last completed catch-up on this device (null before the first). */
  lastSyncedAtMs: number | null;
}

export interface HlcState {
  wallMs: number;
  counter: number;
}

export interface SyncStore {
  get<Row = Record<string, unknown>>(table: string, id: string): Promise<Row | null>;
  meta(table: string, id: string): Promise<LocalRowMeta | null>;
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
  markSynced?(scope?: string): Promise<number>;
  syncInfo?(scope?: string): Promise<SyncInfo>;
  getHlcState?(): Promise<HlcState | null>;
  setHlcState?(state: HlcState): Promise<void>;
  close(): void;
  readonly _db: IDBDatabase;
}

export interface SyncQueue {
  enqueue(write: QueuedWrite): Promise<number>;
  enqueueOptimistic<Row = Record<string, unknown>>(
    write: QueuedWrite<Row>,
    row: Row | null,
    options?: { hlcState?: HlcState },
  ): Promise<number>;
  list<Row = Record<string, unknown>>(): Promise<Array<QueuedWrite<Row> & { seq: number }>>;
  remove(seq: number): Promise<void>;
  settleAck(
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
  /** "failed" only occurs under the pessimistic server-* policies. */
  status: "acked" | "queued" | "failed";
  version?: number;
  via?: "echo";
  error?: string;
  attempts?: number;
  /** Durable queue sequence, present for queued (local-*) results. */
  seq?: number;
}

export interface HydrateResult {
  applied: number;
  ignored: number;
  conflicts: number;
  pruned: number;
}

export interface SyncClient {
  applyChange(event: ChangeEvent): Promise<string>;
  optimisticWrite<Row = Record<string, unknown>>(
    table: string,
    id: string,
    row: Row | null,
    send?: SendWrite<Row>,
    opOrOptions?: ChangeOp | OptimisticWriteOptions,
    merge?: boolean,
  ): Promise<OptimisticResult>;
  optimisticPatch<Row = Record<string, unknown>>(
    table: string,
    id: string,
    patch: Partial<Row>,
    send: SendWrite<Row>,
    opOrOptions?: ChangeOp | OptimisticWriteOptions,
  ): Promise<OptimisticResult>;
  optimisticDelete(
    table: string,
    id: string,
    send: SendWrite,
    options?: Omit<OptimisticWriteOptions, "op" | "merge">,
  ): Promise<OptimisticResult>;
  flushQueue(
    send: SendWrite,
    options?: {
      onError?: (error: unknown, write: QueuedWrite, attempts: number | null) => void;
      errorMode?: ErrorMode;
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
  telemetry?: TelemetrySink;
  writePolicy?: WritePolicy;
  errorMode?: ErrorMode;
  hydratePrune?: boolean;
  cursorScope?: string;
  pullPageSize?: number;
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

export function openStore(
  dbName: string,
  tables: string[],
  options?: { now?: () => number },
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
  telemetry?: TelemetrySink;
  now?: () => number;
  writePolicy?: WritePolicy;
  errorMode?: ErrorMode;
}): SyncClient;
export function startSync(options: StartSyncOptions): Promise<SyncHandle>;

/** Web-Storage fallback store (localStorage/sessionStorage) — see webstorage.mjs. */
export function openWebStorageStore(
  dbName: string,
  tables: string[],
  options?: {
    storage?: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    };
    now?: () => number;
  },
): Promise<Omit<SyncStore, "_db">>;
export function makeWebStorageQueue(store: Omit<SyncStore, "_db">): SyncQueue;

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
