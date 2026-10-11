# Gestionale Officina: installazione e gestione sul VPS

L’app Windows 1.0.3 include **Aggiornamenti** per installare le release pubblicate senza scaricare manualmente un nuovo setup ogni volta. Per la prima attivazione aggiornare il VPS e installare questa versione sui PC: [istruzioni per gli aggiornamenti dell’app](AGGIORNAMENTI-APP.md).

Per provarlo su Windows senza VPS, estrarre lo ZIP e aprire **Avvia gestionale sul PC.bat**. Il programma guida la creazione dell'account al primo avvio e apre il browser. Vedere [AVVIO-SUL-PC.txt](AVVIO-SUL-PC.txt): l'archivio del PC e quello del VPS sono separati.

Questo pacchetto aggiunge un server centrale con database persistente, accessi personali, aggiornamenti tra dispositivi e protezioni contro le sovrascritture. Deve essere installato sul VPS: la preparazione dei file non pubblica il sito. Dominio, VPS e credenziali effettive devono ancora essere configurati. Per le fatture ricevute dai fornitori e la ricezione tramite PEC, vedere [FATTURE-FORNITORI.md](FATTURE-FORNITORI.md).

**Gli operatori possono modificare contemporaneamente, senza richiedere un turno o un permesso a ogni modifica.** L'accesso con un account `admin` o `operator` abilita subito il lavoro; `viewer` rimane in consultazione.

Il PDF dei preventivi riporta **Sede legale** e **Sede operativa** dai dati dell'officina nelle **Impostazioni**; compilare la sede operativa per includerla nel documento. Nell'elenco **Preventivi**, il pulsante **Elimina** chiede conferma e rimuove soltanto il preventivo selezionato dall'archivio condiviso.

Interventi e appuntamenti permettono di indicare i **chilometri del veicolo**, anche nella modifica della scheda di accettazione. Il dato compare in agenda, nello storico del cliente e nella stampa della scheda. Il campo è facoltativo: un valore non indicato rimane distinto da zero. Gli appuntamenti della giornata sono sempre ordinati per orario crescente.

La **targa è facoltativa** quando si crea un intervento o un appuntamento. Si può aggiungerla in seguito nella **Scheda di accettazione**, insieme al modello del veicolo: al salvataggio viene aggiornata anche la voce corrispondente in **Clienti e veicoli**, conservando contatti e ultimo intervento. Se la targa identifica un veicolo già presente per quel cliente, la voce temporanea senza targa viene unita a quella esistente. Annullare la scheda non modifica l'archivio; salvare soltanto lavorazioni o note non ricrea veicoli precedentemente eliminati.

Nel grafico **Andamento del valore dei lavori**, **Pneumatici e servizi** è un'unica voce, coerente con il riepilogo per settore. I servizi degli pneumatici si sommano agli pneumatici; **Tagliandi** rimane un settore distinto. Grafico, legenda e riepilogo usano le stesse categorie e conservano i decimali degli importi.

Aprire o salvare una scheda senza cambiare la destinazione dell'importo conserva **Fuori cassa**, **In cassa** o la ripartizione parziale già registrata. Vale anche per i veicoli in parcheggio e per gli acconti: il selettore cambia la destinazione soltanto su scelta esplicita, rispettando i blocchi del libro contabile.

Il cruscotto **Da richiamare** mostra sia i richiami manuali presenti nell'archivio sia i promemoria automatici delle revisioni. Modifiche, cancellazioni e aggiornamenti condivisi si riflettono nel riepilogo.

Il campo **Targa** conserva anche targhe di moto ed estere, con spazi o trattini. Nel parcheggio la modifica non le sostituisce con il modello del veicolo; la ricerca cliente confronta la targa ignorando spazi e trattini. Il recupero delle vecchie righe senza campo separato usa soltanto formati identificabili o la posizione strutturata della targa, senza interpretare liberamente misure pneumatici e importi.

Le stampe A4 di schede, preventivi, rapporti e moduli sopprimono l'indirizzo server aggiunto automaticamente da Chrome mantenendo lo spazio bianco su ogni pagina. Le etichette conservano il formato termico. Per la stampa nell'app Windows installare anche **Officina 1.0.2**, poiché il suo stile di stampa è incluso nel programma.

Lo scarico e le prenotazioni degli pneumatici distinguono **estivi**, **invernali** e **quattro stagioni**, oltre a misura, indici e marca. **Se nella lavorazione non è indicata la stagione, lo pneumatico è considerato estivo**, anche per prenotazioni e calcolo del profitto. Si possono scrivere, per esempio, `4 pneumatici 155/65/14 75T FALKEN 4 stagioni`, usando anche `invernali` oppure `all season` per indicare la stagione. Per le quattro stagioni vengono riconosciute anche le abbreviazioni **AS**, **A/S**, **4S**, **quattro st.**, **4 st.** e **4 stag.**. Se manca la scorta della stagione richiesta (anche estiva sottintesa), appare un avviso senza scaricare un'altra stagione; scorte duplicate nella stessa stagione restano da verificare. I movimenti già registrati restano collegati agli articoli originari finché non si modifica la lavorazione o si riapre il lavoro.

Sono riconosciuti anche gli pneumatici da carico con doppio indice, ad esempio **195/75/16 110/108 FALKEN** e **195/75R16C 107/105T SUMITOMO**. Entrambi gli indici partecipano alla scelta della scorta. Se la lettera di velocità manca, lo scarico avviene solo quando la scorta compatibile nella stagione richiesta è unica.

La **categoria revisione** parte **vuota** per ogni veicolo senza un intervallo scelto. Si può compilare quando si aggiunge un cliente o un veicolo, oppure nello storico del cliente con **Revisioni veicoli**. Salvando una lavorazione che contiene **revisione**, **rev** o **revis** (anche con il punto), la stessa schermata si apre per la targa senza intervallo; vale per appuntamenti, interventi e parcheggio. La compilazione della scheda non viene interrotta e annullarla non apre il richiamo. Una categoria già scelta impedisce ulteriori aperture automatiche; chiudere la schermata senza scegliere lascia il campo vuoto. Le categorie già salvate restano conservate, mentre la precedente cadenza ordinaria implicita diventa non impostata.

La scelta riguarda ciascuna targa: **Uso ordinario** usa la cadenza biennale successiva a una revisione registrata; **Taxi**, **NCC (autovettura)** e **Altra categoria con revisione annuale** usano quella annuale. I richiami considerano l'ultima revisione completata, anche dallo storico importato, e la fine del mese di scadenza; l'anticipo e il secondo richiamo seguono le impostazioni esistenti. Senza intervallo scelto o senza una revisione registrata, non viene inventata una scadenza. Riferimenti: [Portale dell'Automobilista](https://www.ilportaledellautomobilista.it/web/portale-automobilista/veicoli/revisioni), [MIT: revisione periodica](https://www.mit.gov.it/node/2789).

**Nuovo appuntamento** nell'agenda apre il calendario settimanale, con i giorni in colonna e gli orari in riga. Il doppio clic su una fascia apre la scheda già presente con giorno e ora impostati; su telefono si seleziona la fascia e si preme **Nuovo appuntamento**. Le frecce cambiano settimana, **Oggi** torna alla settimana corrente e **Mostra 24 ore** rende disponibili anche gli orari fuori dalla fascia abituale. Le schede già presenti si aprono cliccando sul loro riquadro.

Il menu laterale contiene due pulsanti diretti: **Agenda interventi** e **Veicoli in parcheggio**, senza tendina. Le due schermate mostrano separatamente gli appuntamenti e i lavori che richiedono più giornate. Il cambio fra le due voci sincronizza i dati con il VPS come gli altri cambi di sezione, senza ricaricare la pagina.

Il campo **Da finire entro** nella scheda di parcheggio è facoltativo. La data compare nel calendario settimanale in un riquadro rosso con cliente, veicolo e lavorazione; il riquadro apre la scheda del veicolo. Le scadenze dei lavori completati, pronti al ritiro o rimossi non compaiono tra quelle attive. Anche il calendario aperto riceve gli aggiornamenti da altri dispositivi senza ricaricarsi.

In **Clienti e veicoli**, espandere un cliente e premere la **×** sulla targa da eliminare. La conferma rimuove il veicolo dall'anagrafica e conserva il cliente, gli altri veicoli e lo storico dei lavori e dei documenti. Il veicolo eliminato non viene ricreato dai lavori in parcheggio o dallo storico importato; può essere inserito di nuovo manualmente.

Nell'archivio **Preventivi**, **Prendi appuntamento** permette di scegliere giorno e ora nel calendario e compilare la scheda di accettazione con i dati del preventivo. Verificare la scheda e premere **Salva appuntamento**: soltanto allora il preventivo diventa **Accettato** e viene collegato all'appuntamento. Annullare il calendario o la scheda non crea appuntamenti. Il collegamento permette di riaprire il lavoro già prenotato.

La colonna **Cassa** dell'agenda e il selettore dei veicoli in parcheggio permettono di scegliere **In cassa** o **Fuori cassa** prima del completamento, anche quando si riapre un lavoro già completato. La scelta riguarda il saldo ancora da ricevere; gli acconti già incassati restano in cassa. Il valore iniziale resta **In cassa**. Per un lavoro completato, la ripartizione si modifica dal libro contabile.

Gli avvisi di magazzino in agenda e parcheggio hanno una **×** per nascondere ciascun messaggio. La scelta vale per quell'utente nella scheda del browser e resta conservata durante navigazione e ricaricamento; avvisi nuovi o cambiati vengono mostrati. Chiudere un avviso non modifica scorte o lavorazioni.

Nel libro contabile la **×** accanto a ogni acconto permette di eliminarlo dopo conferma. Viene rimosso soltanto quell'incasso: importo del lavoro, profitto, altri pagamenti e movimenti di magazzino restano invariati. Per un lavoro completato, l'importo eliminato torna nel saldo ancora da ricevere. L'acconto totale in agenda e parcheggio viene aggiornato di conseguenza.

**Aggiungi richiamo** mostra ciascun cliente una sola volta, in ordine alfabetico. Se ha più veicoli, compare una seconda selezione obbligatoria; l'unico veicolo viene associato automaticamente. Il richiamo conserva modello e targa del veicolo scelto.

In **Impostazioni > Scegli tema**, tema e colori sono personali e vengono salvati per account nel database del VPS, anche per gli utenti in consultazione. Sono ripristinati al nuovo accesso, dopo un ricaricamento e su un altro dispositivo. Gli aggiornamenti dei dati dell'officina non cambiano l'aspetto aperto: la scelta cambia soltanto quando l'utente modifica il tema o i colori. Se il salvataggio non viene confermato, il tema scelto resta visibile e compare **Riprova salvataggio tema**; completare il salvataggio prima di uscire o ricaricare. La prova **npm run test:user-appearance** verifica persistenza, separazione degli account e aggiornamenti concorrenti su archivi temporanei.

In **Moduli**, **Inserisci modulo** guida tre passaggi: scegliere **Informativa privacy**, **Rifiuto di interventi raccomandati** o **Fornitura propria di ricambi**, selezionare un cliente dell'archivio e caricare dal computer un **PDF, PNG, JPG o WebP fino a 10 MB**. Il file viene conservato così come caricato nel database centrale, separato dai dati delle schermate. Dopo la conferma del server compare in **Apri archivio**, sotto il cliente scelto; **Apri** scarica l'originale anche da altri dispositivi autorizzati. Gli utenti in consultazione possono leggere l'archivio; il caricamento richiede un account amministratore o operatore. La prova **npm run test:manual-modules** verifica i passaggi, i file, la sincronizzazione e i ritentativi senza duplicati.

La colonna **Acconto**, tra **Importo** e **Cassa**, mostra gli acconti già registrati. **+ Acconto** permette di inserire un nuovo importo e confermarlo con **Registra acconto**. Il pagamento entra subito in cassa nel libro contabile, nella data in cui viene registrato, anche se il lavoro non è ancora completato. Al completamento viene registrato soltanto il residuo: per un lavoro da € 100 con un acconto di € 30 e destinazione **Fuori cassa**, si registrano € 30 in cassa e € 70 fuori cassa. Non si possono registrare acconti superiori al residuo. La funzione è disponibile anche per i veicoli in parcheggio.

L'icona **P con automobile**, a destra dello stato in agenda, sposta l'appuntamento nei **Veicoli in parcheggio**. Conserva cliente, contatti, veicolo, chilometri, lavorazioni, note, stato, acconti e collegamenti contabili. La conferma del server salva insieme il trasferimento e i collegamenti; i pagamenti e gli scarichi di magazzino già registrati non vengono duplicati.

Nel preventivo, **Stampa preventivo** apre l'anteprima dei dati attualmente compilati, anche prima del salvataggio, con sede legale e sede operativa. Dall'anteprima si può stampare o scaricare il PDF e poi tornare alla compilazione.

In **Magazzino**, **Fai inventario** apre una conta separata con tutti gli articoli e quantità iniziali a zero. Le scorte correnti restano operative finché non si applica il risultato. Si può chiudere e riprendere la bozza; il **Resoconto** mostra le quantità attese, quelle contate e le differenze. Più operatori possono contare prodotti diversi nella stessa bozza: le righe si aggiornano dal vivo anche con la finestra aperta e le quantità inserite su righe diverse si uniscono. Se due operatori cambiano la stessa riga, il conflitto indica il prodotto coinvolto. Gli articoli lasciati a zero diventano zero anche nel magazzino dopo **Applica inventario**. Prezzi, unità, prodotti e collegamenti degli interventi vengono conservati.

Le **vendite registrate dagli interventi**, successive a un conteggio già salvato, vengono sottratte automaticamente anche dalla bozza: con 10 pezzi contati e una vendita di 2, restano 8 nel conteggio. Lo scarico e l'aggiornamento della bozza sono salvati insieme sul server; valgono anche con la finestra chiusa, nel resoconto e per vendite da altri dispositivi. La differenza fisica rilevata contando rimane conservata. La riapertura del lavoro restituisce anche al conteggio la quantità del relativo scarico annullato. Gli articoli non ancora contati restano da contare. Se le vendite superano la quantità contata, la riga richiede un nuovo conteggio. Modifiche manuali alle quantità e movimenti non riconducibili interamente a vendite richiedono ancora una verifica della riga; una bozza obsoleta non viene corretta per supposizione. Prima di **Applica inventario** il server verifica le versioni aggiornate e conserva la bozza se rileva un conflitto.

Il pulsante **+** nella colonna **Disponibilità** apre il carico di scorta: indica la quantità arrivata e il costo pagato per unità. Il **Costo medio unitario** viene aggiornato con la media ponderata tra quantità già presenti e quantità in arrivo. Se il costo delle scorte già presenti non è registrato, inseriscilo nella finestra per ottenere una media corretta. Il ricarico unitario, usato per il profitto, resta separato.

Durante il conteggio, **+ Aggiungi scorta** permette di registrare un prodotto non ancora presente, con categoria, unità, prezzo, profitto, posizione e quantità contata. Il prodotto rimane nella bozza condivisa fino ad **Applica inventario**, che aggiunge le nuove scorte e aggiorna tutte le quantità in un'unica operazione. Eliminare la bozza scarta anche i prodotti aggiunti nella conta. Questa funzione richiede il riavvio del servizio con il nuovo pacchetto.

I salvataggi della conta e del calendario inventari non modificano la versione delle scorte. Dopo questo aggiornamento occorre **riavviare il servizio** e ricaricare la pagina: all'avvio il server recupera automaticamente le bozze bloccate dal vecchio controllo solo se la cronologia completa dei salvataggi dimostra che nessuna scorta è cambiata. Le quantità inserite restano conservate; il recupero non applica l'inventario. Se la pagina è aggiornata ma il servizio usa ancora il codice precedente, l'app lo segnala prima di avviare o applicare la conta.

Per il nuovo canale diretto di invio e ricezione fatture leggere [SDI-DIRETTO.md](SDI-DIRETTO.md). Il codice e i test locali non sostituiscono l’accreditamento e il collaudo di interoperabilità con lo SdI. L’installazione normale resta disattivata per gli invii.

In **Fatture emesse > Rapporti di intervento**, scegliere un cliente o un'azienda e un solo mese, ad esempio dal 1° al 31 maggio. Sono proposti gli interventi completati del libro contabile, comprendendo le diverse targhe dello stesso cliente; si possono selezionare singolarmente o con **Seleziona tutti**. Se un intervento è già fatturato, la casella è disattivata e la riga mostra **Già in fattura**. **Scheda** apre la stampa del singolo lavoro. Nel rapporto salvato, **Stampa** e **Invia > Email** usano lo stesso PDF riepilogativo: Email lo invia tramite il servizio scelto in **Impostazioni** e con il mittente configurato sul VPS. **WhatsApp** e **PEC** preparano il testo per il canale scelto; non inviano il PDF automaticamente. Mancano email o telefono? Aggiungili all'anagrafica cliente o ai dati fiscali. Il rapporto, con numero interno, date, targhe, lavorazioni e importi IVA inclusa, è condiviso tra dispositivi e incluso nel backup fatture senza concorrere ai totali.

**Crea bozza TD24** prepara una fattura differita per gli interventi selezionati dello stesso cliente e mese. La data proposta è quella dell'ultimo intervento e la causale richiama numero e data del rapporto; controlla dati fiscali, aliquote, termini e pagamento prima di numerare. L'app conserva i centesimi originari, con l'eventuale arrotondamento indicato nel PDF/XML. La fattura differita prevista dall'art. 21, comma 4, riguarda prestazioni identificabili con documentazione idonea svolte nello stesso mese per lo stesso cliente; la guida AdE indica l'invio entro il 15 del mese successivo. Gli interventi già collegati a una fattura non si possono riutilizzare. Se un lavoro cambia o viene riaperto, prepara un nuovo rapporto prima della conversione. Creare il rapporto o la bozza non registra nuovi lavori, incassi o scarichi di magazzino; il pagamento della fattura aggregata rimane nell'archivio fatture e i singoli incassi nel libro contabile. Riferimenti: [Guida AdE alla compilazione della fattura elettronica, TD24](https://www.agenziaentrate.gov.it/portale/documents/20143/451259/Guida_compilazione-FE-Esterometro-V_1.9_2024-03-05.pdf) e [adempimento per le fatture differite](https://www1.agenziaentrate.gov.it/servizi/scadenzario/main.php/main.php?chi=31&come=76&cosa=898&entroil=17-02-2014&op=4&vista=0).

## Salvataggi e modifiche concorrenti

- PC, Android e iPhone/iPad aprono lo stesso indirizzo HTTPS. Il database sul VPS è l'archivio centrale.
- Ogni cliente, appuntamento, articolo, veicolo in parcheggio, richiamo, post-it, preventivo, modulo e conto cassa ha un'identità stabile. Il browser invia soltanto le voci cambiate e la versione letta per ciascuna voce.
- Modifiche a voci diverse si salvano contemporaneamente, anche partendo dalla stessa revisione generale. Nessun dispositivo invia una copia dell'intero archivio sopra quella di un altro.
- Se due operatori modificano la stessa voce, anche in campi diversi, il server accetta il primo salvataggio e rifiuta il secondo. L'app conserva una bozza e mostra il conflitto; gli altri operatori continuano a lavorare. Il controllo vale anche tra eliminazione e modifica, dopo una riconnessione e quando il valore finale sembra identico.
- Le modifiche raccolte in un salvataggio sono una transazione: vengono confermate tutte insieme o nessuna. Un conflitto sullo scarico del magazzino non lascia confermato soltanto l'intervento. Non si sommano automaticamente giacenze di copie differenti.
- I controlli sui dati collegati proteggono cassa, pagamenti e interventi che usano il magazzino. Per questi interventi un aggiornamento del magazzino non ancora letto può richiedere di aggiornare e verificare l'operazione, anche se riguarda un altro articolo.
- Alcuni archivi restano unità indivisibili: registro/numerazione fatture, cronologie d'importazione e alcune impostazioni. Due modifiche simultanee di una di queste unità richiedono confronto. XML/PDF e registro fatture attendono il salvataggio centrale prima dell'esportazione: un numero locale non confermato non viene esportato.
- Ogni richiesta ha un identificativo univoco: il ritentativo dopo una risposta persa non applica due volte la stessa operazione. Le versioni delle voci eliminate restano registrate per impedire che una vecchia copia le ricrei accidentalmente.
- Le modifiche degli altri operatori compaiono **automaticamente nella sezione già aperta, senza ricaricare la pagina o ricreare l'interfaccia**. Per esempio, la quantità in magazzino cambia direttamente nella tabella dopo il salvataggio dell'altro dispositivo. Vengono aggiornate soltanto le voci cambiate, conservando filtri, ricerca e posizione nella pagina. Le notifiche del server avviano il controllo in sottofondo; un controllo periodico recupera eventuali notifiche perse. Non serve uscire e rientrare nella sezione.
- Durante la compilazione di un modulo, di un post-it da inviare o di un campo modificabile, i dati ricevuti aspettano: vengono applicati dopo la chiusura del modulo o la conferma delle modifiche locali. I campi di sola ricerca possono restare selezionati e non impediscono gli aggiornamenti. Il controllo confronta sempre le versioni effettivamente lette; un conflitto continua a proteggere la bozza. Gli scarichi di magazzino e gli incassi già registrati dall'altro dispositivo non vengono ripetuti.
- Il cambio di sezione rimane immediato quando non ci sono modifiche locali da confermare e conserva lo stesso documento. Le richieste di rete non bloccano il lavoro; le nuove modifiche attendono soltanto la breve applicazione dei dati ricevuti. Un modulo aperto o un post-it ancora da inviare va completato o chiuso prima del cambio. Cliccare di nuovo sulla sezione già aperta non forza una sincronizzazione.
- Il cambio di sezione senza modifiche recenti non aggiunge attese fisse. I controlli usano la revisione dell’archivio: se non è cambiata il VPS risponde senza rispedire tutti i dati. Gli aggiornamenti ricevuti mentre si compila restano separati dalla bozza e vengono applicati automaticamente appena è possibile, dopo i salvataggi locali. Anche quando l’archivio cambia, i dati vengono aggiornati nella pagina già aperta; le modifiche appena inserite attendono la conclusione dei relativi calcoli prima di proseguire. La prova **npm run test:live-sync** usa utenti e database temporanei per verificare aggiornamenti nella stessa vista, filtri e focus, risposte lente, bozze e contabilità senza duplicazioni.

I salvataggi sul server sono automatici: non serve un pulsante generale di salvataggio. I pulsanti dei singoli moduli confermano gli inserimenti e le modifiche. La barra superiore compare soltanto quando occorre recuperare la connessione, correggere un errore di avvio o risolvere un conflitto. Nelle **Impostazioni**, accanto a **Salva impostazioni**, **Gestione dati** dà accesso a esportazione e bozze; **Esci dall'account** attende anche i salvataggi in corso e torna alla schermata di accesso. Per un modulo ancora aperto, l'uscita propone di conservarne una bozza. I messaggi “Salvato” nei moduli possono precedere la conferma centrale; l'uscita dall'account effettua il controllo finale.

La semplice apertura di una scheda di accettazione e la ricostruzione dei controlli durante un aggiornamento ricevuto non generano salvataggi. Note, chilometri e importi di un intervento non richiedono che l'intero magazzino sia rimasto invariato: la protezione delle scorte riguarda completamenti, riaperture e variazioni effettive delle lavorazioni o degli scarichi. I consumabili già scaricati conservano la scorta realmente usata; l'aggiunta successiva di un altro prodotto compatibile non ricalcola i vecchi scarichi. Le prove **npm run test:passive-snapshot** e **npm run test:phantom-conflicts** verificano questi casi su database temporanei, compreso l'accesso dallo stesso account su PC e viewport mobile. L'aggiornamento richiede il nuovo pacchetto sul VPS, il riavvio del servizio e il ricaricamento delle pagine sui dispositivi.

In caso di conflitto si apre **Confronta le modifiche**: mostra il nome della voce coinvolta, l'utente e l'ora dell'ultimo salvataggio documentato, i campi cambiati e un confronto fra i dati che avevi, i valori attuali del server e la tua bozza. Il pulsante **Confronta modifiche** riapre l'avviso. Sono riportate anche le modifiche collegate a magazzino o cassa che hanno bloccato l'operazione. **Scarica confronto** esporta soltanto questo riepilogo; **Scarica bozza** conserva invece i dati completi e i moduli aperti. Dopo il confronto usare **Ricarica dati server** e reinserire le sole modifiche ancora necessarie: la bozza resta separata dai salvataggi successivi e non viene applicata forzatamente sopra dati recenti. Per attivare i dettagli occorre aggiornare anche il server e riavviare il servizio; per modifiche anteriori all'aggiornamento autore e valori precedenti possono non essere disponibili e vengono indicati come tali. I riepiloghi hanno limiti di dimensione e non sostituiscono la bozza completa.

Se manca la rete, le modifiche si sospendono e rimangono recuperabili nella scheda. Le bozze non sono backup: scaricarle prima di chiudere la scheda o cancellare i dati del browser. La prova **npm run test:conflicts** usa due utenti su un archivio temporaneo e verifica attribuzione, confronto, protezione dei dati, cancellazioni e recupero della bozza.

Se il caricamento dell'archivio fallisce **dopo l'accesso**, l'errore viene mostrato nella schermata aperta, con il pulsante **Ricarica dati server**. Una richiesta che non risponde viene interrotta dopo otto secondi; l'avvio della pagina applicativa ha un controllo separato di trenta secondi. Anche una risposta tardiva non riabilita una pagina il cui avvio è già stato sospeso: serve il tentativo esplicito di ricaricamento. Le bozze precedenti restano scaricabili e il tentativo di recupero non le importa nell'archivio centrale. Se la sessione scade durante l'accesso o il tentativo di riconnessione, viene riproposta la schermata di login.

Questi controlli rendono visibile il problema e permettono di riprovare; non riparano una connessione o un servizio VPS non disponibile. Per individuare la causa, annotare il messaggio visibile e leggere sul server `docker compose logs --tail=100 app` dalla cartella dell'installazione. Il solo stato `healthy` del container non conferma che il browser abbia completato il caricamento. La prova automatica `npm run test:startup` usa un database temporaneo e verifica errori HTTP, richieste bloccate, avvio tardivo, sessioni scadute e conservazione delle bozze; richiede Playwright e un browser di prova.

L'app richiede la rete. Il manifest permette l'aggiunta alla schermata iniziale nei browser compatibili, senza modalità di modifica offline. Le prove con viewport mobile in Chromium non sostituiscono il collaudo su Android e iOS reali.

I caratteri originali **Manrope** e **DM Mono** sono inclusi nel pacchetto, con le rispettive licenze. Vengono caricati dallo stesso server del gestionale, senza richieste a Google Fonts. Il font Manrope è usato anche nella schermata di accesso e nella barra di sincronizzazione.

## Architettura e requisiti

```text
PC / Android / iOS
        │ HTTPS, account personale
        ▼
Caddy :443  ── rete Docker privata ──  app Node.js :8080
        │                                  │
certificati persistenti                  /data/officina.sqlite
                                        /backups/backup online
```

Sono previsti **un VPS, un processo applicativo e un database su disco locale**. Non avviare repliche dell'app, non usare `--scale app`, non condividere `/data` tramite NFS/SMB/OneDrive e non avviare due stack diversi sullo stesso database. Il dominio pubblico usa Caddy; la porta 8080 non è pubblicata. La rete `backend` tra proxy e app è interna; app e servizio PEC opzionale hanno anche una rete di uscita per raggiungere rispettivamente SMTP e IMAP. La rete di uscita non pubblica porte, ma non limita di per sé le destinazioni consentite. [Riferimento Docker](https://docs.docker.com/reference/compose-file/networks/).

Il nome fisso `officina-app` impedisce a Compose di scalare accidentalmente il servizio o duplicarlo sullo stesso host con un altro nome di progetto. Per il collaudo usare preferibilmente un VPS separato; un ambiente di prova sullo stesso host deve avere nome container, dominio e volumi distinti e non deve montare i dati di produzione.

Servono un VPS Linux con Docker Engine e plugin Docker Compose aggiornati, Bash, `flock`, `sha256sum`, `realpath`, `find`, un dominio sotto il proprio controllo e spazio disco sufficiente per dati, cronologia e backup. Il server usa Node.js 24 dal container; non serve installare Node sul VPS. Il modulo integrato `node:sqlite` evita pacchetti binari esterni; mantenere l'immagine aggiornata e verificare gli aggiornamenti in staging prima di applicarli.

Nel firewall del provider consentire TCP 80/443 e, se si vuole HTTP/3, UDP 443. Limitare SSH alle sorgenti amministrative. Non pubblicare 8080, database o socket Docker. Verificare le porte anche nel firewall del provider: le regole Docker possono influire sul firewall locale.

## Prima installazione

1. Copiare tutta questa cartella in `/opt/officina` sul VPS, senza dati di prova. Installare Docker seguendo la [documentazione ufficiale](https://docs.docker.com/engine/install/).
2. Puntare il record DNS A del dominio all'IPv4 pubblico del VPS. Creare un record AAAA soltanto se anche IPv6 è configurato e raggiungibile.
3. Entrare nella cartella e preparare la configurazione:

   ```bash
   cd /opt/officina
   cp .env.example .env
   chmod 600 .env
   nano .env
   ```

   Impostare `OFFICINA_DOMAIN` al solo nome, per esempio `officina.azienda.it`; `OFFICINA_ORIGIN` a `https://officina.azienda.it`, senza slash finale; `ACME_EMAIL` alla propria email. Non usare i valori `example.com` in produzione. Il dominio e l'origine devono corrispondere esattamente.

4. Validare e avviare inizialmente solo il servizio interno:

   ```bash
   docker compose config --quiet
   docker compose build --pull app
   docker compose up -d --wait app
   docker compose ps
   ```

5. Creare l'amministratore prima di pubblicare Caddy. Non esistono credenziali predefinite:

   ```bash
   bash deploy/user.sh add amministratore admin
   ```

   Lo script richiede due volte la password senza mostrarla e la passa tramite stdin; non inserirla nei comandi, nel file `.env` o nella cronologia della shell. Usare una password lunga e unica conforme ai controlli mostrati dalla CLI.

6. Validare il proxy e attivare HTTPS:

   ```bash
   docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker compose up -d
   docker compose logs --tail=50 app caddy
   ```

   Caddy richiede e rinnova automaticamente i certificati e redirige HTTP a HTTPS quando dominio e raggiungibilità sono corretti. I certificati restano nel volume `caddy_data`. [Riferimento Caddy](https://caddyserver.com/docs/automatic-https).

7. Aprire il dominio via HTTPS e verificare l'accesso da almeno due dispositivi. `docker compose ps` deve mostrare `app` healthy. Il controllo verifica `/api/health`; Caddy attende questo stato durante l'avvio. [Riferimento Compose](https://docs.docker.com/compose/how-tos/startup-order/).

I volumi nuovi sono inizializzati con proprietario UID/GID 1000 per l'app, che lavora senza privilegi di root. Non cambiare l'utente del container senza adeguare i volumi. I volumi persistono quando i container vengono sostituiti. **Non usare `docker compose down -v`**, perché cancella anche i dati. [Riferimento volumi Docker](https://docs.docker.com/engine/storage/volumes/).

## Trasferimento iniziale dei dati esistenti

Prima dell'importazione stabilire quale dispositivo contiene l'archivio completo da usare. Seguire [la procedura di migrazione](deploy/MIGRAZIONE.md) ed eseguire lo script `deploy/esporta-gestionale-locale.js` nella pagina originale ancora aperta, senza ricaricarla prima dell'esportazione. Parte dei dati originali può esistere soltanto nella pagina in memoria: il solo localStorage o il file HTML copiato non bastano. Conservare una copia intatta del JSON esportato.

Accedere alla nuova applicazione come amministratore, aprire **Gestione > Importa archivio iniziale**. L'importazione, fino a 16 MB, è consentita solo all'amministratore e alla revisione 0: non creare dati di prova prima di importare. Dopo il successo controllare clienti, appuntamenti, quantità di magazzino, documenti e saldi. Archivi differenti di più browser richiedono confronto e riconciliazione; non vengono fusi automaticamente. **Gestione > Esporta copia dati** scarica una copia dell'archivio operativo originario. Non include il registro delle fatture fornitori, gli XML PEC, i file originali dei moduli caricati o le preferenze personali del tema: dei moduli caricati conserva soltanto i riferimenti ai file, che non sono trasferibili da soli su un nuovo server. Per la copia completa serve il backup SQLite del VPS, descritto sotto. Conservare gli originali finché il controllo non è concluso.

Controllare anche **impostazioni officina, ragione sociale, indirizzo, partita IVA, contatti e dati del venditore sui documenti**: il sorgente originale contiene valori aziendali preimpostati. Confermare i dati reali della propria azienda prima di produrre documenti; non presumere che una nuova installazione abbia queste impostazioni vuote.

Successivamente distribuire a tutti il solo indirizzo HTTPS. I vecchi file aperti tramite `file://`, HTA e lanciatori Windows appartengono all'installazione locale e non sono l'accesso condiviso al VPS. Sono esclusi dall'immagine Docker. Il vecchio servizio email OAuth locale non viene esposto o avviato: il servizio SMTP configurato qui invia i PDF dei rapporti di intervento e dei preventivi, oltre ai link di recupero password. WhatsApp e PEC restano canali separati. L'OCR può richiedere modelli remoti che la policy CSP blocca; prima di usarlo in produzione verificare il flusso e ospitare i relativi modelli sul proprio server. Il canale diretto SdI è implementato nei moduli `server/sdi-*` ed è disattivato nell’installazione ordinaria. Per funzionalità, limiti e attivazione dopo accreditamento e collaudo leggere [SDI-DIRETTO.md](SDI-DIRETTO.md). Il vecchio prototipo `backend/src/sdi/` non è il canale usato dal gestionale; di `backend/` l’immagine include i parser XML e i contratti verificati. I file `LEGGIMI-*` originali descrivono funzioni e avvio della versione locale; per il VPS seguire questo documento.

## Account e ruoli

Usare account distinti per ricostruire chi ha eseguito le operazioni. L'amministratore può gestire l'archivio; `operator` può effettuare le normali modifiche dopo l’accesso; `viewer` consulta soltanto.

```bash
bash deploy/user.sh add officina1 operator
bash deploy/user.sh add consultazione viewer
bash deploy/user.sh password officina1
docker compose exec -T app node server/cli.mjs users
docker compose exec -T app node server/cli.mjs user-disable officina1
```

I comandi amministrativi richiedono accesso alla console del VPS; non sono credenziali da consegnare agli operatori. Dopo un cambio password o la disabilitazione verificare che il vecchio dispositivo non mantenga l'accesso. Proteggere il VPS e il sistema di backup: contengono l'intero archivio aziendale.

### Invio PDF e recupero password via Gmail

In **Impostazioni**, salvare il servizio email e l'indirizzo mittente per i messaggi ai clienti. In **Rapporti di intervento > Invia > Email** il server invia al cliente il PDF del rapporto, generato dallo stesso modello del pulsante **Stampa**. L'invio del preventivo usa lo stesso servizio. Il mittente selezionato nelle Impostazioni deve coincidere con `SMTP_FROM` (o `SMTP_USER`) nel VPS. Se il servizio o il mittente non sono configurati correttamente, l'app mostra l'errore senza dichiarare l'invio riuscito. Il PDF viene inviato al server solo per l'invio richiesto e non viene salvato nell'archivio.

Il link **Password dimenticata?** nella pagina di accesso usa una configurazione SMTP distinta, `RECOVERY_SMTP_*`, e richiede anche il dominio pubblico HTTPS. Se queste variabili restano vuote, il server usa `SMTP_*` per compatibilità con installazioni già configurate. Per tenere separati i mittenti, impostare tutte le variabili di recupero. Fino a quando SMTP e HTTPS non sono configurati, il gestionale indica che il recupero via email non è disponibile e resta utilizzabile il comando `bash deploy/user.sh password NOME` dalla console del VPS.

Per usare Gmail per le email ai clienti, attivare la verifica in due passaggi sull'account e creare una **password per le app** dedicata al gestionale. Non usare la normale password dell'account Google. Inserire nella `.env` del VPS `SMTP_USER`, `SMTP_PASSWORD` e `SMTP_FROM`; in **Impostazioni**, scegliere **Gmail** e inserire lo stesso indirizzo di `SMTP_FROM` (o `SMTP_USER`). Per un mittente separato di recupero password, configurare `RECOVERY_SMTP_HOST`, `RECOVERY_SMTP_PORT`, `RECOVERY_SMTP_USER`, `RECOVERY_SMTP_PASSWORD` e `RECOVERY_SMTP_FROM` con la casella dedicata. Il mittente deve essere autorizzato dal provider per le credenziali configurate. Conservare `.env` con permessi `600` e non includerlo nei backup di codice o in messaggi di assistenza. Le [istruzioni Google per le password per le app](https://support.google.com/accounts/answer/2461835) descrivono la disponibilità di questa opzione; in alcuni account aziendali può essere disabilitata dall'amministratore. Il server VPS deve poter raggiungere l'host SMTP configurato.

Associare poi a ogni utente il **suo** indirizzo email, controllando attentamente che appartenga davvero a quella persona:

```bash
cd /opt/officina
bash deploy/user.sh email mario mario@example.com
```

L'associazione viene effettuata dall'amministratore dalla console, non verificata automaticamente dall'app. Se l'indirizzo è errato o appartiene a qualcun altro, chi riceve il link potrebbe cambiare la password di Mario: correggerlo prima di attivare il recupero. Per rimuovere un indirizzo: `bash deploy/user.sh email-clear mario`.

Quando l'utente richiede il recupero, il server invia un link temporaneo utilizzabile una sola volta. La nuova password viene scelta nella pagina aperta dal link, anche su iPhone o iPad; il messaggio non contiene la password. Dopo il cambio, le vecchie sessioni dell'utente vengono chiuse. La pagina non rivela se un indirizzo è registrato. Se Gmail non consegna un messaggio, verificare configurazione SMTP, connessione in uscita e filtri antispam; l'app non deve essere considerata collaudata finché un recupero reale non è riuscito da un dispositivo esterno.

## Backup e recupero

Eseguire subito il primo backup:

```bash
cd /opt/officina
bash deploy/backup.sh
```

La CLI usa un backup coerente di SQLite anche con il server attivo. La copia include anche i file originali dei moduli caricati e tema e colori di ciascun account. Non copiare direttamente il solo file `.sqlite` mentre il server scrive: potrebbero esserci dati ancora nel journal WAL. [API ufficiale di backup Node](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options).

Lo script conserva la copia nel volume dedicato ed esporta `backups/officina-DATA-ID.sqlite` con il relativo `.sha256` nella cartella host. La conservazione predefinita è 30 giorni; nel volume rimangono almeno le due copie più recenti. La pulizia parte solo dopo un nuovo backup esportato correttamente. Il checksum rileva alterazioni accidentali; non cifra il file e non protegge se un aggressore può modificare anche il checksum.

Un backup sullo stesso VPS non protegge dalla perdita del VPS. Copiare regolarmente backup e checksum su uno storage esterno cifrato, con credenziali limitate e retention indipendente. Scegliere destinazione e credenziali prima della messa in esercizio; questa cartella non configura un account esterno inesistente. Controllare gli esiti dei job ed eseguire periodicamente una prova di ripristino su un ambiente separato.

Per pianificare il backup ogni giorno alle 02:30 nel fuso orario del VPS:

```bash
sudo install -m 644 deploy/officina-backup.service /etc/systemd/system/officina-backup.service
sudo install -m 644 deploy/officina-backup.timer /etc/systemd/system/officina-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now officina-backup.timer
sudo systemctl start officina-backup.service
sudo systemctl list-timers officina-backup.timer
sudo journalctl -u officina-backup.service -n 50 --no-pager
```

I file presuppongono `/opt/officina`; modificare `WorkingDirectory` ed `ExecStart` se si usa un'altra cartella. Il timer pianifica le esecuzioni e registra gli errori; non invia automaticamente allarmi. Configurare il monitoraggio operativo del provider o del proprio sistema di allerta.

Il ripristino sostituisce **tutto l'archivio e gli utenti** con la copia scelta. Fermare il lavoro degli operatori e usare un backup affidabile insieme al suo checksum:

```bash
bash deploy/restore.sh /percorso/officina-DATA-ID.sqlite --confirm-restore
```

Lo script verifica il checksum, crea una copia di sicurezza del database corrente, ferma l'app, richiama il ripristino della CLI e riavvia l'app dopo il successo. La CLI verifica integrità e schema del backup e invalida sessioni precedenti. Un errore lascia l'app ferma per impedire di proseguire su uno stato incerto. Su un VPS nuovo preparare prima il container con `docker compose create app`; il flag aggiuntivo `--skip-safety-backup` evita il tentativo di esportazione da un'app non ancora avviata. Quando il database esiste la CLI conserva comunque una copia prima di sostituirlo: un database corrotto richiede intervento amministrativo, conservazione dei file originali e ripristino su un volume nuovo, senza forzare la sovrascrittura. Non cancellare manualmente un lockfile per aggirare un processo che sta ancora scrivendo.

Dopo il ripristino chiudere le sessioni su tutti i dispositivi, accedere nuovamente e verificare i dati prima di riprendere il lavoro. Una bozza precedente al ripristino deve essere confrontata manualmente; non importarla sopra l'archivio appena recuperato.

## Scorte, lavorazioni parziali e solleciti

Nella modifica di una scorta, **Elimina scorta** chiede una conferma prima di rimuovere l'articolo dall'archivio condiviso. Le lavorazioni della scheda di accettazione e dei veicoli in parcheggio hanno una spunta **Eseguita** per seguire l'avanzamento. La spunta è un'informazione condivisa: merce, incassi e contabilità continuano a dipendere dallo stato complessivo **COMPLETATO** dell'intervento o del veicolo.

Nell'archivio fatture, **Sollecita** compare sulle fatture definitive ancora da saldare. Apre un testo modificabile da copiare o scaricare; **Registra sollecito** conserva data e testo nell'archivio condiviso. L'app non invia email o messaggi automaticamente e non registra un pagamento quando si prepara un sollecito.

## Storico clienti importato

Nella sezione **Clienti e veicoli** ogni cliente appare una sola volta; aprendo la riga si vedono i veicoli associati. La ricerca trova anche una targa contenuta nell'elenco e apre il cliente corrispondente.

L'importazione dello storico da Excel o CSV aggiunge le lavorazioni ai riepiloghi del **valore dei lavori** e, se la descrizione indica una quantità riconoscibile (per esempio `4 pneumatici 205/55 R16`) o se sono compilate le colonne dedicate, ai conteggi delle gomme vendute. Data e targa devono essere abbinate correttamente prima di confermare l'anteprima. Reimportare lo stesso file non raddoppia le righe identiche.

Nell'**Agenda pneumatici venduti**, i totali seguono il periodo selezionato: giorno, settimana da lunedì a domenica, mese, anno o intervallo personalizzato con estremi inclusi. In modalità mese si sceglie il mese e l'anno; le frecce avanzano o arretrano del periodo impostato. Il selettore cambia soltanto la visualizzazione dei dati.

L'elenco mostra inizialmente cinque lavorazioni; **Mostra altro** aggiunge cinque righe alla volta senza cambiare il totale del periodo. Gli indicatori di Data analysis partono da **Quest'anno**. Le dieci misure più vendute sono disposte in due colonne di cinque righe. L'andamento annuale mostra tutti i dodici mesi, ordinati per importo decrescente; gli altri intervalli mostrano i dieci mesi con valori maggiori in verde e i dieci con valori minori in rosso. Gli importi dello storico rappresentano il valore dei lavori: il file importato non attesta i pagamenti.

In **Magazzino**, la colonna **DIO (giorni)** mostra il dato per singola scorta secondo **giacenza media al costo ÷ costo del venduto × giorni del periodo**. L'app registra carichi, consumi collegati ai lavori completati, rettifiche e costi unitari; se manca un costo o uno scarico valorizzato, il DIO di quella scorta resta non calcolabile. Lo storico parte dal primo movimento registrato e non ricostruisce il passato. In **Fuori cassa e uscite** è visibile il ciclo di conversione di cassa (**CCC = DIO + DSO − DPO**): il DIO complessivo e il CCC appaiono quando tutte le scorte hanno uno storico confrontabile. Il DSO usa i giorni delle posizioni clienti ancora aperte, aggiornati ogni giorno, e i tempi dei saldi registrati. Il DPO è la media dei giorni tra data fattura e pagamento, ponderata per l'importo, sulle fatture fornitori confermate.

Se il file non indica i pagamenti, gli importi storici **non sono incassi accertati**: non creano movimenti nel libro contabile, profitti o scarichi retroattivi di magazzino. Gli incassi effettivi vanno registrati separatamente dai documenti o dalle evidenze di pagamento. La schermata segnala le targhe già importate che non risultano riconoscibili e le esclude dai report finché il file non viene corretto e reimportato.

## Aggiornamenti, controllo e collaudo prima dell'uso

Questa versione usa il protocollo di salvataggio 2 e porta lo schema database alla versione 5: oltre al recupero password e al registro fornitori con pagamenti e originali PEC, comprende coda, esiti e originali del canale SdI. Un ripristino sospende gli invii che nel backup risultavano in coda o in corso: vanno confrontati con lo SdI prima di qualunque ulteriore trasmissione. Per aggiornare la precedente versione con turni: completare i salvataggi, conservare le bozze, eseguire un backup, fermare il vecchio server e distribuire **tutto il nuovo pacchetto**, riutilizzando la cartella dati. All'avvio le righe ricevono identità stabili in una migrazione atomica. Ricaricare tutte le schede: le vecchie API di salvataggio e di prenotazione del turno sono rifiutate. Per tornare al vecchio software occorre ripristinare il backup precedente alla migrazione, oltre al codice precedente.

Prima di aggiornare salvare un backup verificato e conservare la precedente immagine. Provare le nuove immagini in un ambiente separato con una copia dei dati, poi ricostruire e riavviare:

Non limitarsi a sostituire i file con il processo Node ancora in esecuzione: la pagina può caricare il nuovo codice mentre il server usa ancora le vecchie regole di salvataggio. Completare sempre il riavvio con Compose prima di usare nuovi campi come “Sede operativa”; ricaricare poi la pagina su tutti i dispositivi. Se una scheda mostra “Modifiche sospese”, scaricare la bozza prima di ricaricarla.

Per installare un nuovo archivio caricato come `/opt/Gestionale-VPS.zip`, dalla cartella di installazione prevista `/opt/officina` estrarre prima in una directory temporanea e controllare che contenga il progetto. Il comando `cp -a` aggiorna i file del programma senza rimuovere `.env`, il database o i backup già presenti. Eseguire il backup prima di questi passaggi; al termine Compose ricostruisce l'immagine e ricrea il servizio:

```bash
cd /opt/officina
bash deploy/backup.sh
docker image tag officina-app:local officina-app:precedente
update_dir=$(mktemp -d /opt/officina-update.XXXXXX)
unzip -q /opt/Gestionale-VPS.zip -d "$update_dir"
test -f "$update_dir/gestionale-vps/compose.yaml" || { echo "Archivio non estratto nel percorso previsto"; exit 1; }
test -f /opt/officina/compose.yaml || { echo "Cartella di installazione non trovata: verificare il percorso usato sul VPS"; exit 1; }
cp -a "$update_dir/gestionale-vps/." /opt/officina/
cd /opt/officina
docker compose config --quiet
docker compose build --pull app
docker compose up -d --wait
docker compose logs --tail=100 app caddy
```

Se il progetto è installato in un'altra cartella, sostituire `/opt/officina` con la directory che contiene il suo `compose.yaml` in entrambe le righe di controllo e in `cp`/`cd`. Se `docker compose` non viene riconosciuto, aggiornare/installare il plugin Docker Compose prima di proseguire. Ricaricare le pagine aperte sui dispositivi dopo aver verificato che il servizio sia avviato.

I tag base `node:24-bookworm-slim` e `caddy:2-alpine` ricevono aggiornamenti: per distribuzioni ripetibili fissare i digest delle immagini effettivamente collaudate. Una migrazione di schema può richiedere anche il ripristino del database per tornare indietro; non presumere che basti riusare il vecchio container.

Il seguente collaudo sul VPS è necessario prima di usarlo come archivio operativo:

1. Aprire due dispositivi con account diversi. Entrambi modificano subito clienti diversi: verificare che entrambe le modifiche siano conservate.
2. Modificare un cliente, un appuntamento e una quantità di magazzino; controllare valori e aggiornamento sull'altro dispositivo.
3. Interrompere la rete su un dispositivo e continuare sull'altro. Al ritorno della rete verificare che una copia vecchia non sovrascriva le voci aggiornate.
4. Modificare la stessa voce da due schede: il secondo salvataggio deve mostrare il conflitto e conservare la bozza. Provare anche due interventi che scaricano lo stesso articolo e verificare che nessun intervento venga salvato a metà.
5. Riavviare l'app, verificare la persistenza dei dati, creare un backup e provarne il ripristino su un'installazione separata.
6. Verificare da Internet che siano esposte soltanto le porte previste e che il certificato HTTPS sia valido. Controllare spazio disco, backup recenti e log senza errori.

**Stato di verifica:** i file di distribuzione sono predisposti, ma Docker, Caddy, certificati pubblici e script Linux devono essere eseguiti e collaudati sul VPS. Docker e Bash non sono disponibili nell'ambiente Windows usato per preparare questo pacchetto; nessun collaudo reale del deployment è implicito nella consegna. Le verifiche applicative effettivamente eseguite sono riportate separatamente nel resoconto di consegna.
