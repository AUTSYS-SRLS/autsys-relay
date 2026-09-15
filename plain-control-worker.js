const PORT = Number(process.env.PORT || 10000);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const CONTROL_RAW_URL = "https://raw.githubusercontent.com/AUTSYS-SRLS/autsys-relay/pc-bridge-control/control/command.json";
const POLL_MS = Math.max(1000, Number(process.env.CHAT_POLL_MS || 1500));

const ALLOWED_TOOLS = new Set(["health", "fs.list", "fs.read_text", "fs.find"]);

if (!CONTROL_TOKEN) {
  console.error("PLAIN CHAT CONTROL disabled: missing CONTROL_TOKEN");
  process.exit(1);
}

let polling = false;
let lastRequestId = "";
let lastError = "";

async function executeLocal(command) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CONTROL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId: command.requestId,
      bridgeId: command.bridgeId || undefined,
      tool: command.tool,
      arguments: command.arguments || {}
    }),
    signal: AbortSignal.timeout(10000)
  });

  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { body = { ok: false, error: text || `HTTP ${response.status}` }; }
  return { status: response.status, body };
}

async function processCommand(command) {
  if (command?.protocol !== "chat-plain-v1") return;

  const requestId = String(command.requestId || "").trim();
  if (!requestId || requestId === lastRequestId) return;

  const expiresAt = Date.parse(String(command.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return;

  const tool = String(command.tool || "").trim();
  if (!ALLOWED_TOOLS.has(tool)) {
    console.error(`PLAIN_CHAT_CONTROL rejected ${requestId}: tool not allowed: ${tool}`);
    lastRequestId = requestId;
    return;
  }

  lastRequestId = requestId;
  console.log(`PLAIN_CHAT_CONTROL observed ${requestId} ${tool}`);

  try {
    const result = await executeLocal({ ...command, tool });
    const packed = Buffer.from(JSON.stringify({
      requestId,
      tool,
      status: result.status,
      response: result.body
    }), "utf8").toString("base64url");
    console.log(`PLAIN_CHAT_RESULT ${requestId} ${packed}`);
    console.log(`PLAIN_CHAT_CONTROL executed ${requestId} ${tool}`);
  } catch (err) {
    console.error(`PLAIN_CHAT_CONTROL error ${requestId}: ${String(err?.message || err)}`);
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const url = `${CONTROL_RAW_URL}?cb=${Date.now()}`;
    const response = await fetch(url, {
      headers: {
        "cache-control": "no-cache, no-store, max-age=0",
        pragma: "no-cache",
        "user-agent": "AUTSYS-PC-BRIDGE-PLAIN-CONTROL/0.1.0.2"
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) throw new Error(`GitHub raw control HTTP ${response.status}`);
    const text = await response.text();
    if (!text || text.length > 65536) throw new Error("Invalid GitHub raw control payload size");

    const command = JSON.parse(text);
    await processCommand(command);
    lastError = "";
  } catch (err) {
    const message = String(err?.message || err);
    if (message !== lastError) {
      console.error(`PLAIN_CHAT_CONTROL poll error: ${message}`);
      lastError = message;
    }
  } finally {
    polling = false;
  }
}

console.log(`AUTSYS PC BRIDGE PLAIN CHAT CONTROL 0.1.0.2 active; poll=${POLL_MS}ms; source=raw`);
setInterval(poll, POLL_MS).unref();
setTimeout(poll, 300);
setInterval(() => {}, 60000);
