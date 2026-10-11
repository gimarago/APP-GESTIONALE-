import {Store} from './storage.js';
import {InvoiceService} from './service.js';
import {NotificationHandler} from './sdi/notification-handler.js';
import {SimulatorReceiver} from './sdi/sdi-receiver.js';
import {fileURLToPath} from 'node:url';
const store=await Store.open(fileURLToPath(new URL('../data/test/simulation.sqlite',import.meta.url)));
try {
  const service=new InvoiceService(store);
  await service.recoverInterrupted();
  const id=await service.createDraft('demo-v1',{simulation:true,label:'Esempio sintetico officina'});
  await service.enqueue(id);
  const attemptId=await service.runOne();
  if(attemptId) await new SimulatorReceiver(new NotificationHandler(store)).receive(JSON.stringify({simulation:true,id:`demo-${attemptId}`,correlation:`SIM-${attemptId}`,outcome:'CONSEGNATA'}));
  const invoice=await service.get(id);
  console.log({simulation:true,id,status:invoice.status,payment:invoice.payment});
} finally {store.close();}
