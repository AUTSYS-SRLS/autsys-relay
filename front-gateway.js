import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const REPO_RAW_BASE = "https://raw.githubusercontent.com/AUTSYS-SRLS/autsys-relay";
const CONTROL_PATH = "control/command.json";
const MAX_CONTROL_BYTES = 262144;
const ALLOWED_TOOLS = new Set(["health", "fs.list", "fs.read_text", "fs.find", "fs.write_text", "fs.delete"]);
const processed = new Set();

if (!CONTROL_TOKEN) {
  console.error("FRONT GATEWAY disabled: missing CONTROL_TOKEN");
  process.exit(1);
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store"
  });
  res.end(payload);
}

async function fetchControlText(ref) {
  const response = await fetch(`${REPO_RAW_BASE}/${ref}/${CONTROL_PATH}`, {
    headers: { "user-agent": "AUTSYS-PC-BRIDGE-HOT-CONTROL/0.1.0.4" },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) {
    throw new Error(`control source HTTP ${response.status}`);
  }
  const text = await response.text();
  if (!text || Buffer.byteLength(text, "utf8") > MAX_CONTROL_BYTES) {
    throw new Error("invalid control payload size");
  }
  return text;
}

async function executeInternal(command) {
  const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/api/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId: command.requestId,
      bridgeId: command.bridgeId || undefined,
      tool: command.tool,
      arguments: command.arguments || {}
    }),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { body = { ok: false, error: text || `HTTP ${response.status}` }; }
  return { status: response.status, body };
}

async function handleChatPull(req, res, url) {
  try {
    const commit = String(url.searchParams.get("commit") || "").trim().toLowerCase();
    const requestId = String(url.searchParams.get("requestId") || "").trim();

    if (!/^[0-9a-f]{40}$/.test(commit)) {
      return json(res, 400, { ok: false, error: "invalid commit" });
    }
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
      return json(res, 400, { ok: false, error: "invalid requestId" });
    }
    if (processed.has(requestId)) {
      return json(res, 409, { ok: false, error: "request already processed" });
    }

    const text = await fetchControlText(commit);
    const command = JSON.parse(text);

    if (command?.protocol !== "chat-plain-v1") {
      return json(res, 400, { ok: false, error: "invalid control protocol" });
    }
    if (String(command.requestId || "") !== requestId) {
      return json(res, 400, { ok: false, error: "requestId mismatch" });
    }

    const expiresAt = Date.parse(String(command.expiresAt || ""));
    const now = Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt < now || expiresAt > now + 10 * 60 * 1000) {
      return json(res, 410, { ok: false, error: "command expired or invalid expiry" });
    }

    const tool = String(command.tool || "").trim();
    if (!ALLOWED_TOOLS.has(tool)) {
      return json(res, 403, { ok: false, error: `tool not allowed: ${tool}` });
    }

    processed.add(requestId);
    if (processed.size > 1000) processed.delete(processed.values().next().value);

    const started = performance.now();
    const result = await executeInternal({ ...command, tool });
    const totalMs = Math.round((performance.now() - started) * 1000) / 1000;
    console.log(`HOT_CHAT_CONTROL ${requestId} ${tool} http=${result.status} totalMs=${totalMs}`);
    return json(res, result.status, {
      ok: result.status >= 200 && result.status < 300,
      requestId,
      tool,
      hotControlMs: totalMs,
      gatewayResponse: result.body
    });
  } catch (err) {
    console.error(`HOT_CHAT_CONTROL error: ${String(err?.message || err)}`);
    return json(res, 500, { ok: false, error: String(err?.message || err) });
  }
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` };
  const proxy = http.request({
    host: "127.0.0.1",
    port: INTERNAL_PORT,
    method: req.method,
    path: req.url,
    headers
  }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on("error", err => {
    if (!res.headersSent) json(res, 502, { ok: false, error: `gateway backend unavailable: ${err.message}` });
    else res.destroy();
  });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); }
  catch { return json(res, 400, { ok: false, error: "bad request" }); }

  if (req.method === "GET" && url.pathname === "/chat-control/pull") {
    return handleChatPull(req, res, url);
  }
  proxyHttp(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(INTERNAL_PORT, "127.0.0.1", () => {
    let request = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      request += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    request += "\r\n";
    upstream.write(request);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AUTSYS PC BRIDGE FRONT GATEWAY listening on ${PORT}; backend=${INTERNAL_PORT}`);
  console.log("HOT CHAT CONTROL ready at /chat-control/pull");
});
