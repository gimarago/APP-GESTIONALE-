# Backend officina

**Recupero storico:** importazione locale di XML/ZIP con archivio aziendale e deduplicazione disponibile; collegamento automatico al portale ancora non implementato. Vedi [SINCRONIZZAZIONE.md](SINCRONIZZAZIONE.md).

**Aggiornamento fase 2:** sono disponibili generazione XML FPR12 per un profilo fiscale limitato, validazione XSD ufficiale e client SOAP con collaudo HTTPS locale. Avvio, limiti e stato del collegamento SdI sono descritti in [FASE-2.md](FASE-2.md). Nessun test sul canale SdI è stato eseguito. Le sezioni seguenti documentano il simulatore della fase 1; le indicazioni relative a generatore/XSD/client non implementati sono superate dalla fase 2. Ricevitore reale e riconciliazione remota restano non implementati.

## Fase 1, simulazione preservata

Questa sottocartella è indipendente da `outputs`: non modifica HTML, localStorage, dati clienti o fatture esistenti. Nessuna importazione, migrazione, numerazione fiscale o connessione a Fatture in Cloud. L'obiettivo futuro è un canale Web Service diretto SdI, non PEC o automazione del portale.

## Avvio locale

Richiede Node.js 24 o successivo con `node:sqlite`. Verificato con Node 24.19.0. Non ci sono dipendenze da installare.

Da questa cartella:

```powershell
node --test
node src/demo.js
```

La demo utilizza solo dati sintetici e crea `data/test/simulation.sqlite` (con eventuali file WAL e SHM). È ripetibile: la chiave `demo-v1` evita una seconda creazione o trasmissione simulata. Non apre porte, non avvia server e non accede alla rete. Non inserire dati fiscali o personali reali in questa fase.

L'ambiente accettato è solo `APP_ENV=test`, `SDI_MODE=simulator` (valori predefiniti). Qualunque altro valore blocca l'apertura dell'archivio e le operazioni di simulazione. `.env.example` documenta riferimenti futuri: non viene caricato automaticamente. Produzione non implementata né attivabile cambiando una variabile.

## Componenti e interfacce

- `src/service.js`: API asincrona gestionale `createDraft(sourceKey, draft)`, `enqueue(id)`, `runOne()`, `get(id)`, `setPayment(id, state)`, recupero e riconciliazione. Le bozze demo richiedono `{simulation:true,label:"..."}`. Non è ancora un modello fiscale completo.
- `src/storage.js`: archivio SQLite, transazioni immediate, coda, tentativi, notifiche ed eventi atomici. Il driver SQLite è sincrono all'interno di operazioni brevi; le API di servizio e trasporto sono asincrone. La coda si consuma esplicitamente con `runOne`, senza scheduler implicito.
- `src/fatture/xml-generator.js`: interfaccia fiscale non implementata; generatore separato di XML `OfficinaSimulation` contenente dati codificati base64, che non costituisce cifratura né FatturaPA. Nessun dato aziendale preimpostato.
- `src/fatture/xml-validator.js`: controlli applicativi demo separati dall'interfaccia XSD, che fallisce esplicitamente. La validazione del formato simulato restituisce sempre `xsdValidated:false`.
- `src/sdi/sdi-client.js`: trasporto reale non implementato; client simulato con ACK locale o timeout.
- `src/sdi/sdi-receiver.js`: ingresso locale JSON limitato a 4096 byte, nessun listener. Ricezione reale non implementata.
- `src/sdi/notification-handler.js`: inbox persistente, idempotenza, correlazione e riconciliazione delle notifiche simulate.
- `src/sdi/sdi-status.js`: vocabolario degli stati interni, non codici ufficiali SdI.

## Stati e affidabilità

| Stato fattura | Significato in questa fase |
|---|---|
| BOZZA | Bozza sintetica locale, senza numero fiscale |
| DA_INVIARE | Accodata; può restare tale se il tentativo ha esito incerto |
| INVIATA | Ricevuto un ACK dal simulatore: non significa consegna, emissione fiscalmente valida o accettazione SdI |
| CONSEGNATA | Applicato un evento sintetico di consegna |
| SCARTATA | Applicato un evento sintetico di scarto |
| MANCATA_CONSEGNA | Applicato un evento sintetico di mancata consegna |

Stato pagamento indipendente: `DA_SALDARE`, `PARZIALE`, `SALDATA`, registrazione manuale senza contabilità dei movimenti. Stato tentativo: `IN_CORSO`, `ACK_SIMULATO`, `ESITO_INCERTO`. Stato coda: `READY`, `IN_FLIGHT`, `DONE`, `RECONCILE`. I consumatori devono leggere anche il tentativo, non dedurre il successo dal solo stato fattura.

La chiave sorgente unica previene duplicati della stessa operazione: stessa chiave e stesso JSON restituiscono l'ID già creato, contenuto diverso produce conflitto. Il confronto JSON è sensibile all'ordine delle proprietà. Chiavi diverse possono creare bozze identiche: non è deduplicazione fiscale universale. Una sola voce di coda per fattura e il claim transazionale impediscono a due worker di prelevare lo stesso lavoro. XML archiviato prima della trasmissione, nessuna modifica della bozza dopo creazione in questa fase.

Timeout ed errori di trasporto sono conservativamente incerti: nessun retry automatico. Al riavvio, dopo aver fermato tutti i worker, chiamare `recoverInterrupted()` per mettere i tentativi interrotti in riconciliazione. Non chiamarlo come controllo periodico mentre altri worker sono attivi. Un ACK tardivo non annulla questa decisione. Un errore di persistenza dopo la chiamata di trasporto viene propagato: fermare il worker e riconciliare, non ripetere l'invio.

`reconcileSimulatedAck(attemptId, evidence)` consente solo una risoluzione manuale sintetica verso ACK, con riferimento di prova non sensibile. Non è una verifica remota. Non esiste una funzione di reinvio degli incerti o di riemissione degli scarti. Per il canale futuro servirà un processo operativo verificato prima di abilitare qualsiasi nuovo tentativo.

Le notifiche hanno ID unico; stesso ID con contenuto diverso genera errore. Notifiche anticipate o senza corrispondenza restano `UNMATCHED`; dopo la correlazione chiamare `reconcileUnmatched()`. Duplicati semantici diventano `DUPLICATE_OUTCOME`. È consentita nel simulatore la progressione mancata consegna → consegna; regressioni e altri esiti incompatibili diventano `CONFLICT`, senza alterare la fattura. Queste regole sono interne e dovranno essere sostituite/verificate sui contratti ufficiali. I conflitti restano archiviati per revisione: la loro risoluzione manuale non è implementata.

Gli eventi registrano ID e cambiamenti, senza XML, dati aziendali, stack di errori del trasporto o credenziali. Non inserire segreti nel riferimento di riconciliazione. Archivio, notifiche, XML ed eventi non sono cifrati e l'audit non è a prova di manomissione. Usare filesystem locale; non condividere SQLite tra computer né usare il database attivo in una cartella sincronizzata OneDrive in un impiego reale. Per backup coerenti usare in futuro backup SQLite o copia a database chiuso, includendo il WAL se presente; non copiare il solo file principale durante le scritture.

## Limiti e prossimi passi

I test coprono persistenza su seconda connessione, idempotenza, claim concorrenti, timeout, recupero interruzioni, ACK tardivi, notifiche anticipate/duplicate/incompatibili, pagamenti separati, rifiuto payload e blocco produzione. Non verificano la durabilità in caso di guasto hardware, né conformità fiscale o sicurezza del canale reale.

1. Verificare e versionare specifiche, XSD, WSDL e relativi import da fonti ufficiali Agenzia delle Entrate/Sistema di Interscambio; registrare provenienza, data e hash. Non sono stati inventati o inseriti endpoint, operazioni SOAP, certificati o codici di esito ufficiali.
2. Implementare modello fiscale e generatore sulla documentazione verificata, con configurazione aziendale esterna e regime ordinario da validare con il professionista. Concordare la transizione da Fatture in Cloud prima di assegnare qualsiasi numero reale.
3. Integrare validazione XSD locale e controlli applicativi fiscali separati. Il parser reale dovrà disabilitare DTD, entità esterne, risoluzione di rete e import non autorizzati, con limiti di byte, profondità e tempo. La regex attuale riconosce solo il formato chiuso del simulatore e non è un parser XML generale.
4. Derivare l'adattatore SOAP esclusivamente dai WSDL ufficiali verificati, quindi testare in ambiente autorizzato. Servono accreditamento, scelta/configurazione del canale, certificati, infrastruttura e autenticazione del ricevitore. Percorsi e riferimenti ai segreti tramite ambiente/secret manager, mai chiavi in HTML, repository o log.
5. Prima di esporre API: autenticazione, autorizzazioni, isolamento ambienti e archivi, controllo accessi, gestione chiavi, backup/ripristino, monitoraggio, limiti e test del parser, riconciliazione operativa e migrazioni schema. Questa versione crea lo schema iniziale senza sistema di migrazioni.
6. Integrare il frontend con un contratto esplicito, senza modificare o importare automaticamente i dati del browser. Completare verifica fiscale e conservazione a norma, che restano attività esterne non svolte da questo archivio.

Non viene dichiarata conformità fiscale, sicurezza assoluta o accreditamento ottenuto. Il precedente README in `outputs` descrive il vecchio prototipo: resta preservato; questo backend segue invece l'obiettivo futuro di collegamento diretto SdI.
