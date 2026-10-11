# Trasferire i dati locali al VPS

L'archivio iniziale si importa una sola volta, da un amministratore, quando il VPS e ancora alla revisione 0. Le importazioni non uniscono automaticamente archivi diversi.

## Prima di chiudere la vecchia applicazione

La versione originale conserva parte dei dati solo nella pagina aperta: copiare la cartella del programma o il solo localStorage non basta per recuperare clienti, appuntamenti e magazzino. Esegui l'esportazione sul dispositivo dove vedi i dati reali, dalla pagina originale ancora aperta. Non ricaricare o chiudere quella pagina prima di avere verificato il file esportato.

1. Termina e salva le schede in corso, chiudi i relativi moduli e attendi almeno due secondi. Durante l'esportazione non modificare altri dati.
2. Apri `esporta-gestionale-locale.js` con un editor di testo e copia tutto il contenuto.
3. Nella pagina del gestionale originale, apri gli strumenti sviluppatore del browser con **F12** oppure **Ctrl+Maiusc+I** e scegli **Console**. Se usi una finestra applicazione senza strumenti sviluppatore, conserva la finestra aperta e chiedi assistenza per estrarre i dati da quella sessione: aprire il file HTML in una nuova finestra potrebbe mostrare dati diversi.
4. Esegui nella console il contenuto completo dello script. Se il browser impedisce l'incolla, usa un **Snippet** negli strumenti sviluppatore oppure chiedi assistenza; non disattivare le protezioni del browser.
5. Verifica che nella cartella Download sia comparso `officina-migrazione-...json`. La console mostra soltanto conteggi e dimensione del file; confrontali con i clienti/veicoli, appuntamenti, articoli e veicoli in parcheggio presenti. Il conteggio include tutte le giornate e i veicoli archiviati, anche se nascosti dai filtri.
6. Conserva una copia di quel JSON e della cartella originale. Il JSON contiene l'archivio gestionale, quindi conservalo in una posizione accessibile alle sole persone autorizzate.

Lo script legge i dati e prepara il download. Non invia nulla al VPS e non modifica gli archivi originali. Non esporta password, preferenze grafiche o il nome/ruolo personale simulato dalla vecchia applicazione. Gli utenti e i ruoli effettivi vanno creati sul VPS.

## Se esistono dati su piu dispositivi

Esporta separatamente ogni sessione locale che contiene dati utili, prima di chiuderla. Conserva i file con nomi che identifichino il dispositivo. Confronta clienti, date, lavorazioni, fatture, pagamenti e giacenze per scegliere l'archivio iniziale piu completo e ricostruire le sole differenze confermate.

Non importare uno dopo l'altro file provenienti da dispositivi diversi e non sommare automaticamente le giacenze: potrebbero rappresentare copie dello stesso intervento o dello stesso magazzino. La procedura di importazione iniziale non esegue confronti o fusioni. I file esportati restano disponibili per una riconciliazione assistita prima dell'avvio operativo.

## Importare sul VPS

1. Accedi alla nuova applicazione HTTPS come amministratore.
2. Verifica che l'archivio centrale sia nuovo, alla **revisione 0**. Non creare clienti o articoli di prova prima dell'importazione.
3. Verifica che nessun altro operatore inserisca dati durante questa importazione iniziale.
4. Apri **Gestione > Importa archivio iniziale** e seleziona il JSON esportato dal dispositivo scelto.
5. Conferma l'importazione e attendi il messaggio di completamento. In caso di errore o interruzione conserva il JSON; verifica la revisione centrale e lo stato dell'operazione prima di riprovare.
6. Controlla clienti e targhe, appuntamenti di giornate diverse, parcheggio e storico, quantita e unita di magazzino, richiami, preventivi, fatture, cassa, note e impostazioni officina. Controlla anche alcuni importi e documenti reali: i soli conteggi non dimostrano che gli archivi locali fossero completi.
7. Accedi da un secondo dispositivo e verifica gli stessi dati. Da questo momento registra il lavoro nella versione VPS.

Se l'archivio centrale non e piu alla revisione 0, l'importazione iniziale non e disponibile. Non azzerare il database per aggirare il blocco: conserva l'esportazione e pianifica una riconciliazione con i dati gia presenti.

## Cosa contiene il file

Il formato e `officina-cloud-export`, con `exportedAt` e `state`. Lo stato comprende la versione dello schema, i contenitori dei dati gestionali, gli archivi applicativi conservati nel browser e le impostazioni officina. Le tabelle vengono descritte come nodi testuali e strutture `{t, a, c}`; script, collegamenti, attributi eseguibili e filtri temporanei non vengono trasferiti.

Totali, grafici, riserve magazzino e richiami automatici sono ricalcolati dalla nuova applicazione. Identificativi, registrazioni di cassa e informazioni sugli scarichi gia effettuati vengono conservati per evitare di applicare gli stessi movimenti una seconda volta.

Il limite di importazione e **16 MB**. Lo script interrompe la procedura senza modificare i dati se trova un archivio locale JSON illeggibile, una pagina incompleta o un file troppo grande. In quel caso mantieni aperta la sessione originale per una migrazione assistita.
