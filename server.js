// AUTSYS Relay – basato su OLD, con controllo anti-ritardo
// Obiettivo: nessun "messaggio -1", zero log spam (no ping visibile)
// Compatibilità endpoint: /, /mobile, /roberta
// Logica: inbox (verso Roberta) separato da outbox_freya (verso Freya)

import express from "express";
import fs from "fs";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// File code (Render FS effimero: ok per relay "live")
const INBOX = "inbox.jsonl";            // messaggi DIRETTI a Roberta
const OUT_FREYA = "outbox_freya.jsonl"; // risposte DIRETTE a Freya

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

function popAll(file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    const content = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "", "utf8");
    return content;
  }
  return null;
}

// -------------------------
// POST
// -------------------------
// /roberta  : messaggi verso Roberta (inbox)
// /mobile   : messaggi verso Freya (outbox_freya)
// /         : legacy -> se body.to==="freya" va in outbox_freya, altrimenti inbox
function handlePost(req, res, forceTo = null) {
  const body = (req.body && typeof req.body === "object") ? req.body : { raw: req.body };

  // Destinazione
  const to =
    (forceTo || String(body.to || "").toLowerCase().trim() || "roberta");

  const envelope = {
    ...body,
    to,
    ts: body.ts || Date.now(),
  };

  if (to === "freya") {
    appendLine(OUT_FREYA, envelope);
    res.json({ status: "queued", to: "freya", ts: Date.now() });
  } else {
    appendLine(INBOX, envelope);
    res.json({ status: "queued", to: "roberta", ts: Date.now() });
  }
}

app.post("/", (req, res) => handlePost(req, res, null));
app.post("/roberta", (req, res) => handlePost(req, res, "roberta"));
app.post("/mobile", (req, res) => handlePost(req, res, "freya"));

// -------------------------
// GET
// -------------------------
// /roberta : Roberta legge SOLO l'inbox (messaggi verso Roberta)
// /mobile  : Freya legge SOLO la sua outbox
// /        : legacy -> Freya outbox
function handleGet(req, res, which) {
  let content = null;

  if (which === "inbox") content = popAll(INBOX);
  if (which === "out_freya") content = popAll(OUT_FREYA);

  if (content) {
    res.type("application/json").send(content);
  } else {
    res.json({ status: "empty" });
  }
}

app.get("/", (req, res) => handleGet(req, res, "out_freya"));
app.get("/mobile", (req, res) => handleGet(req, res, "out_freya"));
app.get("/roberta", (req, res) => handleGet(req, res, "inbox"));

app.listen(port, () => {
  console.log(`AUTSYS relay attivo sulla porta ${port}`);
});
