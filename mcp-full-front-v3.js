import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const VERSION = "0.1.0.19";
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
      instructions: "At conversation start, if the chat belongs to a specific project, call session_bootstrap with scope PROJECT and the exact current project name; do not call GENERAL first. If the chat is general, call session_bootstrap with scope GENERAL. Bootstrap is ONCE PER CONVERSATION: after a successful bootstrap, NEVER call session_bootstrap again in the same conversation unless the user explicitly asks to reload/re-bootstrap the project or the project itself changes. A routine request to read a file, query a DB, inspect state, run a simulation or continue work is NOT permission to bootstrap again. Always retain the compact global context, active learning and compact project catalog. In PROJECT scope, load detailed context only for the current project; retrieve other project/domain details on demand. Prefer the narrow typed tools for routine filesystem, process and project-database work. Use pc_execute only as a fallback when no typed capability exists. For AUTSYS_PROJECT.sqlite reads use project_db_query/project.db.query natively; never use process.start/project_db_tool.py for project DB reads. For project handoffs ALWAYS use project_handoff_create: handoffs belong in the project local AUTSYS_PROJECT.sqlite, not in ROBERTA, and the tool resolves the project path/public id automatically. Do not use roberta_write or generic project_db_write to create a project handoff when project_handoff_create is available. Do not create/execute helper scripts for routine mkdir, project DB reads, project handoff creation, hash, move, rename or long recursive delete when the dedicated MCP tool exists."
    }
  );

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
