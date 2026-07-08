// Adapter over the fiducia-sync-core WASM. The wasm ABI is JSON string in/out
// (see ../../src/wasm.rs); this wraps it as object-in/object-out JS so the client
// works with plain values. Same tested Rust core in the browser and in tests.

/** Wrap a loaded wasm module into an object-valued core. */
export function wrapCore(wasm) {
  return {
    /** reconcile(local|null, changeEvent) -> "Apply" | {Ignore:"Stale"|"AlreadyApplied"} | "Conflict" */
    reconcile(local, incoming) {
      const l = local == null ? undefined : JSON.stringify(local);
      return JSON.parse(wasm.reconcile(l, JSON.stringify(incoming)));
    },
    /** onAck(local, {id, committed_version}) -> {Adopt:<version>} | "Superseded" */
    onAck(local, ack) {
      return JSON.parse(wasm.on_ack(JSON.stringify(local), JSON.stringify(ack)));
    },
    /** True if `incoming` is the realtime echo of our own queued write. */
    isOwnEcho(queued, incoming) {
      return wasm.is_own_echo(JSON.stringify(queued), JSON.stringify(incoming));
    },
  };
}

/**
 * Browser core: dynamically import the bundler-target wasm (built by
 * `npm run build:wasm` into ../pkg) and wrap it. Bundlers (Vite) resolve the
 * `.wasm` asset automatically.
 */
export async function loadBrowserCore() {
  const wasm = await import("../../pkg/fiducia_sync_core.js");
  return wrapCore(wasm);
}
