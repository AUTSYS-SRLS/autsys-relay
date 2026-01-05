// AUTSYS Relay – versione "OLD" stabilizzata (anti-risposta -1)
// Compatibile con Render
// Filosofia: la core NON si tocca. Il relay decide quando consegnare la risposta a Freya.
// Regola: Freya può inviare più messaggi in sequenza; Roberta li vede tutti.
// La risposta viene CONSEGNATA a Freya solo quando c'è una breve "quiete" dopo l'ultimo input utente.
//
// Endpoints compatibili (legacy):
// - Freya:  POST /mobile   (invio comandi)   | GET /mobile   (lettura risposta)
// - Roberta:GET  /roberta  (lettura comandi) | POST /roberta  (invio risposta)
// - Root:   POST /         (alias)           | GET /          (alias Freya)

import express from "express";
import fs from "fs";

const app = express();
const port = process.env.PORT || 10010;

// Debounce: quanto aspettare dopo l'ultimo messaggio utente prima di consegnare la risposta (ms)
const QUIET_MS = Number(process.env.QUIET_MS || 900);

// File code (Render FS effimero: ok per relay "live")
const INBOX = "inbox.jsonl";   // messaggi verso Roberta
const OUTBOX = "outbox.json";  // 1 risposta "ultima" verso Freya (overwrite)

app.use(express.json({ limit: "1mb" }));

function nowMs() {
  return Date.now();
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

function readAllAndClear(file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const content = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "", "utf8");
    return content;
  }
  return null;
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj), "utf8");
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  if (fs.statSync(file).size <= 0) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function clearFile(file) {
  if (fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
}

// Stato minimo in RAM (per-session, ok)
let lastUserTs = 0;            // ultimo input utente visto dal relay
let lastAssistantTs = 0;       // ultimo output assistant ricevuto
let assistantPending = null;   // ultima risposta ricevuta (non ancora consegnata a Freya)

function isFromFreya(req, body) {
  // Heuristics: compat con i tuoi payload
  if (req.path === "/mobile") return true;
  const src = String(body?.source || body?.from || "").toLowerCase();
  if (src.includes("freya") || src.includes("freja")) return true;
  const role = String(body?.role || "").toLowerCase();
  if (role === "user") return true;
  return false;
}

function isAssistant(body) {
  const role = String(body?.role || "").toLowerCase();
  if (role === "assistant") return true;
  // fallback: se arriva da Roberta di solito non ha "source" freya
  return false;
}

// --------- POST ---------
// Freya invia comandi -> INBOX
function postFromFreya(req, res) {
  const body = (req.body && typeof req.body === "object") ? req.body : { raw: req.body };
  lastUserTs = nowMs();
  appendLine(INBOX, body);
  res.json({ status: "queued", to: "roberta", ts: nowMs() });
}

// Roberta invia risposta -> OUTBOX (pendente, overwrite)
function postFromRoberta(req, res) {
  const body = (req.body && typeof req.body === "object") ? req.body : { raw: req.body };

  // Se per qualche ragione Freya usa /roberta, trattalo come input utente
  if (isFromFreya(req, body)) {
    return postFromFreya(req, res);
  }

  // Risposta di Roberta: la memorizziamo come "ultima" (overwrite)
  assistantPending = body;
  lastAssistantTs = nowMs();
  writeJson(OUTBOX, assistantPending);

  res.json({ status: "queued", to: "freya", ts: nowMs() });
}

// Alias root POST: se arriva da Freya -> inbox, altrimenti -> outbox
function postRoot(req, res) {
  const body = (req.body && typeof req.body === "object") ? req.body : { raw: req.body };
  if (isFromFreya(req, body)) return postFromFreya(req, res);
  return postFromRoberta(req, res);
}

app.post("/mobile", postFromFreya);
app.post("/roberta", postFromRoberta);
app.post("/", postRoot);

// --------- GET ---------
// Roberta legge inbox (svuota)
app.get("/roberta", (req, res) => {
  const content = readAllAndClear(INBOX);
  if (content) {
    res.type("application/json").send(content);
  } else {
    res.json({ status: "empty" });
  }
});

// Freya legge outbox SOLO se è passato QUIET_MS dall'ultimo input utente
function getForFreya(req, res) {
  const sinceUser = nowMs() - lastUserTs;

  // Se non è passata quiescenza, non consegnare nulla (evita risposta al messaggio precedente)
  if (lastUserTs > 0 && sinceUser < QUIET_MS) {
    return res.json({ status: "empty" });
  }

  // Leggi l'ultima risposta (overwrite)
  const obj = assistantPending || readJson(OUTBOX);
  if (obj) {
    // Consegna UNA volta e svuota
    assistantPending = null;
    clearFile(OUTBOX);
    return res.type("application/json").send(JSON.stringify(obj));
  }

  return res.json({ status: "empty" });
}

app.get("/mobile", getForFreya);
app.get("/", getForFreya);

app.listen(port, () => {
  console.log(`AUTSYS relay attivo sulla porta ${port}`);
});
