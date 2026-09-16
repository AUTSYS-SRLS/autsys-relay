import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT || 10000);
const INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const REPO_RAW_BASE = "https://raw.githubusercontent.com/AUTSYS-SRLS/autsys-relay";
const CONTROL_PATH = "control/command.json";
const MAX_CONTROL_BYTES = 262144;
const ALLOWED_TOOLS = new Set([
  "health",
  "fs.list",
  "fs.read_text",
  "fs.find",
  "fs.write_text",
  "fs.delete",
  "pg.roberta.query",
  "pg.roberta.write",
  "pg.roberta.migrate",
  "session.bootstrap",
  "project.register"
]);
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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNullable(value) {
  return value == null ? "NULL" : sqlLiteral(value);
}

function normalizeProjectKey(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function optionalText(args, name, maxLength) {
  if (args[name] == null) return null;
  const value = String(args[name]).trim();
  if (!value) return null;
  if (value.length > maxLength) throw new Error(`${name} too long`);
  return value;
}

function parseBootstrapArgs(args = {}) {
  const scope = String(args.scope || "").trim().toUpperCase();
  if (scope !== "GENERAL" && scope !== "PROJECT") {
    throw new Error("session.bootstrap requires scope GENERAL or PROJECT");
  }

  const projectName = String(args.projectName || "").trim();
  if (scope === "PROJECT" && !projectName) {
    throw new Error("session.bootstrap requires projectName for PROJECT scope");
  }
  if (projectName.length > 240) {
    throw new Error("projectName too long");
  }

  return { scope, projectName, projectKey: normalizeProjectKey(projectName) };
}

function parseProjectRegisterArgs(args = {}) {
  const projectName = String(args.projectName || "").trim();
  if (!projectName) throw new Error("project.register requires projectName");
  if (projectName.length > 240) throw new Error("projectName too long");

  const projectKey = normalizeProjectKey(args.projectKey || projectName);
  if (!projectKey) throw new Error("project.register could not derive projectKey");

  const entityKind = String(args.entityKind || "").trim().toUpperCase();
  if (!entityKind) throw new Error("project.register requires entityKind");
  if (!/^[A-Z][A-Z0-9_.-]{0,79}$/.test(entityKind)) {
    throw new Error("entityKind must be 1-80 characters: A-Z, 0-9, _, ., -");
  }

  let isAuthoritative = true;
  if (args.isAuthoritative != null) {
    if (typeof args.isAuthoritative === "boolean") {
      isAuthoritative = args.isAuthoritative;
    } else if (String(args.isAuthoritative).toLowerCase() === "true") {
      isAuthoritative = true;
    } else if (String(args.isAuthoritative).toLowerCase() === "false") {
      isAuthoritative = false;
    } else {
      throw new Error("isAuthoritative must be boolean");
    }
  }

  return {
    projectName,
    projectKey,
    entityKind,
    rootPath: optionalText(args, "rootPath", 1024),
    repositoryUrl: optionalText(args, "repositoryUrl", 2048),
    repositoryBranch: optionalText(args, "repositoryBranch", 255),
    description: optionalText(args, "description", 4000),
    isAuthoritative
  };
}

async function fetchControlText(ref) {
  const response = await fetch(`${REPO_RAW_BASE}/${ref}/${CONTROL_PATH}`, {
    headers: { "user-agent": "AUTSYS-PC-BRIDGE-HOT-CONTROL/0.1.0.9" },
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

async function callBridge(command, tool, args = {}, suffix = "") {
  const internalTimeoutMs = tool === "pg.roberta.migrate" ? 300000 : tool === "pg.roberta.write" ? 60000 : 15000;
  const internalRequestId = suffix ? `${command.requestId}:${suffix}` : command.requestId;
  const response = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/api/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId: internalRequestId,
      bridgeId: command.bridgeId || undefined,
      tool,
      arguments: args
    }),
    signal: AbortSignal.timeout(internalTimeoutMs)
  });

  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { body = { ok: false, error: text || `HTTP ${response.status}` }; }
  return { status: response.status, body, effectiveTool: tool };
}

function requireBridgeResult(call, label, operation) {
  const br = call?.body?.bridgeResponse;
  const result = br?.result;
  if (call?.status < 200 || call?.status >= 300 || !br?.ok || !result?.ok) {
    const detail = br?.error || call?.body?.error || result?.message || result?.error || `HTTP ${call?.status}`;
    throw new Error(`${operation} ${label} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return result;
}

function requireQueryResult(call, label) {
  return requireBridgeResult(call, label, "session.bootstrap");
}

function firstRow(result) {
  return Array.isArray(result?.rows) && result.rows.length ? result.rows[0] : {};
}

function decodeB64(value) {
  const raw = String(value || "").trim();
  return raw ? Buffer.from(raw, "base64").toString("utf8") : "";
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function projectRow(row = {}) {
  return {
    projectKey: row.project_key || null,
    displayName: row.display_name || null,
    entityKind: row.entity_kind || null,
    lifecycleStatus: row.lifecycle_status || null,
    rootPath: row.root_path || null,
    repositoryUrl: row.repository_url || null,
    repositoryBranch: row.repository_branch || null,
    description: row.description || null,
    authoritative: Boolean(row.is_authoritative),
    publicId: row.public_id || null
  };
}

async function executeProjectRegister(command) {
  const args = parseProjectRegisterArgs(command.arguments || {});
  const lookupSql = `
SELECT public_id::text,project_key,display_name,entity_kind,lifecycle_status,root_path,repository_url,repository_branch,description,is_authoritative
FROM public.autsys_project_registry
WHERE project_key=${sqlLiteral(args.projectKey)} OR lower(display_name)=lower(${sqlLiteral(args.projectName)})
ORDER BY CASE WHEN project_key=${sqlLiteral(args.projectKey)} THEN 0 ELSE 1 END,id
LIMIT 1;`.trim();

  const beforeCall = await callBridge(command, "pg.roberta.query", { sql: lookupSql }, "project-register-precheck");
  const beforeResult = requireBridgeResult(beforeCall, "precheck", "project.register");
  if (Array.isArray(beforeResult.rows) && beforeResult.rows.length) {
    return {
      status: 200,
      effectiveTool: "project.register",
      body: {
        ok: true,
        operation: "project.register",
        database: beforeResult.database,
        created: false,
        alreadyExisted: true,
        project: projectRow(beforeResult.rows[0])
      }
    };
  }

  const migrationId = `AUTSYS_PROJECT_REGISTER_${args.projectKey}_${String(command.requestId).replaceAll("-", "")}`;
  const registrationSql = `
INSERT INTO public.autsys_project_registry
(project_key,display_name,entity_kind,lifecycle_status,root_path,repository_url,repository_branch,description,is_authoritative,metadata_json)
VALUES (
  ${sqlLiteral(args.projectKey)},
  ${sqlLiteral(args.projectName)},
  ${sqlLiteral(args.entityKind)},
  'active',
  ${sqlNullable(args.rootPath)},
  ${sqlNullable(args.repositoryUrl)},
  ${sqlNullable(args.repositoryBranch)},
  ${sqlNullable(args.description)},
  ${args.isAuthoritative ? "true" : "false"},
  jsonb_build_object(
    'registered_by','chatgpt_session_bootstrap',
    'registration_request_id',${sqlLiteral(command.requestId)}
  )
)
ON CONFLICT (project_key) DO NOTHING;`.trim();

  const migrationCall = await callBridge(command, "pg.roberta.migrate", {
    migrationId,
    sql: registrationSql,
    description: `Direct project registration from ChatGPT session bootstrap: ${args.projectKey}`
  }, "project-register-write");
  const migrationResult = requireBridgeResult(migrationCall, "write", "project.register");

  const verifyCall = await callBridge(command, "pg.roberta.query", { sql: lookupSql }, "project-register-verify");
  const verifyResult = requireBridgeResult(verifyCall, "verify", "project.register");
  if (!Array.isArray(verifyResult.rows) || !verifyResult.rows.length) {
    throw new Error("project.register verify failed: project not found after write");
  }

  const verified = verifyResult.rows[0];
  if (verified.project_key !== args.projectKey || verified.display_name !== args.projectName || verified.entity_kind !== args.entityKind) {
    return {
      status: 409,
      effectiveTool: "project.register",
      body: {
        ok: false,
        operation: "project.register",
        error: "project key/name conflict after concurrent registration",
        requested: {
          projectKey: args.projectKey,
          displayName: args.projectName,
          entityKind: args.entityKind
        },
        existing: projectRow(verified)
      }
    };
  }

  return {
    status: 200,
    effectiveTool: "project.register",
    body: {
      ok: true,
      operation: "project.register",
      database: verifyResult.database,
      created: true,
      alreadyExisted: false,
      project: projectRow(verified),
      migration: {
        migrationId,
        applied: migrationResult.applied ?? true,
        backupPath: migrationResult.backupPath || migrationResult.backup || null
      }
    }
  };
}

async function executeSessionBootstrap(command) {
  const { scope, projectName, projectKey } = parseBootstrapArgs(command.arguments || {});
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

  const summaryCall = await callBridge(command, "pg.roberta.query", { sql: summarySql }, "bootstrap-summary");
  const summaryResult = requireQueryResult(summaryCall, "summary");
  const summary = firstRow(summaryResult);
  const projectFound = Boolean(summary.project_found);
  const registrationRequired = scope === "PROJECT" && !projectFound;
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

    const call = await callBridge(command, "pg.roberta.query", { sql }, `bootstrap-plugin-${i + 1}`);
    const result = requireQueryResult(call, `plugin ${pluginKey}`);
    const compact = decodeB64(firstRow(result).capabilities_b64);

    for (const line of splitLines(compact)) {
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

  const externalCall = await callBridge(command, "pg.roberta.query", { sql: externalSql }, "bootstrap-external");
  const externalResult = requireQueryResult(externalCall, "external capabilities");
  const externalCompact = decodeB64(firstRow(externalResult).capabilities_b64);
  const externalCapabilities = splitLines(externalCompact).map(line => {
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
    status: 200,
    effectiveTool: "session.bootstrap",
    body: {
      ok: true,
      operation: "session.bootstrap",
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
      registration: registrationRequired ? {
        required: true,
        known: {
          projectName,
          projectKey
        },
        requiredFields: [
          {
            name: "entityKind",
            label: "tipo di progetto",
            reason: "autsys_project_registry.entity_kind is mandatory and cannot be derived safely from the session name"
          }
        ],
        optionalFields: [
          "rootPath",
          "repositoryUrl",
          "repositoryBranch",
          "description"
        ]
      } : {
        required: false
      },
      pluginCapabilityCount: Number(summary.plugin_capability_count || 0),
      externalCapabilityCount: Number(summary.external_capability_count || 0),
      pluginCapabilities,
      externalCapabilities,
      readsPerformed: 2 + pluginKeys.length
    }
  };
}

async function executeInternal(command) {
  if (command.tool === "session.bootstrap") {
    return await executeSessionBootstrap(command);
  }
  if (command.tool === "project.register") {
    return await executeProjectRegister(command);
  }
  return await callBridge(command, command.tool, command.arguments || {});
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
    console.log(`HOT_CHAT_CONTROL ${requestId} ${tool} -> ${result.effectiveTool} http=${result.status} totalMs=${totalMs}`);
    return json(res, result.status, {
      ok: result.status >= 200 && result.status < 300,
      requestId,
      tool,
      effectiveTool: result.effectiveTool,
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
  console.log("SESSION BOOTSTRAP orchestrator ready as session.bootstrap");
  console.log("DIRECT PROJECT REGISTRATION ready as project.register");
});
