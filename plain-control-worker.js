const PORT = Number(process.env.PORT || 10000);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const CONTROL_API_URL = "https://api.github.com/repos/AUTSYS-SRLS/autsys-relay/contents/control/command.json?ref=pc-bridge-control";
const POLL_MS = Math.max(5000, Number(process.env.CHAT_POLL_MS || 5000));

const ALLOWED_TOOLS = new Set(["health", "fs.list", "fs.read_text", "fs.find"]);

if (!CONTROL_TOKEN) {
  console.error("PLAIN CHAT CONTROL disabled: missing CONTROL_TOKEN");
  process.exit(1);
}

let etag = "";
let polling = false;
let lastRequestId = "";

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
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "AUTSYS-PC-BRIDGE-PLAIN-CONTROL/0.1.0.1"
    };
    if (etag) headers["if-none-match"] = etag;

    const response = await fetch(CONTROL_API_URL, {
      headers,
      signal: AbortSignal.timeout(5000)
    });

    if (response.status === 304) return;
    if (!response.ok) throw new Error(`GitHub control HTTP ${response.status}`);

    etag = response.headers.get("etag") || etag;
    const apiPayload = await response.json();
    const encoded = String(apiPayload?.content || "").replace(/\s+/g, "");
    if (!encoded) return;

    const command = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    await processCommand(command);
  } catch (err) {
    console.error(`PLAIN_CHAT_CONTROL poll error: ${String(err?.message || err)}`);
  } finally {
    polling = false;
  }
}

console.log(`AUTSYS PC BRIDGE PLAIN CHAT CONTROL active; poll=${POLL_MS}ms`);
setInterval(poll, POLL_MS).unref();
setTimeout(poll, 1000);
setInterval(() => {}, 60000);
