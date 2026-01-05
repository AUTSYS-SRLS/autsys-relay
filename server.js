// AUTSYS Relay – queue per-destinazione (fix: niente più messaggi "-1")
// Compatibile con Render

import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// Request log (per debug: Freya/Roberta hitting which endpoint)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});


// Directory code+data (Render: filesystem effimero, ok per relay "live")
const QDIR = "queue";

function ensureQueueDir() {
  if (!fs.existsSync(QDIR)) fs.mkdirSync(QDIR, { recursive: true });
}

function qfile(who) {
  // who: "freya" | "roberta"
  return path.join(QDIR, `${who}.jsonl`);
}

function safeWho(v, fallback) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "freya" || s === "roberta") return s;
  return fallback;
}

// POST: invio messaggio verso un destinatario (to)
// Richiesta consigliata:
//  - Freya -> Roberta: {"to":"roberta","client_msg_id":"uuid","conversation_id":"...","text":"..."}
//  - Roberta -> Freya: {"to":"freya","in_reply_to":"<client_msg_id_freya>","text":"..."}
app.post("/", (req, res) => {
  ensureQueueDir();

  const body = req.body || {};
  const to = safeWho(body.to, "roberta");

  // Se Freya non manda un client_msg_id, lo generiamo qui e lo ritorniamo come ACK
  const client_msg_id = body.client_msg_id || crypto.randomUUID();

  const envelope = {
    ...body,
    to,
    client_msg_id,
    ts: body.ts || Date.now(),
  };

  fs.appendFileSync(qfile(to), JSON.stringify(envelope) + "\n", "utf8");

  // ACK immediato
  res.json({ status: "queued", to, client_msg_id, ts: Date.now() });
});

// GET: leggi messaggi destinati a "who" e svuota la sua coda
// Uso:
//  - Freya:   GET /?who=freya
//  - Roberta: GET /?who=roberta
app.get("/", (req, res) => {
  ensureQueueDir();

  const who = safeWho(req.query.who, "freya");
  const f = qfile(who);

  if (fs.existsSync(f) && fs.statSync(f).size > 0) {
    const content = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, "", "utf8");
    res.type("application/json").send(content);
  } else {
    res.json({ status: "empty", who });
  }
});

app.listen(port, () => {
  console.log(`AUTSYS relay attivo sulla porta ${port}`);
});
