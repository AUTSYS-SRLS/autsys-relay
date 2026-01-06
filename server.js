// AUTSYS Relay – DIAGNOSTIC SAFE (Freja 2.2.6 + Roberta Core)
// Fix: code in-memory (no filesystem dependency) + endpoint /diag per verifiche.
// Obiettivo: eliminare il caso "POST ok ma inbox vuota" dovuto a fs/istanze.
// Endpoints:
// - GET  /            health
// - GET  /diag        counts + last errors
// - POST /mobile      enqueue Freja->Roberta (immediato)
// - GET  /mobile      dequeue Roberta->Freja
// - GET  /roberta     dequeue Freja->Roberta
// - POST /roberta     enqueue Roberta->Freja

import express from "express";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

// In-memory queues (single instance). Render normalmente 1 istanza; se più istanze, serve storage condiviso.
const inbox = [];   // Freja -> Roberta: {ts, source, message}
const outbox = [];  // Roberta -> Freja: {ts, text}

let lastEnqueueInboxOkTs = 0;
let lastEnqueueOutboxOkTs = 0;
let lastError = null;

// HEALTH
app.get("/", (req, res) => {
  res.json({ ok: true, service: "AUTSYS_RELAY", ts: nowTs() });
});

// DIAG
app.get("/diag", (req, res) => {
  res.json({
    ok: true,
    ts: nowTs(),
    inbox_len: inbox.length,
    outbox_len: outbox.length,
    lastEnqueueInboxOkTs,
    lastEnqueueOutboxOkTs,
    lastError
  });
});

// FREJA -> Relay
app.post("/mobile", (req, res) => {
  try {
    const body = req.body || {};
    const message = (body.message ?? body.text ?? "").toString();

    if (message.trim().length > 0) {
      inbox.push({
        ts: nowTs(),
        source: (body.source || "freja_app").toString(),
        message
      });
      lastEnqueueInboxOkTs = nowTs();
    }

    return res.json({ status: "received_by_relay" });
  } catch (e) {
    lastError = { ts: nowTs(), where: "POST /mobile", err: String(e) };
    return res.json({ status: "error" });
  }
});

// Freja polling per risposta
app.get("/mobile", (req, res) => {
  try {
    if (outbox.length === 0) return res.json({ status: "empty" });

    const msg = outbox.shift();
    const text = (msg.text ?? "").toString().trim();
    if (!text) return res.json({ status: "empty" });

    return res.json({ text });
  } catch (e) {
    lastError = { ts: nowTs(), where: "GET /mobile", err: String(e) };
    return res.json({ status: "empty" });
  }
});

// Roberta polling per messaggi da Freja
app.get("/roberta", (req, res) => {
  try {
    if (inbox.length === 0) return res.json({ status: "empty" });

    const job = inbox.shift();
    const source = (job.source || "freja_app").toString();
    const message = (job.message || "").toString();

    if (!message.trim()) return res.json({ status: "empty" });

    return res.json({ source, message });
  } catch (e) {
    lastError = { ts: nowTs(), where: "GET /roberta", err: String(e) };
    return res.json({ status: "empty" });
  }
});

// Roberta -> Relay (risposta verso Freja)
app.post("/roberta", (req, res) => {
  try {
    const body = req.body || {};
    const text = (body.text ?? body.message ?? "").toString();

    if (text.trim().length > 0) {
      outbox.push({ ts: nowTs(), text });
      lastEnqueueOutboxOkTs = nowTs();
    }

    return res.json({ ok: true });
  } catch (e) {
    lastError = { ts: nowTs(), where: "POST /roberta", err: String(e) };
    return res.json({ ok: true });
  }
});

app.listen(port, () => {});
