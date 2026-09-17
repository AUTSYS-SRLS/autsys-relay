# AUTSYS PC BRIDGE — TASK: PRIVILEGED UPDATER PERMANENTE

## Obiettivo
Eliminare la necessità di aprire CMD/PowerShell come amministratore per ogni futuro aggiornamento di AUTSYS PC BRIDGE.

L'utente deve effettuare al massimo UNA installazione/elevazione iniziale del componente privilegiato. Dopo tale bootstrap amministrativo, gli aggiornamenti del Bridge devono poter essere eseguiti in autonomia attraverso il normale flusso autorizzato ChatGPT Work -> Gateway -> PC Bridge -> Updater, senza shell arbitraria e senza richieste ricorrenti di CMD amministratore.

## Vincoli architetturali

1. Creare un componente separato dal Bridge principale, preferibilmente servizio Windows dedicato:
   - nome prodotto: AUTSYS PC BRIDGE Updater
   - nome servizio suggerito: AUTSYS_PC_BRIDGE_UPDATER
   - esecuzione con account Windows sufficientemente privilegiato per arrestare/avviare AUTSYS_PC_BRIDGE_API e sostituire i file runtime del Bridge.

2. Il servizio updater NON deve essere una shell remota e NON deve accettare comandi arbitrari.

3. Deve accettare esclusivamente richieste di aggiornamento strutturate con almeno:
   - productId fisso AUTSYS_PC_BRIDGE;
   - versione corrente attesa;
   - versione destinazione;
   - percorso staging sotto una radice AUTSYS autorizzata;
   - manifest dei file con SHA-256;
   - identificativo univoco richiesta;
   - timestamp/scadenza;
   - firma/autenticazione della richiesta secondo le primitive realmente disponibili nel progetto.

4. Protezioni obbligatorie:
   - allowlist dei soli servizi e percorsi AUTSYS PC BRIDGE modificabili;
   - rifiuto path traversal, UNC non autorizzati, symlink/reparse point pericolosi e destinazioni fuori radice;
   - nessun parametro può diventare nome di servizio Windows arbitrario;
   - nessun comando shell fornito dal chiamante;
   - nessun eseguibile esterno arbitrario;
   - verifica hash prima di applicare;
   - backup pre-update obbligatorio;
   - rollback automatico in caso di errore di copia, avvio o health check;
   - audit locale append-only dei tentativi e degli esiti;
   - idempotenza per requestId/updateId.

5. Flusso update richiesto:
   a. Bridge/Work prepara i file in STAGING.
   b. Updater valida manifest/autorizzazione/versione/hash.
   c. Crea backup completo dei file che saranno sostituiti.
   d. Arresta AUTSYS_PC_BRIDGE_API.
   e. Sostituisce atomicamente i file consentiti.
   f. Riavvia AUTSYS_PC_BRIDGE_API.
   g. Verifica health e versione attesa.
   h. Se health/versione falliscono, arresta, ripristina backup, riavvia e verifica rollback.
   i. Registra audit finale.

6. Il Bridge principale deve esporre un tool dedicato e ristretto, suggerito:
   - `bridge.update.apply`
   oppure nome equivalente coerente con il progetto.
   Il tool NON deve prendere SQL o shell. Deve soltanto inviare una richiesta strutturata all'Updater.

7. Trasporto locale Bridge -> Updater:
   Preferire un canale locale non esposto in rete (Named Pipe Windows con ACL restrittiva oppure loopback autenticato con secret locale protetto). Non aprire una porta pubblica.

8. Installazione iniziale:
   - produrre un installer/script AUTSYS che installi e avvii una sola volta il servizio privilegiato;
   - richiedere elevazione UAC solo in questa fase iniziale;
   - dopo l'installazione, verificare automaticamente servizio, ACL, health e capacità di update in dry-run;
   - evitare di chiedere all'utente di digitare comandi amministrativi se è possibile fornire un unico eseguibile/script avviabile con UAC.

9. Aggiornamento dell'Updater stesso:
   Deve essere previsto un meccanismo sicuro. Se l'Updater non può sostituire se stesso direttamente, usare una strategia side-by-side/versionata o un helper minimale; non introdurre shell arbitraria.

10. Versioning:
   Non modificare la versione del Bridge finché non è necessario per una release reale. Leggere lo stato reale dei sorgenti prima di decidere il nuovo numero.

## Test obbligatori

- servizio Updater installato e RUNNING;
- canale locale accessibile solo dal contesto previsto;
- richiesta non autorizzata rifiutata;
- path fuori radice rifiutato;
- hash errato rifiutato;
- nome servizio arbitrario impossibile;
- dry-run riuscito;
- aggiornamento reale di un file innocuo/versionato o release di test;
- arresto e riavvio del Bridge riusciti senza CMD dell'utente;
- health finale OK e versione attesa;
- test di rollback forzato;
- replay stessa requestId idempotente;
- audit privo di secret/token/password.

## Criterio di chiusura
Il task è chiuso solo quando, dopo la singola installazione privilegiata iniziale, una successiva modifica controllata del Bridge può essere applicata end-to-end senza che l'utente apra CMD/PowerShell amministratore.
