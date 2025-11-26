// AUTSYS Relay – versione Node.js compatibile con Render (SCAMBIO INCROCIATO)
import express from "express";
import fs from "fs";
const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

// File usati come "caselle postali"
const inbox_roberta = "inbox_roberta.json";   // Messaggi destinati a Roberta
const inbox_freya   = "inbox_freya.json";     // Messaggi destinati a Freya

//-------------------------------------------
// 1) FREYA → RELAY → ROBERTA
//-------------------------------------------
app.post("/mobile", (req, res) => {
    const data = JSON.stringify(req.body);

    // Accoda messaggio per Roberta
    fs.appendFileSync(inbox_roberta, data + "\n", "utf8");

    res.json({ status: "received_by_relay", to: "roberta", ts: Date.now() });
});

//-------------------------------------------
// 2) ROBERTA → RELAY → FREYA
//-------------------------------------------
app.post("/roberta", (req, res) => {
    const data = JSON.stringify(req.body);

    // Accoda messaggio per Freya
    fs.appendFileSync(inbox_freya, data + "\n", "utf8");

    res.json({ status: "received_by_relay", to: "freya", ts: Date.now() });
});

//-------------------------------------------
// 3) ROBERTA chiede se ci sono messaggi per lei (GET)
//-------------------------------------------
app.get("/roberta", (req, res) => {
    if (fs.existsSync(inbox_roberta) && fs.statSync(inbox_roberta).size > 0) {
        const content = fs.readFileSync(inbox_roberta, "utf8");
        fs.writeFileSync(inbox_roberta, "", "utf8");
        res.type("application/json").send(content);
    } else {
        res.json({ status: "empty" });
    }
});

//-------------------------------------------
// 4) FREYA chiede se ci sono messaggi per lei (GET)
//-------------------------------------------
app.get("/mobile", (req, res) => {
    if (fs.existsSync(inbox_freya) && fs.statSync(inbox_freya).size > 0) {
        const content = fs.readFileSync(inbox_freya, "utf8");
        fs.writeFileSync(inbox_freya, "", "utf8");
        res.type("application/json").send(content);
    } else {
        res.json({ status: "empty" });
    }
});

//-------------------------------------------
app.listen(port, () => {
    console.log(`AUTSYS relay attivo sulla porta ${port}`);
});
