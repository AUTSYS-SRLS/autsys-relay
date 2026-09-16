import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const WORK_FRONT_PORT = Number(process.env.WORK_FRONT_PORT || 10003);
const GATEWAY_INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || "";
const SESSION_COOKIE = "autsys_work_session";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

if (!CONTROL_TOKEN || !PANEL_SESSION_SECRET) {
  console.error("WORK DB FRONT disabled: missing CONTROL_TOKEN or PANEL_SESSION_SECRET");
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

function layout(content) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AUTSYS PC BRIDGE — DB</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#111827;color:#f9fafb;margin:0;padding:24px;line-height:1.4}main{max-width:980px;margin:auto}.card{background:#1f2937;border:1px solid #374151;border-radius:14px;padding:18px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}h1,h2{margin:.2em 0 .6em}label{display:block;font-weight:700;margin-top:10px}input,textarea,select,button{font:inherit}input,textarea,select{width:100%;box-sizing:border-box;background:#0f172a;color:#f9fafb;border:1px solid #475569;border-radius:8px;padding:10px;margin-top:5px}textarea{min-height:160px}button{background:#e5e7eb;color:#111827;border:0;border-radius:8px;padding:10px 14px;font-weight:700;cursor:pointer;margin-top:12px}.danger{background:#fecaca}.muted{color:#cbd5e1}.warn{color:#fde68a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#020617;border:1px solid #334155;border-radius:8px;padding:12px}a{color:#93c5fd}</style></head><body><main>${content}</main></body></html>`;
}

function page(result = null, title = "Risultato") {
  const output = result == null ? "" : `<div class="card"><h2>${esc(title)}</h2><pre>${esc(JSON.stringify(result, null, 2))}</pre></div>`;
  return layout(`<div class="card"><h1>AUTSYS PC BRIDGE — DB</h1><p class="muted">Estensione protetta per registrazione progetti ed evoluzione dello schema ROBERTA.</p><p><a href="/work">← Torna al pannello Work</a></p><p class="warn"><strong>Nota:</strong> le migrazioni usano il tool protetto pg.roberta.migrate con backup, transazione e guardie additive.</p></div><div class="grid">
<div class="card"><h2>Registra progetto</h2><form method="post" action="/work/db/run"><input type="hidden" name="tool" value="project.register"><label>Nome progetto</label><input name="projectName" required><label>Project key (opzionale)</label><input name="projectKey"><label>Entity kind</label><input name="entityKind" required><label>Root path</label><input name="rootPath"><label>Repository URL</label><input name="repositoryUrl"><label>Repository branch</label><input name="repositoryBranch"><label>Descrizione</label><textarea name="description"></textarea><label><input style="width:auto" type="checkbox" name="isAuthoritative" value="true" checked> Authoritative</label><label><input style="width:auto" type="checkbox" name="confirm" value="YES" required> Confermo la registrazione</label><button>PROJECT.REGISTER</button></form></div>
<div class="card"><h2>Migrazione ROBERTA</h2><form method="post" action="/work/db/run"><input type="hidden" name="tool" value="pg.roberta.migrate"><label>Migration ID</label><input name="migrationId" required><label>Descrizione</label><input name="migrationDescription" required><label>SQL migrazione additiva</label><textarea name="sql" required></textarea><label><input style="width:auto" type="checkbox" name="confirm" value="YES" required> Confermo la migrazione dello schema</label><button class="danger">ESEGUI MIGRAZIONE</button></form></div>
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

function projectArgs(form) {
  const projectName = String(form.get("projectName") || "").trim();
  const projectKey = String(form.get("projectKey") || "").trim();
  const entityKind = String(form.get("entityKind") || "").trim();
  if (!projectName || !entityKind) throw new Error("projectName and entityKind are required");
  const out = {
    projectName,
    entityKind,
    isAuthoritative: String(form.get("isAuthoritative") || "").toLowerCase() === "true"
  };
  if (projectKey) out.projectKey = projectKey;
  for (const name of ["rootPath", "repositoryUrl", "repositoryBranch", "description"]) {
    const value = String(form.get(name) || "").trim();
    if (value) out[name] = value;
  }
  return out;
}

function migrateArgs(form) {
  const migrationId = String(form.get("migrationId") || "").trim();
  const description = String(form.get("migrationDescription") || "").trim();
  const sql = String(form.get("sql") || "").trim();
  if (!migrationId || !description || !sql) throw new Error("migrationId, description and sql are required");
  return { migrationId, description, sql };
}

async function callBridge(tool, args) {
  const requestId = crypto.randomUUID();
  const timeoutMs = tool === "pg.roberta.migrate" ? 300000 : 30000;
  const response = await fetch(`http://127.0.0.1:${GATEWAY_INTERNAL_PORT}/api/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, tool, arguments: args }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, raw: text }; }
  return { httpStatus: response.status, requestId, body };
}

function proxy(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${WORK_FRONT_PORT}` };
  const upstream = http.request({ host: "127.0.0.1", port: WORK_FRONT_PORT, method: req.method, path: req.url, headers }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  upstream.on("error", err => {
    if (!res.headersSent) html(res, 502, layout(`<div class="card"><h1>Errore</h1><pre>${esc(err.message)}</pre></div>`));
    else res.destroy();
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); }
  catch { return html(res, 400, layout("<div class=\"card\">Bad request</div>")); }

  if (!url.pathname.startsWith("/work/db")) return proxy(req, res);

  try {
    if (!validSession(req)) return html(res, 303, "", { location: "/work" });
    if (req.method === "GET" && (url.pathname === "/work/db" || url.pathname === "/work/db/")) return html(res, 200, page());
    if (req.method === "POST" && url.pathname === "/work/db/run") {
      const form = await readForm(req);
      if (String(form.get("confirm") || "") !== "YES") return html(res, 400, page({ ok: false, error: "confirmation required" }, "Errore"));
      const tool = String(form.get("tool") || "").trim();
      if (tool !== "project.register" && tool !== "pg.roberta.migrate") return html(res, 403, page({ ok: false, error: "tool not allowed" }, "Errore"));
      const args = tool === "project.register" ? projectArgs(form) : migrateArgs(form);
      const result = await callBridge(tool, args);
      return html(res, 200, page(result, `${tool} — risultato`));
    }
    return html(res, 404, page({ ok: false, error: "not found" }, "Errore"));
  } catch (err) {
    console.error(`WORK_DB_FRONT error: ${String(err?.message || err)}`);
    return html(res, 500, page({ ok: false, error: String(err?.message || err) }, "Errore"));
  }
});


server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(GATEWAY_INTERNAL_PORT, "127.0.0.1", () => {
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
  console.log(`AUTSYS WORK DB FRONT listening on ${PORT}; work=${WORK_FRONT_PORT}; backend=${GATEWAY_INTERNAL_PORT}`);
  console.log("WORK DB extension ready at /work/db");
});
