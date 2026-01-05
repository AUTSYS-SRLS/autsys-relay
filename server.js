// AUTSYS Relay – queue per-destinazione (fix: niente più messaggi "-1")
// Compatibile con Render
// Compatibilità endpoint legacy: /mobile, /roberta, /freya

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

const QDIR = "queue";

function ensureQueueDir() {
  if (!fs.existsSync(QDIR)) fs.mkdirSync(QDIR, { recursive: true });
}

function qfile(who) {
  return path.join(QDIR, `${who}.jsonl`);
}

function safeWho(v, fallback) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "freya" || s === "roberta") return s;
  return fallback;
}

function handlePost(req, res) {
  ensureQueueDir();

  const body = req.body || {};
  const to = safeWho(body.to, "roberta");
  const client_msg_id = body.client_msg_id || crypto.randomUUID();

  const envelope = {
    ...body,
    to,
    client_msg_id,
    ts: body.ts || Date.now(),
  };

  fs.appendFileSync(qfile(to), JSON.stringify(envelope) + "\n", "utf8");
  res.json({ status: "queued", to, client_msg_id, ts: Date.now() });
}

function handleGet(req, res, whoOverride = null) {
  ensureQueueDir();

  const who = whoOverride || safeWho(req.query.who, "freya");
  const f = qfile(who);

  if (fs.existsSync(f) && fs.statSync(f).size > 0) {
    const content = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, "", "utf8");
    res.type("application/json").send(content);
  } else {
    res.json({ status: "empty", who });
  }
}

// Modern endpoints
app.post("/", handlePost);
app.get("/", (req, res) => handleGet(req, res));

// Legacy endpoint used by Freya (observed): /mobile
app.post("/mobile", handlePost);
app.get("/mobile", (req, res) => handleGet(req, res));

// Legacy endpoints used by Core (observed): /roberta and /freya
app.post("/roberta", handlePost);
app.get("/roberta", (req, res) => handleGet(req, res, "roberta"));

app.post("/freya", handlePost);
app.get("/freya", (req, res) => handleGet(req, res, "freya"));

app.listen(port, () => {
  console.log(`AUTSYS relay attivo sulla porta ${port}`);
});
