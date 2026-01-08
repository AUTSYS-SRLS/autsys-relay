// AUTSYS Relay – DIAGNOSTIC SAFE (MSG_ID FIX)
// In-memory queues + /diag
// Endpoints:
// - GET  /            health
// - GET  /diag        counts + last ok timestamps + last error
// - POST /mobile      enqueue Freja->Roberta
// - GET  /roberta     dequeue Freja->Roberta
// - POST /roberta     enqueue Roberta->Freja
// - GET  /mobile      dequeue Roberta->Freja
//
// IMPORTANT: outbox items ALWAYS carry msg_id so Freja can correlate.
// Also: permissive CORS for iOS apps.

import express from "express";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// CORS (iOS-friendly)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// --------------------
// In-memory queues
// --------------------
const inbox = [];  // Freja -> Roberta : { ts, msg_id, state, message, source }
const outbox = []; // Roberta -> Freja : { ts, msg_id, text }

// --------------------
// Diagnostics
// --------------------
const nowTs = () => Math.floor(Date.now() / 1000);

let lastEnqueueInboxOkTs = 0;
let lastEnqueueOutboxOkTs = 0;
let lastDequeueInboxOkTs = 0;
let lastDequeueOutboxOkTs = 0;
let lastError = null;

// --------------------
// Health
// --------------------
app.get("/", (req, res) => {
  return res.json({ ok: true, ts: nowTs() });
});

// --------------------
// Diag
// --------------------
app.get("/diag", (req, res) => {
  return res.json({
    ok: true,
    ts: nowTs(),
    inbox_len: inbox.length,
    outbox_len: outbox.length,
    lastEnqueueInboxOkTs,
    lastEnqueueOutboxOkTs,
    lastDequeueInboxOkTs,
    lastDequeueOutboxOkTs,
    lastError
  });
});

// --------------------
// Freja -> Relay (enqueue)
//
// Body: { source, msg_id, state, message }
// --------------------
app.post("/mobile", (req, res) => {
  try {
    const source = String(req.body?.source ?? "freja_app");
    let msg_id = String(req.body?.msg_id ?? "").trim();
    const state = String(req.body?.state ?? "DA_RISPONDERE");
    const message = String(req.body?.message ?? "");
    const tsIn = req.body?.ts;
    const tsVal = Number.isFinite(tsIn) ? Number(tsIn) : nowTs();
    if (!msg_id) {
      msg_id = `${tsVal}_${Math.random().toString(16).slice(2)}_${Math.random().toString(16).slice(2)}`;
    }
    if (message.trim().length > 0) {
      inbox.push({ ts: tsVal, msg_id, state, message, source });
      lastEnqueueInboxOkTs = nowTs();
    }
    return res.json({ ok: true, msg_id });
  } catch (e) {
    lastError = { ts: nowTs(), where: "POST /mobile", err: String(e) };
    return res.json({ ok: true, msg_id: "" });
  }
});// --------------------
// Roberta <- Relay (dequeue)
//
// Returns:
// - { status: "empty" } if none
// - { msg_id, state, message, ts } if present
// --------------------
app.get("/roberta", (req, res) => {
  try {
    if (inbox.length === 0) return res.json({ status: "empty" });

    const item = inbox.shift();
    lastDequeueInboxOkTs = nowTs();

    return res.json({
      msg_id: item.msg_id ?? "",
      state: item.state ?? "DA_RISPONDERE",
      message: item.message ?? "",
      ts: item.ts ?? nowTs()
    });
  } catch (e) {
    lastError = { ts: nowTs(), where: "GET /roberta", err: String(e) };
    return res.json({ status: "empty" });
  }
});

// --------------------
// Roberta -> Relay (enqueue)
//
// Body: { text, msg_id }
// NOTE: msg_id is required for correct correlation. If missing, we still enqueue with "".
// --------------------
app.post("/roberta", (req, res) => {
  try {
    const text = String(req.body?.text ?? "");
    const msg_id = String(req.body?.msg_id ?? "").trim();

    if (text.trim().length > 0) {
      outbox.push({ ts: nowTs(), msg_id, text });
      lastEnqueueOutboxOkTs = nowTs();
    }

    return res.json({ ok: true });
  } catch (e) {
    lastError = { ts: nowTs(), where: "POST /roberta", err: String(e) };
    return res.json({ ok: true });
  }
});

// --------------------
// Freja <- Relay (dequeue)
//
// Returns:
// - { status: "empty" } if none
// - { text, msg_id, ts } if present
// --------------------
app.get("/mobile", (req, res) => {
  try {
    if (outbox.length === 0) return res.json({ status: "empty" });

    const item = outbox.shift();
    lastDequeueOutboxOkTs = nowTs();

    return res.json({
      text: item.text ?? "",
      msg_id: item.msg_id ?? "",
      ts: item.ts ?? nowTs()
    });
  } catch (e) {
    lastError = { ts: nowTs(), where: "GET /mobile", err: String(e) };
    return res.json({ status: "empty" });
  }
});

app.listen(port, () => {});
