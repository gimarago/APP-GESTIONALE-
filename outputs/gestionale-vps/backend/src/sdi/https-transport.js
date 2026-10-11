import https from 'node:https';
import {readFile} from 'node:fs/promises';
// Unica richiesta, niente redirect né retry; tutti gli errori dopo l'avvio sono incerti.
export async function postSoap({endpoint,certPath,keyPath,caPath,body,action,timeoutMs=15000}) {
  const [cert,key,ca]=await Promise.all([readFile(certPath),readFile(keyPath),readFile(caPath)]);
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(value);};
    const request=https.request(endpoint,{method:'POST',cert,key,ca,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,
      headers:{'Content-Type':'text/xml; charset=utf-8','SOAPAction':`"${action}"`,'Content-Length':Buffer.byteLength(body)}},response=>{
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>2000000){request.destroy();finish(Error('RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
      response.on('error',()=>finish(Error('RESPONSE_INTERRUPTED')));
      response.on('end',()=>finish(null,{status:response.statusCode,contentType:response.headers['content-type']||'',body:Buffer.concat(chunks).toString('utf8')}));
    });
    const timer=setTimeout(()=>{request.destroy();finish(Error('TRANSPORT_TIMEOUT'));},timeoutMs);
    request.on('error',()=>finish(Error('TRANSPORT_FAILURE')));
    request.end(body);
  });
}
