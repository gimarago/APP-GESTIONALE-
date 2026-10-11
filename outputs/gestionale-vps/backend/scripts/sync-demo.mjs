import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {sampleInvoice} from '../fixtures/invoice.js';
import {XmlGenerator} from '../src/fatture/xml-generator.js';
import {InvoiceSync} from '../src/sync/invoice-sync.js';
const dir=new URL('../data/sync-demo/',import.meta.url);await mkdir(new URL('exports/',dir),{recursive:true});
await writeFile(new URL('exports/prova.xml',dir),await new XmlGenerator().generate(sampleInvoice()));
const service=await InvoiceSync.open(fileURLToPath(new URL('received.sqlite',dir)),{vat:sampleInvoice().customer.vat});
try {
  const result=await service.syncLocal(fileURLToPath(new URL('exports/',dir)));
  console.log(JSON.stringify(result,null,2));
  await writeFile(new URL('fatture-ricevute.json',dir),JSON.stringify(service.list(),null,2));
}finally{service.close();}
