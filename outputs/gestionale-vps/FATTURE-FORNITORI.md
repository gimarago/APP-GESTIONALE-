# Fatture dei fornitori e pagamenti

La sezione **Fatture fornitori** è separata dalle fatture emesse ai clienti. Mostra le fatture da controllare, gli importi ancora da pagare, le scadenze e i pagamenti registrati. Per le fatture ricevute via PEC offre un'anteprima leggibile delle righe dell'XML e permette di scaricare l'originale. Registrare un pagamento nel gestionale significa annotare un bonifico o un altro pagamento già effettuato tramite la banca: il gestionale non dispone bonifici.

Il totale **Da pagare** somma soltanto gli importi residui delle fatture verificate. Una fattura acquisita automaticamente dalla PEC resta **Da verificare** finché un operatore non controlla importo, fornitore e scadenza sull'XML originale. I documenti da verificare non vengono sommati ai debiti. I pagamenti parziali riducono il residuo; il server impedisce di registrare più del totale e conserva le modifiche concorrenti in transazioni SQLite.

Le fatture e i pagamenti registrati dagli altri dispositivi aggiornano automaticamente l'elenco aperto, i residui e le spese in Data analysis, senza ricaricare la pagina. Filtri e anteprima XML restano disponibili. Se stai compilando una fattura o un pagamento, l'aggiornamento aspetta la chiusura del modulo e conserva la versione della tua bozza: una modifica concorrente viene segnalata prima di salvare. Dopo un errore di rete, i dati disponibili restano visibili e il controllo viene ritentato con attese crescenti.

## Ricezione indipendente da Fatture in Cloud

L'opzione prevista per questa officina è la casella **Legalmail PEC**: il servizio sul VPS legge via IMAP cifrato i messaggi consegnati alla casella, senza cancellarli né spostarli, e importa gli XML riconosciuti delle fatture intestate alla partita IVA configurata. Si tratta di ricezione attraverso la PEC, **non** di un accesso diretto al portale dell'Agenzia delle Entrate. Il codice destinatario oggi usato potrebbe appartenere al canale di Fatture in Cloud; conoscere quel codice non dà accesso al relativo canale.

La ricezione resta spenta finché non vengono configurate la casella PEC e la partita IVA sul VPS e attivato il servizio dedicato. Non comunicare password PEC o Google in chat. Le credenziali Legalmail sono diverse da quelle Gmail usate per spedire i link di recupero password. Legalmail offre una password applicativa dedicata ai client, da creare nella propria webmail. [Parametri IMAP Legalmail](https://help.infocert.it/home/faq/quali-sono-le-nuove-modalita-di-accesso-ai-servizi-legalmail) · [Password applicativa Legalmail](https://help.infocert.it/home/faq/che-cosa-e-l-application-password).

Prima di modificare il recapito delle fatture nel portale **Fatture e Corrispettivi**, verificare il recapito attuale e collaudare la lettura della PEC con un documento di prova. Registrare la PEC come indirizzo telematico è una modifica operativa esterna: può interrompere la consegna automatica a Fatture in Cloud. Non eseguirla alla cieca. Gli XML già presenti solo su Fatture in Cloud non arrivano retroattivamente nella PEC; occorre recuperarli separatamente. Le [specifiche FatturaPA](https://www.fatturapa.gov.it/export/documenti/Specifiche_tecniche_del_formato_FatturaPA_V1.3.1.pdf) distinguono il recapito tramite canale accreditato da quello tramite PEC.

La presenza di un XML non prova che sia già stato pagato. Inoltre il tracciato può contenere note di credito, più corpi, rate o un totale documento facoltativo: per questo importi ambigui richiedono la verifica umana e non aumentano automaticamente il totale **Da pagare**. Le note di credito importate sono visibili ma **non riducono automaticamente** il totale dei debiti; riconciliarle con le fatture e i pagamenti effettivi. Il gestionale non sostituisce la conservazione fiscale a norma o le verifiche del commercialista. [Tracciato ufficiale FatturaPA](https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.3/Rappresentazione-tabellare-fattura-ordinaria.pdf).

## Attivazione sul VPS, dopo il collaudo

1. Installare prima il gestionale con dominio HTTPS secondo [README-VPS.md](README-VPS.md). Eseguire un backup verificato. La ricezione PEC è un servizio facoltativo e inizialmente spento.
2. Verificare nel portale **Fatture e Corrispettivi** il recapito registrato oggi. Se il codice destinatario appartiene a Fatture in Cloud, non è un canale SdI indipendente del gestionale. Verificare che la tua Legalmail riceva effettivamente fatture SdI prima di modificare quel recapito.
3. Sulla console del VPS modificare `/opt/officina/.env` (senza inviare il contenuto in chat), impostando `SHOP_VAT` con le **11 cifre** della partita IVA della tua officina, `PEC_USER` con l'utente di accesso IMAP Legalmail, `PEC_APP_PASSWORD` con la credenziale IMAP autorizzata da Legalmail, `PEC_HOST=mbox.cert.legalmail.it`, `PEC_PORT=993` e `PEC_MAILBOX=INBOX` o la cartella che contiene le fatture. Le variabili `SMTP_*` di Gmail sono indipendenti e servono solo per inviare i link di recupero password. Mantenere `.env` leggibile solo dall'amministratore (`chmod 600 .env`).
4. Avviare il lettore e controllare i log, senza spostare o cancellare messaggi dalla casella:

   ```bash
   cd /opt/officina
   docker compose build app
   docker compose up -d --wait app
   docker compose --profile pec up -d pec
   docker compose --profile pec logs --tail=100 pec
   ```

5. Aprire **Fatture fornitori** da due account. Una fattura di prova indirizzata alla partita IVA configurata deve apparire **Da verificare**, con XML scaricabile. Confrontare fornitore, numero, importo e scadenza con l'originale prima di confermarla. Verificare che il totale **Da pagare** si aggiorni su entrambi i dispositivi. Se la casella contiene vecchie fatture, anche quelle possono essere elencate come **Da verificare**: non confermarle come debiti correnti senza controllare i pagamenti storici.

Se il banner della sezione segnala errori o documenti non acquisiti, consultare i log del servizio e confrontare la casella PEC con il registro prima di usare il totale per decidere i pagamenti. Il numero di anomalie è cumulativo e non si azzera automaticamente dopo il controllo manuale. Il servizio non cancella i messaggi e non invia bonifici. I file firmati `.xml.p7m` non vengono ancora aperti automaticamente: restano nella PEC e vengono segnalati come problemi d'importazione. La verifica della firma digitale non viene eseguita sugli XML importati.

**Backup:** il backup SQLite creato da `bash deploy/backup.sh` include registro, pagamenti, XML originali e stato del lettore PEC. Nella sezione è disponibile **Esporta registro CSV** per consultazioni rapide, ma contiene solo il riepilogo delle fatture. Il comando **Gestione > Esporta copia dati** esporta il precedente archivio operativo, ma non include questo nuovo registro separato né gli XML originali: non usarlo come unico backup del VPS.

## Canale diretto SdI

La ricezione diretta tramite canale accreditato è descritta in [SDI-DIRETTO.md](SDI-DIRETTO.md). È alternativa al recapito PEC: registrare il recapito effettivo soltanto dopo il collaudo. Le ricezioni XML compatibili sono importate come fatture **da verificare**, senza inventare pagamenti; gli originali non importabili restano nel pannello SdI con il motivo della verifica. Il collaudo è separato dalla contabilità di produzione.
