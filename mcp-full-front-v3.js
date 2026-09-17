import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const VERSION = "0.1.0.3";
const PORT = Number(process.env.PORT || 10006);
const BACKEND_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || 10001);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
if (!CONTROL_TOKEN) process.exit(1);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "40mb" }));

function timeoutFor(tool) {
  if (tool === "pg.roberta.migrate" || tool === "bridge.update.apply") return 300000;
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

  const agentSql = `SELECT
    count(*)::int AS agent_capability_count,
    COALESCE(jsonb_agg(to_jsonb(a)),'[]'::jsonb) AS agent_capabilities
    FROM public.autsys_agent_capabilities a;`;

  const contextSql = `SELECT
    count(*)::int AS project_bootstrap_context_count,
    COALESCE(jsonb_agg(to_jsonb(c)),'[]'::jsonb) AS project_bootstrap_context
    FROM public.autsys_project_bootstrap_context c;`;

  const [core, agent, context] = await Promise.all([
    queryRows(coreSql, bridgeId, "bootstrap core"),
    queryRows(agentSql, bridgeId, "bootstrap agent capabilities"),
    queryRows(contextSql, bridgeId, "bootstrap project context")
  ]);

  const row = Array.isArray(core.rows) && core.rows.length ? core.rows[0] : {};
  const agentRow = Array.isArray(agent.rows) && agent.rows.length ? agent.rows[0] : {};
  const contextRow = Array.isArray(context.rows) && context.rows.length ? context.rows[0] : {};
  const found = Boolean(row.project_found);

  return {
    ok: true,
    operation: "session.bootstrap",
    source: "ROBERTA",
    bootstrapVersion: "3",
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
    projects: Array.isArray(row.projects) ? row.projects : [],
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
    pluginCapabilities: row.plugin_capabilities || [],
    externalCapabilities: row.external_capabilities || [],
    agentCapabilityCount: Number(agentRow.agent_capability_count || 0),
    agentCapabilities: Array.isArray(agentRow.agent_capabilities) ? agentRow.agent_capabilities : [],
    projectBootstrapContextCount: Number(contextRow.project_bootstrap_context_count || 0),
    projectBootstrapContext: Array.isArray(contextRow.project_bootstrap_context) ? contextRow.project_bootstrap_context : [],
    database: core.database || agent.database || context.database || "roberta"
  };
}

const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const wr = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const de = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function buildMcp() {
  const mcp = new McpServer({ name: "AUTSYS PC BRIDGE", version: VERSION });

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

  mcp.registerTool("pc_fs_write_text", {
    title: "Scrivi file AUTSYS",
    description: "Scrive testo mantenendo le protezioni del Bridge.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string(), bridgeId: z.string().optional() }),
    annotations: wr
  }, async ({ path, content, bridgeId }) => result(await callBridge("fs.write_text", { path, content }, bridgeId || "")));

  mcp.registerTool("pc_fs_delete", {
    title: "Elimina file AUTSYS",
    description: "Elimina un file consentito secondo le protezioni del Bridge.",
    inputSchema: z.object({ path: z.string().min(1), bridgeId: z.string().optional() }),
    annotations: de
  }, async ({ path, bridgeId }) => result(await callBridge("fs.delete", { path }, bridgeId || "")));

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
    description: "Bootstrap ROBERTA v3: catalogo progetti, progetto corrente, capacità operative e contesto informativo dell'agente.",
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
    bootstrapVersion: "3",
    utc: new Date().toISOString()
  }));

app.listen(PORT, "127.0.0.1", () =>
  console.log(`AUTSYS MCP FULL FRONT ${VERSION} listening on ${PORT}; backend=${BACKEND_PORT}; bootstrap=v3`));
