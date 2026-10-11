import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export async function xmlEngine(input) {
  const body=JSON.stringify(input);
  if(Buffer.byteLength(body)>4000000) throw Error('INPUT_TOO_LARGE');
  const executable=process.env.OFFICINA_PYTHON || (process.platform==='win32'?'python':'python3');
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[fileURLToPath(new URL('./engine.py',import.meta.url))],{stdio:['pipe','pipe','ignore'],windowsHide:true});
    let output='',size=0;
    const timer=setTimeout(()=>{child.kill();reject(Error('XML_ENGINE_TIMEOUT'));},15000);
    child.on('error',()=>{clearTimeout(timer);reject(Error('XML_ENGINE_UNAVAILABLE: configurare OFFICINA_PYTHON con Python e lxml'));});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4000000){child.kill();reject(Error('XML_ENGINE_OUTPUT_LIMIT'));}else output+=chunk;});
    child.stdin.on('error',()=>{});
    child.on('close',()=>{clearTimeout(timer);try {const value=JSON.parse(output);if(!value.ok) reject(Error(value.error));else resolve(value.result);}catch {reject(Error('XML_ENGINE_FAILURE: verificare Python e lxml'));}});
    child.stdin.end(body);
  });
}
