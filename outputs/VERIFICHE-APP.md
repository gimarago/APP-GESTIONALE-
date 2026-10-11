# Verifiche Officina App

## Windows 1.0.1 — 8 ottobre 2026

Corrette le pagine bianche nella stampa nativa. Tauri riscriveva l'indirizzo data URL del documento e aggiungeva la CSP del launcher: la finestra respingeva la navigazione e avviava la stampa su una pagina vuota. Ora riceve il documento già sanitizzato da un protocollo interno, accessibile soltanto alla finestra di stampa per la richiesta attiva. La stampa Windows attende documento, immagini, font e layout; la chiusura elimina il contenuto dalla memoria.

- Compilazione release Windows x64 e installer NSIS 1.0.1 riusciti usando le dipendenze già disponibili.
- Bridge: 11 test superati. Il nuovo test usa l'HTML VPS e l'editor di accettazione reali, verifica le modifiche non salvate e l'importo 100,75 nel documento trasferito al servizio nativo.
- Plugin Rust: 7 test superati. Verificati URL originale e mappato da WebView2, origine e percorso riservati, contenuto sanitizzato, accesso esclusivo della finestra di stampa e rimozione del documento alla chiusura.
- La risposta HTML effettiva del protocollo è stata renderizzata con Chrome in modalità stampa: testo e importo visibili, CSS applicato e PDF A4 di una pagina. Screenshot ispezionato.
- Non è stata eseguita una stampa fisica, né una prova interattiva della nuova anteprima WebView2 sul PC dell'utente. I test del bridge usano una risposta nativa simulata; il test del rendering usa Chrome.

Installer: `Officina-Windows-1.0.1-setup.exe`. Sorgenti: `Officina-App-Sorgenti-1.0.1.zip`. Questa correzione non richiede modifiche al VPS. L'APK Android consegnato resta alla versione 1.0.0; non è stato ricompilato per questo aggiornamento Windows.

## Verifiche della versione 1.0.0

Data: 3 ottobre 2026. Server configurato: `https://api.magomme.it/`.

## Pacchetti

- Windows x64: compilazione release Rust e installer NSIS riusciti. Installer per utente corrente, con WebView2 come prerequisito. Nessuna firma commerciale Windows applicata.
- Android ARM64: compilazione Rust, Kotlin, risorse e ottimizzazione release R8 riuscite. APK firmato con chiave RSA privata dell'app; firma v2/v3 verificata con `apksigner`. Verificato `zipalign -c -P 16 4`; segmenti ELF della libreria nativa allineati a 16 KB.
- Android: identificativo `it.magomme.officina`, versione `1.0.0`, versionCode `1000000`, Android minimo 8 (API 26), target API 37. Il manifest release non dichiara `debuggable`. Permessi: Internet e permesso interno per ricevitori non esportati.
- iPhone: sorgenti Tauri e plugin Swift preparati e revisionati. Non compilati su macOS, non firmati e non provati su iPhone.
- ZIP sorgenti verificato: include lockfile Rust/npm, icone, plugin Android/iOS, test e istruzioni. Esclude toolchain, cache, progetti generati con percorsi locali, database e chiavi private.
- ZIP VPS aggiornato e verificato. Non è stato pubblicato automaticamente sul server.

## Test automatici

- Bridge JavaScript: 10 test passati, inclusi download PDF con contenuto preservato, nome file da risposta server, iframe, stampa, dimensioni etichette, collegamenti modificati dal gestore della pagina, domini non autorizzati e tasto Indietro Android con attesa del salvataggio.
- Server: 23 test passati, inclusi autenticazione, CSRF, ruoli, concorrenza, backup e ripristino in archivi temporanei.
- Preventivi: passati gli scenari browser di attesa del salvataggio nativo, annullamento, condivisione mobile senza apertura automatica dell'email, indirizzi legale/operativo nel PDF, eliminazione selettiva e limitazioni del ruolo di consultazione.
- Rust: 7 test passati (3 sulle politiche URL e 4 sulla validazione documenti), eseguiti separatamente dalle prove sui dispositivi.

## Limiti della verifica

Non sono state utilizzate credenziali reali né modificati clienti, fatture o lavori del VPS. La verifica pubblica del server ha ricevuto HTTP 200 da `/api/health` e dalla schermata di accesso. Il server, al momento della verifica, aveva ancora la precedente Content Security Policy: aggiornare il VPS con lo ZIP consegnato prima dell'uso delle nuove funzioni native.

La prova della finestra Windows nell'ambiente protetto di compilazione non è stata completata: la cartella AppData è stata negata dal sistema; anche con un profilo debug nella cartella di lavoro non è stato possibile collegarsi al WebView per verificare la pagina. Non si considera quindi dimostrato l'avvio interattivo dell'installer sul PC dell'utente.

Non sono disponibili prove su un telefono Android o iPhone fisico. Prima dell'uso quotidiano verificare accesso/uscita, PDF preventivo, annullamento del salvataggio, WhatsApp/email, stampa, selezione di file, tastiera, rotazione e ripristino dopo assenza di rete. Eseguire le prove che modificano dati con record di collaudo riconoscibili.

## Firma Android

La chiave è conservata separatamente in `Officina-Android-firma-privata`, esclusa dagli ZIP. Conservare chiave e password per gli aggiornamenti. Impronta SHA-256 pubblica del certificato:

`2a07cdc65c013ad2697d8fbf47600f536193e04972e4070048aae02d241caa6e`

I file `.sha256` accanto ai pacchetti consentono di verificare che il trasferimento non li abbia alterati; non sostituiscono una firma commerciale Windows.
