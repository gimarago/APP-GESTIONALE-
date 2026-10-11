# Officina M.A. Gomme — app collegate al VPS

Progetto Tauri 2 per Windows, Android e iPhone. Il gestionale si apre all’indirizzo **https://api.magomme.it/** dentro l’app. Accessi, autorizzazioni e archivio rimangono quelli del VPS. Non sono inclusi database, password, certificati SdI o un server locale.

## Cosa cambia rispetto al sito

- Icona e finestra dedicate; controllo della connessione all’avvio e possibilità di riprovare.
- Download dei PDF, XML, CSV e backup JSON tramite una finestra di salvataggio su Windows e il pannello di condivisione su Android/iPhone.
- Stampa di moduli, schede ed etichette tramite le finestre del dispositivo. Le stampanti disponibili dipendono da Windows, dai servizi di stampa Android o da AirPrint.
- Email, telefono e WhatsApp si aprono nelle applicazioni esterne. Un pannello di condivisione aperto non significa che il documento sia stato inviato.
- Interfaccia caricata dal VPS: dopo un aggiornamento del server, chiudere e riaprire l’app per caricare il nuovo codice. Dalla versione Windows 1.0.3, **Aggiornamenti** permette di cercare, scaricare e installare una nuova versione del programma, con riavvio dopo la conferma dei salvataggi. [Attivazione e pubblicazione degli aggiornamenti](AGGIORNAMENTI-WINDOWS.md).

Serve una connessione Internet. Non è implementata una modalità di lavoro offline con sincronizzazione successiva.

## Prima dell’uso

Aggiornare il VPS con la versione del gestionale fornita insieme a questo progetto. Include il collegamento tra WebView e funzioni native nella Content Security Policy e il flusso dei preventivi che attende il salvataggio prima di aprire l’email. Non cambia il contenuto del database.

Il sorgente carica la pagina HTTPS come documento principale, mantenendo nello stesso dominio la schermata `/legacy` e le API. Non cambiare questo schema in un iframe remoto dentro una pagina locale: cookie, CSRF e comunicazione fra le due schermate dipendono dalla stessa origine.

## Compilazione Windows

Prerequisiti: Node.js LTS, Rust MSVC e Visual Studio Build Tools con **Sviluppo desktop con C++** e Windows SDK. [Prerequisiti ufficiali Tauri](https://v2.tauri.app/start/prerequisites/).

Da questa cartella, in PowerShell:

```powershell
npm ci
npm run doctor
```

Per la compilazione firmata di Windows seguire [AGGIORNAMENTI-WINDOWS.md](AGGIORNAMENTI-WINDOWS.md): occorre caricare la chiave privata e la password nelle variabili richieste prima di `npm run build:windows`. La chiave non è inclusa nello ZIP sorgente.

L’installer si trova in `src-tauri/target/release/bundle/nsis/`. Installa l’app per l’utente corrente e, se manca, scarica il runtime WebView2. Il progetto non contiene un certificato commerciale di firma Windows: la firma va configurata separatamente prima di una distribuzione pubblica. Non ignorare avvisi di firma di file da fonti sconosciute.

## Compilazione Android

Installare Android Studio, il suo JDK, SDK/Build Tools e NDK. Configurare `JAVA_HOME`, `ANDROID_HOME` e `NDK_HOME` secondo i [prerequisiti Tauri](https://v2.tauri.app/start/prerequisites/#android).

La versione qui verificata usa JDK 17, NDK 28.2.13676358, SDK Platform 37 e 36 (quest'ultimo serve al plugin ufficiale che apre i collegamenti), Build Tools 36.0.0. Su Windows la CLI Tauri crea collegamenti simbolici: la modalità sviluppatore di Windows deve consentirli. Non è necessaria per installare l'APK sul telefono.

```text
npm ci
rustup target add aarch64-linux-android
npm run android:init
npm run icons
npm run android:dev
```

Per creare l’APK:

```text
npm run android:build
```

Il progetto Android generato si trova in `src-tauri/gen/android`. Un APK di release deve essere firmato prima dell’installazione: seguire la [procedura ufficiale](https://v2.tauri.app/distribute/sign/android/) e conservare al sicuro il keystore per gli aggiornamenti futuri. Il keystore e le password non vanno inclusi nel repository o nello ZIP sorgente. Per Google Play si produce invece un AAB con `npm run tauri -- android build --aab --target aarch64`.

## iPhone: dal Mac

Sul Mac occorrono Xcode completo, Rust, Node.js, CocoaPods e il tuo account Apple Developer. Non inviare password o certificati privati in chat.

```sh
npm ci
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm run ios:init
npm run icons
npm run ios:dev
```

Aprire il progetto generato in `src-tauri/gen/apple`, scegliere il proprio Team in **Signing & Capabilities** e collegare l’iPhone. L’identificativo dell’app è `it.magomme.officina`: deve essere registrato nel proprio account.

Su un Mac Intel, per il simulatore aggiungere anche `rustup target add x86_64-apple-ios`. La cartella `gen` viene creata sul Mac: non è inclusa nello ZIP perché contiene percorsi specifici del computer che la genera.

Per distribuire ai dispositivi tramite TestFlight, creare l’archivio da Xcode e caricarlo su App Store Connect. Una build iOS non si installa copiando un file ZIP sull’iPhone. La distribuzione TestFlight/App Store richiede i passaggi di firma e revisione Apple; questo progetto non li esegue automaticamente. [Guida Tauri per App Store](https://v2.tauri.app/distribute/app-store/).

## Verifiche

Lo stato dei pacchetti consegnati e i limiti delle prove sono in [VERIFICHE.md](VERIFICHE.md).

```sh
npx playwright install chromium
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -p tauri-plugin-officina-documents
```

I test JavaScript usano pagine simulate e un collegamento nativo simulato: verificano i documenti trasferiti e la gestione degli errori, ma non sostituiscono le prove di stampa/condivisione sui dispositivi. `PLAYWRIGHT_MODULE` e `CHROME_PATH` possono indicare un’installazione già disponibile.

Solo nelle build debug Windows, `OFFICINA_TEST_PROFILE` permette di indicare una cartella assoluta temporanea per il profilo WebView2 dei test. Le build release ignorano questa variabile e usano il profilo dell'utente in AppData.

Prima di distribuire: provare accesso/uscita, salvataggio di un lavoro, PDF preventivo, annullamento del salvataggio, email/WhatsApp, stampa di un modulo firmato, importazione file, perdita/ripristino rete, rotazione e tastiera su telefono. Eseguire prove che modificano dati in un ambiente di collaudo o su record di prova riconoscibili.

## Permessi nativi

Solo `https://api.magomme.it` nella finestra principale può richiedere esportazione documenti, stampa e apertura di collegamenti autorizzati. Non sono concessi accesso generico ai file, shell, SQL, fotocamera o microfono. I documenti di stampa vengono ripuliti da script e risorse esterne. Le copie per condivisione mobile sono temporanee nella cache privata dell’app; quelle più vecchie di 24 ore vengono eliminate durante l’esportazione successiva. I file salvati o condivisi dall’utente rimangono dove sono stati destinati.

La politica di navigazione è in `src-tauri/src/policy.rs`. Il dominio è fissato nel codice e nella capability `workshop.json`; cambiarlo richiede aggiornare entrambi e ricompilare.
