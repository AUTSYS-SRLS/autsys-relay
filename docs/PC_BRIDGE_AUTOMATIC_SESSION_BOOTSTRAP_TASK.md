# AUTSYS PC BRIDGE — TASK: BOOTSTRAP AUTOMATICO DI SESSIONE

## Obiettivo
Portare `session.bootstrap` da funzione manuale a flusso automatico e affidabile per le sessioni ChatGPT/Work che usano AUTSYS PC BRIDGE.

Il bootstrap deve ricostruire prima possibile il contesto ROBERTA e le capacità reali disponibili, senza inventare dati e senza usare il bootstrap per aggirare le policy dei tool sottostanti.

## Stato noto da verificare prima di modificare

- Esiste già `session.bootstrap` lato gateway come orchestrazione di query ROBERTA.
- Il pannello Work espone attualmente un pulsante `session.bootstrap`, ma il percorso Work chiama `/api/execute` del backend; verificare se il Bridge locale espone davvero `session.bootstrap`. Non assumere che il pulsante funzioni solo perché è presente nella UI.
- Il tool locale `project.register` esiste ed è diretto sul PostgreSQL ROBERTA. NON usare il vecchio fallback gateway che costruisce INSERT SQL tramite `pg.roberta.migrate`.
- `pg.roberta.query`, `pg.roberta.write`, `pg.roberta.migrate` e `project.register` hanno governance separate e vanno mantenute separate.

## Requisiti funzionali

### 1. Un'unica implementazione autoritativa di session.bootstrap
Evitare due implementazioni divergenti.

Preferenza: rendere `session.bootstrap` un tool diretto del Bridge oppure spostare l'orchestrazione nel backend condiviso in modo che sia raggiungibile sia da Work sia dagli altri client autorizzati.

Il risultato deve includere almeno:
- scope: GENERAL o PROJECT;
- progetto richiesto e projectKey normalizzata quando PROJECT;
- stato registrazione progetto;
- entityKind/lifecycle/authoritative quando disponibili;
- capacità plugin ROBERTA abilitate;
- capacità esterne abilitate;
- capability level, risk level, requiresApproval e verification status ove presenti;
- conteggi e stato sorgente;
- timestamp/versione schema/bootstrap;
- eventuali campi mancanti realmente non deducibili.

### 2. Registrazione progetto
Se scope=PROJECT e il progetto non è registrato:
- NON registrare inventando `entityKind`;
- restituire `registration.required=true` con i soli campi realmente mancanti;
- quando i dati necessari sono disponibili, usare esclusivamente il tool diretto `project.register` del Bridge;
- rifare bootstrap dopo registrazione e verificare `project.found=true`.

### 3. Bootstrap automatico nel pannello Work
Quando una sessione browser Work AUTSYS viene autenticata/aperta:
- eseguire automaticamente almeno un bootstrap GENERAL e mostrarne chiaramente l'esito nella pagina;
- non richiedere all'utente di premere manualmente il pulsante BOOTSTRAP per ottenere il contesto base;
- mantenere il pulsante manuale solo come diagnostica/riprova.

Per PROJECT, supportare un ingresso esplicito e persistente, ad esempio:
`/work?scope=PROJECT&projectName=<nome>`
oppure un path equivalente sicuro.

Il nome progetto deve essere validato e non deve diventare SQL libero.
La sessione può ricordare il contesto progetto mediante cookie/sessione firmata, ma non deve confondere progetti diversi.

### 4. Limite di piattaforma da rispettare
Il Bridge/gateway non può autonomamente conoscere il nome del progetto ChatGPT corrente se ChatGPT non glielo trasmette. Non fingere di poterlo dedurre da IP, browser, referrer o altri segnali non affidabili.

Per ottenere il comportamento "prima della prima risposta" dentro un ChatGPT Project, predisporre una istruzione di progetto minima e stabile che dica a Work di aprire l'endpoint bootstrap del relativo progetto prima di procedere con attività PC. Le istruzioni del progetto sono il punto corretto per fornire il nome del progetto al Bridge.

Preparare il testo esatto dell'istruzione da inserire una sola volta nelle impostazioni del progetto. Non richiedere all'utente di ripeterla in ogni chat.

### 5. Sessioni GENERAL
Predisporre un endpoint/landing GENERAL che effettui automaticamente bootstrap GENERAL all'apertura.
Preparare anche una istruzione globale opzionale equivalente, se il prodotto ChatGPT consente all'utente di configurarla. Non dichiarare che è stata impostata se non è stato possibile modificarla realmente.

### 6. Sicurezza
- nessun SQL libero aggiuntivo;
- nessuna shell;
- nessun segreto mostrato nella pagina;
- sessione Work firmata e HttpOnly/Secure/SameSite;
- rate limit/riduzione replay dove opportuno;
- timeout e messaggi errore chiari;
- bootstrap deve essere read-only salvo chiamata separata e governata a project.register quando esplicitamente necessaria.

## Correzione obbligatoria del gateway project.register
Nel codice gateway corrente verificare se `front-gateway.js` intercetta `project.register` con una vecchia implementazione basata su `pg.roberta.migrate`.
Se sì:
- rimuovere/disattivare quel percorso;
- inoltrare `project.register` direttamente al tool locale del Bridge;
- testare che nessuna registrazione progetto utilizzi `pg.roberta.migrate`.

## Test obbligatori

1. `session.bootstrap GENERAL` end-to-end da Work senza click manuale dopo login/apertura.
2. `session.bootstrap PROJECT` su AUTSYS PC BRIDGE con progetto esistente.
3. progetto sconosciuto: `registration.required=true`, nessuna scrittura automatica con entityKind inventato.
4. registrazione di progetto di test tramite tool locale diretto + re-bootstrap.
5. verificare che il gateway non usi migrate per project.register.
6. nuova sessione Work con contesto PROJECT persistente: bootstrap eseguito automaticamente e progetto corretto.
7. nessun leakage di token/segreti nei log o nella pagina.
8. regressione: health, file tools, pg.roberta.query/write/migrate e project.register ancora funzionanti secondo le loro policy.

## Criterio di chiusura
Il lato AUTSYS è chiuso quando l'apertura della landing Work autenticata esegue automaticamente il bootstrap corretto e quando il contesto PROJECT può essere fornito una sola volta tramite istruzione/progetto, senza ripetere comandi manuali in ogni chat.

Non dichiarare possibile l'esecuzione "prima della prima risposta" in una normale chat ChatGPT se il prodotto non invoca automaticamente strumenti esterni prima del modello. In quel caso documentare con precisione il limite prodotto e usare le istruzioni di progetto + Work come trigger supportato.
