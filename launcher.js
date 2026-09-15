import { spawn } from "node:child_process";

const children = [];
let stopping = false;

function start(name, script) {
  const child = spawn(process.execPath, [script], {
    stdio: "inherit",
    env: process.env
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

async function runBootstrapCommand() {
  const packed = String(process.env.CHAT_BOOTSTRAP_COMMAND_B64 || "").trim();
  const token = String(process.env.CONTROL_TOKEN || "");
  if (!packed || !token) return;

  let command;
  try {
    command = JSON.parse(Buffer.from(packed, "base64url").toString("utf8"));
  } catch (err) {
    console.error(`BOOTSTRAP_CONTROL invalid command: ${err?.message || err}`);
    return;
  }

  const allowed = new Set(["health", "fs.list", "fs.read_text", "fs.find"]);
  const tool = String(command?.tool || "");
  const requestId = String(command?.requestId || "");
  if (!requestId || !allowed.has(tool)) {
    console.error(`BOOTSTRAP_CONTROL rejected ${requestId || "?"} ${tool || "?"}`);
    return;
  }

  for (let attempt = 1; attempt <= 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 10000)}/api/execute`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          requestId,
          bridgeId: command.bridgeId || undefined,
          tool,
          arguments: command.arguments || {}
        }),
        signal: AbortSignal.timeout(10000)
      });

      const text = await response.text();
      let body;
      try { body = JSON.parse(text); }
      catch { body = { ok: false, error: text }; }

      if (response.status === 503 && attempt < 40) continue;

      const result = Buffer.from(JSON.stringify({
        requestId,
        tool,
        httpStatus: response.status,
        response: body
      }), "utf8").toString("base64url");
      console.log(`BOOTSTRAP_RESULT ${requestId} ${result}`);
      return;
    } catch (err) {
      if (attempt === 40) {
        console.error(`BOOTSTRAP_CONTROL error ${requestId}: ${err?.message || err}`);
      }
    }
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start("gateway", "server.js");
start("chat-control", "control-worker.js");
start("plain-chat-control", "plain-control-worker.js");
setTimeout(runBootstrapCommand, 1000);
