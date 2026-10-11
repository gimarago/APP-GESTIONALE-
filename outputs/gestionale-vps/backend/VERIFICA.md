# Verifica locale della fase 2

## Aggiornamento recupero storico — 12 settembre 2026

Suite completa: **21 test backend e 8 controlli frontend superati**. I 7 nuovi test verificano importazione locale XML/ZIP, originali preservati, riapertura archivio e deduplicazione, identità aziendale, conflitti senza sovrascrittura, XML multi-corpo, run interrotti, separazione degli archivi, ZIP ostili/espansivi e rifiuto esplicito del connettore remoto non configurato. Demo ripetuta: una importazione iniziale, un duplicato al secondo passaggio. Nessuna connessione al portale, nessun download aziendale effettuato. Vedi `SINCRONIZZAZIONE.md` per il lavoro ancora necessario.

## Verifica precedente

Eseguita l'11 settembre 2026 su Windows, Node.js 24.19.0, Python con lxml 6.1.1/libxml2 2.11.9 e cryptography 50.0.1.

Risultati:

- 14 test Node superati: 6 del simulatore preservato e 8 della fase fiscale/SOAP.
- 8 controlli del modulo frontend `fatturazione.test.js` superati.
- Demo fiscale eseguita: XML validato contro lo XSD ufficiale FPR12 1.2.3; richiesta SOAP generata e validata contro lo schema del WSDL ufficiale.
- HTTPS locale con server e client autenticati tramite certificati temporanei: risposta sincrona valida archiviata, secondo invio identico evitato.
- Duplicati bloccati anche con nuova chiave sorgente o nuovo progressivo per la medesima identità fiscale.
- Timeout archiviato UNKNOWN senza retry; SOAP Fault ed errore di fiducia del certificato non interpretati come ACK.
- XML non valido, DTD/entità, eccessi di dimensione/profondità, namespace errati e codici di risposta non previsti rifiutati.

I certificati generati dai test sono temporanei, locali e privi di rapporto con SdI. Il server viene associato esclusivamente a 127.0.0.1 su porta effimera e chiuso al termine. Nessun ricevitore pubblico è stato avviato.

L'utente ha confermato di non avere ancora il canale di test. Nessuna chiamata a SdI è stata effettuata. Interoperabilità reale, ricevitore notifiche, riconciliazione remota, accreditamento e verifica fiscale restano da completare. I risultati locali non attestano conformità fiscale, conservazione o sicurezza assoluta.
