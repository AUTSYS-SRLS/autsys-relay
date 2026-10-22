# UTOPIA mobile monitor

Pagina AUTSYS nera/argento per Safari, con caricamento solo all'apertura e con il pulsante AGGIORNA.

I dati richiesti sono:
- capitale iniziale dal database V4bis;
- saldo attuale inclusivo del P&L delle posizioni aperte;
- rendimento percentuale dall'avvio;
- rendimento percentuale del giorno civile italiano;
- posizioni aperte e minimo di ulteriori posizioni finanziabili al costo peggiore fra AUDSGD, CADJPY, EURTRY.

**Stato al 22/10/2026:** file frontend e script locale `MONITOR_MOBILE/dashboard_snapshot.py` preparati e lettura locale verificata. **NON PUBBLICATO**: nessun endpoint pubblico autenticato del PC collegato a questa pagina. Il file `server2.js` e il protocollo WebSocket sono prove non distribuite. Non presentare una pagina statica isolata come servizio live.

## Vincoli
- Non toccare la logica e il ciclo del robot V4bis.
- Nessun ordine, né lettura delle credenziali IG da browser.
- Nessun polling di dati, richiesta solo all'apertura/pulsante.
- Proteggere qualunque endpoint remoto con autenticazione.
- Cloudflare Workers/Pages gia usato da PORTIERI e preferibile a modificare il bridge o i servizi Render esistenti.
- Icona argento su nero approvata nel thread, da inserire nell'asset di pubblicazione.
