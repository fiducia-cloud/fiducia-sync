// The `fiducia-optimistic` HTMX extension: makes htmx write through the local-first
// store. On a mutating hx-post/hx-put whose element opts in with
// data-fiducia-table + data-fiducia-id, we write IndexedDB immediately (instant
// DOM) and enqueue the durable write; the request still goes to the backend, and
// the committed change flows back via a transport to reconcile. HTMX stays the
// render/trigger layer sitting ON TOP of the optimistic store.

/**
 * Pure: derive an optimistic write intent from an element + its request values.
 * `values` may be a FormData/anything with .entries(), or a plain object.
 * Returns { table, id, row } or null when the element didn't opt in.
 */
export function optimisticIntent(el, values) {
  const attr = (k) =>
    (el && typeof el.getAttribute === "function" ? el.getAttribute(k) : null) ??
    el?.dataset?.[k.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ??
    null;

  const table = attr("data-fiducia-table");
  const id = attr("data-fiducia-id");
  if (!table || !id) return null;

  const row = { id };
  if (values) {
    const entries =
      typeof values.entries === "function" ? values.entries() : Object.entries(values);
    for (const [k, v] of entries) row[k] = v;
  }
  return { table, id, row };
}

/**
 * Register the extension. Elements activate it with hx-ext="fiducia-optimistic".
 * @param {object} htmx    the htmx instance
 * @param {object} client  makeSyncClient(...) result
 * @param {(write:object)=>Promise<{id:string,committed_version:number}>} send
 */
export function registerOptimisticExtension(htmx, client, send) {
  htmx.defineExtension("fiducia-optimistic", {
    onEvent(name, evt) {
      if (name !== "htmx:configRequest") return true;
      const verb = String(evt.detail?.verb ?? "").toLowerCase();
      if (verb !== "post" && verb !== "put") return true;

      const intent = optimisticIntent(evt.detail.elt, evt.detail.parameters);
      if (!intent) return true;

      // Instant local write + durable queue; the real request still proceeds and
      // the committed change reconciles when it echoes back over a transport.
      void client.optimisticWrite(intent.table, intent.id, intent.row, send);
      return true;
    },
  });
}
