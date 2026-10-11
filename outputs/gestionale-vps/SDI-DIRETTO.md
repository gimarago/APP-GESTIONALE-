# Canale SdI diretto: invio, ricezione e gestione operativa

Il gestionale contiene un canale SdICoop bidirezionale: invia le fatture confermate, riceve le notifiche degli invii e acquisisce le fatture fornitori. **Il canale è disattivato per impostazione predefinita. Questo pacchetto non accredita il titolare presso SdI e non costituisce un collaudo ufficiale.**

**Stato della release: versione per il collaudo.** Prima di sostituire integralmente il servizio attuale occorre completare anche il flusso di correzione/ritrasmissione dopo scarto e definire la gestione dei documenti firmati `.p7m`, oltre alle verifiche ufficiali descritte sotto.

Per questa installazione l'indirizzo dell'applicazione è `https://api.magomme.it`. Il dominio separato del servizio SdI deve ancora essere scelto, configurato nel DNS e concordato nell'accreditamento; non è stato inventato né attivato. Il dominio dell'applicazione, da solo, non abilita l'invio o la ricezione fiscale.

Non sono stati eseguiti invii reali, modifiche al DNS, installazioni sul VPS o verifiche con certificati SdI reali. Docker e Caddy non sono disponibili nell'ambiente locale di sviluppo: la configurazione fornita richiede validazione sul VPS e collaudo di interoperabilità prima dell'uso.

## Cosa comprende questa versione

| Funzione | Comportamento |
| --- | --- |
| Fatture emesse | Usa l'XML già confermato e salvato nel gestionale. Il generatore gestisce TD01, TD04 e TD24 nazionali FPR12; TD24 è proposto dai rapporti di intervento mensili. Non aggiunge la fatturazione verso la PA. |
| Invio | Verifica il documento, l'XML, la partita IVA del cedente, i contratti locali e i certificati. Dopo conferma esplicita crea una registrazione persistente e compie un solo tentativo HTTPS con autenticazione reciproca. |
| Ricevute | Riceve scarto, consegna, mancata consegna ed altre operazioni previste dai WSDL inclusi; conserva l'originale e correla nome file e identificativo SdI. Le notifiche discordanti o non abbinabili restano da verificare. |
| Fatture ricevute | Salva SOAP, allegato e metadati prima della risposta positiva. Le consegne ripetute sono deduplicate; le varianti incompatibili restano visibili. |
| Registro fornitori | In produzione analizza gli XML compatibili intestati a `SHOP_VAT` e importa i corpi fattura nel registro, senza registrare pagamenti. Il collaudo non alimenta il registro fornitori. |
| File da verificare | `.p7m`, formati non supportati, destinatari discordanti ed errori di lettura mantengono l'originale in stato **Da verificare**. Non è presente una procedura di verifica firma o di approvazione automatica di questi file. |
| Archivio | Memorizza originali, tentativi ed eventi nel database SQLite condiviso. Il backup SQLite comprende anche queste tabelle; la normale esportazione JSON del browser non è un backup completo. |

La validazione XSD non certifica la correttezza fiscale e non sostituisce i controlli SdI. Non viene verificata crittograficamente la firma CAdES o XMLDSig: l'identità del mittente delle callback è verificata tramite il canale mTLS, non tramite la firma contenuta nei documenti. Il pacchetto non effettua firma digitale né conservazione digitale a norma. Queste attività, insieme alla verifica contabile dei documenti acquisiti, restano da organizzare separatamente.

Gli importi non traducibili con sicurezza in un debito positivo in EUR, comprese le note di credito ricevute, restano da completare/verificare nel registro fornitori. L'acquisizione non equivale a registrazione di un pagamento.

## Attività esterne necessarie prima dell'attivazione

Il referente del canale deve completare l'iter vigente di accreditamento SdICoop per **trasmissione e ricezione**, ottenere l'accordo e i materiali dei rispettivi ambienti, predisporre gli endpoint e completare il collaudo richiesto. Le impostazioni del software non dichiarano concluso questo iter.

Servono almeno:

1. La partita IVA intestataria e il riferimento effettivo dell'accordo del canale.
2. L'URL esatto del servizio di invio e i contratti previsti dall'accordo, separati per collaudo e produzione.
3. Un dominio SdI distinto da quello del gestionale, raggiungibile direttamente dal SdI su HTTPS, con certificato server e chiave privata appropriati.
4. Il certificato client e la chiave privata per gli invii, le CA per verificare il server remoto, le CA e le impronte SHA-256 dei client SdI ammessi alle callback.
5. Il completamento delle prove di interoperabilità, compresa ricezione fatture, ricevute, duplicati e gestione degli errori, prima del passaggio in produzione.
6. La configurazione del recapito fatture associato al canale nelle modalità concordate: nessun codice destinatario è generato da questa applicazione e il solo avvio del server non modifica il recapito presso SdI.

I riferimenti tecnici inclusi nel pacchetto sono elencati con URL e hash in [backend/contracts/manifest.json](backend/contracts/manifest.json). Consultare l'accordo vigente e confrontare i WSDL/XSD prima dell'attivazione. Il software usa copie locali verificate e non scarica contratti durante l'elaborazione. Le istruzioni archiviate sono [SdICoop Trasmissione 3.3](backend/contracts/Istruzioni-per-il-servizio-SDICoop-Trasmissione-versione3.3.pdf) e [SdICoop Ricezione 3.3](backend/contracts/Istruzioni-per-il-servizio-SDICoop-Ricezione-versione3.3.pdf); eventuali aggiornamenti richiedono revisione e nuovi test.

## Separare collaudo e produzione

Usare installazioni e archivi distinti, preferibilmente VPS distinti. La configurazione Compose assegna un nome fisso ai container e al progetto: due copie della cartella sullo stesso host non bastano a isolare ambienti e volumi. Non eseguire prove sull'archivio operativo e non inviare fatture di produzione al collaudo.

L'archivio lega i documenti all'ambiente e all'identità del canale (partita IVA, riferimento accordo e host remoto). Dopo l'acquisizione di documenti, cambiare questa identità o alternare `test`/`production` nello stesso archivio viene bloccato. Non aggirare il blocco modificando il database. Il passaggio alla produzione parte dall'archivio operativo, privo di invii e ricezioni di collaudo; conservare separatamente l'archivio delle prove.

## Rete e autenticazione delle callback

Il profilo ordinario [compose.yaml](compose.yaml) mantiene SdI spento e non pubblica la porta dell'applicazione. Il file facoltativo [compose.sdi.yaml](compose.sdi.yaml) aggiunge i certificati e sostituisce il Caddyfile con [deploy/Caddyfile.sdi](deploy/Caddyfile.sdi).

Il gestionale rimane accessibile con il normale HTTPS pubblico. Il dominio SdI richiede invece un certificato client riconosciuto per l'intero handshake TLS. Solo due percorsi POST vengono inoltrati:

| Percorso sul dominio SdI | Contratto |
| --- | --- |
| `/sdi/notifications` | `TrasmissioneFatture_v1.1.wsdl`, notifiche relative agli invii |
| `/sdi/invoices` | `RicezioneFatture_v1.0.wsdl`, fatture ricevute e operazioni previste dal relativo contratto |

Questi sono gli indirizzi da verificare nell'accordo; il servizio non espone una pagina pubblica di caricamento XML o un endpoint `?wsdl`. Le copie dei contratti sono nel pacchetto.

Caddy verifica la catena client e impone che SNI TLS e host HTTP coincidano. Sostituisce gli header interni di token, impronta e dominio; il backend verifica tutti e tre. Sul normale host gli stessi header sono eliminati, e il Caddyfile SdI rifiuta i percorsi `/sdi/*`. Le richieste browser non possono dichiararsi callback SdI aggiungendo header. La configurazione segue la documentazione Caddy per [client_auth e trust_pool file](https://caddyserver.com/docs/caddyfile/directives/tls), [strict_sni_host](https://caddyserver.com/docs/caddyfile/options#strict_sni_host) e [placeholder TLS](https://caddyserver.com/docs/caddyfile/concepts#placeholders).

Mantenere chiusa la porta 8080 verso Internet e non collegare servizi non fidati alla rete Docker interna. Il DNS del dominio SdI deve arrivare al gateway configurato: un proxy/CDN che termina TLS prima di Caddy altera questa architettura e richiede una progettazione e un collaudo specifici. Non disabilitare la verifica dei certificati per far funzionare una prova.

## Preparare i certificati sul VPS

Il Dockerfile include Node.js 24, Python 3 e lxml; i file di certificato non entrano nell'immagine. I sei file PEM vanno in una directory assoluta esterna alla cartella della release, per esempio `/opt/officina-secrets/sdi-test` nel solo ambiente di collaudo:

| Nome | Uso |
| --- | --- |
| `client-cert.pem` | Certificato client e, quando richiesto, catena per autenticare gli invii |
| `client-key.pem` | Chiave privata corrispondente, in PEM leggibile dal processo senza prompt |
| `remote-ca.pem` | CA che verificano l'identità TLS del servizio SdI remoto |
| `server-cert.pem` | Certificato e catena del dominio callback concordato |
| `server-key.pem` | Chiave privata corrispondente al certificato server |
| `peer-ca.pem` | CA ammesse per i certificati client usati da SdI nelle callback |

I materiali devono appartenere all'ambiente selezionato. Non usare certificati fittizi per attivare la produzione. File PKCS#12/PFX non sono letti direttamente: l'eventuale conversione deve essere eseguita dal gestore dei certificati in modo protetto.

Il container app usa l'utente `node` (UID/GID 1000 nell'immagine fornita). Rendere i tre file degli invii leggibili a tale identità, per esempio proprietario `root`, gruppo `1000`, modalità `0640`; proteggere la directory host con modalità `0700`. I tre file di Caddy possono restare `root:root` con modalità `0600` nella configurazione fornita. I bind mount sono individuali e in sola lettura. Verificare le identità effettive se si cambia immagine, si abilita Docker rootless o si usa un rimappamento degli utenti.

Per ciascun certificato client SdI approvato ricavare l'impronta del certificato finale, non della CA:

```bash
openssl x509 -in /percorso/client-sdi-approvato.pem -noout -fingerprint -sha256
```

Inserire in `SDI_PEER_FINGERPRINTS` le 64 cifre esadecimali, con o senza i due punti, separando più impronte con virgole. Confrontarle con quelle del materiale ufficialmente approvato, non con un certificato ottenuto da una connessione non verificata.

## Variabili e prima configurazione

Usare [`.env.example`](.env.example) come elenco, preservando la `.env` già operativa. Il file è un segreto amministrativo: permessi `0600`, nessuna pubblicazione o inclusione nel pacchetto distribuito.

| Variabile | Valore richiesto |
| --- | --- |
| `OFFICINA_DOMAIN` | `api.magomme.it` per il gestionale indicato |
| `OFFICINA_ORIGIN` | `https://api.magomme.it`, senza slash finale |
| `ACME_EMAIL` | Email amministrativa reale per il normale HTTPS |
| `SHOP_VAT` | Le 11 cifre della partita IVA intestataria; coerente con le fatture |
| `SDI_ENABLED` | `false` finché il canale non deve operare; `true` per avviarlo con i materiali corretti |
| `SDI_ENVIRONMENT` | `test` oppure `production` |
| `SDI_PRODUCTION_APPROVED` | `false` in collaudo; `true` è richiesto esplicitamente in produzione dopo le verifiche esterne |
| `SDI_ACCREDITATION_REFERENCE` | Riferimento effettivo dell'accordo, massimo 200 caratteri |
| `SDI_DOMAIN` | Dominio callback concordato, distinto da `OFFICINA_DOMAIN`; nessun `https://`, percorso o porta |
| `SDI_ENDPOINT` | URL HTTPS esatto dall'accordo per l'ambiente scelto; nessun endpoint precompilato |
| `SDI_ENDPOINT_HOST` | Host esatto dello stesso URL |
| `SDI_PEER_FINGERPRINTS` | Impronte SHA-256 dei certificati client SdI approvati |
| `SDI_GATEWAY_TOKEN` | Segreto casuale condiviso soltanto fra Caddy e app, 43–128 caratteri Base64URL |
| `SDI_SECRETS_DIR` | Percorso assoluto della directory dei sei PEM, esterna alla release |
| `SDI_TIMEOUT_MS` | Timeout singolo invio, predefinito `30000`, da `1000` a `60000` ms |
| `CADDY_IMAGE` | Immagine Caddy 2 con la sintassi `trust_pool`; validare e poi fissare versione/digest prima della produzione |

Generare il token sul VPS e salvarlo nella `.env` protetta, senza inserirlo nei comandi di prova o nei log condivisi:

```bash
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'
```

Il controllo applicativo ammette soltanto HTTPS sulla porta ordinaria, senza credenziali nell'URL, query o frammenti, su host appartenenti ai domini istituzionali previsti dal codice e uguali a `SDI_ENDPOINT_HOST`. Per il collaudo il primo elemento dell'host deve contenere `test` o `collaudo`; in produzione deve esserne privo. Questa è una barriera prudenziale del software, non una regola ufficiale del protocollo: se l'accordo usa un diverso host legittimo occorre aggiornare e testare il controllo, senza inventare un endpoint o scegliere un ambiente errato per aggirarlo.

L'override monta i file in `/run/sdi` e imposta automaticamente `SDI_CLIENT_CERT_PATH`, `SDI_CLIENT_KEY_PATH` e `SDI_REMOTE_CA_PATH`. Anche con `SDI_ENABLED=false`, l'override richiede le altre variabili e i file: per una normale installazione senza credenziali usare soltanto `compose.yaml`.

## Avvio e prove sul VPS

I comandi seguenti sono per Bash su VPS Linux, dalla cartella della release. Iniziare nell'installazione separata di collaudo. I comandi non inviano una fattura da soli, ma l'avvio con `SDI_ENABLED=true` elabora eventuali voci già in coda: controllare sempre l'archivio dell'ambiente prima di riavviare un canale già usato.

Con tutti i valori reali e i certificati installati, validare senza stampare la configurazione espansa, che contiene il token:

```bash
docker compose -f compose.yaml -f compose.sdi.yaml config --quiet
docker compose -f compose.yaml -f compose.sdi.yaml build app
docker compose -f compose.yaml -f compose.sdi.yaml run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Per verificare nel container che configurazione e certificati degli invii siano leggibili, senza aprire una connessione SdI:

```bash
docker compose -f compose.yaml -f compose.sdi.yaml run --rm --no-deps app node --input-type=module -e 'import {readSdiConfig} from "./server/sdi-config.mjs"; import {loadSdiCredentials} from "./server/sdi-transport.mjs"; const config=readSdiConfig(); if(!config.enabled) throw Error("Impostare SDI_ENABLED=true nell’ambiente da verificare"); const credentials=loadSdiCredentials(config); console.log("Certificati invio verificati; scadenza:",new Date(credentials.expiresAt).toISOString());'
```

Questo controllo non dimostra l'accettazione dei certificati da parte di SdI, la disponibilità della rete o il completamento dell'accreditamento. Dopo le verifiche locali avviare il canale nell'ambiente autorizzato:

```bash
docker compose -f compose.yaml -f compose.sdi.yaml up -d --wait app
docker compose -f compose.yaml -f compose.sdi.yaml up -d caddy
docker compose -f compose.yaml -f compose.sdi.yaml ps
```

Accedere al gestionale e aprire **Fatture → Canale SdI · invii e ricezioni**. Lo stato deve indicare l'ambiente atteso. **Configurato** significa che i controlli locali sono passati; non è una certificazione della raggiungibilità o dell'accreditamento.

Completare le prove previste dall'accordo. Verificare anche che il normale dominio non accetti callback, che il dominio SdI rifiuti certificati assenti/sconosciuti e SNI/Host discordanti, e che una consegna duplicata non generi un secondo documento. Le prove di ricezione vanno effettuate attraverso il gateway reale, senza chiamare direttamente l'app o inserire manualmente il suo token.

Per rendere persistente la scelta dell'override su un'installazione attivata, aggiungere alla sua `.env`:

```dotenv
COMPOSE_FILE=compose.yaml:compose.sdi.yaml
```

Su Linux il separatore è `:`. Così anche gli script di manutenzione che richiamano `docker compose` mantengono la configurazione del canale. Gli argomenti espliciti `-f` prevalgono su questa scelta. Vedere le [variabili predefinite di Docker Compose](https://docs.docker.com/compose/how-tos/environment-variables/envvars/#compose_file). Non aggiungere questa riga alle installazioni prive dei certificati.

## Operazioni quotidiane

Per inviare, confermare e numerare la fattura, attendere il salvataggio sul server, aprirla e usare **Invia allo SdI** (oppure **Invia al collaudo SdI** nell'ambiente test). Verificare la conferma che mostra documento e ambiente. Gli utenti in sola lettura non possono inviare. Prima del primo invio controllare che il documento non sia già stato trasmesso con un altro servizio: il canale conosce solo il proprio archivio.

Una risposta dell'API `202` attesta la registrazione nella coda interna, non l'emissione fiscale. La risposta positiva del servizio remoto assegna l'identificativo SdI; gli esiti successivi compaiono nel dettaglio dell'invio. Il nome file usato dal trasporto può differire dal nome dell'esportazione precedente per rispettare il progressivo massimo di cinque caratteri: l'XML archiviato e il numero della fattura non vengono alterati.

| Stato | Significato e azione |
| --- | --- |
| In coda | Documento salvato, tentativo non ancora iniziato. Alla ripartenza ordinaria può essere inviato. |
| Invio in corso | Tentativo già preso in carico. Non creare un secondo documento. |
| Ricevuta dallo SdI · attesa esiti | Risposta di trasporto positiva o ricevuta correlata; attendere/verificare l'esito fiscale. |
| Consegnata | È stata correlata una ricevuta di consegna valida per il canale. Consultare l'originale. |
| Mancata consegna | Consultare la notifica e applicare gli adempimenti pertinenti al documento; non equivale a scarto. |
| Scartata | Leggere i codici e l'originale della notifica. L'originale inviato resta immutabile. |
| Trasporto rifiutato | Il servizio ha restituito un errore di trasporto riconosciuto; consultare il dettaglio. |
| Esito incerto | Timeout, interruzione, ripristino o risposta non verificabile. Nessun reinvio automatico. Riconciliare con gli esiti ufficiali. |
| Esiti discordanti / da abbinare | Gli originali sono conservati, ma non esiste un esito conclusivo affidabile. Serve verifica tecnica. |

**La correzione e ritrasmissione controllata dopo scarto o rifiuto non è implementata in questa versione.** Non modificare/eliminare la fattura già affidata al canale, non forzare il database e non creare automaticamente un nuovo numero per riprovare. Conservare documento e ricevuta, verificare il caso con chi segue la contabilità e predisporre un flusso di correzione che rispetti identità fiscale, numerazione e tracciabilità. Anche per un esito incerto verificare prima se SdI ha già ricevuto il documento. Una successiva callback autentica può chiarire l'esito senza inviare di nuovo.

I pagamenti possono essere aggiornati anche dopo l'invio; gli elementi fiscali e l'XML affidati al canale restano bloccati. Il pulsante non reinvia una registrazione esistente.

Per gli acquisti aprire il dettaglio delle fatture ricevute, scaricare l'originale e verificare il registro **Fatture fornitori**. Le fatture in collaudo e quelle da verificare non vanno considerate nuovi debiti certi. La consegna SOAP positiva conferma la conservazione del messaggio, anche se il suo contenuto richiede poi esame manuale.

PEC e canale diretto sono ingressi distinti. Se entrambi vengono mantenuti, verificare il recapito effettivo e gli eventuali duplicati nel registro: l'attivazione SdI non sposta automaticamente i messaggi PEC e non recupera lo storico di un altro servizio.

## Aggiornamento, backup e ripristino

La migrazione porta il database alla versione **5** e aggiunge le tabelle SdI. Prima dell'aggiornamento salvare un backup verificato e la precedente immagine, completare i salvataggi degli operatori e conservare le bozze. Distribuire tutta la release, mantenendo dati, `.env` e segreti esterni. Seguire anche [README-VPS.md](README-VPS.md).

Su un canale già attivo mantenere entrambi i file Compose, tramite `COMPOSE_FILE` nella `.env` o la stessa variabile di ambiente. Esempio di backup coerente:

```bash
COMPOSE_FILE=compose.yaml:compose.sdi.yaml bash deploy/backup.sh
```

Copiare il backup e il checksum su storage esterno protetto; provare periodicamente il ripristino in un ambiente isolato, con SdI disattivato. Il backup del database non comprende `.env`, chiavi e certificati: gestirne una copia cifrata separata con accesso limitato. Gli originali conservati nel database non sono un servizio di conservazione a norma.

Per aggiornare dopo il backup:

```bash
docker compose -f compose.yaml -f compose.sdi.yaml build app
docker compose -f compose.yaml -f compose.sdi.yaml up -d --wait app
docker compose -f compose.yaml -f compose.sdi.yaml up -d caddy
```

Durante un riavvio ordinario le voci **In coda** possono proseguire; un tentativo interrotto diventa **Esito incerto**. Pianificare la finestra di manutenzione e verificare prima e dopo le voci pendenti. Per tornare a una versione precedente non riutilizzare alla cieca un database già migrato: un ripristino del backup può perdere gli eventi SdI successivi e richiede riconciliazione, oltre al ripristino del codice.

Il ripristino è un intervento amministrativo che sostituisce tutto il database e gli utenti. Prima impostare `SDI_ENABLED=false` nella `.env`, ricreare l'app con la configurazione del canale e registrare quali invii/notifiche sono successivi al backup. Conservare il database corrente. Usare la procedura prevista:

```bash
COMPOSE_FILE=compose.yaml:compose.sdi.yaml bash deploy/restore.sh /percorso/backup.sqlite --confirm-restore
```

La CLI di questa release trasforma le voci recuperate **In coda** e **Invio in corso** in **Esito incerto**, per impedirne la ritrasmissione automatica. Rimangono da confrontare con SdI anche gli invii assenti da un backup troppo vecchio: nessun ripristino può ricostruire automaticamente i fatti avvenuti dopo la copia. Riattivare solo dopo questa riconciliazione. Non ripristinare copiando direttamente il solo file SQLite durante l'esecuzione e non usare una vecchia CLI priva di questa protezione.

## Sospensione e rotazione dei certificati

Per sospendere il canale impostare `SDI_ENABLED=false` e ricreare l'app. Questa scelta sospende sia invii sia callback; non elimina gli originali e non cancella le voci in coda. Le callback ricevono errore e la loro ripetizione dipende dalle regole e dai limiti SdI. La sospensione richiede quindi una finestra controllata, non costituisce una modalità permanente di ricezione.

Se i file dei certificati non sono più disponibili, è possibile ripartire con il solo profilo ordinario:

```bash
docker compose -f compose.yaml up -d --wait app
docker compose -f compose.yaml up -d caddy
```

L'archivio dell'ambiente precedentemente usato resta consultabile, ma il dominio callback non è più servito dal Caddyfile ordinario. Prima di una successiva riattivazione verificare tutte le voci pendenti. Se era presente `COMPOSE_FILE` nella `.env`, aggiornarlo coerentemente per evitare che una manutenzione futura riattivi per errore l'override.

Per la rotazione, ottenere i materiali approvati per lo stesso canale, verificare catene, scadenze e corrispondenza chiave/certificato, sostituire i file esterni in modo controllato e validare di nuovo. Ricreare **app e Caddy** per rimontare anche i file sostituiti atomicamente; il solo reload può mantenere un vecchio bind mount. Durante una rotazione pianificata dei chiamanti SdI, la lista di impronte può contenere vecchia e nuova identità per il periodo concordato; rimuovere quella ritirata dopo la verifica. Non impostare wildcard o liste di CA pubbliche generiche per superare un errore.

La verifica locale delle credenziali degli invii rileva file mancanti, certificato scaduto e chiave discordante. Non è un monitor delle scadenze del certificato server né un sistema automatico di controllo revoche: predisporre il monitoraggio operativo dei materiali del canale e lo spazio disco del database.

## Diagnostica e limiti verificati

Consultare prima il banner del canale e il dettaglio dei documenti. Per la salute dei servizi usare `docker compose ps` con la configurazione corretta. I log tecnici possono essere letti con `docker compose logs --tail=100 app caddy`, verificando che il comando usi entrambi i file quando necessari. Non condividere `.env`, output di `docker compose config` senza `--quiet`, chiavi, token o fatture integrali in log di assistenza.

Una callback fallita prima della persistenza non riceve conferma positiva. I messaggi sono limitati a 18 MB dal gateway, senza compressione HTTP in ingresso; al backend sono consentite al massimo due elaborazioni di callback contemporanee. Un errore temporaneo non autorizza la cancellazione del messaggio o una modifica manuale delle ricevute.

La suite automatica comprende verifiche locali del protocollo, dello store, delle API e del coordinatore, oltre a prove HTTPS mTLS con identità sintetiche. Sono state verificate credenziali mancanti/scadute/discordanti, identità TLS del server, timeout, risposte troppo grandi, mancata ripetizione degli invii, acquisizione persistente prima dell'ACK, duplicati e separazione collaudo/produzione. Queste prove non attestano l'interoperabilità con un canale SdI accreditato. Conservare l'esito del collaudo reale e la configurazione approvata prima della messa in esercizio.

Per ripetere i test sul codice sorgente, con Node.js 24 e Python con lxml disponibili, eseguire `npm run test:sdi`. Su Windows impostare `OFFICINA_PYTHON` al percorso dell'interprete, se `python` non è quello configurato. Le prove browser si avviano con `npm run test:sdi-browser` e richiedono Playwright e Chromium. Questi test usano archivi temporanei e trasporti sintetici: non trasmettono fatture allo SdI.

Se il processo di invio incontra un errore imprevisto nel registrare un esito, si blocca e mantiene l'avviso fino al riavvio del server. Le callback possono ancora essere acquisite se il database è disponibile. Risolvere prima la causa (per esempio spazio disco) e verificare gli esiti; il riavvio trasforma i tentativi interrotti in esiti incerti senza ripeterli. Non riavviare in ciclo per nascondere un errore.
