import {InvoiceSync} from '../src/sync/invoice-sync.js';
const args=process.argv.slice(2);
if(args.length!==3){console.error('Uso: node scripts/sync-import.mjs PARTITA_IVA CARTELLA_O_FILE_XML_ZIP DATABASE_NUOVO.sqlite');process.exitCode=1;}
else {
  let service;
  try {
    service=await InvoiceSync.open(args[2],{vat:args[0]});
    const result=await service.syncLocal(args[1]);console.log(JSON.stringify(result,null,2));
    if(result.state!=='COMPLETED')process.exitCode=2;
  } catch {console.error('Importazione non riuscita: verificare identificativo azienda, percorsi, Python/lxml e assenza di sincronizzazioni già attive.');process.exitCode=1;}
  finally {service?.close();}
}
