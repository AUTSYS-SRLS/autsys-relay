import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const VERSION = "0.1.0.25";
const PORT = Number(process.env.PORT || 10006);
const BACKEND_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const RENDER_API_KEY = process.env.RENDER_API_KEY || "";
if (!CONTROL_TOKEN) process.exit(1);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "40mb" }));

function timeoutFor(tool) {
  if (["pg.roberta.migrate","bridge.update.apply","fs.delete","fs.copy","fs.replace","fs.move_path","fs.hash_tree","fs.compare","fs.tree","fs.search_text","fs.zip","fs.unzip"].includes(tool)) return 300000;
  if (tool === "sqlite.query") return 120000;
  if (tool === "pg.roberta.write") return 60000;
  return 30000;
}

async function callBridge(tool, args = {}, bridgeId = "") {
  const response = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      bridgeId: bridgeId || undefined,
      tool,
      arguments: args
    }),
    signal: AbortSignal.timeout(timeoutFor(tool))
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, raw: text }; }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function result(body) {
  const br = body?.bridgeResponse;
  const out = {
    ok: Boolean(br?.ok),
    bridgeId: body?.bridgeId,
    gatewayRoundTripMs: body?.gatewayRoundTripMs,
    executionMs: br?.executionMs,
    result: br?.ok ? br?.result : undefined,
    error: br?.ok ? undefined : br?.error
  };
  return { content: [{ type: "text", text: JSON.stringify(out) }], isError: !out.ok };
}

function jsonResult(out, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(out) }], isError };
}

function unwrap(body, label) {
  const br = body?.bridgeResponse;
  if (!br?.ok || !br?.result?.ok) {
    const detail = br?.error || br?.result?.error || br?.result?.message;
    throw new Error(typeof detail === "string" ? detail : `${label} failed`);
  }
  return br.result;
}

function sqlLiteral(v) {
  return `'${String(v).replaceAll("'", "''")}'`;
}

function projectKey(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

async function queryRows(sql, bridgeId, label) {
  return unwrap(await callBridge("pg.roberta.query", { sql }, bridgeId), label);
}

async function optionalQueryRows(sql, bridgeId, label) {
  try {
    return { data: await queryRows(sql, bridgeId, label), warning: null };
  } catch (e) {
    return { data: { rows: [] }, warning: label + ": " + String(e?.message || e) };
  }
}

async function callRender(path, options = {}) {
  if (!RENDER_API_KEY) throw new Error("RENDER_API_KEY not configured");
  const method = options.method || "GET";
  const headers = {
    authorization: "Bearer " + RENDER_API_KEY,
    accept: "application/json"
  };
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch("https://api.render.com/v1" + path, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs || 30000)
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!response.ok) {
    const detail = parsed?.message || parsed?.error || parsed?.raw || ("HTTP " + response.status);
    throw new Error("Render API " + response.status + ": " + detail);
  }
  return parsed;
}

function renderResult(data) {
  return jsonResult({ ok: true, provider: "Render", result: data });
}

function bridgePayload(body, label) {
  const br = body?.bridgeResponse;
  if (!br?.ok) {
    const detail = br?.error || br?.result?.error || br?.result?.message || (label + " failed");
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return br.result;
}

function compactProcessSnapshot(snapshot, includeLogs = false, tailChars = 4000) {
  const out = {
    processId: snapshot?.processId ?? null,
    pid: snapshot?.pid ?? null,
    kind: snapshot?.kind ?? null,
    target: snapshot?.target ?? null,
    workingDirectory: snapshot?.workingDirectory ?? null,
    startedUtc: snapshot?.startedUtc ?? null,
    running: Boolean(snapshot?.running),
    exitCode: snapshot?.exitCode ?? null
  };
  if (includeLogs) {
    const limit = Math.max(0, Math.min(Number(tailChars) || 4000, 16000));
    out.stdoutTail = String(snapshot?.stdout || "").slice(-limit);
    out.stderrTail = String(snapshot?.stderr || "").slice(-limit);
  }
  return out;
}

function compactProcessResult(body, includeLogs = false, tailChars = 4000) {
  const br = body?.bridgeResponse;
  if (!br?.ok) return result(body);
  return jsonResult({
    ok: true,
    bridgeId: body?.bridgeId,
    gatewayRoundTripMs: body?.gatewayRoundTripMs,
    executionMs: br?.executionMs,
    result: compactProcessSnapshot(br?.result, includeLogs, tailChars)
  });
}

const asyncJobs = new Map();

function pruneJobs() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of asyncJobs.entries()) {
    const stamp = Date.parse(job.completedAt || job.startedAt || 0);
    if (Number.isFinite(stamp) && stamp < cutoff) asyncJobs.delete(id);
  }
}

function startAsyncJob(kind, meta, action) {
  pruneJobs();
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    kind,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    meta,
    result: null,
    error: null
  };
  asyncJobs.set(jobId, job);
  Promise.resolve()
    .then(action)
    .then(value => {
      job.status = "completed";
      job.result = value;
      job.completedAt = new Date().toISOString();
    })
    .catch(err => {
      job.status = "failed";
      job.error = String(err?.message || err);
      job.completedAt = new Date().toISOString();
    });
  return job;
}

const BRIDGE_HOME = "D:\\AUTSYS\\AUTSYS S.R.L.S\\CLIENTI\\AUTSYS S.R.L.S\\05 - AUTSYS PC BRIDGE\\AUTSYS PC BRIDGE";
const PROJECT_DB_HELPER = BRIDGE_HOME + "\\SANDBOX\\EXECUTABLES\\project_db_tool.py";
const PROJECT_DB_WORKDIR = BRIDGE_HOME + "\\SANDBOX\\EXECUTABLES";

function winJoin(base, name) {
  return String(base || "").replace(/[\\\\/]+$/, "") + "\\" + name;
}

async function runProjectDbHelper(request, bridgeId = "") {
  const requestPath = winJoin(PROJECT_DB_WORKDIR, "PROJECT_DB_REQUEST_" + crypto.randomUUID().replaceAll("-", "") + ".json");
  let processId = "";
  try {
    bridgePayload(await callBridge("fs.write_text", {
      path: requestPath,
      content: JSON.stringify(request),
      overwrite: false,
      createDirectories: false
    }, bridgeId), "project db request write");

    const started = bridgePayload(await callBridge("process.start", {
      kind: "python",
      target: PROJECT_DB_HELPER,
      args: [requestPath],
      workingDirectory: PROJECT_DB_WORKDIR
    }, bridgeId), "project db helper start");
    processId = String(started?.processId || "");
    if (!processId) throw new Error("project db helper did not return processId");

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const snap = bridgePayload(await callBridge("process.status", { processId }, bridgeId), "project db helper status");
      if (!snap?.running) {
        const lines = String(snap?.stdout || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const last = lines.at(-1) || "";
        if (!last) throw new Error(String(snap?.stderr || "project db helper returned no JSON"));
        let parsed;
        try { parsed = JSON.parse(last); } catch { throw new Error("project db helper returned invalid JSON: " + last.slice(0, 1000)); }
        if (!parsed?.ok) throw new Error(parsed?.message || parsed?.code || "project db helper failed");
        return parsed;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error("project db helper timeout");
  } finally {
    try { await callBridge("fs.delete", { path: requestPath }, bridgeId); } catch {}
  }
}

async function ensureDirectory(path, bridgeId = "") {
  const clean = String(path || "").trim().replace(/[\\\\/]+$/, "");
  if (!clean) throw new Error("path required");
  const probe = winJoin(clean, ".autsys_mkdir_probe_" + crypto.randomUUID().replaceAll("-", "") + ".tmp");
  let probeCreated = false;
  try {
    bridgePayload(await callBridge("fs.write_text", {
      path: probe,
      content: "",
      overwrite: false,
      createDirectories: true
    }, bridgeId), "mkdir probe write");
    probeCreated = true;
    bridgePayload(await callBridge("fs.delete", { path: probe }, bridgeId), "mkdir probe delete");
    probeCreated = false;
    const listed = bridgePayload(await callBridge("fs.list", { path: clean }, bridgeId), "mkdir verify");
    return { path: clean, exists: true, verified: true, entryCount: Number(listed?.count || 0) };
  } finally {
    if (probeCreated) {
      try { await callBridge("fs.delete", { path: probe }, bridgeId); } catch {}
    }
  }
}

async function bootstrap(scope, projectName = "", bridgeId = "") {
  scope = String(scope || "").toUpperCase();
  if (!new Set(["GENERAL", "PROJECT"]).has(scope)) {
    throw new Error("scope must be GENERAL or PROJECT");
  }

  projectName = String(projectName || "").trim();
  if (scope === "PROJECT" && !projectName) {
    throw new Error("projectName required for PROJECT scope");
  }

  const key = projectKey(projectName);
  const where = scope === "PROJECT"
    ? `lower(p.display_name)=lower(${sqlLiteral(projectName)}) OR p.project_key=${sqlLiteral(key)}`
    : "false";

  const coreSql = `SELECT ${sqlLiteral(scope)}::text AS scope,
    EXISTS(SELECT 1 FROM public.autsys_project_registry p WHERE ${where}) AS project_found,
    (SELECT p.project_key FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS project_key,
    (SELECT p.display_name FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS display_name,
    (SELECT p.entity_kind FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS entity_kind,
    (SELECT p.lifecycle_status FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS lifecycle_status,
    (SELECT p.root_path FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS root_path,
    (SELECT p.repository_url FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS repository_url,
    (SELECT p.repository_branch FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS repository_branch,
    (SELECT p.is_authoritative FROM public.autsys_project_registry p WHERE ${where} ORDER BY p.is_authoritative DESC,p.id LIMIT 1) AS is_authoritative,
    (SELECT count(*)::int FROM public.autsys_project_registry) AS project_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'projectKey',p.project_key,
      'displayName',p.display_name,
      'entityKind',p.entity_kind,
      'lifecycleStatus',p.lifecycle_status,
      'rootPath',p.root_path,
      'repositoryUrl',p.repository_url,
      'repositoryBranch',p.repository_branch,
      'description',p.description,
      'authoritative',p.is_authoritative,
      'publicId',p.public_id
    ) ORDER BY p.is_authoritative DESC,p.display_name,p.id)
    FROM public.autsys_project_registry p),'[]'::jsonb) AS projects,
    (SELECT count(*)::int FROM public.plugin_capabilities_server pc WHERE pc.is_enabled=true) AS plugin_capability_count,
    (SELECT count(*)::int FROM public.autsys_external_capabilities_registry ec WHERE ec.is_enabled=true) AS external_capability_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'pluginKey',pc.plugin_key,
      'capabilityKey',pc.capability_key,
      'capabilityType',pc.capability_type,
      'capabilityLevel',pc.capability_level,
      'riskLevel',pc.risk_level,
      'requiresApproval',pc.requires_approval
    ) ORDER BY pc.plugin_key,pc.capability_key)
    FROM public.plugin_capabilities_server pc WHERE pc.is_enabled=true),'[]'::jsonb) AS plugin_capabilities,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'providerKey',ec.provider_key,
      'capabilityKey',ec.capability_key,
      'capabilityType',ec.capability_type,
      'capabilityLevel',ec.capability_level,
      'riskLevel',ec.risk_level,
      'requiresApproval',ec.requires_approval,
      'verificationStatus',ec.verification_status
    ) ORDER BY ec.provider_key,ec.capability_key)
    FROM public.autsys_external_capabilities_registry ec WHERE ec.is_enabled=true),'[]'::jsonb) AS external_capabilities;`;

  const agentIdentitySql = `SELECT
    id,public_id,agent_key,display_name,agent_role,description,lifecycle_status,
    bootstrap_enabled,instructions_version,metadata_json,created_at,updated_at
    FROM public.autsys_agent_registry
    WHERE bootstrap_enabled=true AND lifecycle_status='active'
    ORDER BY id
    LIMIT 1;`;

  const agentFoundationSql = `SELECT
    f.id,f.public_id,f.agent_public_id,f.foundation_key,f.foundation_version,
    f.foundation_text_human,f.foundation_payload_json,f.source_of_truth,
    f.is_active,f.created_at,f.updated_at
    FROM public.autsys_agent_foundation f
    JOIN public.autsys_agent_registry a ON a.public_id=f.agent_public_id
    WHERE a.bootstrap_enabled=true AND a.lifecycle_status='active' AND f.is_active=true
    ORDER BY f.id;`;

  const agentRulesSql = `SELECT r.public_id,r.rule_key,r.rule_version,r.rule_text_human,r.priority_level,r.metadata_json FROM public.autsys_agent_rules r JOIN public.autsys_agent_registry a ON a.public_id=r.agent_public_id WHERE a.bootstrap_enabled=true AND a.lifecycle_status='active' AND r.is_active=true AND r.lifecycle_status='active' AND r.user_confirmed=true AND (COALESCE((r.metadata_json->>'bootstrap_pinned')::boolean,false)=true OR COALESCE((r.metadata_json->>'bootstrap_required')::boolean,false)=true) ORDER BY r.priority_level DESC,r.rule_key,r.rule_version DESC,r.id;`;

  const agentSql = `SELECT count(*)::int AS agent_capability_count,
    COALESCE(jsonb_agg(jsonb_build_object('capability_key',a.capability_key,'capability_type',a.capability_type,'access_mode',a.access_mode,'risk_level',a.risk_level,'verification_status',a.verification_status) ORDER BY a.capability_key),'[]'::jsonb) AS agent_capabilities
    FROM public.autsys_agent_capabilities a WHERE a.is_enabled=true;`;

  const contextSql = scope === "PROJECT" ? `SELECT count(*)::int AS project_bootstrap_context_count, COALESCE(jsonb_agg(to_jsonb(c)),'[]'::jsonb) AS project_bootstrap_context FROM public.autsys_project_bootstrap_context c WHERE lower(c.display_name)=lower(${sqlLiteral(projectName)}) OR c.project_key=${sqlLiteral(key)};` : `SELECT 0::int AS project_bootstrap_context_count,'[]'::jsonb AS project_bootstrap_context;`;

  const globalContextSql = `SELECT
    context_key,context_type,context_value,context_json,priority_level,source_type,source_reference
    FROM public.autsys_agent_global_context
    WHERE is_active=true AND bootstrap_required=true
    ORDER BY priority_level DESC,context_key,id;`;

  const activeLearningSql = `SELECT
    lesson_key,category,applicability_scope,trigger_context,correct_reasoning,prevention_check,
    severity,occurrence_count,last_seen_at,metadata_json
    FROM public.autsys_agent_learning_lessons
    WHERE is_active=true
    ORDER BY
      CASE lower(COALESCE(severity,'')) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'normal' THEN 4 WHEN 'low' THEN 5 ELSE 6 END,
      last_seen_at DESC NULLS LAST,id DESC;`;

  const databaseCatalogSql = `SELECT database_key,display_name FROM public.autsys_database_catalog WHERE false;`;

  const databaseSourcesSql = `SELECT
    p.project_key,p.display_name AS project_name,
    d.data_source_key,d.source_type,d.locator,d.database_name,d.schema_name,
    d.access_mode,d.connection_via,d.is_authoritative,d.lifecycle_status,d.metadata_json
    FROM public.autsys_project_data_sources d
    JOIN public.autsys_project_registry p ON p.public_id=d.project_public_id
    WHERE ${scope === "PROJECT" ? `(lower(p.display_name)=lower(${sqlLiteral(projectName)}) OR p.project_key=${sqlLiteral(key)}) AND` : "false AND"} (upper(COALESCE(d.source_type,'')) IN ('DATABASE','POSTGRESQL','SQLITE','FILE_DATABASE')
       OR d.database_name IS NOT NULL)
    ORDER BY p.display_name,d.data_source_key,d.id;`;

  const openItemSql = `SELECT
    oi.id,oi.project_public_id,p.project_key,p.display_name AS project_name,
    oi.item_key,oi.title,oi.description,oi.status,oi.priority,oi.updated_at
    FROM public.autsys_project_open_items oi
    LEFT JOIN public.autsys_project_registry p ON p.public_id=oi.project_public_id
    WHERE lower(COALESCE(oi.status,'')) NOT IN ('completed','closed','done','cancelled','canceled')
      ${scope === "PROJECT" ? `AND (lower(p.display_name)=lower(${sqlLiteral(projectName)}) OR p.project_key=${sqlLiteral(key)})` : "AND false"}
    ORDER BY
      CASE lower(COALESCE(oi.priority,'')) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
      oi.updated_at DESC NULLS LAST,oi.id;`;

  const core = await queryRows(coreSql, bridgeId, "bootstrap core");
  const [identityOptional, foundationOptional, rulesOptional, agentOptional, contextOptional, globalContextOptional, activeLearningOptional, databaseCatalogOptional, databaseSourcesOptional, openItemsOptional] = await Promise.all([
    optionalQueryRows(agentIdentitySql, bridgeId, "bootstrap agent identity"),
    optionalQueryRows(agentFoundationSql, bridgeId, "bootstrap agent foundation"),
    optionalQueryRows(agentRulesSql, bridgeId, "bootstrap agent rules"),
    optionalQueryRows(agentSql, bridgeId, "bootstrap agent capabilities"),
    optionalQueryRows(contextSql, bridgeId, "bootstrap project context"),
    optionalQueryRows(globalContextSql, bridgeId, "bootstrap global context"),
    optionalQueryRows(activeLearningSql, bridgeId, "bootstrap active learning"),
    optionalQueryRows(databaseCatalogSql, bridgeId, "bootstrap database catalog"),
    optionalQueryRows(databaseSourcesSql, bridgeId, "bootstrap project database sources"),
    optionalQueryRows(openItemSql, bridgeId, "bootstrap open items")
  ]);
  const identity = identityOptional.data;
  const foundation = foundationOptional.data;
  const rules = rulesOptional.data;
  const agent = agentOptional.data;
  const context = contextOptional.data;
  const globalContextResult = globalContextOptional.data;
  const activeLearningResult = activeLearningOptional.data;
  const databaseCatalogResult = databaseCatalogOptional.data;
  const databaseSourcesResult = databaseSourcesOptional.data;
  const openItemsResult = openItemsOptional.data;
  const warnings = [
    identityOptional.warning,
    foundationOptional.warning,
    rulesOptional.warning,
    agentOptional.warning,
    contextOptional.warning,
    globalContextOptional.warning,
    activeLearningOptional.warning,
    databaseCatalogOptional.warning,
    databaseSourcesOptional.warning,
    openItemsOptional.warning
  ].filter(Boolean);

  const row = Array.isArray(core.rows) && core.rows.length ? core.rows[0] : {};
  const identityRow = Array.isArray(identity.rows) && identity.rows.length ? identity.rows[0] : null;
  const foundationRows = Array.isArray(foundation.rows) ? foundation.rows : [];
  const ruleRows = Array.isArray(rules.rows) ? rules.rows : [];
  const agentRow = Array.isArray(agent.rows) && agent.rows.length ? agent.rows[0] : {};
  const contextRow = Array.isArray(context.rows) && context.rows.length ? context.rows[0] : {};
  const globalContextRows = Array.isArray(globalContextResult.rows) ? globalContextResult.rows : [];
  const activeLearningRows = Array.isArray(activeLearningResult.rows) ? activeLearningResult.rows : [];
  const databaseCatalogRows = Array.isArray(databaseCatalogResult.rows) ? databaseCatalogResult.rows : [];
  const databaseSourceRows = Array.isArray(databaseSourcesResult.rows) ? databaseSourcesResult.rows : [];
  const openItemRows = Array.isArray(openItemsResult.rows) ? openItemsResult.rows : [];
  const documentRuleRows = ruleRows.filter(r => {
    const domain = String(r?.metadata_json?.domain || "").toLowerCase();
    const key = String(r?.rule_key || "").toUpperCase();
    return domain.startsWith("document") || key.includes("DOCUMENT") || key.includes("_AI_DOCUMENT_");
  });
  const storageRule = ruleRows.find(r => r?.rule_key === "DOCUMENT_AI_ISSUED_STORAGE_POLICY");
  const storageRoots = storageRule?.metadata_json?.storage_roots || {};
  const documentStorageRoots = [
    { entity: "TERMOMECCANICA EOLO", path: storageRoots.eolo || null, purpose: "Archivio fisico dei documenti AI emessi da EOLO" },
    { entity: "AUTSYS DI AUTELLI ING. GUIDO / ING. GUIDO AUTELLI", path: storageRoots.autsys_piva || null, purpose: "Archivio fisico dei documenti AI emessi da AUTSYS individuale/P.IVA o come Ing. Guido Autelli" },
    { entity: "AUTSYS S.R.L.S.", path: storageRoots.autsys_srls || null, purpose: "Archivio fisico dei documenti AI emessi da AUTSYS S.R.L.S." }
  ].filter(x => x.path);
  const found = Boolean(row.project_found);
  // Project handoffs live exclusively in the owner's local AUTSYS_PROJECT.sqlite.
  // Bootstrap must surface pending handoffs without consuming or changing them.
  let pendingHandoffs = [];
  if (scope === "PROJECT" && found && row.root_path) {
    try {
      const path = String(row.root_path).replace(/[\\/]+$/, "") + "\\AUTSYS_PROJECT.sqlite";
      const sql = "SELECT id,public_id,session_key,created_at,session_date,session_title,status,summary,completed_work,verified_state,pending_work,operational_notes,external_links,next_session_bootstrap,source_reference,COUNT(*) OVER() AS pending_total FROM session_handoffs WHERE status='pending' ORDER BY created_at DESC,id DESC LIMIT 3";
      const handoffData = bridgePayload(await callBridge("project.db.query", { path, sql, maxRows: 3 }, bridgeId), "bootstrap project handoffs");
      pendingHandoffs = Array.isArray(handoffData?.rows) ? handoffData.rows : [];
    } catch (e) {
      warnings.push("bootstrap project handoffs: " + String(e?.message || e));
    }
  }

  return {
    ok: true,
    operation: "session.bootstrap",
    source: "ROBERTA",
    bootstrapVersion: "6",
    bootstrapRevision: "6.1",
    completedUtc: new Date().toISOString(),
    scope,
    project: {
      requestedName: scope === "PROJECT" ? projectName : null,
      found,
      projectKey: row.project_key || (scope === "PROJECT" ? key : null),
      displayName: row.display_name || null,
      entityKind: row.entity_kind || null,
      lifecycleStatus: row.lifecycle_status || null,
      rootPath: row.root_path || null,
      repositoryUrl: row.repository_url || null,
      repositoryBranch: row.repository_branch || null,
      authoritative: Boolean(row.is_authoritative)
    },
    projectCount: Number(row.project_count || 0),
    projects: Array.isArray(row.projects) ? row.projects.map(p => ({ projectKey:p.projectKey, displayName:p.displayName, entityKind:p.entityKind, lifecycleStatus:p.lifecycleStatus, authoritative:p.authoritative, publicId:p.publicId })) : [],
    globalContextCount: globalContextRows.length,
    globalContext: globalContextRows,
    activeLearningCount: activeLearningRows.length,
    activeLearning: activeLearningRows,
    registration: scope === "PROJECT" && !found
      ? {
          required: true,
          known: { projectName, projectKey: key },
          requiredFields: [{ name: "entityKind", label: "tipo di progetto" }],
          optionalFields: ["rootPath", "repositoryUrl", "repositoryBranch", "description"]
        }
      : { required: false },
    pluginCapabilityCount: Number(row.plugin_capability_count || 0),
    externalCapabilityCount: Number(row.external_capability_count || 0),
    pluginCapabilities: [],
    externalCapabilities: [],
    agent: identityRow,
    agentFoundationCount: foundationRows.length,
    agentFoundation: foundationRows,
    agentRuleCount: ruleRows.length,
    agentRules: ruleRows,
    agentCapabilityCount: Number(agentRow.agent_capability_count || 0),
    agentCapabilities: Array.isArray(agentRow.agent_capabilities) ? agentRow.agent_capabilities : [],
    projectBootstrapContextCount: Number(contextRow.project_bootstrap_context_count || 0),
    projectBootstrapContext: Array.isArray(contextRow.project_bootstrap_context) ? contextRow.project_bootstrap_context : [],
    databaseCatalogCount: 0,
    databaseCatalog: [],
    projectDatabaseSourceCount: databaseSourceRows.length,
    projectDatabaseSources: databaseSourceRows,
    openItemCount: openItemRows.length,
    openItems: openItemRows,
    pendingHandoffCount: pendingHandoffs.length ? Number(pendingHandoffs[0].pending_total || pendingHandoffs.length) : 0,
    pendingHandoffs,
    documentRuleCount: 0,
    documentRules: [],
    documentStorageRootCount: 0,
    documentStorageRoots: [],
    warnings,
    database: core.database || agent.database || context.database || "roberta"
  };
}

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const wi = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const wr = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const de = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function buildMcp() {
  const mcp = new McpServer(
    { name: "AUTSYS PC BRIDGE", version: VERSION },
    {
      instructions: "Use the compact AUTSYS tool surface. At conversation start, if the chat belongs to a specific project, call autsys_bootstrap with scope PROJECT and the exact current project name; do not call GENERAL first. If the chat is general, call autsys_bootstrap with scope GENERAL. Bootstrap is ONCE PER CONVERSATION unless the user explicitly asks to reload/re-bootstrap or the project changes. Local read access is broader than mutation access: filesystem_read and sqlite_read may read any local volume allowed by the Bridge read policy; filesystem_write, filesystem_manage, filesystem_delete and process_control may mutate or execute only inside AUTHORIZED_ROOTS. ROBERTA has no special filesystem privilege. Use sqlite_read for local SQLite collectors/history, project_db_read/project_db_change/project_db_delete for AUTSYS_PROJECT.sqlite, and project_handoff for handoffs. Never reconstruct configuration from event/tick tables when an authoritative registry/configuration source exists. The legacy pc_execute and old individual tools are compatibility fallbacks and should not be used when a compact typed family is available."
    }
  );


  // Direct, read-only SQLite entry, deliberately early in the MCP catalog.
  mcp.registerTool("pc_sqlite_query", {
    title: "Leggi SQLite AUTSYS (sola lettura)",
    description: "Legge un database SQLite autorizzato (.sqlite/.sqlite3/.db) mediante una singola SELECT o PRAGMA. Nessuna scrittura, nessun processo o copia. Usa la capability nativa sqlite.query.",
    inputSchema: z.object({
      path: z.string().min(1),
      sql: z.string().min(1),
      maxRows: z.number().int().min(1).max(1000).default(1000),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ path, sql, maxRows, bridgeId }) =>
    result(await callBridge("sqlite.query", { path, sql, maxRows }, bridgeId || "")));

  // Compact typed surface. Keep these FIRST: ChatGPT may materialize only the first ~24 tools.
  // The native/legacy tools remain registered below for backward compatibility.

  mcp.registerTool("autsys_bootstrap", {
    title: "Bootstrap AUTSYS",
    description: "Bootstrap iniziale AUTSYS. In una chat di progetto usare direttamente PROJECT; una sola volta per conversazione salvo richiesta esplicita o cambio progetto.",
    inputSchema: z.object({ scope: z.enum(["GENERAL","PROJECT"]), projectName: z.string().optional(), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ scope, projectName, bridgeId }) => {
    try { return jsonResult(await bootstrap(scope, projectName || "", bridgeId || "")); }
    catch (err) { return jsonResult({ ok:false, error:String(err?.message || err) }, true); }
  });

  mcp.registerTool("desktop_windows_list", {
    title: "Elenca finestre desktop Windows",
    description: "Elenca le finestre visibili della sessione Windows interattiva tramite l'agente desktop generico AUTSYS.",
    inputSchema: z.object({ bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ bridgeId }) => result(await callBridge("desktop.windows.list", {}, bridgeId || "")));

  mcp.registerTool("desktop_windows_inspect", {
    title: "Ispeziona finestra Windows",
    description: "Legge titolo e coordinate della finestra interattiva.",
    inputSchema: z.object({ handle: z.number().int(), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ handle, bridgeId }) => result(await callBridge("desktop.windows.inspect", { handle }, bridgeId || "")));

  mcp.registerTool("desktop_windows_focus", {
    title: "Attiva una finestra desktop",
    description: "Attiva una finestra desktop.",
    inputSchema: z.object({ handle: z.number().int(), bridgeId: z.string().optional() }),
    annotations: wi
  }, async ({ handle, bridgeId }) => result(await callBridge("desktop.windows.focus", {handle}, bridgeId || "")));

  mcp.registerTool("desktop_screen_capture", {
    title: "Acquisisce il desktop interattivo",
    description: "Acquisisce il desktop interattivo.",
    inputSchema: z.object({ bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ bridgeId }) => result(await callBridge("desktop.screen.capture", {}, bridgeId || "")));

  mcp.registerTool("desktop_input_click", {
    title: "Clicca alle coordinate del desktop",
    description: "Clicca alle coordinate del desktop.",
    inputSchema: z.object({ x: z.number().int(), y: z.number().int(), bridgeId: z.string().optional() }),
    annotations: wi
  }, async ({ x, y, bridgeId }) => result(await callBridge("desktop.input.click", {x,y}, bridgeId || "")));

  mcp.registerTool("desktop_input_key", {
    title: "Invia un tasto virtuale al desktop",
    description: "Invia un tasto virtuale al desktop.",
    inputSchema: z.object({ vk: z.number().int().min(1).max(254), bridgeId: z.string().optional() }),
    annotations: wi
  }, async ({ vk, bridgeId }) => result(await callBridge("desktop.input.key", {vk}, bridgeId || "")));

  mcp.registerTool("desktop_controls_inspect", {
    title: "Ispeziona controlli Windows",
    description: "Elenca i controlli della finestra tramite UI Automation.",
    inputSchema: z.object({ handle: z.number().int(), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ handle, bridgeId }) => result(await callBridge("desktop.controls.inspect", {handle}, bridgeId || "")));

  mcp.registerTool("desktop_input_text", {
    title: "Inserisci testo Windows",
    description: "Inserisce testo ordinario nel controllo attivo; non usare per credenziali.",
    inputSchema: z.object({ text: z.string().max(2000), bridgeId: z.string().optional() }),
    annotations: wi
  }, async ({ text, bridgeId }) => result(await callBridge("desktop.input.text", {text}, bridgeId || "")));

  mcp.registerTool("bridge_health", {
    title: "Stato AUTSYS PC BRIDGE",
    description: "Legge stato, versione e identita del Bridge.",
    inputSchema: z.object({ bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ bridgeId }) => result(await callBridge("health", {}, bridgeId || "")));

  mcp.registerTool("filesystem_read", {
    title: "Leggi filesystem",
    description: "Famiglia esclusivamente read-only. Legge, naviga, cerca, confronta e calcola hash su qualunque percorso che Windows renda leggibile al Bridge.",
    inputSchema: z.object({
      operation: z.enum(["list","read_text","find","hash","exists","stat","drives","read_binary","hash_tree","compare","tree","read_lines","search_text"]),
      arguments: z.record(z.any()).default({}),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ operation, arguments: args, bridgeId }) =>
    result(await callBridge("fs." + operation, args || {}, bridgeId || "")));

  mcp.registerTool("filesystem_write", {
    title: "Scrivi filesystem autorizzato",
    description: "Crea o modifica file/cartelle SOLO dentro AUTHORIZED_ROOTS. Include mkdir, testo/binario, append, patch, metadata, touch e truncate. Backup e verifiche restano attivi.",
    inputSchema: z.object({
      operation: z.enum(["mkdir","write_text","create_text","write_binary","append_text","patch_text","set_metadata","touch","truncate"]),
      arguments: z.record(z.any()).default({}),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ operation, arguments: args, bridgeId }) =>
    result(await callBridge("fs." + operation, args || {}, bridgeId || "")));

  mcp.registerTool("filesystem_manage", {
    title: "Gestisci filesystem autorizzato",
    description: "Copia, sostituisce, sposta, rinomina, comprime o estrae. Le destinazioni e ogni sorgente che viene rimossa devono essere dentro AUTHORIZED_ROOTS.",
    inputSchema: z.object({
      operation: z.enum(["copy","replace","move_path","rename_path","move","rename","zip","unzip"]),
      arguments: z.record(z.any()).default({}),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ operation, arguments: args, bridgeId }) =>
    result(await callBridge("fs." + operation, args || {}, bridgeId || "")));

  mcp.registerTool("filesystem_delete", {
    title: "Elimina filesystem autorizzato",
    description: "Cancella file/cartelle SOLO dentro AUTHORIZED_ROOTS con backup protetto. async=true avvia un job per cancellazioni lunghe.",
    inputSchema: z.object({
      path: z.string().min(1),
      recursive: z.boolean().default(false),
      async: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: de
  }, async ({ path, recursive, async: asyncMode, bridgeId }) => {
    if (!asyncMode) return result(await callBridge("fs.delete", { path, recursive }, bridgeId || ""));
    const job = startAsyncJob("fs.delete", { path, recursive }, async () =>
      bridgePayload(await callBridge("fs.delete", { path, recursive }, bridgeId || ""), "fs.delete"));
    return jsonResult({ ok:true, jobId:job.jobId, status:job.status, startedAt:job.startedAt, path, recursive });
  });

  mcp.registerTool("process_read", {
    title: "Leggi processi e job AUTSYS",
    description: "Legge processi tracciati/reali o lo stato di un job gateway. Non avvia e non termina nulla.",
    inputSchema: z.object({
      operation: z.enum(["list","discover","status","job_status"]),
      arguments: z.record(z.any()).default({}),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ operation, arguments: args, bridgeId }) => {
    if (operation === "job_status") {
      pruneJobs();
      const jobId = String(args?.jobId || "");
      const job = asyncJobs.get(jobId);
      return job ? jsonResult({ ok:true, job }) : jsonResult({ ok:false, error:"JOB_NOT_FOUND" }, true);
    }
    return result(await callBridge("process." + operation, args || {}, bridgeId || ""));
  });

  mcp.registerTool("process_control", {
    title: "Controlla processi autorizzati",
    description: "Avvia script Python/CMD/PowerShell o ferma processi. Le azioni mutative sono confinate alle AUTHORIZED_ROOTS.",
    inputSchema: z.object({
      operation: z.enum(["start","stop","stop_pid"]),
      arguments: z.record(z.any()).default({}),
      bridgeId: z.string().optional()
    }),
    annotations: wi
  }, async ({ operation, arguments: args, bridgeId }) =>
    result(await callBridge("process." + operation, args || {}, bridgeId || "")));

  mcp.registerTool("sqlite_read", {
    title: "Leggi SQLite",
    description: "Query SQLite strettamente read-only (SELECT/PRAGMA) su file .sqlite/.sqlite3/.db leggibili. Percorso preferito per collettori, storici e DB progetto.",
    inputSchema: z.object({
      path:z.string().min(1), sql:z.string().min(1),
      maxRows:z.number().int().min(1).max(1000).default(1000),
      bridgeId:z.string().optional()
    }),
    annotations: ro
  }, async ({ path, sql, maxRows, bridgeId }) =>
    result(await callBridge("sqlite.query", { path, sql, maxRows }, bridgeId || "")));

  mcp.registerTool("sqlite_change", {
    title: "Modifica o crea SQLite autorizzato",
    description: "Esegue DDL/DML non classificato come distruttivo su SQLite dentro AUTHORIZED_ROOTS; puo creare nuovi DB. Per DELETE/DROP usare sqlite_delete.",
    inputSchema: z.object({
      path:z.string().min(1), sql:z.string().min(1),
      createIfMissing:z.boolean().default(false), createDirectories:z.boolean().default(false),
      bridgeId:z.string().optional()
    }),
    annotations: wr
  }, async ({ path, sql, createIfMissing, createDirectories, bridgeId }) => {
    if (/\b(DELETE|DROP)\b/i.test(sql))
      return jsonResult({ok:false,error:"Usare sqlite_delete per SQL contenente DELETE o DROP."},true);
    return result(await callBridge("sqlite.execute", { path, sql, createIfMissing, createDirectories }, bridgeId || ""));
  });

  mcp.registerTool("sqlite_delete", {
    title: "Elimina dati o schema SQLite autorizzato",
    description: "Esegue SQL distruttivo DELETE/DROP su SQLite dentro AUTHORIZED_ROOTS con backup nativo.",
    inputSchema: z.object({
      path:z.string().min(1), sql:z.string().min(1),
      createIfMissing:z.boolean().default(false), createDirectories:z.boolean().default(false),
      bridgeId:z.string().optional()
    }),
    annotations: de
  }, async ({ path, sql, createIfMissing, createDirectories, bridgeId }) => {
    if (!/\b(DELETE|DROP)\b/i.test(sql))
      return jsonResult({ok:false,error:"sqlite_delete richiede SQL contenente DELETE o DROP."},true);
    return result(await callBridge("sqlite.execute", { path, sql, createIfMissing, createDirectories }, bridgeId || ""));
  });

  mcp.registerTool("project_handoff", {
    title: "Gestisci handoff progetto AUTSYS",
    description: "Crea handoff nel DB locale del progetto oppure li marca consumed senza cancellarli. Create e consume sono nativi nel Bridge; ROBERTA non e il deposito degli handoff.",
    inputSchema: z.object({
      operation:z.enum(["create","consume"]),
      projectName:z.string().optional(), path:z.string().optional(), ids:z.array(z.number().int().positive()).optional(),
      sessionKey:z.string().optional(), sessionTitle:z.string().optional(), summary:z.string().optional(),
      completedWork:z.string().default(""), verifiedState:z.string().default(""), pendingWork:z.string().default(""),
      operationalNotes:z.string().default(""), externalLinks:z.string().default(""), nextSessionBootstrap:z.string().default(""),
      sourceReference:z.string().default(""), createdAt:z.string().optional(), sessionDate:z.string().optional(), publicId:z.string().optional(),
      bridgeId:z.string().optional()
    }),
    annotations: wi
  }, async (x) => {
    try {
      if (x.operation === "consume") {
        if (!x.path || !x.ids?.length) throw new Error("consume richiede path e ids.");
        return result(await callBridge("project.handoff.consume", { path:x.path, ids:x.ids }, x.bridgeId || ""));
      }
      if (!x.projectName || !x.sessionKey || !x.sessionTitle || !x.summary)
        throw new Error("create richiede projectName, sessionKey, sessionTitle e summary.");
      const key=projectKey(x.projectName);
      const resolved=await queryRows(
        `SELECT p.project_key,p.public_id,p.root_path FROM public.autsys_project_registry p
         WHERE lower(p.display_name)=lower(${sqlLiteral(x.projectName)}) OR p.project_key=${sqlLiteral(key)}
         ORDER BY p.is_authoritative DESC,p.id LIMIT 1`,
        x.bridgeId || "", "project handoff project resolve");
      const row=Array.isArray(resolved?.rows)&&resolved.rows.length?resolved.rows[0]:null;
      if(!row?.root_path||!row?.public_id) throw new Error("Progetto AUTSYS non trovato o privo di root_path/public_id.");
      const args={
        path:winJoin(String(row.root_path),"AUTSYS_PROJECT.sqlite"), projectPublicId:String(row.public_id),
        sessionKey:x.sessionKey, sessionTitle:x.sessionTitle, summary:x.summary,
        completedWork:x.completedWork, verifiedState:x.verifiedState, pendingWork:x.pendingWork,
        operationalNotes:x.operationalNotes, externalLinks:x.externalLinks,
        nextSessionBootstrap:x.nextSessionBootstrap, sourceReference:x.sourceReference
      };
      if(x.createdAt) args.createdAt=x.createdAt;
      if(x.sessionDate) args.sessionDate=x.sessionDate;
      if(x.publicId) args.publicId=x.publicId;
      return result(await callBridge("project.handoff.create", args, x.bridgeId || ""));
    } catch(err){ return jsonResult({ok:false,error:String(err?.message||err)},true); }
  });

  mcp.registerTool("roberta_read", {
    title: "Leggi ROBERTA",
    description: "Query SQL read-only sul database ROBERTA.",
    inputSchema: z.object({ sql:z.string().min(1), bridgeId:z.string().optional() }),
    annotations: ro
  }, async ({ sql, bridgeId }) => result(await callBridge("pg.roberta.query", { sql }, bridgeId || "")));

  mcp.registerTool("roberta_change", {
    title: "Modifica ROBERTA",
    description: "Scrittura strutturata non-delete su ROBERTA oppure consume handoff centrale legacy.",
    inputSchema: z.object({
      operation:z.enum(["write","handoff_consume"]).default("write"),
      request:z.record(z.any()), bridgeId:z.string().optional()
    }),
    annotations: wr
  }, async ({ operation, request, bridgeId }) => {
    if(operation==="handoff_consume")
      return result(await callBridge("session.handoff.consume", request, bridgeId || ""));
    if(String(request?.operation||"").toLowerCase()==="delete")
      return jsonResult({ok:false,error:"Usare roberta_delete per DELETE."},true);
    return result(await callBridge("pg.roberta.write", request, bridgeId || ""));
  });

  mcp.registerTool("roberta_delete", {
    title: "Elimina righe ROBERTA",
    description: "DELETE strutturato governato su ROBERTA.",
    inputSchema: z.object({ request:z.record(z.any()), bridgeId:z.string().optional() }),
    annotations: de
  }, async ({ request, bridgeId }) => {
    if(String(request?.operation||"").toLowerCase()!=="delete")
      return jsonResult({ok:false,error:"roberta_delete accetta solo operation=delete."},true);
    return result(await callBridge("pg.roberta.write", request, bridgeId || ""));
  });

  mcp.registerTool("roberta_schema", {
    title: "Migra schema ROBERTA",
    description: "Migrazione additiva governata dello schema ROBERTA.",
    inputSchema: z.object({
      migrationId:z.string().min(1), description:z.string().min(1),
      sql:z.string().min(1), bridgeId:z.string().optional()
    }),
    annotations: de
  }, async ({ migrationId, description, sql, bridgeId }) =>
    result(await callBridge("pg.roberta.migrate", { migrationId, description, sql }, bridgeId || "")));

  mcp.registerTool("project_registry", {
    title: "Registra progetto AUTSYS",
    description: "Registra o aggiorna idempotentemente un progetto nel registry ROBERTA.",
    inputSchema: z.object({
      projectName:z.string().min(1), projectKey:z.string().optional(), entityKind:z.string().min(1),
      rootPath:z.string().optional(), repositoryUrl:z.string().optional(), repositoryBranch:z.string().optional(),
      description:z.string().optional(),
      currentStateSummary:z.string().max(16384).optional(), currentObjective:z.string().max(16384).optional(),
      nextAction:z.string().max(16384).optional(), lastReviewedAt:z.string().optional(),
      isAuthoritative:z.boolean().default(true), bridgeId:z.string().optional()
    }),
    annotations: wr
  }, async ({ bridgeId, projectName, ...rest }) =>
    result(await callBridge("project.register", { displayName:projectName, ...rest }, bridgeId || "")));

  mcp.registerTool("eolo_sql", {
    title: "SQL EOLO_AI",
    description: "Esegue la capability SQL governata EOLO_AI del Bridge.",
    inputSchema: z.object({ arguments:z.record(z.any()).default({}), bridgeId:z.string().optional() }),
    annotations: wr
  }, async ({ arguments:args, bridgeId }) =>
    result(await callBridge("sql.eolo_ai.execute", args || {}, bridgeId || "")));

  mcp.registerTool("service_read", {
    title: "Leggi servizi AUTSYS",
    description: "Letture tipizzate dei servizi esterni governati dal Bridge: Stripe e Acube.",
    inputSchema: z.object({
      operation:z.enum(["stripe.status","stripe.catalog.snapshot","stripe.checkout.retrieve","acube.status","acube.business_registry.get","acube.recipient_code.find"]),
      arguments:z.record(z.any()).default({}), bridgeId:z.string().optional()
    }),
    annotations: ro
  }, async ({ operation, arguments:args, bridgeId }) =>
    result(await callBridge(operation, args || {}, bridgeId || "")));

  mcp.registerTool("service_write", {
    title: "Modifica servizi AUTSYS",
    description: "Azioni governate sui servizi esterni AUTSYS, attualmente Stripe.",
    inputSchema: z.object({
      operation:z.enum(["stripe.checkout.create_subscription","stripe.account.set_terms_url","stripe.payment_link.create","stripe.price.create_recurring","stripe.price.deactivate","stripe.product.set_default_price"]),
      arguments:z.record(z.any()).default({}), bridgeId:z.string().optional()
    }),
    annotations: wr
  }, async ({ operation, arguments:args, bridgeId }) =>
    result(await callBridge(operation, args || {}, bridgeId || "")));

  mcp.registerTool("bridge_update", {
    title: "Aggiorna AUTSYS PC BRIDGE",
    description: "Stage o apply governato dell'Updater Bridge con backup, health e rollback.",
    inputSchema: z.object({
      operation:z.enum(["stage","apply"]), request:z.record(z.any()), bridgeId:z.string().optional()
    }),
    annotations: de
  }, async ({ operation, request, bridgeId }) =>
    result(await callBridge("bridge.update." + operation, request, bridgeId || "")));

  mcp.registerTool("render_read", {
    title: "Leggi Render AUTSYS",
    description: "Legge servizi, deploy e log Render senza avviare deploy.",
    inputSchema: z.object({
      operation:z.enum(["list_services","get_service","list_deploys","get_deploy","logs"]),
      arguments:z.record(z.any()).default({})
    }),
    annotations: ro
  }, async ({ operation, arguments:a }) => {
    try {
      if(operation==="list_services"){
        const q=new URLSearchParams(); q.set("limit",String(a.limit||20)); if(a.name) q.append("name",String(a.name));
        return renderResult(await callRender("/services?"+q.toString()));
      }
      if(operation==="get_service")
        return renderResult(await callRender("/services/"+encodeURIComponent(String(a.serviceId||""))));
      if(operation==="list_deploys"){
        const q=new URLSearchParams({limit:String(a.limit||20)});
        return renderResult(await callRender("/services/"+encodeURIComponent(String(a.serviceId||""))+"/deploys?"+q.toString()));
      }
      if(operation==="get_deploy")
        return renderResult(await callRender("/services/"+encodeURIComponent(String(a.serviceId||""))+"/deploys/"+encodeURIComponent(String(a.deployId||""))));
      const q=new URLSearchParams(); q.set("ownerId",String(a.ownerId||"")); q.set("direction",String(a.direction||"backward")); q.set("limit",String(a.limit||50));
      if(a.startTime) q.set("startTime",String(a.startTime)); if(a.endTime) q.set("endTime",String(a.endTime));
      for(const id of (a.resourceIds||[])) q.append("resource",String(id));
      for(const t of (a.text||[])) q.append("text",String(t));
      for(const t of (a.type||[])) q.append("type",String(t));
      return renderResult(await callRender("/logs?"+q.toString(),{timeoutMs:60000}));
    } catch(err){ return jsonResult({ok:false,provider:"Render",error:String(err?.message||err)},true); }
  });

  mcp.registerTool("render_deploy", {
    title: "Avvia deploy Render AUTSYS",
    description: "Avvia un deploy Render governato.",
    inputSchema: z.object({
      serviceId:z.string().min(1), clearCache:z.boolean().default(false), commitId:z.string().optional()
    }),
    annotations: de
  }, async ({ serviceId, clearCache, commitId }) => {
    try {
      const body={clearCache:clearCache?"clear":"do_not_clear"}; if(commitId) body.commitId=commitId;
      return renderResult(await callRender("/services/"+encodeURIComponent(serviceId)+"/deploys",{method:"POST",body,timeoutMs:60000}));
    } catch(err){ return jsonResult({ok:false,provider:"Render",error:String(err?.message||err)},true); }
  });

  mcp.registerTool("pc_file_stage", {
    title: "Trasferisci file ChatGPT al PC",
    description: "Trasferisce un file allegato/autorizzato da ChatGPT nello staging Bridge con verifica SHA-256.",
    inputSchema: z.object({
      file:z.object({download_url:z.string().url(),file_id:z.string().min(1),mime_type:z.string().optional(),file_name:z.string().optional()}),
      updateId:z.string().min(8).max(100).optional(), relativePath:z.string().min(1).optional(), bridgeId:z.string().optional()
    }),
    annotations: wr,
    _meta: { "openai/fileParams": ["file"] }
  }, async ({ file, updateId, relativePath, bridgeId }) => {
    try {
      const response=await fetch(file.download_url,{signal:AbortSignal.timeout(120000)});
      if(!response.ok) throw new Error("Download file ChatGPT fallito: HTTP "+response.status);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length>32*1024*1024) throw new Error("File oltre il limite di 32 MiB del Bridge.");
      const sha256=crypto.createHash("sha256").update(bytes).digest("hex");
      const id=updateId||("chat_"+Date.now()+"_"+crypto.randomBytes(4).toString("hex"));
      const rel=relativePath||file.file_name||(file.file_id+".bin");
      return result(await callBridge("bridge.update.stage",{updateId:id,relativePath:rel,sha256,contentBase64:bytes.toString("base64")},bridgeId||""));
    } catch(err){ return jsonResult({ok:false,error:String(err?.message||err)},true); }
  });

  mcp.registerTool("pc_execute", {
    title: "Esegui capability AUTSYS PC BRIDGE",
    description: "Dispatcher di fallback verso capability native del Bridge. Preferire sempre i tool tipizzati quando disponibili; usare questo solo se manca una capability MCP specifica. Le capability restano soggette alle policy e protezioni native del Bridge.",
    inputSchema: z.object({
      operation: z.string().min(1),
      arguments: z.record(z.any()).default({}),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ operation, arguments: args, bridgeId }) =>
    result(await callBridge(operation, args || {}, bridgeId || "")));

  mcp.registerTool("pc_health", {
    title: "Stato PC Bridge",
    description: "Controlla lo stato reale del Bridge e del PC.",
    inputSchema: z.object({ bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ bridgeId }) => result(await callBridge("health", {}, bridgeId || "")));

  mcp.registerTool("pc_fs_list", {
    title: "Elenca cartella AUTSYS",
    description: "Elenca file/cartelle autorizzati.",
    inputSchema: z.object({ path: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ path, bridgeId }) => result(await callBridge("fs.list", { path }, bridgeId || "")));

  mcp.registerTool("pc_fs_read_text", {
    title: "Leggi file AUTSYS",
    description: "Legge un file di testo autorizzato.",
    inputSchema: z.object({ path: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ path, bridgeId }) => result(await callBridge("fs.read_text", { path }, bridgeId || "")));

  mcp.registerTool("pc_fs_find", {
    title: "Cerca file AUTSYS",
    description: "Cerca file/cartelle autorizzati.",
    inputSchema: z.object({ path: z.string().min(1), pattern: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ path, pattern, bridgeId }) => result(await callBridge("fs.find", { path, pattern }, bridgeId || "")));

  mcp.registerTool("pc_fs_hash", {
    title: "Hash file AUTSYS",
    description: "Calcola SHA-256 e dimensione di un file autorizzato senza modificarlo.",
    inputSchema: z.object({ path: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ path, bridgeId }) => result(await callBridge("fs.hash", { path }, bridgeId || "")));

  mcp.registerTool("pc_fs_move", {
    title: "Sposta file AUTSYS",
    description: "Sposta un file tra percorsi autorizzati con verifica SHA-256 post-operazione.",
    inputSchema: z.object({
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
      overwrite: z.boolean().default(false),
      createDirectories: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ sourcePath, destinationPath, overwrite, createDirectories, bridgeId }) =>
    result(await callBridge("fs.move", { sourcePath, destinationPath, overwrite, createDirectories }, bridgeId || "")));

  mcp.registerTool("pc_fs_rename", {
    title: "Rinomina file AUTSYS",
    description: "Rinomina un file autorizzato nella stessa cartella con verifica SHA-256.",
    inputSchema: z.object({
      path: z.string().min(1),
      newName: z.string().min(1),
      overwrite: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, newName, overwrite, bridgeId }) =>
    result(await callBridge("fs.rename", { path, newName, overwrite }, bridgeId || "")));

  mcp.registerTool("pc_fs_mkdir", {
    title: "Crea cartella AUTSYS",
    description: "Crea nativamente una cartella entro le radici autorizzate e verifica che esista. Operazione idempotente.",
    inputSchema: z.object({
      path: z.string().min(1),
      parents: z.boolean().default(true),
      existOk: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wi
  }, async ({ path, parents, existOk, bridgeId }) =>
    result(await callBridge("fs.mkdir", { path, parents, existOk }, bridgeId || "")));

  mcp.registerTool("pc_fs_write_text", {
    title: "Scrivi file AUTSYS",
    description: "Scrive testo mantenendo le protezioni del Bridge.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string(), bridgeId: z.string().optional() }),
    annotations: wr
  }, async ({ path, content, bridgeId }) => result(await callBridge("fs.write_text", { path, content }, bridgeId || "")));

  mcp.registerTool("pc_fs_delete", {
    title: "Elimina file AUTSYS",
    description: "Elimina un file consentito secondo le protezioni del Bridge.",
    inputSchema: z.object({
      path: z.string().min(1),
      recursive: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: de
  }, async ({ path, recursive, bridgeId }) => result(await callBridge("fs.delete", { path, recursive }, bridgeId || "")));

  mcp.registerTool("pc_fs_delete_async", {
    title: "Elimina file o cartella AUTSYS in background",
    description: "Avvia una cancellazione governata, anche ricorsiva, come job asincrono per evitare timeout del client. Restano attivi backup e policy del Bridge.",
    inputSchema: z.object({
      path: z.string().min(1),
      recursive: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: de
  }, async ({ path, recursive, bridgeId }) => {
    const job = startAsyncJob("fs.delete", { path, recursive }, async () =>
      bridgePayload(await callBridge("fs.delete", { path, recursive }, bridgeId || ""), "fs.delete"));
    return jsonResult({ ok: true, jobId: job.jobId, status: job.status, startedAt: job.startedAt, path, recursive });
  });

  mcp.registerTool("pc_job_status", {
    title: "Stato job AUTSYS",
    description: "Legge stato ed esito di un job asincrono avviato dal gateway AUTSYS.",
    inputSchema: z.object({ jobId: z.string().uuid() }),
    annotations: ro
  }, async ({ jobId }) => {
    pruneJobs();
    const job = asyncJobs.get(jobId);
    return job ? jsonResult({ ok: true, job }) : jsonResult({ ok: false, error: "JOB_NOT_FOUND" }, true);
  });



  mcp.registerTool("pc_fs_exists", {
    title: "Verifica percorso AUTSYS",
    description: "Verifica se un percorso locale esiste e se e file o cartella.",
    inputSchema: z.object({ path: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ path, bridgeId }) => result(await callBridge("fs.exists", { path }, bridgeId || "")));

  mcp.registerTool("pc_fs_stat", {
    title: "Metadata percorso AUTSYS",
    description: "Legge dimensione, attributi e timestamp di file/cartelle locali.",
    inputSchema: z.object({ path: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ path, bridgeId }) => result(await callBridge("fs.stat", { path }, bridgeId || "")));

  mcp.registerTool("pc_fs_drives", {
    title: "Volumi locali AUTSYS",
    description: "Elenca volumi locali e spazio disponibile.",
    inputSchema: z.object({ bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ bridgeId }) => result(await callBridge("fs.drives", {}, bridgeId || "")));

  mcp.registerTool("pc_fs_read_binary", {
    title: "Leggi binario AUTSYS",
    description: "Legge un chunk binario Base64 con offset.",
    inputSchema: z.object({
      path: z.string().min(1),
      offset: z.number().int().nonnegative().default(0),
      length: z.number().int().min(0).max(8388608).default(1048576),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ path, offset, length, bridgeId }) =>
    result(await callBridge("fs.read_binary", { path, offset, length }, bridgeId || "")));

  mcp.registerTool("pc_fs_write_binary", {
    title: "Scrivi binario AUTSYS",
    description: "Crea, sovrascrive, accoda o patcha dati binari Base64 con backup e hash.",
    inputSchema: z.object({
      path: z.string().min(1),
      dataBase64: z.string(),
      mode: z.enum(["create","overwrite","append","patch"]).default("overwrite"),
      offset: z.number().int().nonnegative().optional(),
      createDirectories: z.boolean().default(false),
      expectedSha256: z.string().optional(),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, dataBase64, mode, offset, createDirectories, expectedSha256, bridgeId }) =>
    result(await callBridge("fs.write_binary", { path, dataBase64, mode, offset, createDirectories, expectedSha256 }, bridgeId || "")));

  mcp.registerTool("pc_fs_append_text", {
    title: "Accoda testo AUTSYS",
    description: "Accoda testo UTF-8 con backup governato.",
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
      createDirectories: z.boolean().default(false),
      expectedSha256: z.string().optional(),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, content, createDirectories, expectedSha256, bridgeId }) =>
    result(await callBridge("fs.append_text", { path, content, createDirectories, expectedSha256 }, bridgeId || "")));

  mcp.registerTool("pc_fs_patch_text", {
    title: "Patch testo AUTSYS",
    description: "Applica sostituzioni testuali esatte a un file autorizzato con SHA opzionale, backup atomico e verifica.",
    inputSchema: z.object({
      path: z.string().min(1),
      expectedSha256: z.string().optional(),
      replacements: z.array(z.object({
        oldText: z.string().min(1),
        newText: z.string(),
        expectedCount: z.number().int().min(1).max(10000).default(1)
      })).min(1).max(100),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, expectedSha256, replacements, bridgeId }) =>
    result(await callBridge("fs.patch_text", { path, expectedSha256, replacements }, bridgeId || "")));

  mcp.registerTool("pc_fs_copy", {
    title: "Copia file o cartella AUTSYS",
    description: "Copia nativamente file o alberi di cartelle con backup e verifica hash.",
    inputSchema: z.object({
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
      overwrite: z.boolean().default(false),
      createDirectories: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ sourcePath, destinationPath, overwrite, createDirectories, bridgeId }) =>
    result(await callBridge("fs.copy", { sourcePath, destinationPath, overwrite, createDirectories }, bridgeId || "")));

  mcp.registerTool("pc_fs_replace", {
    title: "Sostituisci file o cartella AUTSYS",
    description: "Sostituisce una destinazione con una sorgente mantenendo backup e verifica.",
    inputSchema: z.object({
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
      createDirectories: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ sourcePath, destinationPath, createDirectories, bridgeId }) =>
    result(await callBridge("fs.replace", { sourcePath, destinationPath, createDirectories }, bridgeId || "")));

  mcp.registerTool("pc_fs_move_path", {
    title: "Sposta file o cartella AUTSYS",
    description: "Sposta file o directory, anche cross-volume, con verifica prima della rimozione sorgente.",
    inputSchema: z.object({
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
      overwrite: z.boolean().default(false),
      createDirectories: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ sourcePath, destinationPath, overwrite, createDirectories, bridgeId }) =>
    result(await callBridge("fs.move_path", { sourcePath, destinationPath, overwrite, createDirectories }, bridgeId || "")));

  mcp.registerTool("pc_fs_rename_path", {
    title: "Rinomina file o cartella AUTSYS",
    description: "Rinomina un file o una directory nella stessa cartella.",
    inputSchema: z.object({
      path: z.string().min(1),
      newName: z.string().min(1),
      overwrite: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, newName, overwrite, bridgeId }) =>
    result(await callBridge("fs.rename_path", { path, newName, overwrite }, bridgeId || "")));

  mcp.registerTool("pc_fs_hash_tree", {
    title: "Hash albero AUTSYS",
    description: "Calcola hash deterministico di una directory e statistiche dell'albero.",
    inputSchema: z.object({ path: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ path, bridgeId }) => result(await callBridge("fs.hash_tree", { path }, bridgeId || "")));

  mcp.registerTool("pc_fs_compare", {
    title: "Confronta percorsi AUTSYS",
    description: "Confronta file o directory per contenuto/hash.",
    inputSchema: z.object({ pathA: z.string().min(1), pathB: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ pathA, pathB, bridgeId }) => result(await callBridge("fs.compare", { pathA, pathB }, bridgeId || "")));

  mcp.registerTool("pc_fs_set_metadata", {
    title: "Modifica metadata AUTSYS",
    description: "Imposta attributi Windows e timestamp di un file o cartella autorizzato.",
    inputSchema: z.object({
      path: z.string().min(1),
      readOnly: z.boolean().optional(),
      hidden: z.boolean().optional(),
      archive: z.boolean().optional(),
      creationUtc: z.string().optional(),
      lastWriteUtc: z.string().optional(),
      lastAccessUtc: z.string().optional(),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, readOnly, hidden, archive, creationUtc, lastWriteUtc, lastAccessUtc, bridgeId }) =>
    result(await callBridge("fs.set_metadata", { path, readOnly, hidden, archive, creationUtc, lastWriteUtc, lastAccessUtc }, bridgeId || "")));

  mcp.registerTool("pc_fs_touch", {
    title: "Touch file AUTSYS",
    description: "Crea un file vuoto se assente o aggiorna il timestamp last-write.",
    inputSchema: z.object({
      path: z.string().min(1),
      lastWriteUtc: z.string().optional(),
      createDirectories: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, lastWriteUtc, createDirectories, bridgeId }) =>
    result(await callBridge("fs.touch", { path, lastWriteUtc, createDirectories }, bridgeId || "")));

  mcp.registerTool("pc_fs_truncate", {
    title: "Ridimensiona file AUTSYS",
    description: "Ridimensiona un file con backup obbligatorio.",
    inputSchema: z.object({ path: z.string().min(1), length: z.number().int().nonnegative(), bridgeId: z.string().optional() }),
    annotations: wr
  }, async ({ path, length, bridgeId }) => result(await callBridge("fs.truncate", { path, length }, bridgeId || "")));

  mcp.registerTool("pc_fs_tree", {
    title: "Albero cartelle AUTSYS",
    description: "Elenca ricorsivamente un albero locale con limiti governati.",
    inputSchema: z.object({
      path: z.string().min(1),
      maxDepth: z.number().int().min(0).max(64).default(8),
      maxEntries: z.number().int().min(1).max(50000).default(5000),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ path, maxDepth, maxEntries, bridgeId }) =>
    result(await callBridge("fs.tree", { path, maxDepth, maxEntries }, bridgeId || "")));

  mcp.registerTool("pc_fs_read_lines", {
    title: "Leggi righe AUTSYS",
    description: "Legge una finestra di righe senza caricare tutto il file.",
    inputSchema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().positive().default(1),
      maxLines: z.number().int().min(1).max(5000).default(200),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ path, startLine, maxLines, bridgeId }) =>
    result(await callBridge("fs.read_lines", { path, startLine, maxLines }, bridgeId || "")));

  mcp.registerTool("pc_fs_search_text", {
    title: "Cerca testo AUTSYS",
    description: "Cerca testo o regex nei file locali con limiti governati.",
    inputSchema: z.object({
      path: z.string().min(1),
      query: z.string().min(1),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      maxResults: z.number().int().min(1).max(5000).default(500),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ path, query, regex, caseSensitive, maxResults, bridgeId }) =>
    result(await callBridge("fs.search_text", { path, query, regex, caseSensitive, maxResults }, bridgeId || "")));

  mcp.registerTool("pc_fs_zip", {
    title: "Crea ZIP AUTSYS",
    description: "Crea un archivio ZIP verificato da file/cartelle locali.",
    inputSchema: z.object({
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
      overwrite: z.boolean().default(false),
      createDirectories: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ sourcePath, destinationPath, overwrite, createDirectories, bridgeId }) =>
    result(await callBridge("fs.zip", { sourcePath, destinationPath, overwrite, createDirectories }, bridgeId || "")));

  mcp.registerTool("pc_fs_unzip", {
    title: "Estrai ZIP AUTSYS",
    description: "Estrae ZIP con protezione zip-slip, limiti, backup e verifica.",
    inputSchema: z.object({
      sourcePath: z.string().min(1),
      destinationPath: z.string().min(1),
      overwrite: z.boolean().default(false),
      createDirectories: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ sourcePath, destinationPath, overwrite, createDirectories, bridgeId }) =>
    result(await callBridge("fs.unzip", { sourcePath, destinationPath, overwrite, createDirectories }, bridgeId || "")));

  mcp.registerTool("pc_process_start", {
    title: "Avvia processo AUTSYS",
    description: "Avvia in modo governato uno script Python, CMD/BAT o PowerShell gia presente su D:. Non accetta command-line shell libera.",
    inputSchema: z.object({
      kind: z.enum(["python", "cmd", "powershell"]),
      target: z.string().min(1),
      args: z.array(z.string()).optional(),
      workingDirectory: z.string().optional(),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ kind, target, args, workingDirectory, bridgeId }) =>
    result(await callBridge("process.start", { kind, target, args: args || [], workingDirectory }, bridgeId || "")));

  mcp.registerTool("pc_process_list", {
    title: "Elenca processi AUTSYS",
    description: "Elenca in modo sintetico i processi avviati e tracciati dal Bridge; puo filtrare per cartella/progetto.",
    inputSchema: z.object({
      pathPrefix: z.string().optional(),
      includeExited: z.boolean().default(false),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ pathPrefix, includeExited, bridgeId }) =>
    result(await callBridge("process.list", { pathPrefix: pathPrefix || "", includeExited }, bridgeId || "")));

  mcp.registerTool("pc_process_discover", {
    title: "Scopri processi progetto AUTSYS",
    description: "Scopre i processi Windows reali collegati a una cartella/progetto autorizzata, inclusi quelli non avviati o non piu tracciati dal Bridge.",
    inputSchema: z.object({
      pathPrefix: z.string().min(1),
      nameContains: z.string().optional(),
      maxResults: z.number().int().min(1).max(500).default(200),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ pathPrefix, nameContains, maxResults, bridgeId }) =>
    result(await callBridge("process.discover", { pathPrefix, nameContains: nameContains || "", maxResults }, bridgeId || "")));

  mcp.registerTool("pc_process_stop_pid", {
    title: "Ferma processo progetto AUTSYS per PID",
    description: "Ferma un processo Windows per PID solo se il Bridge verifica che appartenga alla cartella/progetto autorizzata indicata. Operazione idempotente e confinata allo scope.",
    inputSchema: z.object({
      pid: z.number().int().positive(),
      pathPrefix: z.string().min(1),
      entireProcessTree: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wi
  }, async ({ pid, pathPrefix, entireProcessTree, bridgeId }) =>
    compactProcessResult(await callBridge("process.stop_pid", { pid, pathPrefix, entireProcessTree }, bridgeId || ""), false, 0));

  mcp.registerTool("pc_process_status", {
    title: "Stato processo AUTSYS",
    description: "Legge stato sintetico di un processo avviato dal Bridge; i log sono opzionali e limitati alla coda richiesta.",
    inputSchema: z.object({
      processId: z.string().min(1),
      includeLogs: z.boolean().default(false),
      tailChars: z.number().int().min(0).max(16000).default(4000),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ processId, includeLogs, tailChars, bridgeId }) =>
    compactProcessResult(await callBridge("process.status", { processId }, bridgeId || ""), includeLogs, tailChars));

  mcp.registerTool("pc_process_stop", {
    title: "Arresta processo AUTSYS",
    description: "Arresta un processo avviato e tracciato dal Bridge.",
    inputSchema: z.object({
      processId: z.string().min(1),
      entireProcessTree: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wi
  }, async ({ processId, entireProcessTree, bridgeId }) =>
    compactProcessResult(await callBridge("process.stop", { processId, entireProcessTree }, bridgeId || ""), false, 0));

  mcp.registerTool("project_db_query", {
    title: "Leggi database locale progetto AUTSYS",
    description: "Esegue una singola SELECT/PRAGMA read-only nativa sul file AUTSYS_PROJECT.sqlite indicato, senza helper Python o process.start.",
    inputSchema: z.object({
      path: z.string().min(1),
      sql: z.string().min(1),
      maxRows: z.number().int().min(1).max(1000).default(1000),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ path, sql, maxRows, bridgeId }) =>
    result(await callBridge("project.db.query", { path, sql, maxRows }, bridgeId || "")));

  mcp.registerTool("sqlite_query", {
    title: "Leggi database SQLite locale AUTSYS",
    description: "Esegue una singola query SQLite strettamente read-only (solo SELECT/PRAGMA) su un file locale .sqlite/.sqlite3/.db autorizzato. Non usa pc_execute, helper Python o process.start ed e il percorso preferito per collettori e archivi storici.",
    inputSchema: z.object({
      path: z.string().min(1),
      sql: z.string().min(1),
      maxRows: z.number().int().min(1).max(1000).default(1000),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ path, sql, maxRows, bridgeId }) =>
    result(await callBridge("sqlite.query", { path, sql, maxRows }, bridgeId || "")));

  mcp.registerTool("project_handoff_create", {
    title: "Crea handoff locale progetto AUTSYS",
    description: "Crea l'handoff nel database locale AUTSYS_PROJECT.sqlite del progetto indicato. Risolve automaticamente root_path e project_public_id da ROBERTA; non salva l'handoff in ROBERTA, non richiede schema o path ed e idempotente su sessionKey.",
    inputSchema: z.object({
      projectName: z.string().min(1),
      sessionKey: z.string().min(1),
      sessionTitle: z.string().min(1),
      summary: z.string().min(1),
      completedWork: z.string().default(""),
      verifiedState: z.string().default(""),
      pendingWork: z.string().default(""),
      operationalNotes: z.string().default(""),
      externalLinks: z.string().default(""),
      nextSessionBootstrap: z.string().default(""),
      sourceReference: z.string().default(""),
      createdAt: z.string().optional(),
      sessionDate: z.string().optional(),
      publicId: z.string().optional(),
      bridgeId: z.string().optional()
    }),
    annotations: wi
  }, async ({
    projectName, sessionKey, sessionTitle, summary, completedWork, verifiedState,
    pendingWork, operationalNotes, externalLinks, nextSessionBootstrap,
    sourceReference, createdAt, sessionDate, publicId, bridgeId
  }) => {
    try {
      const key = projectKey(projectName);
      const resolved = await queryRows(
        `SELECT p.project_key,p.public_id,p.root_path
         FROM public.autsys_project_registry p
         WHERE lower(p.display_name)=lower(${sqlLiteral(projectName)})
            OR p.project_key=${sqlLiteral(key)}
         ORDER BY p.is_authoritative DESC,p.id
         LIMIT 1`,
        bridgeId || "",
        "project handoff project resolve"
      );
      const row = Array.isArray(resolved?.rows) && resolved.rows.length ? resolved.rows[0] : null;
      if (!row?.root_path || !row?.public_id) throw new Error("Progetto AUTSYS non trovato o privo di root_path/public_id.");
      const path = winJoin(String(row.root_path), "AUTSYS_PROJECT.sqlite");
      const args = {
        path,
        projectPublicId: String(row.public_id),
        sessionKey,
        sessionTitle,
        summary,
        completedWork,
        verifiedState,
        pendingWork,
        operationalNotes,
        externalLinks,
        nextSessionBootstrap,
        sourceReference
      };
      if (createdAt) args.createdAt = createdAt;
      if (sessionDate) args.sessionDate = sessionDate;
      if (publicId) args.publicId = publicId;
      return result(await callBridge("project.handoff.create", args, bridgeId || ""));
    } catch (e) {
      return jsonResult({ ok: false, error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("project_db_write", {
    title: "Scrivi database locale progetto AUTSYS",
    description: "Esegue una scrittura strutturata governata sul database AUTSYS_PROJECT.sqlite; nessun SQL libero di scrittura.",
    inputSchema: z.object({
      path: z.string().min(1),
      table: z.string().min(1),
      writeOperation: z.enum(["insert", "update", "delete"]),
      values: z.record(z.any()).optional(),
      filters: z.array(z.record(z.any())).default([]),
      maxAffectedRows: z.number().int().min(1).max(100).default(100),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ path, table, writeOperation, values, filters, maxAffectedRows, bridgeId }) => {
    try {
      const out = await runProjectDbHelper({
        operation: "write", path, table, writeOperation,
        values: values || {}, filters: filters || [], maxAffectedRows
      }, bridgeId || "");
      return jsonResult(out);
    } catch (e) {
      return jsonResult({ ok: false, error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("project_handoff_consume", {
    title: "Consuma handoff locale progetto AUTSYS",
    description: "Marca uno o piu handoff del database locale AUTSYS_PROJECT.sqlite come consumed senza cancellarli. Operazione idempotente.",
    inputSchema: z.object({
      path: z.string().min(1),
      ids: z.array(z.number().int().positive()).min(1).max(20),
      bridgeId: z.string().optional()
    }),
    annotations: wi
  }, async ({ path, ids, bridgeId }) => {
    try {
      const out = await runProjectDbHelper({ operation: "handoff_consume", path, ids }, bridgeId || "");
      return jsonResult(out);
    } catch (e) {
      return jsonResult({ ok: false, error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("roberta_query", {
    title: "Leggi ROBERTA",
    description: "Query SQL sola lettura sul DB ROBERTA.",
    inputSchema: z.object({ sql: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: ro
  }, async ({ sql, bridgeId }) => result(await callBridge("pg.roberta.query", { sql }, bridgeId || "")));

  mcp.registerTool("roberta_write", {
    title: "Scrivi dati ROBERTA",
    description: "INSERT/UPDATE/DELETE/UPSERT strutturati e governati; nessun SQL libero.",
    inputSchema: z.object({ request: z.record(z.any()), bridgeId: z.string().optional() }),
    annotations: de
  }, async ({ request, bridgeId }) => result(await callBridge("pg.roberta.write", request, bridgeId || "")));

  mcp.registerTool("roberta_migrate", {
    title: "Evolvi schema ROBERTA",
    description: "Migrazione additiva con backup e guardie.",
    inputSchema: z.object({
      migrationId: z.string().min(1),
      description: z.string().min(1),
      sql: z.string().min(1),
      bridgeId: z.string().optional()
    }),
    annotations: de
  }, async ({ migrationId, description, sql, bridgeId }) =>
    result(await callBridge("pg.roberta.migrate", { migrationId, description, sql }, bridgeId || "")));

  mcp.registerTool("session_bootstrap", {
    title: "Bootstrap AUTSYS",
    description: "Bootstrap ROBERTA v6.1 da eseguire una sola volta all'avvio della conversazione. Non richiamare nella stessa conversazione dopo un bootstrap riuscito salvo richiesta esplicita dell'utente di ricaricare/re-bootstrap o cambio progetto. Le normali richieste operative non richiedono un nuovo bootstrap.",
    inputSchema: z.object({
      scope: z.enum(["GENERAL", "PROJECT"]),
      projectName: z.string().optional(),
      bridgeId: z.string().optional()
    }),
    annotations: ro
  }, async ({ scope, projectName, bridgeId }) => {
    try {
      return jsonResult(await bootstrap(scope, projectName || "", bridgeId || ""));
    } catch (e) {
      return jsonResult({ ok: false, error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("project_register", {
    title: "Registra progetto ROBERTA",
    description: "Registra/aggiorna idempotentemente un progetto con project.register.",
    inputSchema: z.object({
      projectName: z.string().min(1),
      projectKey: z.string().optional(),
      entityKind: z.string().min(1),
      rootPath: z.string().optional(),
      repositoryUrl: z.string().optional(),
      repositoryBranch: z.string().optional(),
      description: z.string().optional(),
      currentStateSummary: z.string().max(16384).optional(),
      currentObjective: z.string().max(16384).optional(),
      nextAction: z.string().max(16384).optional(),
      lastReviewedAt: z.string().optional(),
      isAuthoritative: z.boolean().default(true),
      bridgeId: z.string().optional()
    }),
    annotations: wr
  }, async ({ bridgeId, projectName, ...rest }) =>
    result(await callBridge("project.register", { displayName: projectName, ...rest }, bridgeId || "")));

  mcp.registerTool("pc_file_stage_from_chat", {
    title: "Trasferisci file ChatGPT al PC",
    description: "Riceve direttamente un file allegato/autorizzato da ChatGPT e lo trasferisce in staging sul PC tramite AUTSYS PC BRIDGE, con verifica SHA-256.",
    inputSchema: z.object({
      file: z.object({
        download_url: z.string().url(),
        file_id: z.string().min(1),
        mime_type: z.string().optional(),
        file_name: z.string().optional()
      }),
      updateId: z.string().min(8).max(100).optional(),
      relativePath: z.string().min(1).optional(),
      bridgeId: z.string().optional()
    }),
    annotations: wr,
    _meta: { "openai/fileParams": ["file"] }
  }, async ({ file, updateId, relativePath, bridgeId }) => {
    try {
      const response = await fetch(file.download_url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error("Download file ChatGPT fallito: HTTP " + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 32 * 1024 * 1024) throw new Error("File oltre il limite di 32 MiB del Bridge.");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const id = updateId || ("chat_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"));
      const rel = relativePath || file.file_name || (file.file_id + ".bin");
      return result(await callBridge("bridge.update.stage", {
        updateId: id,
        relativePath: rel,
        sha256,
        contentBase64: bytes.toString("base64")
      }, bridgeId || ""));
    } catch (e) {
      return jsonResult({ ok: false, error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("bridge_update_stage", {
    title: "Prepara aggiornamento Bridge",
    description: "Stage governato di un file per l'Updater.",
    inputSchema: z.object({ request: z.record(z.any()), bridgeId: z.string().optional() }),
    annotations: wr
  }, async ({ request, bridgeId }) =>
    result(await callBridge("bridge.update.stage", request, bridgeId || "")));

  mcp.registerTool("bridge_update_apply", {
    title: "Applica aggiornamento Bridge",
    description: "Applica update governato con backup/health/rollback; nessuna shell arbitraria.",
    inputSchema: z.object({ request: z.record(z.any()), bridgeId: z.string().optional() }),
    annotations: de
  }, async ({ request, bridgeId }) =>
    result(await callBridge("bridge.update.apply", request, bridgeId || "")));


  mcp.registerTool("render_list_services", {
    title: "Elenca servizi Render",
    description: "Elenca i servizi Render accessibili con la credenziale AUTSYS configurata sul gateway.",
    inputSchema: z.object({
      name: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20)
    }),
    annotations: ro
  }, async ({ name, limit }) => {
    try {
      const q = new URLSearchParams();
      q.set("limit", String(limit));
      if (name) q.append("name", name);
      return renderResult(await callRender("/services?" + q.toString()));
    } catch (e) {
      return jsonResult({ ok: false, provider: "Render", error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("render_get_service", {
    title: "Leggi servizio Render",
    description: "Legge configurazione e stato di un servizio Render tramite serviceId.",
    inputSchema: z.object({ serviceId: z.string().min(1) }),
    annotations: ro
  }, async ({ serviceId }) => {
    try {
      return renderResult(await callRender("/services/" + encodeURIComponent(serviceId)));
    } catch (e) {
      return jsonResult({ ok: false, provider: "Render", error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("render_list_deploys", {
    title: "Elenca deploy Render",
    description: "Elenca i deploy di un servizio Render.",
    inputSchema: z.object({
      serviceId: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20)
    }),
    annotations: ro
  }, async ({ serviceId, limit }) => {
    try {
      const q = new URLSearchParams({ limit: String(limit) });
      return renderResult(await callRender("/services/" + encodeURIComponent(serviceId) + "/deploys?" + q.toString()));
    } catch (e) {
      return jsonResult({ ok: false, provider: "Render", error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("render_get_deploy", {
    title: "Leggi deploy Render",
    description: "Legge lo stato reale di uno specifico deploy Render.",
    inputSchema: z.object({
      serviceId: z.string().min(1),
      deployId: z.string().min(1)
    }),
    annotations: ro
  }, async ({ serviceId, deployId }) => {
    try {
      return renderResult(await callRender("/services/" + encodeURIComponent(serviceId) + "/deploys/" + encodeURIComponent(deployId)));
    } catch (e) {
      return jsonResult({ ok: false, provider: "Render", error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("render_trigger_deploy", {
    title: "Avvia deploy Render",
    description: "Avvia un deploy governato di un servizio Render. Può usare l'ultimo commit o un commitId esplicito.",
    inputSchema: z.object({
      serviceId: z.string().min(1),
      clearCache: z.boolean().default(false),
      commitId: z.string().optional()
    }),
    annotations: de
  }, async ({ serviceId, clearCache, commitId }) => {
    try {
      const body = { clearCache: clearCache ? "clear" : "do_not_clear" };
      if (commitId) body.commitId = commitId;
      return renderResult(await callRender("/services/" + encodeURIComponent(serviceId) + "/deploys", {
        method: "POST",
        body,
        timeoutMs: 60000
      }));
    } catch (e) {
      return jsonResult({ ok: false, provider: "Render", error: String(e?.message || e) }, true);
    }
  });

  mcp.registerTool("render_logs", {
    title: "Leggi log Render",
    description: "Legge i log Render per uno o più resourceId nello stesso workspace. Usa ownerId del workspace Render.",
    inputSchema: z.object({
      ownerId: z.string().min(1),
      resourceIds: z.array(z.string().min(1)).min(1).max(20),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      direction: z.enum(["backward", "forward"]).default("backward"),
      limit: z.number().int().min(1).max(100).default(50),
      text: z.array(z.string()).optional(),
      type: z.array(z.string()).optional()
    }),
    annotations: ro
  }, async ({ ownerId, resourceIds, startTime, endTime, direction, limit, text, type }) => {
    try {
      const q = new URLSearchParams();
      q.set("ownerId", ownerId);
      q.set("direction", direction);
      q.set("limit", String(limit));
      if (startTime) q.set("startTime", startTime);
      if (endTime) q.set("endTime", endTime);
      for (const id of resourceIds) q.append("resource", id);
      for (const t of (text || [])) q.append("text", t);
      for (const t of (type || [])) q.append("type", t);
      return renderResult(await callRender("/logs?" + q.toString(), { timeoutMs: 60000 }));
    } catch (e) {
      return jsonResult({ ok: false, provider: "Render", error: String(e?.message || e) }, true);
    }
  });

  return mcp;
}

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const mcp = buildMcp();
  res.on("close", () => {
    try { transport.close(); } catch {}
    try { mcp.close(); } catch {}
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP FULL error:", e?.message || e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "MCP internal error" },
        id: null
      });
    }
  }
});

app.get("/mcp", (_req, res) =>
  res.status(405).json({ ok: false, error: "Use POST /mcp" }));

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    product: "AUTSYS MCP FULL FRONT",
    version: VERSION,
    bootstrapVersion: "6",
    bootstrapRevision: "6.1",
    renderTools: true,
    utc: new Date().toISOString()
  }));

app.listen(PORT, "127.0.0.1", () =>
  console.log(`AUTSYS MCP FULL FRONT ${VERSION} listening on ${PORT}; backend=${BACKEND_PORT}; bootstrap=v6`));
