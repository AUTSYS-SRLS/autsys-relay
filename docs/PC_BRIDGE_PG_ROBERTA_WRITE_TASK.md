# AUTSYS PC BRIDGE — TASK: `pg.roberta.write`

## Scopo
Completare il collegamento operativo ChatGPT/Work ↔ AUTSYS PC BRIDGE ↔ PostgreSQL ROBERTA aggiungendo una capacità generale ma governata di scrittura dati.

Il nuovo tool deve chiamarsi **`pg.roberta.write`**.

Non attivare né modificare il bootstrap automatico in questo task.

## Stato già verificato
- PC Bridge installato: `0.1.0.18` al momento della stesura.
- PostgreSQL ROBERTA locale: host `127.0.0.1`, porta `8860`, database `roberta`.
- `pg.roberta.query`: lettura read-only già funzionante.
- `pg.roberta.migrate`: migrazioni additive con backup e guardie già funzionanti.
- `project.register`: tool diretto già implementato e verificato; non usa il migrator.
- Sorgenti Bridge: `D:\AUTSYS\AUTSYS S.R.L.S\CLIENTI\AUTSYS S.R.L.S\05 - AUTSYS PC BRIDGE\AUTSYS PC BRIDGE\src\AUTSYS.PCBridge`.
- File già rilevanti: `PostgresTools.cs`, `Program.cs`, `roberta_db_tool.py`. Leggere sempre lo stato reale prima di modificare.

## Principi obbligatori
1. **Nessun SQL dati arbitrario dal chiamante.** Il chiamante fornisce solo struttura: operazione, schema, tabella, valori, filtri, limiti e opzioni.
2. **DDL separato.** Creazione/modifica di tabelle, colonne, indici e relazioni continua a usare `pg.roberta.migrate`.
3. **Valori sempre parametrizzati.** Identificatori validati e composti con primitive sicure (`psycopg.sql.Identifier` o equivalente). Mai concatenare valori in SQL.
4. **Schema inizialmente ammesso: `public` soltanto.** Non toccare cataloghi PostgreSQL o altri schemi.
5. **Transazione per ogni operazione.** `statement_timeout` e `lock_timeout` coerenti con gli altri tool DB del Bridge.
6. **Privilegio minimo.** Usare un ruolo dedicato, ad esempio `autsys_pc_bridge_data_writer`, normalmente `NOLOGIN`; abilitarlo con password casuale solo per la singola operazione, concedendo solo `SELECT` + il privilegio richiesto sulla sola tabella target e, per INSERT/UPSERT, `USAGE` sulle sole sequenze necessarie. Revocare/disabilitare sempre a fine operazione, anche in errore.
7. **Nessun superuser/createdb/createrole/inherit/replication/bypassrls.** Nessuna membership in altri ruoli.
8. **Aggiornamenti/cancellazioni non massivi per errore.** UPDATE/DELETE richiedono filtri non vuoti e un limite esplicito `maxAffectedRows` (hard cap iniziale 100). Se il precheck trova più righe, rollback senza scrivere.
9. **Verifica post-commit.** Dopo la scrittura, rileggere in connessione read-only i record tramite chiave primaria e verificare il risultato. Per DELETE confermare l'assenza. Se non è possibile una verifica forte, l'operazione deve dichiararlo esplicitamente e non fingere `verified=true`.
10. **Audit dedicato e non alterabile dal writer.** Creare tramite `pg.roberta.migrate` una tabella di audit del Bridge, con almeno: request/idempotency key, timestamp, schema, tabella, operazione, colonne toccate, chiavi primarie coinvolte, numero righe, hash before/after, successo/errore. Non salvare password o segreti. Il writer generale NON deve poter modificare/cancellare la propria tabella audit.
11. **Idempotenza.** Supportare una `idempotencyKey` o usare un identificatore stabile derivato dalla request del Bridge; una ripetizione non deve duplicare l'effetto.
12. **Tabelle protette.** Come minimo impedire al writer generale di scrivere direttamente nelle tabelle di audit/migrazione del Bridge e nei log di migrazione. Prima di definire l'elenco preciso, leggere i nomi reali nel DB; non inventarli. Gli aggiornamenti dello schema/registry restano responsabilità del migrator o di tool dedicati.
13. **Nessun allargamento di `pg.roberta.migrate` per fare normale data write.**
14. **Nessun uso di ROBERTA come intermediario applicativo.** Il Bridge scrive direttamente PostgreSQL sotto governance.

## Contratto funzionale richiesto
Il tool deve supportare almeno:
- `insert`
- `update`
- `delete`
- `upsert`

Argomenti strutturati proposti (adattare ai pattern reali del codice dopo averli letti):

```json
{
  "operation": "insert|update|delete|upsert",
  "schema": "public",
  "table": "nome_tabella",
  "values": {"colonna": "valore"},
  "rows": [{"colonna": "valore"}],
  "filters": [
    {"column": "id", "operator": "eq", "value": 123}
  ],
  "conflictColumns": ["chiave_univoca"],
  "maxAffectedRows": 1,
  "returning": ["id"],
  "idempotencyKey": "..."
}
```

Non è obbligatorio mantenere esattamente questa forma se il pattern reale del Bridge suggerisce una struttura migliore, ma i requisiti di sicurezza sopra sono obbligatori.

Operatori filtro iniziali sufficienti: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `is_null`, `not_null`, `in`. Vietare espressioni SQL fornite come stringhe.

## Migrazione di supporto
Usare `pg.roberta.migrate` per creare le strutture di audit/self-test necessarie. Prima:
- verificare le migrazioni già presenti;
- scegliere un migration ID non esistente;
- fare il backup obbligatorio previsto dal Bridge;
- registrare le nuove tabelle/colonne nei registry ROBERTA usando lo schema reale dei registry, senza inventare colonne.

È accettabile creare una tabella permanente vuota di self-test del writer (es. `autsys_pc_bridge_writer_selftest`) purché sia registrata correttamente e i test lascino **zero righe residue**.

## File locali attesi
Dopo aver letto i sorgenti reali, integrare almeno dove necessario:
- `PostgresTools.cs`: runner + `IBridgeTool` per `pg.roberta.write`.
- `Program.cs`: registrazione tool.
- `roberta_db_tool.py`: operazione strutturata di data write.
- eventuali file di versione/config reali del progetto, solo se necessari.

Non modificare file non necessari.

## Work / Render
Dopo che il tool locale è realmente operativo, aggiornare il gateway/pannello Work affinché esponga `pg.roberta.write` in modo controllato. Il repository remoto è `AUTSYS-SRLS/autsys-relay`, branch `pc-bridge-gateway`; il pannello Work è già protetto e raggiungibile sotto `/work` e l'estensione DB sotto `/work/db`.

Nel pannello, la scrittura dati deve richiedere conferma esplicita. Preferire un form strutturato o un JSON validato lato server; non aggiungere una textarea che invii SQL libero.

## Test obbligatori
1. Compilazione del Bridge: 0 errori; riportare warning eventuali, non nasconderli.
2. Health servizio dopo pubblicazione/riavvio.
3. Verifica privilegi del ruolo writer dopo l'uso: `rolcanlogin=false`, nessun privilegio elevato, nessuna membership.
4. Test INSERT su tabella self-test → `ok=true`, commit, verify.
5. Ripetizione con stessa idempotency key → nessun duplicato.
6. Test UPDATE di una sola riga → verify valori richiesti.
7. Test UPDATE che supererebbe `maxAffectedRows` → rifiutato e nessuna modifica.
8. Test UPSERT → comportamento idempotente verificato.
9. Test DELETE della riga self-test → verify assenza.
10. Audit presente per le operazioni; nessun segreto memorizzato.
11. Test che il writer rifiuti una tabella protetta.
12. Test finale attraverso il servizio Windows `pg.roberta.write`, non solo helper Python diretto.
13. Confermare che `pg.roberta.query`, `pg.roberta.migrate`, `project.register`, file tools e `session.bootstrap` continuino a funzionare.
14. Confermare che il bootstrap automatico NON sia stato attivato/modificato.

## Versione
Leggere il meccanismo di versione reale del Bridge. Se l'aggiunta di un nuovo tool richiede un incremento secondo la convenzione già usata, applicarlo in modo coerente (candidato naturale `0.1.0.19` partendo da `0.1.0.18`), ma non inventare file/versioni se il progetto gestisce la versione diversamente.

## Criterio di chiusura
Il task è chiuso soltanto quando:
- `pg.roberta.write` è presente nei sorgenti;
- compila;
- è pubblicato nel servizio Windows;
- è verificato end-to-end;
- il ruolo writer torna disabilitato dopo l'uso;
- l'audit funziona;
- i test di sicurezza/limite righe passano;
- il pannello Work può invocarlo senza SQL libero;
- è prodotto un riepilogo finale con modifiche e risultati reali.
