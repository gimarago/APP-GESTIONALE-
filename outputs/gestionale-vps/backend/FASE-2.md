# Fase 2: XML FPR12, XSD e client SDICoop

Implementazione locale del generatore fiscale e del client SOAP. Collaudo eseguito su HTTPS locale con autenticazione TLS reciproca e contratti ufficiali. Nessuna chiamata effettuata al Sistema di Interscambio, nessun accreditamento ottenuto e nessuna fattura reale emessa.

## Aprire la demo

Aprire PowerShell nella cartella `outputs/backend`. Su questo computer:

```powershell
$env:OFFICINA_PYTHON = 'C:\Users\digio\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
node scripts/fiscal-demo.mjs
node --test
```

La demo non usa la rete. Produce `data/fiscal-demo/fattura-test.xml` e `data/fiscal-demo/richiesta-soap-test.xml`, entrambi sintetici, con numero TEST-1 esplicitamente fornito nella fixture. Il risultato `xsdValidated: true` indica che il documento rispetta lo schema installato, non che SdI lo abbia accettato. Il file SOAP contiene lo stesso XML codificato in base64. Non caricare questi esempi in produzione.

Per altri computer: Node.js 24+, Python 3.10+ e `python -m pip install -r requirements.txt`. Per i test TLS serve anche `python -m pip install -r requirements-test.txt`; impostare `OFFICINA_PYTHON` al relativo eseguibile. Nessun percorso personale è incorporato nel codice. Le versioni effettivamente usate sono riportate in `VERIFICA.md`.

L'app HTML e il suo archivio browser sono preservati. Non c'è ancora una nuova schermata nell'app: le API fiscali non sono collegate al frontend, né alla vecchia coda del simulatore. Il comando `node src/demo.js` resta disponibile per il simulatore precedente.

## Profilo fiscale implementato

`XmlGenerator.generate(invoice)` genera FPR12 non firmato per TD01, TD04 e TD24, in EUR, venditore italiano RF01 e cliente con indirizzo italiano, IVA 4/5/10/22%, sconto percentuale di riga, riepiloghi IVA ed esigibilità immediata. La nota di credito richiede numero e data del documento collegato; TD24 richiede una causale di riferimento alla documentazione degli interventi. La funzione Rapporti di intervento del frontend limita TD24 a un cliente e un mese, aggiunge numero e data del rapporto e propone la data dell'ultimo lavoro del mese. Verificare l'idoneità della documentazione e il termine di emissione prima di numerare. I totali derivano dalle righe, con aritmetica BigInt, arrotondamento half-up ai centesimi per riga e IVA per gruppo. Quantità fino a 4 decimali, prezzi fino a 8, percentuali fino a 2. Prezzi sempre netti: il formato `grossPrice` del frontend è rifiutato.

Numero fiscale e progressivo sono forniti dall'esterno; `numberSource` deve essere `external`. Non esiste un contatore o un'assegnazione automatica. Prima dell'utilizzo effettivo occorre concordare il passaggio da Fatture in Cloud. Il numero TEST-1 nella fixture è solo un dato sintetico.

Controlli applicativi separati in `fiscal-rules.js`: struttura, campi ammessi, date, checksum partita IVA italiana, formato identificativi, valori positivi, aliquote e sconti, riferimenti. Il codice fiscale e l'IBAN hanno controlli di formato, non verifica anagrafica o bancaria. Lo schema non verifica la reale esistenza delle parti, la legittimità dell'aliquota o la completezza fiscale del caso concreto.

Non supportati: PA, estero, IVA zero/natura, reverse charge, split payment, bollo, ritenute, cassa previdenziale, REA e dati societari aggiuntivi, allegati, firme, pagamenti rateali, maggiorazioni e sconti a livello documento. I campi aggiuntivi vengono rifiutati. Non usare il profilo per società/casistiche che richiedono questi dati. Il regime ordinario da solo non garantisce che un documento rientri nel profilo supportato.

## XSD e fonti

- [Documentazione del formato FatturaPA](https://www.fatturapa.gov.it/it/norme-e-regole/documentazione-fattura-elettronica/formato-fatturapa/): scaricato `Schema_VFPR12_v1.2.3.xsd` dal percorso ufficiale v1.4.
- [Documentazione SdI](https://www.fatturapa.gov.it/it/norme-e-regole/DocumentazioneSDI/): scaricati `SdIRiceviFile_v1.0.wsdl`, `TrasmissioneTypes_v1.0.xsd`, contratti delle notifiche e istruzioni SDICoop Trasmissione 3.3.
- Import XML Signature scaricato dal sito W3C e risolto dalla copia locale.

`contracts/manifest.json` registra URL, data e SHA-256 dei file originali. I contratti XML utilizzati vengono verificati a ogni esecuzione del motore. Non modificarli senza revisione. `scripts/download-contracts.mjs` è uno strumento manuale di aggiornamento che sovrascrive contratti e manifest: non viene eseguito da demo o test e non va usato come aggiornamento automatico in esercizio. Il manifest locale non è una firma digitale della fonte.

Il motore `src/xml/engine.py` usa lxml in un processo separato. Payload: niente DTD/entità esterne, recupero di XML malformati o accessi di rete; massimo 2 MB, 30.000 nodi e profondità 64, con timeout del processo di 15 secondi. Il solo import W3C autorizzato viene risolto localmente. La DTD presente nel file W3C originale fidato non viene caricata; i payload non possono dichiarare DTD. Gli errori XSD restituiscono tipo e riga, senza includere valori del documento. La validazione di una eventuale struttura Signature non equivale alla verifica crittografica di una firma; il generatore non produce firme.

## Collegamento Web Service

Il client legge nome dell'operazione, SOAPAction e QNames di richiesta/risposta dal WSDL ufficiale. Costruisce SOAP 1.1 document/literal, con `NomeFile` e `File` base64; valida richiesta e risposta con `TrasmissioneTypes_v1.0.xsd`. Usa HTTPS, verifica certificato server e hostname, TLS minimo 1.2, certificato client e CA da percorsi esterni. Non effettua redirect o retry. Questo profilo invia XML singolo, non archivi ZIP o file firmati.

Non viene utilizzato automaticamente l'indirizzo HTTP contenuto nel WSDL. Il relativo hostname di produzione è bloccato; l'endpoint HTTPS di test va verificato sull'accordo/configurazione del proprio canale. Il semplice nome `sdi-test` non prova che un URL o un certificato appartengano all'ambiente di test: la verifica operativa resta necessaria. Non sono stati inventati URL di test.

Configurazione attesa dal costruttore `SdiClient` e dal coordinatore persistente:

```javascript
const config = {
  environment: 'sdi-test',
  endpoint: process.env.SDI_TEST_ENDPOINT,
  endpointSource: process.env.SDI_TEST_ENDPOINT_SOURCE,
  authorizedTestChannel: true, // solo dopo verifica del canale di interoperabilità
  certPath: process.env.SDI_CERT_PATH,
  keyPath: process.env.SDI_PRIVATE_KEY_PATH,
  caPath: process.env.SDI_CA_PATH,
  timeoutMs: 15000
};
```

Non impostare `authorizedTestChannel` finché il canale non è disponibile e verificato. L'altra modalità, `local-contract-test`, accetta esclusivamente loopback e viene usata dai test. `environment=production` e `APP_ENV=production` sono rifiutati. Chiavi PEM locali non cifrate sono attualmente il formato supportato dal trasporto: proteggerle tramite ACL/gestione segreti; supporto PFX e passphrase da secret manager da aggiungere prima di impieghi che li richiedano. Non fornire password, chiavi o token nell'HTML o nei log.

## Persistenza e assenza di reinvii automatici

Per orchestrare una trasmissione usare `FiscalTransmissionService.open(databasePath, config)` e `submit({sourceKey, filename, invoice})`. Usare un database nuovo e distinto da quello del simulatore, su disco locale non sincronizzato. L'archivio registra l'ambiente e rifiuta riaperture con ambiente differente. Non invocare il client di basso livello direttamente da una UI: da solo non offre idempotenza persistente.

Prima della rete vengono generati e validati XML e SOAP. Una transazione registra documento immutabile, digest e claim. Vincoli unici su chiave sorgente, nome file, digest e identità fiscale interna (venditore, anno, tipo documento, numero) impediscono duplicati anche modificando il progressivo. Una seconda `submit` identica restituisce la registrazione precedente. Documento diverso con stessa chiave genera conflitto. Correzioni, annullamenti e reinvio dopo scarto non sono implementati e non vanno aggirati cambiando chiave.

| Stato trasmissione | Significato |
|---|---|
| IN_FLIGHT | Registrata, esito della chiamata ancora non salvato |
| SDI_RECEIVED | Risposta sincrona valida con ID e data di ricezione; non significa consegna o superamento dei controlli fiscali |
| TRANSPORT_REJECTED | Errore EI01/EI02/EI03 previsto dal contratto; non è una notifica fiscale di scarto |
| UNKNOWN | Timeout, errore TLS/rete, SOAP Fault, risposta HTTP inattesa o non validabile: riconciliazione necessaria |

Nessuno stato causa retry automatico, nemmeno EI02. Il metodo `recoverInterrupted()` converte IN_FLIGHT in UNKNOWN: usarlo soltanto dopo l'arresto di tutti i worker. Un errore di persistenza successivo alla chiamata deve fermare il worker e richiedere riconciliazione. Non cancellare righe per forzare un altro invio. Gli eventi contengono soltanto ID, tipo e data; database e XML non sono cifrati e richiedono protezione, backup e gestione accessi.

Il nuovo archivio rappresenta esclusivamente le trasmissioni: non aggiorna automaticamente stato fiscale o pagamento del frontend. Il ricevitore pubblico delle notifiche, la loro verifica/autenticazione reale e la riconciliazione con SdI restano da implementare e collaudare. Le notifiche del simulatore non vengono interpretate come ricevute ufficiali. La risposta sincrona è distinta dalla consegna.

## Collaudo SdI ancora necessario

Per la prova esterna occorrono endpoint di interoperabilità verificato, certificati e CA di test, canale autorizzato e destinatari di test. Poi vanno predisposti e collaudati ricevitore e notifiche previsti dall'accordo, eseguendo un invio controllato e verificandolo nel Sistema di Accreditamento. Le [istruzioni ufficiali per la sperimentazione](https://www.fatturapa.gov.it/it/sistemainterscambio/sperimentazione/) distinguono questi test dai documenti validi fiscalmente.

Il collaudo locale non attesta accreditamento o interoperabilità effettiva con SdI. Produzione, migrazione da Fatture in Cloud, verifica fiscale, backup operativi e conservazione a norma restano esclusi da questa consegna.
