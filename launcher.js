import { spawn } from "node:child_process";

const children = [];
let stopping = false;

function start(name, script, extraEnv = {}) {
  const child = spawn(process.execPath, [script], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`${name} exited unexpectedly: code=${code} signal=${signal || ""}`);
    for (const other of children) {
      if (other !== child && !other.killed) {
        try { other.kill("SIGTERM"); } catch {}
      }
    }
    setTimeout(() => process.exit(code ?? 1), 250);
  });

  children.push(child);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) {
      try { child.kill(signal); } catch {}
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const publicPort = String(process.env.PORT || 10000);
const internalPort = String(process.env.GATEWAY_INTERNAL_PORT || 10001);
const legacyFrontPort = String(process.env.LEGACY_FRONT_PORT || 10002);
const workFrontPort = String(process.env.WORK_FRONT_PORT || 10003);
const workDbFrontPort = String(process.env.WORK_DB_FRONT_PORT || 10004);
const workBootstrapPort = String(process.env.WORK_BOOTSTRAP_PORT || 10005);

start("gateway-backend", "server.js", { PORT: internalPort });
start("front-gateway", "front-gateway.js", { PORT: legacyFrontPort, GATEWAY_INTERNAL_PORT: internalPort });
start("work-front", "work-front.js", { PORT: workFrontPort, LEGACY_FRONT_PORT: legacyFrontPort, GATEWAY_INTERNAL_PORT: internalPort });
start("work-db-front", "work-db-front.js", { PORT: workDbFrontPort, WORK_FRONT_PORT: workFrontPort, GATEWAY_INTERNAL_PORT: internalPort });
start("work-bootstrap-front", "work-bootstrap-front.js", { PORT: workBootstrapPort, WORK_DB_FRONT_PORT: workDbFrontPort, GATEWAY_INTERNAL_PORT: internalPort });
start("mcp-auth-front", "mcp-auth-front.js", { PORT: publicPort, WORK_BOOTSTRAP_PORT: workBootstrapPort, GATEWAY_INTERNAL_PORT: internalPort });
