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
  readonly _db: IDBDatabase;
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
export function makeQueue(store: SyncStore): SyncQueue;
export function promisify<T = unknown>(request: IDBRequest<T>): Promise<T>;
export function deepMerge<T>(base: T, patch: unknown): T;
export function wrapCore(wasm: Record<string, (...args: never[]) => unknown>): SyncCore;
export function loadBrowserCore(): Promise<SyncCore>;
export function makeSyncClient(deps: {
  store: SyncStore;
  queue: SyncQueue;
  core: SyncCore;
}): SyncClient;
export function startSync(options: StartSyncOptions): Promise<SyncHandle>;

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
