import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectWebSocket(url, timeoutMs) {
  assert.equal(typeof WebSocket, "function", "Node must provide the WebSocket API");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`DevTools WebSocket did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("DevTools WebSocket failed to open"));
    }, { once: true });
  });
}

function createCdpClient(socket) {
  let nextId = 1;
  const pending = new Map();

  function rejectPending(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  socket.addEventListener("message", async (event) => {
    try {
      let text;
      if (typeof event.data === "string") text = event.data;
      else if (event.data instanceof ArrayBuffer) text = Buffer.from(event.data).toString("utf8");
      else if (ArrayBuffer.isView(event.data)) {
        text = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString("utf8");
      } else text = Buffer.from(await event.data.arrayBuffer()).toString("utf8");
      const message = JSON.parse(text);
      if (typeof message.id !== "number") return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(`CDP ${waiter.method} failed: ${JSON.stringify(message.error)}`));
      } else waiter.resolve(message.result ?? {});
    } catch (error) {
      rejectPending(error);
    }
  });
  socket.addEventListener("close", () => {
    rejectPending(new Error("DevTools WebSocket closed unexpectedly"));
  });

  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { method, resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}

async function stopChrome(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await Promise.race([closed, delay(2_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export async function runBrowserContract({ chromePath, pageUrl, profile, timeoutMs = 30_000 }) {
  const child = spawn(chromePath, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-sync",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-sandbox",
    "--remote-allow-origins=*",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  let devToolsSettled = false;
  let resolveDevTools;
  let rejectDevTools;
  const devToolsUrl = new Promise((resolve, reject) => {
    resolveDevTools = resolve;
    rejectDevTools = reject;
  });
  const startupTimer = setTimeout(() => {
    if (devToolsSettled) return;
    devToolsSettled = true;
    rejectDevTools(new Error(`Chrome did not expose DevTools within 10 seconds.\n${stderr}`));
  }, 10_000);

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match && !devToolsSettled) {
      devToolsSettled = true;
      clearTimeout(startupTimer);
      resolveDevTools(match[1]);
    }
  });
  child.once("error", (error) => {
    if (devToolsSettled) return;
    devToolsSettled = true;
    clearTimeout(startupTimer);
    rejectDevTools(error);
  });
  child.once("close", (code, signal) => {
    if (devToolsSettled) return;
    devToolsSettled = true;
    clearTimeout(startupTimer);
    rejectDevTools(new Error(`Chrome exited before DevTools was ready: code=${code} signal=${signal ?? "none"}.\n${stderr}`));
  });

  let socket;
  try {
    socket = await connectWebSocket(await devToolsUrl, 5_000);
    const cdp = createCdpClient(socket);
    const { targetId } = await cdp.send("Target.createTarget", { url: pageUrl });
    assert.equal(typeof targetId, "string", "Chrome did not return a target id");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    assert.equal(typeof sessionId, "string", "Chrome did not return a session id");
    await cdp.send("Runtime.enable", {}, sessionId);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const evaluation = await cdp.send("Runtime.evaluate", {
          expression: "document.body?.dataset.status ?? 'loading'",
          returnByValue: true,
        }, sessionId);
        const status = evaluation.result?.value;
        if (status === "passed") {
          await cdp.send("Target.closeTarget", { targetId });
          return;
        }
        if (status === "failed") {
          const output = await cdp.send("Runtime.evaluate", {
            expression: "document.querySelector('#output')?.textContent ?? ''",
            returnByValue: true,
          }, sessionId);
          throw new Error(`Browser contract failed:\n${output.result?.value ?? "unknown failure"}\nChrome stderr:\n${stderr}`);
        }
      } catch (error) {
        if (String(error).includes("Browser contract failed:")) throw error;
      }
      await delay(50);
    }
    throw new Error(`Browser contract timed out while page status remained pending.\nChrome stderr:\n${stderr}`);
  } finally {
    socket?.close();
    await stopChrome(child);
  }
}
