# Fatturazione autonoma locale

Dal menu **Preventivi e fatture** puoi gestire fatture TD01, note di credito TD04 e fatture differite TD24 create dai rapporti di intervento. Il flusso funziona anche aprendo direttamente `officina-fatturazione.html`, mantenendo tutti i file della cartella.

**Nessuna fattura viene trasmessa al Sistema di Interscambio.** Il modulo non chiama servizi di fatturazione esterni e non utilizza il trasporto SdI del backend sperimentale. Documento definitivo significa numerato e bloccato nell'archivio locale: non significa trasmesso o accettato dal SdI. Lo stato è indicato anche nel PDF.

## Primo utilizzo

1. Apri **Dati fiscali dell'officina** e salva denominazione, partita IVA, indirizzo completo, codice fiscale, regime fiscale e IBAN.
2. Imposta anno e **primo numero disponibile**. Se hai già numerato documenti altrove, indica il primo numero libero. Fatture e note di credito condividono la serie annuale `numero/anno`. I numeri già usati non vengono riutilizzati.
3. Il logo del PDF è quello delle Impostazioni, salvato insieme ai dati fiscali; la conferma conserva una copia dei dati dell'emittente nel documento.

## Dal lavoro alla fattura

- Crea una nuova fattura e scegli il cliente dall'anagrafica, oppure compila i dati fiscali.
- Importa lavori dall'agenda/parcheggio o un preventivo salvato. Il preventivo conserva quantità e prezzi; lo stesso preventivo non può essere collegato a due fatture.
- I prezzi inseriti sono unitari IVA inclusa. Il documento espone imponibile, sconto, IVA e totale. I calcoli fiscali arrotondano imponibili e riepiloghi: con righe particolari è possibile uno scarto di un centesimo rispetto alla semplice somma dei prezzi lordi; il totale mostrato è quello di XML e PDF.
- Aliquote: 22%, 10%, 5%, 4%, oppure 0% con natura e riferimento normativo. Regimi disponibili: ordinario RF01 e forfettario RF19. L'importazione dall'agenda assume IVA 22%: controlla l'aliquota prima di confermare. Il regime RF19 richiede IVA 0% e N2.2.
- Puoi indicare scadenza, modalità di pagamento, IBAN e bollo da 2 euro addebitato al cliente. Il bollo è una scelta manuale, non una determinazione fiscale automatica.
- **Salva bozza** conserva una versione modificabile. **Scarica PDF** produce anche le bozze, identificate come tali.
- **Conferma e numera** controlla i dati, propone numero e totale, e salva una versione definitiva immutabile. Non invia nulla. Da quel momento puoi scaricare il PDF e lo stesso XML archiviato senza assegnare altri numeri.
- **Duplica in bozza** crea un nuovo documento senza copiare numero, saldo o collegamento contabile. **Crea nota di credito** parte dalla fattura originale riportandone numero e data; rettifica le righe prima della conferma. Le note di credito hanno valori positivi nel documento e sono sottratte nei totali dell'archivio.
- Si possono eliminare solo bozze. Una bozza con saldo collegato deve prima tornare Da saldare.

## Pagamenti e archivio

L'archivio mostra documenti per anno/mese, bozze, saldati, non saldati, note di credito e scaduti. I riepiloghi mensili e le schede economiche comprendono solo documenti definitivi.

Per una fattura associata a un lavoro completato nel libro contabile, **Salva pagamento** azzera il fuori cassa residuo e registra il rientro alla data scelta. Cliente e totale devono corrispondere; lo stesso lavoro non può essere collegato a due fatture. Salvare nuovamente non duplica l'incasso. Correggere la data aggiorna il rientro esistente; tornare Da saldare lo annulla e ripristina il residuo. Gli errori di salvataggio annullano la transazione.

Senza lavoro collegato, il pagamento è registrato nel solo archivio fatture. Le note di credito hanno stato Da rimborsare/compensare oppure Rimborsata/compensata; non alterano automaticamente il saldo del lavoro originale.

**Esporta registro CSV** scarica tutti i documenti definitivi, con importi, scadenze, saldo e stato non trasmesso; gli importi delle note di credito sono negativi nel registro.

## Backup

I dati restano nel browser e nella stessa origine (file locale, localhost o 127.0.0.1 sono archivi distinti). **Esporta backup fatture** salva documenti, dati fiscali, numerazione e XML. L'importazione unisce documenti nuovi e ignora copie identiche; blocca numeri duplicati, documenti incompleti e conflitti sullo stesso documento. Nessun dato viene importato se un controllo fallisce. Il registro rientri e gli interventi del gestionale sono archivi separati e non vengono ricostruiti dal backup fatture.

Le modifiche effettuate in altre schede vengono rilevate prima di salvare: ricarica la scheda obsoleta. La numerazione usa anche un blocco condiviso nei browser con Web Locks.

## Ambito e verifica

Il flusso gestisce clienti con sede in Italia e formato ordinario FPR12. Le fatture differite TD24 sono disponibili soltanto dalla funzione Rapporti di intervento, per lavori dello stesso cliente e dello stesso mese; la bozza riporta numero e data del rapporto e propone come data documento quella dell'ultimo intervento. Prima di numerare verifica la documentazione e i termini fiscali. Non è una gestione generale di DDT o di tutti i casi di fatturazione differita. PA, estero, ritenute, casse previdenziali, split payment e altri documenti speciali non sono inclusi. Non sono implementati trasmissione, ricevute SdI o conservazione a norma.

XML verificati in locale con lo schema ufficiale incluso `backend/contracts/Schema_VFPR12_v1.2.3.xsd`, scaricato dalla [documentazione FatturaPA](https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.4/Schema_VFPR12_v1.2.3.xsd). La validazione locale non equivale ai controlli o all'accettazione SdI.

Test: `node fatturazione.test.js`; `node --test cashbook.test.cjs invoice-independent.test.cjs`. Per i test XSD serve Python con lxml; indicarne il percorso nella variabile OFFICINA_PYTHON. Verificati inoltre in un browser isolato: numerazione, PDF/XML, nota di credito, backup, preventivi, protezione tra schede e assenza di chiamate di trasmissione. Nessun documento reale è stato numerato o inviato durante le prove.
