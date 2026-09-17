import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const WORK_BOOTSTRAP_PORT = Number(process.env.WORK_BOOTSTRAP_PORT || 10005);
const GATEWAY_INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || "";

if (!CONTROL_TOKEN || !MCP_ACCESS_TOKEN) {
  console.error("MCP AUTH FRONT disabled: missing CONTROL_TOKEN or MCP_ACCESS_TOKEN");
  process.exit(1);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function bearer(req) {
  const raw = String(req.headers.authorization || "");
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function proxyHttp(req, res, targetPort, replaceAuthorization = false) {
  const headers = {
    ...req.headers,
    host: `127.0.0.1:${targetPort}`
  };
  if (replaceAuthorization) headers.authorization = `Bearer ${CONTROL_TOKEN}`;

  const upstream = http.request({
    host: "127.0.0.1",
    port: targetPort,
    method: req.method,
    path: req.url,
    headers
  }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });

  upstream.on("error", err => {
    if (!res.headersSent) json(res, 502, { ok: false, error: `upstream unavailable: ${err.message}` });
    else res.destroy();
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); }
  catch { return json(res, 400, { ok: false, error: "bad request" }); }

  if (url.pathname === "/mcp") {
    if (!safeEqual(bearer(req), MCP_ACCESS_TOKEN)) {
      return json(res, 401, { ok: false, error: "UNAUTHORIZED" });
    }
    return proxyHttp(req, res, GATEWAY_INTERNAL_PORT, true);
  }

  return proxyHttp(req, res, WORK_BOOTSTRAP_PORT, false);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(WORK_BOOTSTRAP_PORT, "127.0.0.1", () => {
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
  console.log(`AUTSYS MCP AUTH FRONT listening on ${PORT}; workBootstrap=${WORK_BOOTSTRAP_PORT}; backend=${GATEWAY_INTERNAL_PORT}`);
  console.log("Dedicated MCP bearer authentication ready on /mcp");
});
