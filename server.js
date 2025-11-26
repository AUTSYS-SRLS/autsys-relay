// AUTSYS Relay – versione Node.js compatibile con Render
import express from "express";
import fs from "fs";
const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// Percorsi dei file
const inbox = "inbox.json";
const outbox = "outbox.json";

// Riceve comandi (POST)
app.post("/", (req, res) => {
  const data = JSON.stringify(req.body);
  fs.appendFileSync(inbox, data + "\n", "utf8");
  res.json({ status: "received", ts: Date.now() });
});

// Roberta chiede aggiornamenti (GET)
app.get("/", (req, res) => {
    if (fs.existsSync(outbox) && fs.statSync(outbox).size > 0) {
        const content = fs.readFileSync(outbox, "utf8");
        fs.writeFileSync(outbox, "", "utf8");
        res.type("application/json").send(content);
    } else {
        res.json({ status: "empty" });
    }
});

// Freja (mobile) chiede aggiornamenti (GET)
app.get("/mobile", (req, res) => {
    if (fs.existsSync(outbox) && fs.statSync(outbox).size > 0) {
        const content = fs.readFileSync(outbox, "utf8");
        fs.writeFileSync(outbox, "", "utf8");
        res.type("application/json").send(content);
    } else {
        res.json({ status: "empty" });
    }
});

app.listen(port, () => {
  console.log(`AUTSYS relay attivo sulla porta ${port}`);

});

