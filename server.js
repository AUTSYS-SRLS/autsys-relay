import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createClient } from "redis";

const VERSION = "0.1.0.14";
const INSTANCE_ID = crypto.randomUUID();
const PORT = Number(process.env.PORT || 10000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const LONG_REQUEST_TIMEOUT_MS = Number(process.env.LONG_REQUEST_TIMEOUT_MS || 300000);
const WRITE_REQUEST_TIMEOUT_MS = Number(process.env.WRITE_REQUEST_TIMEOUT_MS || 60000);
const SQLITE_REQUEST_TIMEOUT_MS = Number(process.env.SQLITE_REQUEST_TIMEOUT_MS || 120000);
// SQLite may still hold the local write until its own busy-timeout expires;
// the gateway deadline must be LONGER than the local SQLite timeout.
const SQLITE_WRITE_TIMEOUT_MS = Number(process.env.SQLITE_WRITE_TIMEOUT_MS || (SQLITE_REQUEST_TIMEOUT_MS + 15000));

function timeoutForTool(tool) {
  if (["fs.delete","fs.copy","fs.replace","fs.move_path","fs.hash_tree","fs.compare","fs.tree","fs.search_text","fs.zip","fs.unzip","bridge.update.apply","pg.roberta.migrate"].includes(tool)) return LONG_REQUEST_TIMEOUT_MS;
  if (tool === "sqlite.query") return SQLITE_REQUEST_TIMEOUT_MS;
  if (tool === "sqlite.execute") return Math.max(SQLITE_WRITE_TIMEOUT_MS, WRITE_REQUEST_TIMEOUT_MS);
  if (tool === "pg.roberta.write") return WRITE_REQUEST_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 48 * 1024 * 1024);

if (!BRIDGE_TOKEN || !CONTROL_TOKEN) {
  console.error("Missing BRIDGE_TOKEN or CONTROL_TOKEN");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: MAX_JSON_BYTES }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_JSON_BYTES });

const bridges = new Map();
const pending = new Map();
// Durable, isolated diagnostics namespace in the existing Frankfurt Render Key Value store.
const DIAG_PREFIX = "autsys:pc-bridge:diagnostics:v1:";
const DIAG_REDIS_ID = "red-dbacgfijnfac73f6qnb0";
let diagRedis = null;
let diagReady = false;
let diagLastError = null;
let diagWriteTail = Promise.resolve();
async function connectDiagnostics() {
  if (!process.env.RENDER_API_KEY) {
    diagLastError = "RENDER_API_KEY_MISSING";
    return;
  }
  try {
    const response = await fetch("https://api.render.com/v1/key-value/" + DIAG_REDIS_ID + "/connection-info", {
      headers: { authorization: "Bearer " + process.env.RENDER_API_KEY },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("CONNECTION_INFO_UNAVAILABLE");
    const info = await response.json();
    const url = info.internalConnectionString;
    if (!url) throw new Error("CONNECTION_STRING_UNAVAILABLE");
    const host = new URL(url).hostname;
    if (host !== DIAG_REDIS_ID && !host.startsWith(DIAG_REDIS_ID + "."))
      throw new Error("UNEXPECTED_REDIS_HOST");
    diagRedis = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 5000, reconnectStrategy: false } });
    diagRedis.on("error", () => { diagReady = false; diagLastError = "REDIS_CONNECTION_ERROR"; });
    await diagRedis.connect();
    diagReady = true;
    diagLastError = null;
    const unresolved = await diagRedis.hGetAll(DIAG_PREFIX + "active");
    for (const [id, raw] of Object.entries(unresolved)) {
      let item;
      try { item = JSON.parse(raw); } catch { continue; }
      const recovery = { ...item, at: nowIso(), state: "OUTCOME_UNCERTAIN_AFTER_RESTART", recovered: true };
      await diagRedis.rPush(DIAG_PREFIX + "events", JSON.stringify(recovery));
      await diagRedis.hSet(DIAG_PREFIX + "latest", id, JSON.stringify(recovery));
      await diagRedis.hDel(DIAG_PREFIX + "active", id);
      if (item.bridgeId && !NONBLOCKING_READ_TOOLS.has(item.tool))
        uncertainBridges.set(item.bridgeId, "Unreconciled request after gateway restart: " + id);
    }
  } catch (_) {
    diagReady = false;
    diagLastError = "PERSISTENCE_CONNECT_FAILED";
  }
}
function persistCommandEvent(event) {
  diagWriteTail = diagWriteTail.catch(() => {}).then(async () => {
    if (!diagReady || !diagRedis) return;
    try {
      const key = DIAG_PREFIX;
      const active = ["QUEUED", "DISPATCHED"].includes(event.state);
      const multi = diagRedis.multi()
        .rPush(key + "events", JSON.stringify(event))
        .hSet(key + "latest", event.requestId, JSON.stringify(event));
      if (active) multi.hSet(key + "active", event.requestId, JSON.stringify(event));
      else multi.hDel(key + "active", event.requestId);
      await multi.exec();
    } catch (_) {
      diagLastError = "PERSISTENCE_WRITE_FAILED";
    }
  });
}

// Bounded in-memory diagnostics. Persistent audit storage is a separate rollout.
const commandHistory = [];
const commandStates = new Map();
const COMMAND_HISTORY_LIMIT = 1000;
function commandEvent(requestId, bridgeId, tool, state, details = {}) {
  const event = { at: new Date().toISOString(), requestId, bridgeId, tool, state, ...details };
  commandHistory.push(event);
  if (commandHistory.length > COMMAND_HISTORY_LIMIT) commandHistory.shift();
  commandStates.set(requestId, event);
  if (commandStates.size > COMMAND_HISTORY_LIMIT) {
    commandStates.delete(commandStates.keys().next().value);
  }
  console.info("BRIDGE_COMMAND_LIFECYCLE", JSON.stringify(event));
  persistCommandEvent(event);
}

// One active command per Bridge. Queued commands start only after a confirmed result.
const bridgeQueues = new Map();
const uncertainBridges = new Map();
// Read-only timeouts are isolated failures: they must NEVER poison the whole Bridge.
// A timed-out mutation remains uncertain until its result is acknowledged.
const NONBLOCKING_READ_TOOLS = new Set([
  "health", "fs.list", "fs.find", "fs.read_text", "fs.read_lines",
  "fs.exists", "fs.stat", "fs.drives", "fs.hash", "fs.hash_tree",
  "fs.compare", "fs.tree", "fs.search_text", "fs.read_binary",
  "process.list", "process.discover", "process.status", "process.job_status",
  "sqlite.query", "pg.roberta.query"
]);
const EXPENSIVE_READ_TOOLS = new Set(["fs.find", "fs.search_text", "fs.tree", "fs.hash_tree"]);
const READ_COOLDOWN_MS = 30000;
const readCooldowns = new Map();
function serializeBridge(bridgeId, action, tool) {
  const previous = bridgeQueues.get(bridgeId) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => {
    const uncertain = uncertainBridges.get(bridgeId);
    // A timed-out write must not be blindly replayed, but read-only diagnostics
    // cannot change its outcome and must remain available to diagnose/recover.
    if (uncertain && !NONBLOCKING_READ_TOOLS.has(tool)) {
      throw new Error(`Bridge mutation uncertain: ${uncertain}. Further MUTATIONS are blocked until its outcome is reconciled; read-only diagnostics remain available.`);
    }
    const cooldownKey = bridgeId + ":" + tool;
    const cooldownUntil = readCooldowns.get(cooldownKey) || 0;
    if (cooldownUntil > Date.now()) {
      throw new Error(`${tool} temporarily unavailable after a read timeout; other Bridge operations remain available.`);
    }
    if (cooldownUntil) readCooldowns.delete(cooldownKey);
    return action();
  });
  const tail = current.catch(() => {});
  bridgeQueues.set(bridgeId, tail);
  tail.then(() => { if (bridgeQueues.get(bridgeId) === tail) bridgeQueues.delete(bridgeId); });
  return current;
}


const nowIso = () => new Date().toISOString();

function bearer(req) {
  const raw = String(req.headers.authorization || "");
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireControl(req, res, next) {
  if (!safeEqual(bearer(req), CONTROL_TOKEN)) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }
  next();
}

function sendJson(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error("Bridge WebSocket is not open.");
  }
  ws.send(JSON.stringify(obj));
}

function rejectPendingForBridge(bridgeId, reason) {
  for (const [requestId, item] of pending.entries()) {
    if (item.bridgeId === bridgeId) {
      clearTimeout(item.timeout);
      pending.delete(requestId);
      if (!NONBLOCKING_READ_TOOLS.has(item.tool)) {
        uncertainBridges.set(bridgeId, "Interrupted request " + requestId + ": " + reason);
      } else {
        if (EXPENSIVE_READ_TOOLS.has(item.tool)) readCooldowns.set(bridgeId + ":" + item.tool, Date.now() + READ_COOLDOWN_MS);
        console.warn("Read-only request interrupted without global lock:", item.tool, requestId, reason);
      }
      commandEvent(requestId, bridgeId, item.tool,
        NONBLOCKING_READ_TOOLS.has(item.tool) ? "READ_INTERRUPTED" : "OUTCOME_UNCERTAIN",
        { errorCode: "BRIDGE_DISCONNECTED" });
      item.reject(new Error(reason + (NONBLOCKING_READ_TOOLS.has(item.tool)
        ? " Read-only request failed; other commands remain available."
        : " Write outcome uncertain; new mutations blocked until reconciliation. Read-only diagnostics remain available.")));
    }
  }
}

function selectBridge(requestedBridgeId) {
  if (requestedBridgeId) {
    const item = bridges.get(requestedBridgeId);
    if (!item || item.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Bridge not connected: ${requestedBridgeId}`);
    }
    return { bridgeId: requestedBridgeId, ...item };
  }

  const open = [...bridges.entries()]
    .filter(([, item]) => item.ws.readyState === WebSocket.OPEN);

  if (open.length !== 1) {
    throw new Error(
      open.length === 0
        ? "No Bridge connected."
        : "Multiple Bridges connected: bridgeId is required."
    );
  }

  const [bridgeId, item] = open[0];
  return { bridgeId, ...item };
}

async function executeBridge(tool, args = {}, requestedBridgeId = "", requestIdOverride = "") {
  const cleanTool = String(tool || "").trim();
  if (!cleanTool) throw new Error("tool is required");

  const requestId = String(requestIdOverride || crypto.randomUUID());
  if (pending.has(requestId)) {
    throw new Error("requestId already in use");
  }

  const bridge = selectBridge(String(requestedBridgeId || ""));
  const startedAt = performance.now();
  commandEvent(requestId, bridge.bridgeId, cleanTool, "QUEUED");

  return serializeBridge(bridge.bridgeId, async () => {
  const bridgeResponse = await new Promise((resolve, reject) => {
    const timeoutMs = timeoutForTool(cleanTool);
    const timeout = setTimeout(() => {
      commandEvent(requestId, bridge.bridgeId, cleanTool,
        NONBLOCKING_READ_TOOLS.has(cleanTool) ? "READ_TIMEOUT" : "OUTCOME_UNCERTAIN",
        { timeoutMs });
      pending.delete(requestId);
      if (NONBLOCKING_READ_TOOLS.has(cleanTool)) {
        if (EXPENSIVE_READ_TOOLS.has(cleanTool)) {
          readCooldowns.set(bridge.bridgeId + ":" + cleanTool, Date.now() + READ_COOLDOWN_MS);
        }
        console.warn("Read-only Bridge timeout (NOT a global lock):", cleanTool, requestId);
        reject(new Error(`Bridge read-only timeout after ${timeoutMs} ms for ${cleanTool}; only this request failed`));
      } else {
        uncertainBridges.set(bridge.bridgeId, `request ${requestId} (${cleanTool}) timed out`);
        console.error("UNCERTAIN_BRIDGE_MUTATION", JSON.stringify({
          bridgeId: bridge.bridgeId, requestId, tool: cleanTool, timeoutMs,
          readOnlyDiagnosticsAvailable: true, at: nowIso()
        }));
        reject(new Error(`Bridge write timeout after ${timeoutMs} ms for ${cleanTool}; outcome uncertain. New mutations blocked pending reconciliation; read-only diagnostics remain available.`));
      }
    }, timeoutMs);

    pending.set(requestId, {
      resolve,
      reject,
      timeout,
      startedAt,
      bridgeId: bridge.bridgeId,
      tool: cleanTool
    });

    try {
      commandEvent(requestId, bridge.bridgeId, cleanTool, "DISPATCHED");
      sendJson(bridge.ws, {
        type: "execute",
        protocolVersion: "1",
        requestId,
        tool: cleanTool,
        arguments: args ?? {}
      });
    } catch (err) {
      clearTimeout(timeout);
      pending.delete(requestId);
      commandEvent(requestId, bridge.bridgeId, cleanTool, "DISPATCH_FAILED",
        { errorCode: "WEBSOCKET_SEND_ERROR" });
      reject(err);
    }
  });

  return {
    ok: true,
    requestId,
    bridgeId: bridge.bridgeId,
    gatewayRoundTripMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    bridgeResponse
  };
  }, cleanTool);
}

function mcpResult(envelope) {
  const br = envelope?.bridgeResponse;
  const payload = br?.ok ? br?.result : br?.error;
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: Boolean(br?.ok),
        bridgeId: envelope?.bridgeId,
        gatewayRoundTripMs: envelope?.gatewayRoundTripMs,
        executionMs: br?.executionMs,
        result: br?.ok ? payload : undefined,
        error: br?.ok ? undefined : payload
      })
    }],
    isError: !br?.ok
  };
}

function buildMcpServer() {
  const mcp = new McpServer({
    name: "AUTSYS PC BRIDGE",
    version: VERSION
  });

  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };

  mcp.registerTool(
    "pc_health",
    {
      title: "PC Bridge Health",
      description: "Legge lo stato reale di AUTSYS PC BRIDGE e del PC collegato.",
      inputSchema: z.object({
        bridgeId: z.string().optional().describe("Bridge specifico; omettere se ne e' connesso uno solo.")
      }),
      annotations: readOnly
    },
    async ({ bridgeId }) => mcpResult(await executeBridge("health", {}, bridgeId || ""))
  );

  mcp.registerTool(
    "pc_fs_list",
    {
      title: "Elenca cartella AUTSYS",
      description: "Elenca file e cartelle in sola lettura entro le radici autorizzate del PC.",
      inputSchema: z.object({
        path: z.string().min(1),
        bridgeId: z.string().optional()
      }),
      annotations: readOnly
    },
    async ({ path, bridgeId }) => mcpResult(await executeBridge("fs.list", { path }, bridgeId || ""))
  );

  mcp.registerTool(
    "pc_fs_read_text",
    {
      title: "Leggi file di testo AUTSYS",
      description: "Legge in sola lettura un file di testo entro le radici autorizzate del PC.",
      inputSchema: z.object({
        path: z.string().min(1),
        bridgeId: z.string().optional()
      }),
      annotations: readOnly
    },
    async ({ path, bridgeId }) => mcpResult(await executeBridge("fs.read_text", { path }, bridgeId || ""))
  );

  mcp.registerTool(
    "pc_fs_find",
    {
      title: "Cerca file AUTSYS",
      description: "Cerca ricorsivamente file e cartelle per pattern entro le radici autorizzate del PC.",
      inputSchema: z.object({
        path: z.string().min(1),
        pattern: z.string().min(1),
        bridgeId: z.string().optional()
      }),
      annotations: readOnly
    },
    async ({ path, pattern, bridgeId }) => mcpResult(await executeBridge("fs.find", { path, pattern }, bridgeId || ""))
  );

  return mcp;
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    product: "AUTSYS PC BRIDGE GATEWAY",
    version: VERSION,
    mcp: "/mcp",
    utc: nowIso(),
    connectedBridges: [...bridges.values()]
      .filter(x => x.ws.readyState === WebSocket.OPEN).length
  });
});

app.get("/bridge/instance", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, instanceId: INSTANCE_ID });
});

app.get("/api/status", requireControl, (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    utc: nowIso(),
    bridges: [...bridges.entries()].map(([bridgeId, item]) => ({
      bridgeId,
      connected: item.ws.readyState === WebSocket.OPEN,
      connectedAt: item.connectedAt,
      lastSeenAt: item.lastSeenAt,
      meta: item.meta
    })),
    pendingRequests: pending.size,
    uncertainBridges: [...uncertainBridges.entries()].map(([bridgeId, reason]) => ({ bridgeId, reason })),
    readCooldowns: [...readCooldowns.entries()].filter(([,until]) => until > Date.now())
      .map(([toolKey,until]) => ({ toolKey, retryAfterMs: until - Date.now() })),
    pendingDetails: [...pending.entries()].map(([requestId, item]) => ({ requestId, bridgeId: item.bridgeId, elapsedMs: Math.round(performance.now() - item.startedAt) }))
  });
});

app.get("/api/diagnostics/commands", requireControl, async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const bridgeId = String(req.query.bridgeId || "");
  const events = bridgeId ? commandHistory.filter(e => e.bridgeId === bridgeId) : commandHistory;
  const queued = events.filter(e => e.state === "QUEUED").length;
  res.setHeader("Cache-Control", "no-store");
  let persistedEvents = [];
  if (diagReady) {
    try { persistedEvents = (await diagRedis.lRange(DIAG_PREFIX + "events", -limit, -1)).map(x => JSON.parse(x)); }
    catch (_) { diagLastError = "PERSISTENCE_READ_FAILED"; }
  }
  res.json({
    ok: true, instanceId: INSTANCE_ID, utc: nowIso(),
    persistence: diagReady ? "RENDER_KEY_VALUE_JOURNAL_SNAPSHOT" : "UNAVAILABLE",
    persistenceError: diagLastError,
    activePending: [...pending.entries()].map(([requestId, p]) => ({
      requestId, bridgeId: p.bridgeId, tool: p.tool,
      elapsedMs: Math.round(performance.now() - p.startedAt)
    })),
    bridgeQueueSlots: [...bridgeQueues.keys()],
    uncertainBridges: [...uncertainBridges.entries()].map(([id, reason]) => ({ bridgeId: id, reason })),
    eventCount: events.length, queuedSinceProcessStart: queued,
    events: events.slice(-limit), persistedEvents
  });
});

app.post("/api/execute", requireControl, async (req, res) => {
  try {
    const result = await executeBridge(
      req.body?.tool,
      req.body?.arguments ?? {},
      req.body?.bridgeId ? String(req.body.bridgeId) : "",
      req.body?.requestId ? String(req.body.requestId) : ""
    );
    res.json(result);
  } catch (err) {
    const message = String(err?.message || err);
    const status = message.includes("not connected") || message.includes("No Bridge") ? 503 :
      message.includes("timeout") ? 504 : 400;
    res.status(status).json({ ok: false, error: message });
  }
});

app.post("/mcp", requireControl, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  const mcp = buildMcpServer();

  res.on("close", () => {
    try { transport.close(); } catch {}
    try { mcp.close(); } catch {}
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "MCP internal error" },
        id: null
      });
    }
  }
});

app.get("/mcp", requireControl, (_req, res) => {
  res.status(405).json({ ok: false, error: "Use POST /mcp (Streamable HTTP)." });
});

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== "/bridge") {
    socket.destroy();
    return;
  }

  if (!safeEqual(bearer(req), BRIDGE_TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", ws => {
  ws.isAlive = true;
  ws.bridgeId = null;

  ws.on("pong", () => {
    ws.isAlive = true;
    if (ws.bridgeId && bridges.has(ws.bridgeId)) {
      bridges.get(ws.bridgeId).lastSeenAt = nowIso();
    }
  });

  ws.on("message", data => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (msg?.type === "hello") {
      const bridgeId = String(msg.bridgeId || "").trim();
      if (!bridgeId) {
        ws.close(1008, "bridgeId required");
        return;
      }

      const previous = bridges.get(bridgeId);
      if (previous?.ws && previous.ws !== ws) {
        try { previous.ws.close(1012, "Replaced by newer connection"); } catch {}
      }

      ws.bridgeId = bridgeId;
      bridges.set(bridgeId, {
        ws,
        connectedAt: nowIso(),
        lastSeenAt: nowIso(),
        meta: {
          product: msg.product || null,
          version: msg.version || null,
          machineName: msg.machineName || null,
          protocolVersion: msg.protocolVersion || null
        }
      });

      try { sendJson(ws, { type: "hello_ack", instanceId: INSTANCE_ID }); } catch {}
      console.log(`Bridge connected: ${bridgeId} ${msg.version || ""}`);
      return;
    }

    if (msg?.type === "heartbeat" || msg?.type === "pong") {
      if (ws.bridgeId && bridges.has(ws.bridgeId)) {
        bridges.get(ws.bridgeId).lastSeenAt = nowIso();
      }
      return;
    }

    if (msg?.type === "result") {
      const requestId = String(msg.requestId || "");
      const waiter = pending.get(requestId);
      if (!waiter) {
        const old = commandStates.get(requestId);
        if (old) commandEvent(requestId, ws.bridgeId, old.tool, "LATE_RESULT",
          { responseOk: Boolean(msg.ok) });
        const uncertain = uncertainBridges.get(ws.bridgeId);
        if (uncertain && uncertain.includes(requestId)) {
          uncertainBridges.delete(ws.bridgeId);
          console.info("UNCERTAIN_BRIDGE_MUTATION_RESOLVED", JSON.stringify({
            bridgeId: ws.bridgeId, requestId, responseOk: Boolean(msg.ok), at: nowIso()
          }));
        }
        return;
      }

      clearTimeout(waiter.timeout);
      pending.delete(requestId);
      commandEvent(requestId, ws.bridgeId, waiter.tool,
        msg.ok ? "SUCCEEDED" : "FAILED",
        { elapsedMs: Math.round(performance.now() - waiter.startedAt) });
      waiter.resolve(msg);

      if (ws.bridgeId && bridges.has(ws.bridgeId)) {
        bridges.get(ws.bridgeId).lastSeenAt = nowIso();
      }
    }
  });

  ws.on("close", () => {
    const bridgeId = ws.bridgeId;
    if (bridgeId && bridges.get(bridgeId)?.ws === ws) {
      bridges.delete(bridgeId);
      rejectPendingForBridge(bridgeId, "Bridge disconnected.");
      console.log(`Bridge disconnected: ${bridgeId}`);
    }
  });

  ws.on("error", err => {
    console.error("Bridge WebSocket error:", err.message);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const [bridgeId, item] of bridges.entries()) {
    const ws = item.ws;
    if (ws.readyState !== WebSocket.OPEN) {
      bridges.delete(bridgeId);
      rejectPendingForBridge(bridgeId, "Bridge socket closed.");
      continue;
    }

    if (ws.isAlive === false) {
      ws.terminate();
      bridges.delete(bridgeId);
      rejectPendingForBridge(bridgeId, "Bridge heartbeat timeout.");
      continue;
    }

    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20000);

heartbeatTimer.unref();

void connectDiagnostics();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`AUTSYS PC BRIDGE GATEWAY ${VERSION} listening on ${PORT}`);
  console.log("MCP endpoint ready at /mcp");
});
