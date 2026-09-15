import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const VERSION = "0.1.0.10";
const PORT = Number(process.env.PORT || 10000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 2 * 1024 * 1024);

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
      item.reject(new Error(reason));
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

  const bridgeResponse = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Bridge timeout after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, {
      resolve,
      reject,
      timeout,
      startedAt,
      bridgeId: bridge.bridgeId
    });

    try {
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
    pendingRequests: pending.size
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
      if (!waiter) return;

      clearTimeout(waiter.timeout);
      pending.delete(requestId);
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AUTSYS PC BRIDGE GATEWAY ${VERSION} listening on ${PORT}`);
  console.log("MCP endpoint ready at /mcp");
});
