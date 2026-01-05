// AUTSYS Relay – queue per-destinazione (fix: niente più messaggi "-1")
// Compatibilità: supporta anche /mobile (Freya legacy) senza cambiare l'app
// Compatibile con Render

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// Directory code+data (Render: filesystem effimero, ok per relay "live")
const QDIR = "queue";
if (!fs.existsSync(QDIR)) fs.mkdirSync(QDIR);

// File coda per destinatario
function qfile(who) {
  return path.join(QDIR, `${who}.jsonl`);
}

function safeWho(x, fallback) {
  const s = String(x || "").trim().toLowerCase();
  if (s === "freya" || s === "roberta") return s;
  return fallback;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

// ---------------------------
// HANDLERS (riusati su / e /mobile)
// ---------------------------

// POST: accoda messaggi per "to"
function postHandler(req, res) {
  const body = req.body || {};
  const to = safeWho(body.to, "roberta"); // default: verso Roberta
  const client_msg_id = body.client_msg_id || uuid();

  const envelope = {
    ...body,
    to,
    client_msg_id,
    ts: body.ts || Date.now(),
  };

  fs.appendFileSync(qfile(to), JSON.stringify(envelope) + "\n", "utf8");

  // ACK immediato
  res.json({ status: "queued", to, client_msg_id, ts: Date.now() });
}

// GET: leggi messaggi destinati a "who" e svuota la sua coda
// Uso:
//  - Freya:   GET /?who=freya
//  - Roberta: GET /?who=roberta
function getHandler(req, res) {
  const who = safeWho(req.query.who, "freya"); // default: freya
  const file = qfile(who);

  if (!fs.existsSync(file)) {
    res.json({ status: "ok", who, messages: [] });
    return;
  }

  const raw = fs.readFileSync(file, "utf8").trim();
  fs.writeFileSync(file, "", "utf8"); // svuota

  if (!raw) {
    res.json({ status: "ok", who, messages: [] });
    return;
  }

  const messages = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  res.json({ status: "ok", who, messages });
}

// ---------------------------
// ROUTES
// ---------------------------

// Nuove route
app.post("/", postHandler);
app.get("/", getHandler);

// Compatibilità legacy: Freya vecchia chiama /mobile
app.post("/mobile", postHandler);
app.get("/mobile", getHandler);

// Health
app.get("/health", (_req, res) => res.send("OK"));

app.listen(port, () => {
  console.log(`AUTSYS Relay listening on port ${port}`);
});
