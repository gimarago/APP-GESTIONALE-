# Verifiche della versione in rete

Preparazione e verifiche locali del 22 settembre 2026. Le prove usano esclusivamente dati sintetici e database separati. Il pacchetto non contiene il database di produzione, credenziali o utenti predefiniti.

## Esiti della versione 2

- **24 test server/avvio locale superati** con Node.js 24.19. Coprono autenticazione, ruoli, cookie, CSRF/origine, scadenza e revoca delle sessioni, migrazione, modifiche concorrenti, transazioni e rollback, riavvio, SSE, percorsi statici, validazione dati e limiti dei tentativi di accesso.
- **20 inserimenti concorrenti di clienti diversi: 20 confermati e tutti conservati**, senza prenotazioni di modifica.
- Modifiche contemporanee a clienti diversi si combinano; modifica della stessa voce, eliminazione contro aggiornamento e ricreazione dopo eliminazione rifiutano le copie obsolete.
- Due scarichi dello stesso articolo, anche con lo stesso valore finale, confermano una sola operazione. Il secondo intervento non viene salvato parzialmente. Un intervento basato su magazzino non aggiornato viene rifiutato anche quando non modifica direttamente una riga di scorta.
- Verificati inserimenti indipendenti di post-it, preventivi e conti cassa; pagamenti concorrenti sullo stesso conto vengono protetti anche quando uno modifica solo la registrazione del pagamento. Il registro e la numerazione fatture sono una sola unità atomica.
- Ritentativi dopo risposta persa e riavvio riconoscono l'operazione già applicata. Un errore di scrittura simulato annulla insieme dati, versioni, ricevuta e audit.
- Verificati importazione iniziale solo amministratore/archivio vuoto, identità stabili nella migrazione, backup online, ripristino a server fermo e revoca delle vecchie sessioni.
- **55 test del gestionale precedente superati**, inclusi fatturazione, cassa, importazioni e magazzino. I controlli XML usano Python/lxml locale e non costituiscono certificazione SdI.
- **20 scenari browser superati** con **due contesti Chrome separati**, uno con viewport 390×844: entrambi possono modificare subito, senza turno. Verificati moduli cliente compilati contemporaneamente, conservazione di un modulo aperto mentre arriva un aggiornamento, inserimenti simultanei di articoli e appuntamenti con identificativi e conti cassa distinti, sincronizzazione, scarico pneumatici, riconnessione, risposta persa e conservazione delle bozze in conflitto durante successivi salvataggi.
- Un intervento completato scarica **2 pneumatici da 12**: dopo la ricarica sul secondo dispositivo rimangono **10**, senza scarico ripetuto; l'importo resta **125,50 €**.

## Ripristino font del 23 settembre 2026

Manrope (pesi 400–800) e DM Mono (400 e 500) sono inclusi come file locali con licenze SIL Open Font License e hash delle sorgenti. Verificati nel browser il caricamento di tutti i pesi e l'effettivo uso dei font nelle scritte, tramite i font renderizzati riportati da Chrome. Tutte le richieste esterne erano bloccate: nessuna richiesta a Google Fonts o altri siti, nessun errore JavaScript. Controllate visivamente le schermate a 1440×1000 e 390×844. Verificati il tipo HTTP `font/ttf`, il rifiuto di file font non autorizzati e il test esistente sui percorsi statici del server.

## Conflitti senza modifiche visibili: 9 ottobre 2026

- **219 test automatici superati**, comprendendo 13 regressioni sulle dipendenze degli interventi dal magazzino e 6 sulla conservazione degli scarichi dei consumabili.
- Riprodotto e corretto il salvataggio automatico di controlli grafici dopo la ricezione di uno stato remoto: una pagina mobile in consultazione non invia modifiche alle scorte e conserva le modifiche locali effettive.
- Verificati PC e viewport mobile con lo stesso account: apertura e chiusura di una scheda senza modifiche non inviano salvataggi; una nota può essere salvata anche dopo un aggiornamento indipendente del magazzino; un vero scarico concorrente continua a essere rifiutato senza sovrascrivere il vincitore.
- Verificato anche il periodo prima dell'invio del salvataggio: due scarichi indipendenti con la stessa quantità finale mantengono le versioni originali e non vengono fusi; una lavorazione che richiede il magazzino conserva la propria versione di riferimento. La prova è **npm run test:presend-inventory-fence**.
- Il controllo delle scorte legge lo stato selezionato e le lavorazioni/deduzioni effettive. Le opzioni non selezionate, i marcatori grafici, le note, i chilometri e gli importi non creano da soli una dipendenza dal magazzino.
- Verificati conteggi inventario, ricezione dei dati precedenti alla normalizzazione grafica, conservazione delle quantità contate e rifiuto atomico delle sostituzioni concorrenti.
- Le prove usano database temporanei e dati sintetici. Il VPS operativo e i telefoni fisici non sono stati modificati o collaudati; serve installare il pacchetto aggiornato, riavviare il servizio e ricaricare le pagine aperte.

## Vendite durante una bozza di inventario: 9 ottobre 2026

- **252 test automatici superati**, inclusi 33 nuovi test sull'aggiornamento delle quantità contate durante vendite e storni. Coperti anche litri, articoli non contati, quantità insufficienti, prima vendita senza storico, testi di conteggio incompleti e movimenti ambigui.
- Verificata una conta fisica di 10 pezzi rispetto a 12 attesi: una vendita di 2 aggiorna insieme le giacenze a 10 e il conteggio a 8. La differenza di −2 rilevata dall'inventario resta conservata. Una seconda vendita e lo storno della prima mantengono la bozza coerente, anche chiusa e dopo il ricaricamento.
- Verificati PC e viewport mobile con lo stesso account: le quantità si aggiornano nella finestra aperta, sul dispositivo che vende e nella bozza chiusa. L'applicazione finale usa il conteggio aggiornato e non reinserisce le scorte vendute. Prova: **npm run test:inventory-count-sales**.
- Verificati vendite durante il resoconto, prima assegnazione dell'identificativo dell'articolo e risposta di sincronizzazione iniziata prima del salvataggio: una vecchia risposta non può sostituire né il conteggio generato dal server né una successiva nota già confermata. Prova: **npm run test:inventory-count-sales-refresh**.
- Le righe generate hanno versioni e audit propri; la risposta di conferma ne richiede la lettura prima di adottare le versioni. Ritentativi e riavvio non ripetono lo scarico. Errori di validazione o scrittura annullano insieme magazzino, bozza, versioni e ricevuta.
- Ripetute con esito positivo le verifiche dell'inventario esistente, le 10 prove di sincronizzazione dal vivo e le 23 di navigazione. Modifiche manuali alle scorte e veri conflitti continuano a proteggere la bozza.
- Le prove usano dati sintetici e database temporanei. Per attivare la funzione in officina occorre aggiornare il pacchetto sul VPS, riavviare il servizio e ricaricare le pagine aperte; il VPS operativo non è stato modificato.

## Targa facoltativa e grafico per settore: 10 ottobre 2026

- **252 test automatici superati**. Ripetute con esito positivo le prove browser di chilometri e ordinamento appuntamenti, prenotazione da preventivo, raggruppamento clienti ed eliminazione dei veicoli.
- **npm run test:appointment-optional-plate** verifica interventi senza targa, clienti distinti senza targa, completamento, annullamento, aggiunta successiva di targa e modello, stampa con i dati appena compilati, ricaricamento e lettura su una seconda sessione con viewport mobile. Il cliente conserva identificativo, contatti e ultimo intervento.
- Verificati clienti diversi con la stessa targa: l'associazione rimane nel cliente corretto. Una targa già presente per lo stesso cliente unisce soltanto la voce temporanea senza targa, conservando il veicolo noto, i collegamenti e la data di intervento più recente. Salvare soltanto note o lavorazioni non ricrea un veicolo eliminato.
- **npm run test:revenue-report** verifica un'unica voce **Pneumatici e servizi** in grafico, legenda e riepilogo, mantenendo **Tagliandi** distinto. Verificati importi con decimali, giorno/settimana/mese/anno, confronto, riapertura del lavoro e layout desktop/mobile. Controllate visivamente le nuove caselle della scheda di accettazione.
- Prove su dati sintetici e database temporanei, senza modificare il VPS operativo. L'attivazione richiede il pacchetto aggiornato sul VPS, il riavvio del servizio e il ricaricamento delle pagine aperte.

## Destinazione cassa, richiami, targhe e stampa: 11 ottobre 2026

- **256 test automatici superati**, inclusi i nuovi controlli delle targhe e le regressioni di importazione, pneumatici e decimali.
- Riprodotto il reset ritardato del parcheggio che riportava su **In cassa** la scheda aperta. **npm run test:cash-editor-preservation** verifica apertura, annullamento, salvataggio invariato e ricaricamento per lavori fuori cassa, in cassa e ripartiti, sia in accettazione sia nel parcheggio. Coperti acconti, lavori riaperti, cambio esplicito del solo residuo e modifica contabile più recente mentre la scheda è aperta. Superati anche i test esistenti di destinazione cassa e acconti.
- **npm run test:dashboard-recalls** verifica richiami manuali e automatici nel cruscotto, ricaricamento, aggiornamento e cancellazione da sincronizzazione, consultazione e assenza di salvataggi generati dal riepilogo. Superate le regressioni di richiami per veicolo e sincronizzazione storage.
- **npm run test:plate-formats** verifica sette formati di targa, inclusi moto, Germania, Regno Unito, Spagna, Svizzera, Belgio e numerici: lettura delle righe precedenti, apertura, modifica, salvataggio, ricaricamento e ricerca con separatori differenti. Importo 100,75 e magazzino restano invariati. Ripetute le prove di targa facoltativa e scadenze parcheggio.
- **npm run test:print-no-address** stampa realmente sei documenti A4 multipagina e un'etichetta con intestazioni/piè di pagina Chromium abilitati. Nessun indirizzo server nei documenti, margini conservati su ogni pagina e contenuti finali presenti. La prova negativa con i vecchi margini rileva l'IP. Verifica dei PDF tramite Python con `pdfplumber`; `PYTHON_PATH` o `PYTHON_COMMAND` indica l'eseguibile. Superata anche la regressione dei preventivi e la risposta di stampa nativa opzionale.
- App Windows ricompilata come **1.0.2** per includere il nuovo stile nativo. 11 test del bridge e 7 Rust superati. Nessuna stampa fisica effettuata e nessun collaudo dei dispositivi mobili reali.
- Prove su dati sintetici e database temporanei. Il VPS operativo non è stato modificato: per attivare le correzioni occorre installare il pacchetto aggiornato sul VPS, riavviare il servizio e ricaricare le pagine aperte.

## Ripetere i test

Nella cartella del pacchetto, con Node.js 24:

```text
node --test server/server.test.mjs server/local.test.mjs
```

Il test browser richiede Playwright (verificato con 1.62.1) e Chromium/Chrome. Installarli in un ambiente di sviluppo, non nel container del VPS:

```text
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
node tests/browser-e2e.cjs
```

È possibile usare un Chrome già installato impostando `CHROME_PATH` al suo eseguibile. `PLAYWRIGHT_MODULE` consente di indicare un modulo Playwright già disponibile. I test browser usano la porta locale 8128 e creano dati e una schermata di prova in una cartella temporanea distinta. Non indicare loro il database aziendale.

## Verifiche ancora da eseguire nell'ambiente finale

Docker, Caddy, i certificati pubblici e gli script Bash/systemd non sono stati eseguiti qui: Docker e Bash non sono disponibili in questo ambiente Windows. Servono il collaudo sul VPS e una prova con i dispositivi effettivi, in particolare Safari/iOS. Una viewport mobile in Chrome non equivale a un collaudo su iPhone o Android fisico.

Questa versione consente modifiche simultanee per singola voce. Non fonde automaticamente due intenzioni incompatibili sulla stessa voce: rifiuta il salvataggio in conflitto e conserva la bozza. Il registro fatture, alcune cronologie e impostazioni restano unità indivisibili. I controlli sugli interventi collegati al magazzino possono richiedere l'aggiornamento anche dopo una modifica di un altro articolo. Il salvataggio centrale è confermato dalla barra superiore.

Le bozze sono copie di recupero della scheda, non backup: scaricarle prima di chiudere la scheda o eliminare i dati del browser. Una bozza non confermata resta separata dai successivi salvataggi. “Elimina bozze scaricate” richiede conferma e riguarda soltanto le copie locali. Il backup amministrativo del database include anche utenti e registri delle operazioni; l'esportazione JSON dalla schermata include i soli dati applicativi.

Seguire [README-VPS.md](README-VPS.md) per installazione, migrazione e collaudo operativo.
