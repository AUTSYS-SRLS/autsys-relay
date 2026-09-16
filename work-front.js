import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const LEGACY_FRONT_PORT = Number(process.env.LEGACY_FRONT_PORT || 10002);
const GATEWAY_INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const PANEL_ACCESS_KEY = process.env.PANEL_ACCESS_KEY || "";
const PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || "";
const SESSION_COOKIE = "autsys_work_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

const ALLOWED_TOOLS = new Set([
  "health",
  "fs.list",
  "fs.read_text",
  "fs.find",
  "fs.write_text",
  "fs.delete",
  "pg.roberta.query",
  "pg.roberta.write",
  "session.bootstrap"
]);
const WRITE_TOOLS = new Set(["fs.write_text", "fs.delete", "pg.roberta.write"]);

if (!CONTROL_TOKEN || !PANEL_ACCESS_KEY || !PANEL_SESSION_SECRET) {
  console.error("WORK FRONT disabled: missing CONTROL_TOKEN, PANEL_ACCESS_KEY or PANEL_SESSION_SECRET");
  process.exit(1);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}
function signSession(exp) {
  const payload = String(exp);
  const sig = crypto.createHmac("sha256", PANEL_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function validSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = crypto.createHmac("sha256", PANEL_SESSION_SECRET).update(payload).digest("base64url");
  return safeEqual(sig, expected);
}
function html(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extraHeaders
  });
  res.end(payload);
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
function layout(title, content) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#111827;color:#f9fafb;margin:0;padding:24px;line-height:1.4}main{max-width:980px;margin:auto}.card{background:#1f2937;border:1px solid #374151;border-radius:14px;padding:18px;margin:14px 0}h1,h2{margin:.2em 0 .6em}label{display:block;font-weight:700;margin-top:10px}input,textarea,select,button{font:inherit}input,textarea,select{width:100%;box-sizing:border-box;background:#0f172a;color:#f9fafb;border:1px solid #475569;border-radius:8px;padding:10px;margin-top:5px}textarea{min-height:120px}button{background:#e5e7eb;color:#111827;border:0;border-radius:8px;padding:10px 14px;font-weight:700;cursor:pointer;margin-top:12px}button.danger{background:#fecaca}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px}.muted{color:#cbd5e1}.warn{color:#fde68a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#020617;border:1px solid #334155;border-radius:8px;padding:12px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center}</style></head><body><main>${content}</main></body></html>`;
}
function loginPage(message = "") {
  return layout("AUTSYS PC BRIDGE — Work", `<div class="card"><h1>AUTSYS PC BRIDGE — Work</h1><p class="muted">Accesso protetto al Bridge AUTSYS. Sono disponibili solo strumenti esplicitamente autorizzati.</p>${message ? `<p class="warn">${esc(message)}</p>` : ""}<form method="post" action="/work/login"><label>Chiave di accesso</label><input name="accessKey" type="password" autocomplete="current-password" required><button type="submit">ENTRA</button></form></div>`);
}
function panelPage(result = null, resultTitle = "Risultato") {
  const output = result == null ? "" : `<div class="card"><h2>${esc(resultTitle)}</h2><pre>${esc(JSON.stringify(result, null, 2))}</pre></div>`;
  return layout("AUTSYS PC BRIDGE — Work", `<div class="top"><div><h1>AUTSYS PC BRIDGE — Work</h1><div class="muted">Interfaccia controllata per ChatGPT Work</div></div><form method="post" action="/work/logout"><button type="submit">ESCI</button></form></div><div class="card"><p><strong>Disponibili:</strong> health, file tools, pg.roberta.query, pg.roberta.write, session.bootstrap.</p><p class="warn"><strong>Governance:</strong> nessuna shell libera e nessun SQL libero di scrittura; migrazioni e registrazione progetti restano nell’estensione DB protetta.</p></div><div class="grid">
<div class="card"><h2>Stato Bridge</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="health"><button>HEALTH</button></form></div>
<div class="card"><h2>Elenca cartella</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="fs.list"><label>Percorso</label><input name="path" required><button>ELENCA</button></form></div>
<div class="card"><h2>Leggi file</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="fs.read_text"><label>Percorso file</label><input name="path" required><button>LEGGI</button></form></div>
<div class="card"><h2>Cerca</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="fs.find"><label>Percorso</label><input name="path" required><label>Pattern</label><input name="pattern" required><button>CERCA</button></form></div>
<div class="card"><h2>Scrivi file</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="fs.write_text"><label>Percorso file</label><input name="path" required><label>Contenuto</label><textarea name="content" required></textarea><label><input style="width:auto" type="checkbox" name="confirm" value="YES" required> Confermo la scrittura</label><button>SCRIVI</button></form></div>
<div class="card"><h2>Elimina file</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="fs.delete"><label>Percorso file</label><input name="path" required><label><input style="width:auto" type="checkbox" name="confirm" value="YES" required> Confermo l'eliminazione</label><button class="danger">ELIMINA</button></form></div>
<div class="card"><h2>Query ROBERTA</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="pg.roberta.query"><label>SQL sola lettura</label><textarea name="sql" required></textarea><button>ESEGUI QUERY</button></form></div>
<div class="card"><h2>Scrittura dati ROBERTA</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="pg.roberta.write"><label>Richiesta JSON strutturata</label><textarea name="writeJson" required></textarea><label><input style="width:auto" type="checkbox" name="confirm" value="YES" required> Confermo la scrittura dati</label><button class="danger">ESEGUI SCRITTURA</button></form></div>
<div class="card"><h2>Session bootstrap</h2><form method="post" action="/work/run"><input type="hidden" name="tool" value="session.bootstrap"><label>Ambito</label><select name="scope"><option>GENERAL</option><option>PROJECT</option></select><label>Nome progetto (solo PROJECT)</label><input name="projectName"><button>BOOTSTRAP</button></form></div>
</div>${output}`);
}
async function readForm(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function parseWriteArguments(form) {
  const text = String(form.get("writeJson") || "").trim();
  if (!text || text.length > 512 * 1024) throw new Error("write JSON missing or too large");
  let args;
  try { args = JSON.parse(text); } catch { throw new Error("write JSON invalid"); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("write JSON must be an object");

  const allowedKeys = new Set(["operation","schema","table","values","rows","filters","conflictColumns","maxAffectedRows","returning","idempotencyKey"]);
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) throw new Error(`write field not allowed: ${key}`);
  }
  const operation = String(args.operation || "").trim().toLowerCase();
  if (!["insert","update","delete","upsert"].includes(operation)) throw new Error("invalid write operation");
  if (String(args.schema || "").trim() !== "public") throw new Error("only public schema is allowed");
  const identifier = value => /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(String(value || "").trim());
  if (!identifier(args.table)) throw new Error("invalid table");
  const idempotencyKey = String(args.idempotencyKey || "").trim();
  if (!idempotencyKey || idempotencyKey.length > 240) throw new Error("invalid idempotencyKey");
  if (args.sql !== undefined) throw new Error("free SQL is not allowed");
  if (args.returning != null && (!Array.isArray(args.returning) || args.returning.some(x => !identifier(x)))) throw new Error("invalid returning");
  if (args.conflictColumns != null && (!Array.isArray(args.conflictColumns) || args.conflictColumns.some(x => !identifier(x)))) throw new Error("invalid conflictColumns");
  if (args.filters != null && !Array.isArray(args.filters)) throw new Error("invalid filters");
  if (["update","delete"].includes(operation)) {
    if (!Array.isArray(args.filters) || args.filters.length === 0) throw new Error("update/delete require filters");
    if (!Number.isInteger(args.maxAffectedRows) || args.maxAffectedRows < 1 || args.maxAffectedRows > 100) throw new Error("invalid maxAffectedRows");
  }
  args.operation = operation;
  args.schema = "public";
  args.table = String(args.table).trim();
  args.idempotencyKey = idempotencyKey;
  return args;
}

function buildArguments(tool, form) {
  switch (tool) {
    case "health": return {};
    case "fs.list":
    case "fs.read_text":
    case "fs.delete": return { path: String(form.get("path") || "").trim() };
    case "fs.find": return { path: String(form.get("path") || "").trim(), pattern: String(form.get("pattern") || "").trim() };
    case "fs.write_text": return { path: String(form.get("path") || "").trim(), content: String(form.get("content") || "") };
    case "pg.roberta.query": return { sql: String(form.get("sql") || "").trim() };
    case "pg.roberta.write": return parseWriteArguments(form);
    case "session.bootstrap": return { scope: String(form.get("scope") || "GENERAL").trim().toUpperCase(), projectName: String(form.get("projectName") || "").trim() };
    default: throw new Error("tool not supported");
  }
}
async function callBridge(tool, args) {
  const requestId = crypto.randomUUID();
  const response = await fetch(`http://127.0.0.1:${GATEWAY_INTERNAL_PORT}/api/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, tool, arguments: args }),
    signal: AbortSignal.timeout(tool === "pg.roberta.write" ? 60000 : 30000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, raw: text }; }
  return { httpStatus: response.status, requestId, body };
}
function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${LEGACY_FRONT_PORT}` };
  const proxy = http.request({ host: "127.0.0.1", port: LEGACY_FRONT_PORT, method: req.method, path: req.url, headers }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on("error", err => {
    if (!res.headersSent) json(res, 502, { ok: false, error: `legacy gateway unavailable: ${err.message}` });
    else res.destroy();
  });
  req.pipe(proxy);
}
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); }
  catch { return json(res, 400, { ok: false, error: "bad request" }); }
  if (!url.pathname.startsWith("/work")) return proxyHttp(req, res);
  try {
    if (req.method === "GET" && url.pathname === "/work/healthz") return json(res, 200, { ok: true, product: "AUTSYS PC BRIDGE WORK FRONT" });
    if (req.method === "POST" && url.pathname === "/work/login") {
      const form = await readForm(req);
      if (!safeEqual(String(form.get("accessKey") || ""), PANEL_ACCESS_KEY)) return html(res, 401, loginPage("Chiave non valida."));
      const exp = Date.now() + SESSION_TTL_MS;
      return html(res, 303, "", { location: "/work", "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(signSession(exp))}; Path=/work; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict` });
    }
    if (req.method === "POST" && url.pathname === "/work/logout") return html(res, 303, "", { location: "/work", "set-cookie": `${SESSION_COOKIE}=; Path=/work; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
    if (!validSession(req)) {
      if (req.method === "GET" && (url.pathname === "/work" || url.pathname === "/work/")) return html(res, 200, loginPage());
      return html(res, 401, loginPage("Sessione non valida o scaduta."));
    }
    if (req.method === "GET" && (url.pathname === "/work" || url.pathname === "/work/")) return html(res, 200, panelPage());
    if (req.method === "POST" && url.pathname === "/work/run") {
      const form = await readForm(req);
      const tool = String(form.get("tool") || "").trim();
      if (!ALLOWED_TOOLS.has(tool)) return html(res, 403, panelPage({ ok: false, error: "tool not allowed" }, "Errore"));
      if (WRITE_TOOLS.has(tool) && String(form.get("confirm") || "") !== "YES") return html(res, 400, panelPage({ ok: false, error: "write confirmation required" }, "Errore"));
      const result = await callBridge(tool, buildArguments(tool, form));
      return html(res, 200, panelPage(result, `${tool} — risultato`));
    }
    return html(res, 404, panelPage({ ok: false, error: "not found" }, "Errore"));
  } catch (err) {
    console.error(`WORK_FRONT error: ${String(err?.message || err)}`);
    return html(res, 500, loginPage(`Errore: ${String(err?.message || err)}`));
  }
});
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(LEGACY_FRONT_PORT, "127.0.0.1", () => {
    let request = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) request += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    request += "\r\n";
    upstream.write(request);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`AUTSYS WORK FRONT listening on ${PORT}; legacy=${LEGACY_FRONT_PORT}; backend=${GATEWAY_INTERNAL_PORT}`);
  console.log("WORK PANEL ready at /work");
});
