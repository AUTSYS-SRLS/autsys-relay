# AUTSYS PC BRIDGE V2 — MCP indipendente (staging)

Data: 16 novembre 2026. Branch: `bridge-v2-mcp-independent-20261116`.

## Obiettivo
Esporre un endpoint **MCP Streamable HTTP** dedicato alla V2 sul gateway Render V2 esistente, senza dipendere da AUTSYS PC BRIDGE V1 e senza introdurre un nuovo servizio a pagamento.

## Stato
Il codice nel branch contiene: endpoint `/mcp` stateless, metadata OAuth Protected Resource, validazione JWT RS256 via JWKS di issuer configurato, audience, scope `autsys.v2.read`, autorizzazione di progetto, quota per soggetto (60 richieste/minuto, massimo 4 calls concurrent), dispatch su Redis V2, lettura degli esiti tramite `request_status`, default OFF se non configurato. Non abilita operazioni mutanti.

**Non è attivo sull'attuale servizio Render** finché il branch non è revisionato, OAuth non è configurato e il deploy non è autorizzato nel workspace corretto.

## Variabili Render richieste (valori non salvati nel repository)
- `MCP_V2_RESOURCE_URL`: URL HTTPS esatto pubblico, con path `/mcp`, su host V2.
- `MCP_V2_OAUTH_ISSUER`: issuer HTTPS del provider OAuth/OIDC approvato per AUTSYS.
- `MCP_V2_OAUTH_JWKS_URI`: URL HTTPS JWKS dello stesso provider.
- `MCP_V2_OAUTH_AUDIENCE`: audience specifica riservata alla V2 MCP.
- `MCP_V2_PROJECT_KEYS`: sottoinsieme dei projectKey già autorizzati in `RELAY_PROJECT_KEYS`.
- `MCP_V2_ALLOWED_ORIGINS`: lista opzionale di Origin HTTPS ammessi. I client senza header Origin rimangono soggetti a verifica JWT.

Il token deve essere RS256 firmato, con issuer/audience corretti, subject non vuoto, exp valido, scope `autsys.v2.read` e claim `autsys_projects` che autorizza espressamente i projectKey. Non aggiungere token, chiavi o segreti ai file GitHub.

L'issuer deve supportare i meccanismi OAuth usati dal client ChatGPT (inclusa discovery/autorizzazione); la registrazione dell'app OAuth deve essere autorizzata dall'amministratore dell'identità. Il semplice endpoint MCP non crea un identity provider.

## Funzionalità read-only esposte
- `health`
- `fs.exists`, `fs.stat`, `fs.list`, `fs.read_text` (solo path relativi nelle radici per progetto configurate)
- `request_status` (recupero idempotente, con isolamento di progetto)

La coda Redis persiste esiti; **non ripetere mai automaticamente una mutazione dall'esito incerto**. Lo status va letto tramite ID originario.

## Test già eseguiti sul server Windows, non in produzione
- `RUN_MCP_V2_STAGING_TEST_20261116.ps1`: PASS (OAuth, JSON-RPC, ACL progetto e status).
- `RUN_MCP_V2_RELAY_TEST_20261116.ps1`: PASS (MCP sul relay senza alterare `/relay` e `/enqueue`).
- Test preesistenti del gateway/worker V2 e health failover A→B erano PASS prima di questa modifica.

## Passaggi necessari prima dell'attivazione
1. Confermare esplicitamente il workspace Render **AUTSYS**; il connettore Render non consente la selezione automatica.
2. Verificare lo specifico servizio V2 staging e la sua configurazione GitHub/autodeploy; evitare qualunque intervento sul gateway V1.
3. Definire/configurare un provider OAuth approvato e verificare issuer, JWKS, audience, scope e project claim; completare registrazione app ChatGPT.
4. Eseguire revisione codice e test regressione completi; effettuare deploy mirato sul servizio V2 con rollback.
5. Testare da client remoto `initialize`, `tools/list`, health, file scoped, deny non autorizzato, richiesta incompleta, down A con B viva, e gateway indisponibile.
6. Collegare la V2 in ChatGPT come app/connector distinta. Questa installazione richiede un'azione esplicita dell'utente.
7. Soltanto dopo test completo considerare V2 operativa come percorso MCP alternativo. Mantenere V1 e processi attivi.

## Protezioni
Non dismettere V1, non modificare il robot o i servizi applicativi, non copiare credenziali tra V1 e V2, non abilitare tools mutanti senza nuove autorizzazioni e riconciliazione.
