// AUTSYS Relay – Freja 2.2.6 + Roberta Core (compat + queue)
// - Freja usa /mobile (POST + polling GET)
// - Roberta usa /roberta (polling GET per leggere inbox; POST per scrivere outbox)
// Obiettivo: risposte SEMPRE immediate ai polling di Freja, senza blocchi e senza debounce.
//
// NOTE:
// - Nessuna logica "smart" qui: solo coda FIFO affidabile.
// - Formati JSON coerenti con Freja 2.2.6 (status/text) e Roberta Core (status/ source/message).

import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// -----------------------------------------------------------------------------
// Storage su filesystem (Render: ephemerals, ma va bene per la sessione live)
// -----------------------------------------------------------------------------
const DATA_DIR = process.env.RELAY_DATA_DIR || ".";
const INBOX_FILE = path.join(DATA_DIR, "inbox_queue.jsonl");   // Freja -> Roberta
const OUTBOX_FILE = path.join(DATA_DIR, "outbox_queue.jsonl"); // Roberta -> Freja

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function safeReadLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return lines;
  } catch {
    return [];
  }
}

function safeAppendLine(filePath, obj) {
  const line = JSON.stringify(obj);
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

function popFirstJson(filePath) {
  // Ritorna il primo oggetto JSON dalla coda (FIFO) e riscrive il file col resto.
  // Se vuoto -> null
  const lines = safeReadLines(filePath);
  if (lines.length === 0) return null;

  const first = lines[0];
  const rest = lines.slice(1);

  try {
    const obj = JSON.parse(first);
    fs.writeFileSync(filePath, rest.join("\n") + (rest.length ? "\n" : ""), "utf8");
    return obj;
  } catch {
    // Se una riga è corrotta, la scarto e continuo ricorsivamente
    fs.writeFileSync(filePath, rest.join("\n") + (rest.length ? "\n" : ""), "utf8");
    return popFirstJson(filePath);
  }
}

// -----------------------------------------------------------------------------
// HEALTH
// -----------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "AUTSYS_RELAY", ts: nowTs() });
});

// -----------------------------------------------------------------------------
// FREJA ENDPOINT – /mobile
// -----------------------------------------------------------------------------

// Freja invia un messaggio a Roberta
app.post("/mobile", (req, res) => {
  try {
    const body = req.body || {};
    const message = (body.message ?? body.text ?? "").toString();

    // Accetta anche payload vuoti, ma non li accoda
    if (message.trim().length > 0) {
      safeAppendLine(INBOX_FILE, {
        ts: nowTs(),
        source: body.source || "freja_app",
        message: message
      });
    }

    // IMPORTANTISSIMO: Freja 2.2.6 si aspetta risposta immediata con status
    res.json({ status: "received_by_relay" });
  } catch (e) {
    // Anche in errore: rispondi subito per evitare fallback strani
    res.json({ status: "received_by_relay" });
  }
});

// Freja polla per messaggi di Roberta
app.get("/mobile", (req, res) => {
  try {
    const msg = popFirstJson(OUTBOX_FILE);

    if (!msg) {
      // Freja gestisce empty/processing/received_by_relay
      return res.json({ status: "empty" });
    }

    // Freja 2.2.6 cerca json["text"]
    const text = (msg.text ?? msg.message ?? "").toString().trim();
    if (!text) {
      return res.json({ status: "empty" });
    }

    return res.json({ text });
  } catch (e) {
    return res.json({ status: "empty" });
  }
});

// -----------------------------------------------------------------------------
// ROBERTA ENDPOINT – /roberta
// -----------------------------------------------------------------------------

// Roberta polla per messaggi provenienti da Freja
app.get("/roberta", (req, res) => {
  try {
    const job = popFirstJson(INBOX_FILE);

    if (!job) {
      // Roberta core controlla '"status":"empty"' dentro r.text
      return res.json({ status: "empty" });
    }

    // Formato atteso da Roberta: dict con source/message
    const source = (job.source || "freja_app").toString();
    const message = (job.message || "").toString();

    if (!message.trim()) {
      return res.json({ status: "empty" });
    }

    return res.json({ source, message });
  } catch (e) {
    return res.json({ status: "empty" });
  }
});

// Roberta invia risposta a Freja
app.post("/roberta", (req, res) => {
  try {
    const body = req.body || {};
    const text = (body.text ?? body.message ?? "").toString();

    if (text.trim().length > 0) {
      safeAppendLine(OUTBOX_FILE, { ts: nowTs(), text: text });
    }

    // Risposta veloce: Roberta non deve mai restare in attesa
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: true });
  }
});

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------
app.listen(port, () => {
  console.log(`AUTSYS relay attivo sulla porta ${port}`);
  console.log(`- Freja  → /mobile`);
  console.log(`- Roberta→ /roberta`);
});
