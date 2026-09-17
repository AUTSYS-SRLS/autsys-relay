import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const WORK_DB_FRONT_PORT = Number(process.env.WORK_DB_FRONT_PORT || 10004);
const LEGACY_FRONT_PORT = Number(process.env.LEGACY_FRONT_PORT || 10002);
const GATEWAY_INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const PANEL_SESSION_SECRET = process.env.PANEL_SESSION_SECRET || "";
const SESSION_COOKIE = "autsys_work_session";
const TARGET_COOKIE = "autsys_bootstrap_target";
const TARGET_TTL_MS = 12 * 60 * 60 * 1000;

if (!CONTROL_TOKEN || !PANEL_SESSION_SECRET) {
  console.error("WORK BOOTSTRAP FRONT disabled: missing CONTROL_TOKEN or PANEL_SESSION_SECRET");
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
    try { out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim()); }
    catch {}
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

function signTarget(scope, projectName) {
  const data = {
    scope,
    projectName: scope === "PROJECT" ? projectName : "",
    exp: Date.now() + TARGET_TTL_MS
  };
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", PANEL_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readTarget(req) {
  const token = parseCookies(req)[TARGET_COOKIE];
  if (!token) return { scope: "GENERAL", projectName: "" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { scope: "GENERAL", projectName: "" };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", PANEL_SESSION_SECRET).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return { scope: "GENERAL", projectName: "" };
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || Number(data.exp) < Date.now()) return { scope: "GENERAL", projectName: "" };
    const scope = String(data.scope || "GENERAL").toUpperCase();
    const projectName = String(data.projectName || "").trim();
    if (scope === "PROJECT" && projectName) return { scope, projectName };
  } catch {}
  return { scope: "GENERAL", projectName: "" };
}

function requestedTarget(url, req) {
  const rawScope = String(url.searchParams.get("scope") || "").trim().toUpperCase();
  const rawProject = String(url.searchParams.get("projectName") || "").trim();
  if (rawScope === "PROJECT") {
    if (!rawProject || rawProject.length > 240) throw new Error("PROJECT bootstrap requires a valid projectName");
    return { scope: "PROJECT", projectName: rawProject, explicit: true };
  }
  if (rawScope === "GENERAL") return { scope: "GENERAL", projectName: "", explicit: true };
  return { ...readTarget(req), explicit: false };
}

function targetCookie(target) {
  return `${TARGET_COOKIE}=${encodeURIComponent(signTarget(target.scope, target.projectName))}; Path=/work; Max-Age=${Math.floor(TARGET_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizeProjectKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function decodeB64(value) {
  const raw = String(value || "").trim();
  return raw ? Buffer.from(raw, "base64").toString("utf8") : "";
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

async function callBridge(tool, args, suffix) {
  const requestId = `${crypto.randomUUID()}:${suffix}`;
  const response = await fetch(`http://127.0.0.1:${GATEWAY_INTERNAL_PORT}/api/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, tool, arguments: args }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, raw: text }; }
  const br = body?.bridgeResponse;
  if (!response.ok || !br?.ok || !br?.result?.ok) {
    const detail = br?.error || body?.error || br?.result?.error || br?.result?.message || `HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return br.result;
}

async function legacyBootstrap(target) {
  const scope = target.scope;
  const projectName = target.projectName;
  const projectKey = normalizeProjectKey(projectName);
  const projectWhere = scope === "PROJECT"
    ? `lower(p.display_name)=lower(${sqlLiteral(projectName)}) OR p.project_key=${sqlLiteral(projectKey)}`
    : "false";

  const summarySql = `
SELECT
  ${sqlLiteral(scope)}::text AS scope,
  EXISTS(SELECT 1 FROM public.autsys_project_registry p WHERE ${projectWhere}) AS project_found,
  (SELECT p.project_key::text FROM public.autsys_project_registry p WHERE ${projectWhere} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS project_key,
  (SELECT p.entity_kind::text FROM public.autsys_project_registry p WHERE ${projectWhere} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS project_kind,
  (SELECT p.lifecycle_status::text FROM public.autsys_project_registry p WHERE ${projectWhere} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS project_status,
  (SELECT p.is_authoritative::text FROM public.autsys_project_registry p WHERE ${projectWhere} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS project_authoritative,
  (SELECT count(*)::int FROM public.plugin_capabilities_server pc WHERE pc.is_enabled=true) AS plugin_capability_count,
  (SELECT count(*)::int FROM public.autsys_external_capabilities_registry ec WHERE ec.is_enabled=true) AS external_capability_count,
  encode(convert_to(COALESCE((SELECT string_agg(DISTINCT pc.plugin_key,E'\\n' ORDER BY pc.plugin_key) FROM public.plugin_capabilities_server pc WHERE pc.is_enabled=true),''),'UTF8'),'base64') AS plugin_keys_b64;`.trim();

  const summaryResult = await callBridge("pg.roberta.query", { sql: summarySql }, "auto-bootstrap-summary");
  const summary = Array.isArray(summaryResult.rows) && summaryResult.rows.length ? summaryResult.rows[0] : {};
  const projectFound = Boolean(summary.project_found);
  const pluginKeys = splitLines(decodeB64(summary.plugin_keys_b64));
  const pluginCapabilities = [];

  for (let i = 0; i < pluginKeys.length; i++) {
    const pluginKey = pluginKeys[i];
    const sql = `
SELECT encode(convert_to(COALESCE(string_agg(
  concat_ws('|',pc.capability_key,pc.capability_type,pc.capability_level,pc.risk_level,pc.requires_approval::text),
  E'\\n' ORDER BY pc.capability_key
),''),'UTF8'),'base64') AS capabilities_b64
FROM public.plugin_capabilities_server pc
WHERE pc.is_enabled=true AND pc.plugin_key=${sqlLiteral(pluginKey)};`.trim();
    const result = await callBridge("pg.roberta.query", { sql }, `auto-bootstrap-plugin-${i + 1}`);
    const row = Array.isArray(result.rows) && result.rows.length ? result.rows[0] : {};
    for (const line of splitLines(decodeB64(row.capabilities_b64))) {
      const [capabilityKey, capabilityType, capabilityLevel, riskLevel, requiresApproval] = line.split("|");
      pluginCapabilities.push({
        pluginKey,
        capabilityKey: capabilityKey || "",
        capabilityType: capabilityType || "",
        capabilityLevel: capabilityLevel || "",
        riskLevel: riskLevel || "",
        requiresApproval: String(requiresApproval || "").toLowerCase() === "true"
      });
    }
  }

  const externalSql = `
SELECT encode(convert_to(COALESCE(string_agg(
  concat_ws('|',ec.provider_key,ec.capability_key,ec.capability_type,ec.capability_level,ec.risk_level,ec.requires_approval::text,ec.verification_status),
  E'\\n' ORDER BY ec.provider_key,ec.capability_key
),''),'UTF8'),'base64') AS capabilities_b64
FROM public.autsys_external_capabilities_registry ec
WHERE ec.is_enabled=true;`.trim();
  const externalResult = await callBridge("pg.roberta.query", { sql: externalSql }, "auto-bootstrap-external");
  const externalRow = Array.isArray(externalResult.rows) && externalResult.rows.length ? externalResult.rows[0] : {};
  const externalCapabilities = splitLines(decodeB64(externalRow.capabilities_b64)).map(line => {
    const [providerKey, capabilityKey, capabilityType, capabilityLevel, riskLevel, requiresApproval, verificationStatus] = line.split("|");
    return {
      providerKey: providerKey || "",
      capabilityKey: capabilityKey || "",
      capabilityType: capabilityType || "",
      capabilityLevel: capabilityLevel || "",
      riskLevel: riskLevel || "",
      requiresApproval: String(requiresApproval || "").toLowerCase() === "true",
      verificationStatus: verificationStatus || ""
    };
  });

  return {
    ok: true,
    operation: "session.bootstrap",
    automatic: true,
    source: "ROBERTA",
    database: summaryResult.database,
    scope,
    project: {
      requestedName: scope === "PROJECT" ? projectName : null,
      found: projectFound,
      projectKey: summary.project_key || (scope === "PROJECT" ? projectKey : null),
      entityKind: summary.project_kind || null,
      lifecycleStatus: summary.project_status || null,
      authoritative: String(summary.project_authoritative || "").toLowerCase() === "true"
    },
    registration: scope === "PROJECT" && !projectFound ? {
      required: true,
      known: { projectName, projectKey },
      requiredFields: [{
        name: "entityKind",
        label: "tipo di progetto",
        reason: "autsys_project_registry.entity_kind is mandatory and cannot be derived safely from the session name"
      }],
      optionalFields: ["rootPath", "repositoryUrl", "repositoryBranch", "description"]
    } : { required: false },
    pluginCapabilityCount: Number(summary.plugin_capability_count || 0),
    externalCapabilityCount: Number(summary.external_capability_count || 0),
    pluginCapabilities,
    externalCapabilities,
    readsPerformed: 2 + pluginKeys.length,
    completedAt: new Date().toISOString()
  };
}

function bootstrapCard(result, error) {
  if (error) {
    return `<div class="card" style="border-color:#b91c1c"><h2>BOOTSTRAP AUTOMATICO — ERRORE</h2><p class="warn">${esc(error)}</p></div>`;
  }
  const p = result?.project || {};
  const headline = result.scope === "PROJECT"
    ? `PROJECT — ${p.requestedName || p.projectKey || "?"} — ${p.found ? "REGISTRATO" : "REGISTRAZIONE RICHIESTA"}`
    : "GENERAL";
  return `<div class="card" style="border-color:#16a34a"><h2>BOOTSTRAP AUTOMATICO — OK</h2><p><strong>${esc(headline)}</strong></p><p class="muted">ROBERTA: ${esc(result.database || "roberta")} · capacità plugin ${esc(result.pluginCapabilityCount)} · capacità esterne ${esc(result.externalCapabilityCount)} · ${esc(result.completedAt)}</p><details><summary>Dettaglio bootstrap</summary><pre>${esc(JSON.stringify(result, null, 2))}</pre></details></div>`;
}

function proxy(req, res, options = {}) {
  const headers = { ...req.headers, host: `127.0.0.1:${WORK_DB_FRONT_PORT}` };
  const upstream = http.request({ host: "127.0.0.1", port: WORK_DB_FRONT_PORT, method: req.method, path: req.url, headers }, r => {
    if (!options.injectHtml) {
      const responseHeaders = { ...r.headers };
      if (options.setCookie) {
        const existing = responseHeaders["set-cookie"] || [];
        responseHeaders["set-cookie"] = [...(Array.isArray(existing) ? existing : [existing].filter(Boolean)), options.setCookie];
      }
      res.writeHead(r.statusCode || 502, responseHeaders);
      r.pipe(res);
      return;
    }

    const chunks = [];
    r.on("data", chunk => chunks.push(chunk));
    r.on("end", () => {
      const type = String(r.headers["content-type"] || "");
      if (!type.includes("text/html")) {
        res.writeHead(r.statusCode || 502, r.headers);
        return res.end(Buffer.concat(chunks));
      }
      let body = Buffer.concat(chunks).toString("utf8");
      const marker = "<main>";
      const idx = body.indexOf(marker);
      if (idx >= 0) body = body.slice(0, idx + marker.length) + options.injectHtml + body.slice(idx + marker.length);
      else body = options.injectHtml + body;
      const responseHeaders = { ...r.headers };
      delete responseHeaders["content-length"];
      if (options.setCookie) {
        const existing = responseHeaders["set-cookie"] || [];
        responseHeaders["set-cookie"] = [...(Array.isArray(existing) ? existing : [existing].filter(Boolean)), options.setCookie];
      }
      res.writeHead(r.statusCode || 200, responseHeaders);
      res.end(body);
    });
  });
  upstream.on("error", err => {
    if (!res.headersSent) json(res, 502, { ok: false, error: `work panel unavailable: ${err.message}` });
    else res.destroy();
  });
  req.pipe(upstream);
}

async function bootstrap(target) {
  const requestId = crypto.randomUUID();
  const response = await fetch(`http://127.0.0.1:${LEGACY_FRONT_PORT}/internal/execute`, {
    method: "POST",
    headers: { authorization: `Bearer ${CONTROL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, tool: "session.bootstrap", arguments: { scope: target.scope, projectName: target.projectName } }),
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(text || `HTTP ${response.status}`); }
  if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); }
  catch { return json(res, 400, { ok: false, error: "bad request" }); }

  if (req.method === "GET" && url.pathname === "/work/bootstrap-healthz") {
    return json(res, 200, { ok: true, product: "AUTSYS WORK AUTO BOOTSTRAP FRONT" });
  }

  if (req.method === "GET" && url.pathname === "/work/bootstrap.json") {
    if (!validSession(req)) return json(res, 401, { ok: false, error: "session required" });
    try {
      const target = requestedTarget(url, req);
      const result = await bootstrap(target);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (req.method === "GET" && (url.pathname === "/work" || url.pathname === "/work/")) {
    let target;
    try { target = requestedTarget(url, req); }
    catch (err) { return json(res, 400, { ok: false, error: String(err?.message || err) }); }
    const cookie = targetCookie(target);
    if (!validSession(req)) return proxy(req, res, { setCookie: cookie });
    try {
      const result = await bootstrap(target);
      return proxy(req, res, { setCookie: cookie, injectHtml: bootstrapCard(result, null) });
    } catch (err) {
      return proxy(req, res, { setCookie: cookie, injectHtml: bootstrapCard(null, String(err?.message || err)) });
    }
  }

  return proxy(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(WORK_DB_FRONT_PORT, "127.0.0.1", () => {
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
  console.log(`AUTSYS WORK AUTO BOOTSTRAP FRONT listening on ${PORT}; workDb=${WORK_DB_FRONT_PORT}; backend=${GATEWAY_INTERNAL_PORT}`);
  console.log("AUTOMATIC SESSION BOOTSTRAP ready on /work");
});
