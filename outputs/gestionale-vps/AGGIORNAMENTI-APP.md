# Aggiornamenti dell’app Windows

Dalla versione **1.0.3**, l’app Windows mostra **Aggiornamenti**. Premere **Verifica aggiornamenti**, poi **Scarica aggiornamento** e **Installa e riavvia**. La ricerca e l’installazione partono soltanto su richiesta. Se la connessione cade durante il download si può riprovare; il download non modifica l’archivio dell’officina.

L’installazione attende la conferma dei salvataggi, compreso il tema personale. Con una scheda ancora aperta, una bozza da recuperare, un conflitto o una connessione assente, viene annullata: salvare e chiudere la scheda oppure risolvere l’avviso e riprovare. L’app viene chiusa dall’installer e poi riavviata. Con una pagina VPS precedente che non supporta la preparazione del riavvio, l’installazione viene bloccata finché il gestionale non è ricaricato con il server aggiornato.

## Prima attivazione

1. Aggiornare il codice del VPS con questo pacchetto, conservando il database, i volumi Docker e la propria `.env` secondo la procedura di aggiornamento già usata.
2. Il pacchetto contiene `app-updates/windows-x86_64/latest.json`, l’installer Windows 1.0.3 e la sua firma pubblica `.exe.sig`. Ricostruire e riavviare il servizio dell’app: la cartella è inclusa nell’immagine Docker attraverso `.dockerignore`.
3. Installare manualmente **Officina-Windows-1.0.3-setup.exe** sui PC che hanno una versione precedente. È l’unica installazione manuale necessaria per introdurre il pulsante. Il collegamento al VPS resta `https://api.magomme.it/`.
4. Riaprire l’app. **Verifica aggiornamenti** deve indicare che è già aggiornata alla versione pubblicata. Le versioni successive, una volta pubblicate, appariranno qui.

Il codice e i file sono stati preparati localmente: questa consegna non ha aggiornato il VPS operativo. Il solo pulsante non pubblica nuove versioni sul server.

## Canale pubblico

Il servizio offre `https://api.magomme.it/app-updates/windows-x86_64/latest.json` e l’installer indicato nel manifest. Funzionano anche prima dell’accesso, così l’aggiornamento è disponibile dalla schermata iniziale. Espongono esclusivamente file pubblici della versione corrente, senza database o credenziali. Se manca una release completa, la risposta è HTTP 503 e l’app invita a riprovare.

L’app accetta solamente pacchetti HTTPS provenienti da questa cartella sul proprio VPS, fino a 150 MiB, con firma valida e versione firmata corrispondente al manifest. Non segue reindirizzamenti e non installa versioni precedenti. La firma degli aggiornamenti è distinta dall’eventuale certificato commerciale Windows/SmartScreen.

## Pubblicare le versioni successive

La compilazione e la preparazione della release sono descritte in `gestionale-app/AGGIORNAMENTI-WINDOWS.md`, nello ZIP dei sorgenti dell’app. Per ogni versione, aumentare il numero, compilare con la **stessa chiave di firma**, quindi creare i tre file pubblici con lo script fornito. Non sovrascrivere un installer diverso mantenendo lo stesso numero di versione.

Caricare l’installer e la firma prima di sostituire `latest.json`. Con l’installazione Docker normale, copiare i file nella cartella `app-updates/windows-x86_64` del progetto sul VPS e ricostruire il servizio da quella cartella:

```sh
docker compose up -d --build app
curl --fail https://api.magomme.it/app-updates/windows-x86_64/latest.json
```

Non eliminare i volumi del database. Questi comandi pubblicano i file e il codice copiati sul VPS; non compilano l’app Windows. La chiave privata e la sua password devono restare fuori dal server, dallo ZIP pubblico e dal repository.

Per un’installazione con directory di release separata, il processo Node supporta `OFFICINA_APP_UPDATES_DIR`. In Docker occorre aggiungere esplicitamente la variabile al servizio e montare la directory come sola lettura; impostarla soltanto nella `.env` senza modificare Compose non la inoltra al container. Il percorso predefinito nell’immagine è `/app/app-updates/windows-x86_64`.

Le modifiche all’interfaccia caricata dal VPS restano aggiornamenti del server. Il pulsante serve agli aggiornamenti del programma installato sul PC. Android e iPhone continuano a usare le proprie procedure di distribuzione.
