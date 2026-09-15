import crypto from "crypto";

const PORT = Number(process.env.PORT || 10000);
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const PRIVATE_KEY_B64 = process.env.CHAT_COMMAND_PRIVATE_KEY_B64 || "";
const CONTROL_URL = process.env.CHAT_CONTROL_URL || "";
const POLL_MS = Math.max(750, Number(process.env.CHAT_POLL_MS || 1500));

const ALLOWED_TOOLS = new Set([
  "health",
  "fs.list",
  "fs.read_text",
  "fs.find"
]);

if (!CONTROL_TOKEN || !PRIVATE_KEY_B64 || !CONTROL_URL) {
  console.error("CHAT CONTROL disabled: missing CONTROL_TOKEN, CHAT_COMMAND_PRIVATE_KEY_B64 or CHAT_CONTROL_URL");
  process.exit(1);
}

const privateKey = crypto.createPrivateKey(
  Buffer.from(PRIVATE_KEY_B64, "base64").toString("utf8")
);

let etag = "";
let polling = false;
let lastError = "";
const processed = new Set();

function decryptEnvelope(envelope) {
  const wrappedKey = Buffer.from(String(envelope.wrappedKey || ""), "base64");
  const iv = Buffer.from(String(envelope.iv || ""), "base64");
  const tag = Buffer.from(String(envelope.tag || ""), "base64");
  const ciphertext = Buffer.from(String(envelope.ciphertext || ""), "base64");

  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256"
    },
    wrappedKey
  );

  if (aesKey.length !== 32) throw new Error("Invalid AES key length");
  if (iv.length !== 12) throw new Error("Invalid IV length");
  if (tag.length !== 16) throw new Error("Invalid GCM tag length");

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { aesKey, command: JSON.parse(plain.toString("utf8")) };
}

function encryptResult(aesKey, requestId, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    protocol: "1",
    requestId,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function emitEncryptedResult(aesKey, requestId, payload) {
  const envelope = encryptResult(aesKey, requestId, payload);
  const packed = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  console.log(`CHAT_RESULT ${requestId} ${packed}`);
}

async function executeLocal(command) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/execute`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${CONTROL_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      requestId: command.requestId,
      bridgeId: command.bridgeId || undefined,
      tool: command.tool,
      arguments: command.arguments || {}
    })
  });

  let body;
  const text = await response.text();
  try { body = JSON.parse(text); }
  catch { body = { ok: false, error: text || `HTTP ${response.status}` }; }

  return { httpStatus: response.status, body };
}

async function processEnvelope(envelope) {
  const requestId = String(envelope?.requestId || "").trim();
  if (!requestId || requestId === "IDLE" || envelope?.state === "idle") return;
  if (processed.has(requestId)) return;

  processed.add(requestId);
  if (processed.size > 500) {
    const first = processed.values().next().value;
    processed.delete(first);
  }

  let aesKey;
  try {
    const decrypted = decryptEnvelope(envelope);
    aesKey = decrypted.aesKey;
    const command = decrypted.command || {};

    if (String(command.requestId || "") !== requestId) {
      throw new Error("requestId mismatch");
    }

    const expiresAt = Date.parse(String(command.expiresAt || ""));
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      throw new Error("Command expired");
    }

    const tool = String(command.tool || "").trim();
    if (!ALLOWED_TOOLS.has(tool)) {
      throw new Error(`Tool not allowed on chat control channel: ${tool}`);
    }

    const result = await executeLocal({ ...command, tool });
    emitEncryptedResult(aesKey, requestId, {
      ok: result.httpStatus >= 200 && result.httpStatus < 300,
      gatewayHttpStatus: result.httpStatus,
      gatewayResponse: result.body
    });
    console.log(`CHAT_CONTROL executed ${requestId} ${tool}`);
  } catch (err) {
    const message = String(err?.message || err);
    if (aesKey) {
      emitEncryptedResult(aesKey, requestId, { ok: false, error: message });
    }
    console.error(`CHAT_CONTROL error ${requestId}: ${message}`);
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const headers = {
      "user-agent": "AUTSYS-PC-BRIDGE-CONTROL/0.1.0.1",
      "cache-control": "no-cache"
    };
    if (etag) headers["if-none-match"] = etag;

    const response = await fetch(CONTROL_URL, { headers, cache: "no-store" });
    if (response.status === 304) {
      lastError = "";
      return;
    }
    if (!response.ok) throw new Error(`GitHub control HTTP ${response.status}`);

    etag = response.headers.get("etag") || etag;
    const envelope = await response.json();
    await processEnvelope(envelope);
    lastError = "";
  } catch (err) {
    const message = String(err?.message || err);
    if (message !== lastError) {
      console.error(`CHAT_CONTROL poll error: ${message}`);
      lastError = message;
    }
  } finally {
    polling = false;
  }
}

console.log(`AUTSYS PC BRIDGE CHAT CONTROL 0.1.0.1 active; poll=${POLL_MS}ms`);
setInterval(poll, POLL_MS).unref();
setTimeout(poll, 500);

// Keep this sidecar alive when it is the foreground process.
setInterval(() => {}, 60_000);
