# AUTSYS PC BRIDGE — MASTER TASK

Eseguire entrambi i task seguenti sul PC reale, uno dopo l'altro, leggendo prima lo stato reale dei sorgenti locali e senza inventare implementazioni:

1. `docs/PC_BRIDGE_PRIVILEGED_UPDATER_TASK.md`
2. `docs/PC_BRIDGE_AUTOMATIC_SESSION_BOOTSTRAP_TASK.md`

## Stato di partenza verificato

- AUTSYS PC BRIDGE locale: versione 0.1.0.19.
- `pg.roberta.write`: collaudato end-to-end per INSERT, UPDATE, DELETE, UPSERT, idempotenza, limiti, audit e disabilitazione ruolo.
- `project.register`: tool diretto locale già implementato.
- Gateway/Work: online su Render.
- Il bootstrap automatico non era ancora attivo nella versione locale al momento del verbale di chiusura precedente.

## Ordine di lavoro

### Fase A — Updater privilegiato permanente

- Studiare sorgenti e installer reali del Bridge.
- Implementare il servizio/helper privilegiato ristretto secondo `PC_BRIDGE_PRIVILEGED_UPDATER_TASK.md`.
- Preparare tutto per ridurre l'intervento dell'utente a una singola installazione UAC iniziale.
- Non introdurre shell arbitraria.
- Verificare backup, rollback, hash, idempotenza e audit.
- Dopo l'installazione iniziale, dimostrare un aggiornamento del Bridge senza CMD/PowerShell amministratore dell'utente.

### Fase B — Bootstrap automatico

- Studiare il codice reale del gateway già aggiornato sul branch `pc-bridge-gateway`.
- Verificare il nuovo `work-bootstrap-front.js` e il routing di `launcher.js`.
- Completare il lato locale/shared di `session.bootstrap` solo se necessario.
- Correggere il vecchio fallback gateway di `project.register` se ancora presente: `project.register` deve arrivare al tool diretto locale, mai a `pg.roberta.migrate`.
- Testare bootstrap GENERAL automatico all'apertura Work.
- Testare bootstrap PROJECT per `AUTSYS PC BRIDGE`.
- Preparare l'istruzione di progetto minima da inserire una sola volta nelle impostazioni del progetto ChatGPT, affinché Work apra il bootstrap PROJECT prima di operare sul PC.

## Vincoli assoluti

- Non usare ROBERTA come intermediario applicativo per operazioni che il Bridge può eseguire direttamente.
- Non usare `pg.roberta.migrate` come sostituto di `project.register`.
- Non consentire SQL libero nel writer dati.
- Non allargare le policy del migrator per aggirare un rifiuto.
- Non introdurre una shell remota generale.
- Mantenere privilegi minimi, backup, rollback, audit e verifiche reali.
- Non dichiarare completato un test non realmente eseguito.

## Consegna finale

Produrre un verbale unico con:
- file modificati;
- versioni;
- hash principali;
- servizi Windows creati/modificati;
- eventuale unica azione UAC richiesta all'utente;
- test updater reali;
- test bootstrap GENERAL e PROJECT reali;
- prova che un update successivo non richiede CMD amministratore;
- prova che `project.register` non passa dal migrator;
- limiti di piattaforma ChatGPT eventualmente residui, distinti dai limiti AUTSYS.
