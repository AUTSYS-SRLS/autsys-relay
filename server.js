import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";

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

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    product: "AUTSYS PC BRIDGE GATEWAY",
    version: "0.1.0.9",
    utc: nowIso(),
    connectedBridges: [...bridges.values()]
      .filter(x => x.ws.readyState === WebSocket.OPEN).length
  });
});

app.get("/api/status", requireControl, (_req, res) => {
  res.json({
    ok: true,
    version: "0.1.0.9",
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
  const tool = String(req.body?.tool || "").trim();
  if (!tool) {
    return res.status(400).json({ ok: false, error: "tool is required" });
  }

  const requestId = String(req.body?.requestId || crypto.randomUUID());
  if (pending.has(requestId)) {
    return res.status(409).json({ ok: false, error: "requestId already in use" });
  }

  let bridge;
  try {
    bridge = selectBridge(req.body?.bridgeId ? String(req.body.bridgeId) : "");
  } catch (err) {
    return res.status(503).json({ ok: false, error: String(err.message || err) });
  }

  const startedAt = performance.now();

  try {
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
          tool,
          arguments: req.body?.arguments ?? {}
        });
      } catch (err) {
        clearTimeout(timeout);
        pending.delete(requestId);
        reject(err);
      }
    });

    const gatewayRoundTripMs =
      Math.round((performance.now() - startedAt) * 1000) / 1000;

    res.json({
      ok: true,
      requestId,
      bridgeId: bridge.bridgeId,
      gatewayRoundTripMs,
      bridgeResponse
    });
  } catch (err) {
    res.status(504).json({
      ok: false,
      requestId,
      bridgeId: bridge.bridgeId,
      error: String(err.message || err)
    });
  }
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
  console.log(`AUTSYS PC BRIDGE GATEWAY 0.1.0.9 listening on ${PORT}`);
});
