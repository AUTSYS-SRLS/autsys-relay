import express from "express";
import fs from "fs";

const app = express();
const port = process.env.PORT || 10010;

app.use(express.json({ limit: "1mb" }));

const inbox_roberta = "inbox_roberta.json";   // Freja → Roberta
const inbox_freya   = "inbox_freya.json";     // Roberta → Freja

//-----------------------------------------------------------
// 1) FREJA → RELAY → ROBERTA
//-----------------------------------------------------------
app.post("/mobile", (req, res) => {
    const line = JSON.stringify(req.body);

    fs.appendFileSync(inbox_roberta, line + "\n", "utf8");

    res.json({ status: "received_by_relay", to: "roberta", ts: Date.now() });
});

//-----------------------------------------------------------
// 2) ROBERTA → RELAY → FREJA
//-----------------------------------------------------------
app.post("/roberta", (req, res) => {
    const line = JSON.stringify(req.body);

    fs.appendFileSync(inbox_freya, line + "\n", "utf8");

    res.json({ status: "received_by_relay", to: "freja", ts: Date.now() });
});

//-----------------------------------------------------------
// 3) ROBERTA chiede messaggi
//-----------------------------------------------------------
app.get("/roberta", (req, res) => {

    if (fs.existsSync(inbox_roberta) && fs.statSync(inbox_roberta).size > 0) {

        let lines = fs.readFileSync(inbox_roberta, "utf8")
                      .split("\n")
                      .filter(l => l.trim() !== "");

        fs.writeFileSync(inbox_roberta, "", "utf8");

        res.type("application/json").send(lines.join("\n"));
    } 
    else {
        res.json({ status: "empty" });
    }
});

//-----------------------------------------------------------
// 4) FREJA chiede messaggi (FIX: prendi SOLO la prima risposta)
//-----------------------------------------------------------
app.get("/mobile", (req, res) => {

    if (fs.existsSync(inbox_freya) && fs.statSync(inbox_freya).size > 0) {

        let lines = fs.readFileSync(inbox_freya, "utf8")
                      .split("\n")
                      .filter(l => l.trim() !== "");

        let first = lines.length > 0 ? lines[0] : "";

        fs.writeFileSync(inbox_freya, "", "utf8");  // 🔥 Pulisce davvero

        res.type("application/json").send(first);
    } 
    else {
        res.json({ status: "empty" });
    }
});

//-----------------------------------------------------------
app.listen(port, () => {
    console.log(`AUTSYS relay attivo sulla porta ${port}`);
});
