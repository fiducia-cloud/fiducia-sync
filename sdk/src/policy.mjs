// Write-policy + error-mode vocabulary for optimistic writes. Mirrors the
// canonical Rust definitions in src/policy.rs (same kebab-case wire names, same
// semantics matrix) so app code and telemetry attributes agree across runtimes.
//
// Both are enums, not booleans: optimism is a spectrum —
//
//   policy         | local mutate first | durable queue | sends now | ack adopts locally
//   local-only     | yes                | yes           | no        | — (flush later)
//   local-first    | yes                | yes           | yes       | via queue settlement
//   server-first   | no                 | no            | yes       | direct, version-guarded
//   server-only    | no                 | no            | yes       | no (echo/pull lands it)
//
// and error surfacing is a channel choice, not on/off — telemetry always sees
// every failure; the mode only selects what the CALLER experiences:
//
//   return  resolve with the failure encoded in the result (historical default)
//   throw   reject with a typed SyncWriteError (local-* writes stay queued)
//   emit    resolve quietly; the failure goes only to telemetry/status hooks

/** All write policies, most optimistic first. */
export const WRITE_POLICIES = Object.freeze([
  "local-only",
  "local-first",
  "server-first",
  "server-only",
]);

/** All error modes. */
export const ERROR_MODES = Object.freeze(["return", "throw", "emit"]);

export const DEFAULT_WRITE_POLICY = "local-first";
export const DEFAULT_ERROR_MODE = "return";

export function assertWritePolicy(policy) {
  if (!WRITE_POLICIES.includes(policy)) {
    throw new TypeError(
      `unknown write policy ${JSON.stringify(policy)}; expected one of ${WRITE_POLICIES.join(", ")}`,
    );
  }
  return policy;
}

export function assertErrorMode(mode) {
  if (!ERROR_MODES.includes(mode)) {
    throw new TypeError(
      `unknown error mode ${JSON.stringify(mode)}; expected one of ${ERROR_MODES.join(", ")}`,
    );
  }
  return mode;
}

/** Does the policy mutate the local store (dirty row) before any network IO? */
export const policyMutatesLocalFirst = (policy) =>
  policy === "local-only" || policy === "local-first";

/** Does the policy append a durable retry record to the write queue? */
export const policyEnqueuesDurably = policyMutatesLocalFirst;

/** Does the policy perform network IO as part of the write call itself? */
export const policySendsImmediately = (policy) => policy !== "local-only";

/**
 * A typed failure for `errorMode: "throw"` (and for durability failures, which
 * always throw regardless of mode). `queued` tells the caller whether the write
 * survives durably for a later flush; `attempts` is the durable retry counter.
 */
export class SyncWriteError extends Error {
  constructor(message, { write, policy, attempts = null, queued = false, cause } = {}) {
    super(message);
    this.name = "SyncWriteError";
    this.write = write;
    this.policy = policy;
    this.attempts = attempts;
    this.queued = queued;
    if (cause !== undefined) this.cause = cause;
  }
}
