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

start("gateway-backend", "server.js", { PORT: internalPort });
start("front-gateway", "front-gateway.js", { PORT: publicPort, GATEWAY_INTERNAL_PORT: internalPort });
