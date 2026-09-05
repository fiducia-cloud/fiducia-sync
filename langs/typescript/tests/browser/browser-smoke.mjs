// Real-browser persistence contract for @fiducia/sync.
// Uses only Node's standard library plus the runner-provided Chrome installation.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { runBrowserContract } from "./chrome-cdp.mjs";

const chromePath = process.env.CHROME_PATH;
assert.ok(chromePath, "CHROME_PATH must point to a Chrome/Chromium executable");

const modules = new Map([
  ["/src/store.mjs", new URL("../../src/store.mjs", import.meta.url)],
  ["/src/local-storage.mjs", new URL("../../src/local-storage.mjs", import.meta.url)],
  ["/src/merge.mjs", new URL("../../src/merge.mjs", import.meta.url)],
]);

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

const browserTests = String.raw`
import { openStore, makeQueue } from "/src/store.mjs";
import { openBrowserStore, openLocalStorageStore } from "/src/local-storage.mjs";
import { deepMerge } from "/src/merge.mjs";

const output = document.querySelector("#output");
const passed = [];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const mark = (name) => passed.push(name);
const expectReject = async (operation, pattern) => {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  check(failure instanceof Error, "expected operation to reject");
  check(pattern.test(failure.message), "unexpected rejection: " + failure.message);
};
const deleteDatabase = (name) => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("database deletion was blocked"));
});

try {
  check(typeof indexedDB?.open === "function", "Chrome IndexedDB is unavailable");
  check(typeof localStorage?.setItem === "function", "Chrome localStorage is unavailable");

  const suffix = crypto.randomUUID();
  const indexedName = "fiducia-browser-indexeddb-" + suffix;
  const first = await openStore(indexedName, ["items"]);
  const firstQueue = makeQueue(first);
  await first.put("items", "row-1", {
    id: "row-1",
    profile: { name: "Ada", flags: { alpha: true } },
  }, { version: 1, dirty: false });
  const seq = await firstQueue.enqueueOptimistic({
    table: "items",
    id: "row-1",
    op: "upsert",
    base_version: 1,
    write_key: "browser-write-1",
    payload: { id: "row-1", profile: { name: "Ada", flags: { beta: true } } },
  }, {
    id: "row-1",
    profile: { name: "Ada", flags: { alpha: true, beta: true } },
  });
  await first.setCursor(7, "items");
  check((await first.meta("items", "row-1"))?.dirty === true, "optimistic row was not dirty");
  check((await firstQueue.list()).length === 1, "retry intent was not committed with the row");

  // Open a second tab-shaped connection requiring another table. The first
  // connection's versionchange handler must release the upgrade without data loss.
  const upgraded = await openStore(indexedName, ["items", "audit"]);
  const upgradedQueue = makeQueue(upgraded);
  const persisted = await upgraded.get("items", "row-1");
  check(persisted?.profile?.flags?.alpha === true, "existing row was lost during schema upgrade");
  check(persisted?.profile?.flags?.beta === true, "optimistic row was lost during schema upgrade");
  check((await upgradedQueue.list())[0]?.seq === seq, "queue sequence was lost during schema upgrade");
  check(await upgraded.getCursor("items") === 7, "durable cursor was lost during schema upgrade");
  await upgraded.put("audit", "audit-1", { id: "audit-1", state: "created" }, {
    version: 1,
    dirty: false,
  });
  check((await upgraded.get("audit", "audit-1"))?.state === "created", "new object store is unusable");
  await upgradedQueue.settleAck("items", "row-1", seq, 2);
  check((await upgradedQueue.list()).length === 0, "ack did not retire the durable retry intent");
  check((await upgraded.meta("items", "row-1"))?.version === 2, "ack did not adopt committed version");
  check((await upgraded.meta("items", "row-1"))?.dirty === false, "ack did not mark the row clean");
  await expectReject(() => upgraded.setCursor(6, "items"), /cannot move backwards/);
  upgraded.close();
  await deleteDatabase(indexedName);
  mark("indexeddb-atomic-upgrade-and-ack");

  const localName = "fiducia-browser-localstorage-" + suffix;
  const local = await openLocalStorageStore(localName, ["items"]);
  const localQueue = makeQueue(local);
  const localSeq = await localQueue.enqueueOptimistic({
    table: "items",
    id: "local-1",
    op: "upsert",
    base_version: 3,
    write_key: "browser-local-write-1",
    payload: { id: "local-1", value: "queued" },
  }, { id: "local-1", value: "queued" });
  local.close();
  const localReloaded = await openLocalStorageStore(localName, ["items"]);
  const localReloadedQueue = makeQueue(localReloaded);
  check((await localReloaded.get("items", "local-1"))?.value === "queued", "localStorage row did not survive reopen");
  check((await localReloadedQueue.list())[0]?.seq === localSeq, "localStorage queue did not survive reopen");
  await localReloadedQueue.settleAck("items", "local-1", localSeq, 4);
  check((await localReloaded.meta("items", "local-1"))?.dirty === false, "localStorage ack did not mark row clean");
  check((await localReloadedQueue.list()).length === 0, "localStorage ack did not retire queue item");
  localReloaded.close();
  mark("localstorage-reload-and-ack");

  const selected = await openBrowserStore(localName + "-selected", ["items"], {
    persistence: "local_storage",
  });
  check(selected.storageKind === "local_storage", "explicit persistence enum selected the wrong adapter");
  selected.close();
  await expectReject(
    () => openBrowserStore(localName + "-invalid", ["items"], { persistence: "boolean-ish" }),
    /unsupported browser persistence mode/,
  );
  mark("persistence-enum");

  const hostile = JSON.parse('{"safe":{"b":2},"list":[2],"nullable":null,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  const base = { safe: { a: 1 }, list: [1], nullable: "present" };
  const merged = deepMerge(base, hostile);
  check(merged.safe.a === 1 && merged.safe.b === 2, "nested JSONB merge lost sibling fields");
  check(merged.list.length === 1 && merged.list[0] === 2, "arrays must replace rather than concatenate");
  check(merged.nullable === null, "null must remain an explicit value");
  check({}.polluted === undefined, "prototype pollution escaped deepMerge");
  check(base.safe.b === undefined, "deepMerge mutated its base input");
  mark("jsonb-merge-security");

  document.body.dataset.status = "passed";
  output.textContent = JSON.stringify({ passed }, null, 2);
} catch (error) {
  document.body.dataset.status = "failed";
  output.textContent = JSON.stringify({
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
  }, null, 2);
}
`;

const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Fiducia sync browser contract</title></head>
  <body data-status="running">
    <pre id="output">running</pre>
    <script type="module" src="/browser-tests.js"></script>
  </body>
</html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      send(res, 200, html, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return;
    }
    if (url.pathname === "/browser-tests.js") {
      send(res, 200, browserTests, {
        "content-type": "text/javascript; charset=utf-8",
        "cross-origin-resource-policy": "same-origin",
      });
      return;
    }
    const modulePath = modules.get(url.pathname);
    if (modulePath) {
      send(res, 200, await readFile(modulePath, "utf8"), {
        "content-type": "text/javascript; charset=utf-8",
        "cross-origin-resource-policy": "same-origin",
      });
      return;
    }
    send(res, 404, { error: "not_found" }, { "content-type": "application/json; charset=utf-8" });
  } catch (error) {
    if (!res.headersSent) {
      send(res, 500, { error: "test_server_error" }, { "content-type": "application/json; charset=utf-8" });
    } else res.destroy();
    console.error(error);
  }
});
server.on("clientError", (_error, socket) => socket.destroy());

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object", "browser test server did not bind");
const pageUrl = `http://127.0.0.1:${address.port}/`;
const profile = await mkdtemp(path.join(tmpdir(), "fiducia-sync-chrome-"));

try {
  await runBrowserContract({ chromePath, pageUrl, profile, timeoutMs: 30_000 });
  console.log("Fiducia sync persistence contract passed in real Chrome");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
