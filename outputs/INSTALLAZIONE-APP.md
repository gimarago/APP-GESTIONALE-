# Officina M.A. Gomme — installazione app

Le app si collegano a **https://api.magomme.it/**. Usa gli stessi nome utente e password del gestionale. Clienti, lavori e fatture rimangono sul VPS e sono condivisi tra PC e telefoni. Serve Internet.

## 1. Aggiorna il VPS

Prima di utilizzare le nuove funzioni native, aggiorna il codice sul VPS con il **Gestionale-VPS.zip** consegnato insieme alle app, seguendo la procedura di aggiornamento già usata. Esegui prima il backup. Mantieni la configurazione `.env` e i volumi Docker esistenti.

Lo ZIP contiene il supporto al salvataggio/condivisione dei documenti nelle app e al flusso email dei preventivi. La preparazione dello ZIP sul PC non aggiorna da sola il VPS.

## 2. Windows

Chiudi l'app se è aperta. Apri **Officina-Windows-1.0.1-setup.exe** sul PC e completa l'installazione per il tuo utente, anche sopra la versione precedente. Se manca WebView2, l'installer lo scarica. Avvia **Officina M.A. Gomme** dal menu Start e accedi.

La versione Windows 1.0.1 corregge le pagine bianche nell'anteprima di stampa di schede, moduli ed etichette. Questa correzione è nell'app nativa: per applicarla a un'installazione già funzionante basta il nuovo installer, senza aggiornare il VPS.

L'installer è per Windows a 64 bit. Non ha una firma commerciale Windows: il sistema può mostrare un avviso relativo all'autore. PDF e altri documenti si salvano scegliendo la destinazione nella finestra di Windows.

## 3. Android

Trasferisci **Officina-Android-1.0.0-arm64.apk** sul telefono e aprilo. Android può chiederti di consentire l'installazione da quell'app di trasferimento o dal gestore file. È un APK per Android 8 o successivo su dispositivi ARM a 64 bit, firmato per l'installazione diretta; non è una pubblicazione sul Play Store.

Apri l'app e accedi. Per i PDF compare il pannello di condivisione del telefono: scegli dove salvarli o con quale app condividerli. L'apertura del pannello non conferma che il documento sia stato inviato.

**Conserva privatamente la cartella `Officina-Android-firma-privata` e fanne una copia di sicurezza.** La chiave e la password servono per firmare gli aggiornamenti installabili sopra questa versione. Non caricare questa cartella sul VPS e non distribuirla insieme all'APK.

## 4. iPhone, quando hai il Mac

Porta sul Mac **Officina-App-Sorgenti-1.0.1.zip**, estrailo e segui la sezione “iPhone: dal Mac” nel suo `README.md`. Il progetto include il codice per condivisione e stampa iOS; deve ancora essere compilato e verificato con Xcode.

Servono il tuo Team Apple Developer e la firma di Xcode per installare sull'iPhone o distribuire tramite TestFlight. In questo pacchetto non è presente un'app iPhone già firmata.

## Aggiornamenti successivi

Per le modifiche al gestionale web basta aggiornare il VPS, poi chiudere e riaprire l'app. Per modificare le funzioni native, l'icona o il collegamento al server serve una nuova versione del pacchetto dell'app.

I sorgenti e gli installer non contengono il database del gestionale. I backup dei dati si continuano a eseguire sul VPS.

## Stato delle verifiche

Vedi `VERIFICHE-APP.md` per distinguere le compilazioni e i test automatici dalle prove ancora da eseguire sui dispositivi.
