import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base=new URL('../contracts/',import.meta.url);
await mkdir(base,{recursive:true});
const paths=[
 '/export/documenti/fatturapa/v1.4/Schema_VFPR12_v1.2.3.xsd',
 '/export/documenti/ws/trasmissione/v1.0/SdIRiceviFile_v1.0.wsdl',
 '/export/documenti/ws/trasmissione/v1.0/TrasmissioneTypes_v1.0.xsd',
 '/export/documenti/ws/trasmissione/v1.0/TrasmissioneTypes_v1.1.xsd',
 '/export/documenti/ws/trasmissione/v1.0/TrasmissioneFatture_v1.1.wsdl',
 '/export/documenti/ws/trasmissione/v3.x/Istruzioni-per-il-servizio-SDICoop-Trasmissione-versione3.3.pdf',
 '/export/documenti/fatturapa/v1.4/Specifiche_tecniche_del_formato_FatturaPA_V1.4.pdf',
 'https://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd'
];
const manifest=[];
for(const path of paths) {
 const url=path.startsWith('https://')?path:'https://www.fatturapa.gov.it'+path;
 const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
 if(!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
 const bytes=Buffer.from(await response.arrayBuffer());const file=path.split('/').at(-1);
 await writeFile(new URL(file,base),bytes);
 manifest.push({file,url,downloadedAt:new Date().toISOString(),sha256:createHash('sha256').update(bytes).digest('hex')});
 console.log(file,bytes.length);
}
await writeFile(new URL('manifest.json',base),JSON.stringify(manifest,null,2)+'\n');
