// AUTSYS Relay – compatibilità massima (Freya legacy + Core legacy) senza spam log
// Obiettivo: 1) Freya POST/GET su /mobile  2) Core GET su /roberta  3) Core POST su /roberta
// Instradamento:
//  - GET /mobile   -> outbox Freya (risposte verso Freya)
//  - POST /mobile  -> inbox Roberta (messaggi da Freya verso Roberta)  [anche se Freya manda to:"freya"]
//  - GET /roberta  -> inbox Roberta (messaggi verso Roberta)
//  - POST /roberta -> ROUTING per campo body.to (se to:"freya" -> outbox Freya, altrimenti inbox Roberta)
//  - /             -> compat: GET come /mobile, POST come /roberta

import express from "express";
import fs from "fs";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// Files (Render FS effimero: ok per relay "live")
const INBOX = "inbox.jsonl";            // messaggi verso Roberta
const OUT_FREYA = "outbox_freya.jsonl"; // risposte verso Freya

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

function normTo(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "freya" || s === "roberta") return s;
  return "";
}

// POST generico: decide inbox/outbox in base a "to"
function postRoute(req, res, forceTo /* "roberta" | null */) {
  const body = (req.body && typeof req.body === "object") ? req.body : { raw: req.body };

  const declaredTo = normTo(body.to);
  const to = forceTo || declaredTo || "roberta";

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

// GET: svuota e restituisce una coda
function getQueue(res, which /* "inbox" | "out_freya" */) {
  const content = (which === "inbox") ? popAll(INBOX) : popAll(OUT_FREYA);
  if (content) {
    res.type("application/json").send(content);
  } else {
    res.json({ status: "empty" });
  }
}

// --------- ROUTES ---------

// Freya legacy
app.get("/mobile", (req, res) => getQueue(res, "out_freya"));
app.post("/mobile", (req, res) => postRoute(req, res, "roberta")); // forza verso Roberta

// Core legacy
app.get("/roberta", (req, res) => getQueue(res, "inbox"));
app.post("/roberta", (req, res) => postRoute(req, res, null)); // rispetta body.to (freya/roberta)

// Root compat
app.get("/", (req, res) => getQueue(res, "out_freya"));
app.post("/", (req, res) => postRoute(req, res, null));

app.listen(port, () => {
  console.log(`AUTSYS relay attivo sulla porta ${port}`);
});
