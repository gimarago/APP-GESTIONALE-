# Recupero delle fatture già presenti sul portale

**Stato: importazione locale implementata; collegamento automatico al portale non implementato.** Questo aggiornamento non entra in Fatture e Corrispettivi, non usa SPID e non scarica dati dall'Agenzia. Importa nell'archivio del backend copie XML/ZIP già scaricate dall'utente. Non è ancora una sincronizzazione remota.

La documentazione ufficiale distingue i [servizi massivi di trasmissione e scarico](https://www.fatturapa.gov.it/export/documenti/ws/servizimassivi/Servizi_Massivi_Specifiche_Tecniche_v1.0.pdf) dal servizio di invio SdIRiceviFile. È stata individuata una [pagina di aggiornamento SMTS 1.5](https://www.fatturapa.gov.it/it/news/Evoluzione-dei-Servizi-Massivi-in-cooperazione-applicativa-SMTS-versione-1.5/), ma in questa sessione non è stato possibile scaricare e verificare i contratti aggiornati: il terminale restituisce EACCES sulla rete e il lettore web HTTP 403. Non si considera verificata la compatibilità della vecchia specifica con il servizio attuale. Inoltre non sono disponibili canale e autorizzazioni aziendali. Non sono stati inventati endpoint o modalità di autenticazione.

## Provare senza fatture reali

In PowerShell, eseguire le righe separatamente:

```powershell
cd "C:\Users\digio\OneDrive\Desktop\files-mentioned-by-the-user-officina\outputs\backend"
$env:OFFICINA_PYTHON = 'C:\Users\digio\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
node scripts/sync-demo.mjs
```

La prima esecuzione indica `imported: 1`; le successive `duplicates: 1`. `portalConnected: false` è intenzionale. I risultati si trovano in `data/sync-demo/received.sqlite` e `data/sync-demo/fatture-ricevute.json`. Sono dati sintetici. Non usare questo archivio dimostrativo per la propria azienda.

## Importare copie già scaricate

Preparare una cartella con XML o ZIP del portale. Eseguire:

```text
node scripts/sync-import.mjs PARTITA_IVA CARTELLA_O_FILE_XML_ZIP DATABASE_NUOVO.sqlite
```

Sostituire i tre argomenti: partita IVA aziendale di 11 cifre, percorso della cartella/file e percorso di un nuovo database. Racchiudere tra virgolette i percorsi contenenti spazi. Per archivi reali scegliere una cartella protetta su disco locale fuori da OneDrive. Non indicare il database del simulatore, di trasmissione o di un'altra azienda: il programma li rifiuta. Il motore Python/lxml è lo stesso della fase 2.

Il terminale mostra conteggi e stato della singola esecuzione; non elenca dati fiscali o contenuto delle fatture. `COMPLETED_WITH_ISSUES` significa che alcuni elementi richiedono verifica: non significa che l'archivio del portale sia stato recuperato integralmente. Un file non valido non impedisce l'importazione degli altri. Nessuna modifica viene apportata ai file sorgenti.

## Funzionamento e interfacce

`InvoiceSync.open(databasePath, {vat, cf?})` apre un archivio legato a una sola azienda. `syncLocal(inputPath)` scansiona nuovamente la cartella/file ad ogni chiamata; le importazioni precedenti sono riconosciute dal digest SHA-256. Le funzioni `list()`, `original(digest)` e `issues(runId)` permettono di leggere documenti, byte originali e problemi. Il campo CF facoltativo permette il confronto di fatture intestate al solo codice fiscale; la CLI attuale accetta solo partita IVA. Non esiste ancora una schermata per questi documenti nell'HTML.

Ogni XML viene validato con lo schema ufficiale FPR12 locale prima dell'archiviazione e confrontato con l'identità del destinatario. Il lettore delle fatture ricevute è distinto dal generatore: può leggere le tipologie e le righe ammesse dallo XSD anche se non sono generabili dal profilo ristretto della fase 2. Schemi storici non compatibili con lo XSD installato richiederanno supporto versionato ulteriore.

L'archivio conserva il file originale come BLOB, digest, data d'importazione, provenienza dichiarata `LOCAL_EXPORT` e dati di ciascun corpo fattura. Non certifica che il file provenga realmente dall'Agenzia. Non attribuisce un identificativo SdI ricavandolo dal nome del file. Pagamento resta UNKNOWN e consegna NOT_INFERRED: il download non è una prova di saldo o di consegna.

Identità documentale interna: fornitore (paese e identificativo fiscale), anno, tipo e numero. Se un nuovo file presenta la stessa identità con byte diversi, viene segnalato CONFLICT e non sovrascrive l'originale, anche quando la differenza è soltanto formattazione. Un XML con più corpi viene importato integralmente in un'unica transazione oppure segnalato in conflitto; non ne viene importata solo una parte. La risoluzione manuale dei conflitti non è ancora implementata.

Le esecuzioni e i problemi sono persistenti. Una sola esecuzione RUNNING per archivio impedisce sovrapposizioni. Dopo l'interruzione del processo, a worker fermo, `recoverInterrupted()` marca il run come interrotto; poi si può ripetere la scansione senza duplicare i documenti già salvati. Non vengono cancellate fatture se spariscono dai file sorgenti e non viene registrato un cursore remoto inesistente.

## Limiti di sicurezza e formati

- XML UTF-8 fino a 2 MB, parser senza DTD/entità esterne, schema locale con hash verificato, limiti di profondità e durata ereditati dalla fase 2.
- ZIP fino a 2 MB, 200 voci e 2 MB complessivi decompressi, rapporto massimo 100:1; nessuna estrazione sul filesystem. Percorsi relativi ostili, assoluti, voci duplicate, link simbolici e cifratura vengono rifiutati. ZIP annidati e file diversi da XML sono segnalati, non ignorati silenziosamente.
- Cartelle non ricorsive fino a 1.000 voci. Sottocartelle, P7M, PDF e metadati non compatibili con lo schema fattura compaiono tra i problemi. Per export più grandi suddividere i file; i limiti sono locali, non limiti ufficiali del portale.
- Le firme XML eventualmente presenti non vengono verificate crittograficamente; `signatureVerification=NOT_PERFORMED`. P7M non è supportato. Nessuna autenticità fiscale viene dedotta dalla sola validazione XSD.
- Database e originali non sono cifrati: richiedono ACL, backup coerenti a database chiuso e gestione dei dati aziendali. Non è conservazione a norma.

## Lavoro ancora necessario per la sincronizzazione automatica

1. Acquisire e verificare specifiche SMTS/WSDL/XSD aggiornati e i requisiti effettivi per l'azienda o il delegato. Il canale di invio già progettato non viene considerato automaticamente autorizzato allo scarico.
2. Implementare il provider `portal-provider.js`, oggi esplicitamente non configurato, con richiesta massiva, protocollo, verifica esito e scarico dei lotti; aggiungere persistenza delle richieste e riconciliazione degli esiti incerti.
3. Collaudare autenticazione, autorizzazioni, intervalli temporali, disponibilità dello storico, metadati ufficiali, download multipli e ripresa dopo interruzioni nell'ambiente previsto dal servizio.
4. Integrare l'archivio nel frontend, poi configurare eventuali sincronizzazioni periodiche solo su richiesta. Nessuna automazione periodica è stata creata.

Non occorre fornire in chat credenziali SPID, password o chiavi private. Questo aggiornamento non attiva trasmissioni, numerazione o migrazione da Fatture in Cloud.
