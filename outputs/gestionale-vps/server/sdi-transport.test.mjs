import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadSdiCredentials, postSdiSoap } from './sdi-transport.mjs';

// Ephemeral, synthetic identities only. No private key is shipped in the repo.
const generate = String.raw`
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
root=Path(sys.argv[1]); now=datetime.now(timezone.utc)
def key(): return rsa.generate_private_key(public_exponent=65537,key_size=2048)
def name(cn): return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,cn)])
ca_key=key(); ca_name=name('Temporary SdI test CA')
ca=(x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
    .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=10))
    .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
    .sign(ca_key,hashes.SHA256()))
(root/'ca.pem').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
for label,eku in [('server',ExtendedKeyUsageOID.SERVER_AUTH),('client',ExtendedKeyUsageOID.CLIENT_AUTH),('other',ExtendedKeyUsageOID.CLIENT_AUTH)]:
    private=key()
    cert=(x509.CertificateBuilder().subject_name(name(label)).issuer_name(ca_name).public_key(private.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
        .add_extension(x509.ExtendedKeyUsage([eku]),critical=False)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False)
        .sign(ca_key,hashes.SHA256()))
    (root/(label+'-cert.pem')).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (root/(label+'-key.pem')).write_bytes(private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
`;
function fixture(t) {
  const python=process.env.OFFICINA_PYTHON || (process.platform==='win32' ? 'python' : 'python3');
  try { execFileSync(python,['-c','import cryptography'],{stdio:'ignore',windowsHide:true}); }
  catch { t.skip('Local TLS tests require Python cryptography (test dependency only).'); return null; }
  const dir=mkdtempSync(join(tmpdir(),'officina-sdi-tls-test-'));
  t.after(()=>{
    const path=resolve(dir);
    assert.ok(path.startsWith(resolve(tmpdir())+sep) && basename(path).startsWith('officina-sdi-tls-test-'));
    rmSync(path,{recursive:true,force:true});
  });
  execFileSync(python,['-c',generate,dir],{stdio:'pipe',windowsHide:true});
  const config={certPath:join(dir,'client-cert.pem'),keyPath:join(dir,'client-key.pem'),caPath:join(dir,'ca.pem'),timeoutMs:500,maxResponseBytes:1024};
  return {dir,config,pem:name=>readFileSync(join(dir,name+'.pem'))};
}
async function listen(t,f,handler) {
  const server=https.createServer({cert:f.pem('server-cert'),key:f.pem('server-key'),ca:f.pem('ca'),requestCert:true,rejectUnauthorized:true},handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `https://localhost:${server.address().port}/soap`;
}
const request={xml:'<Envelope>test</Envelope>',action:'urn:test-action'};

test('credential loader rejects mismatched, missing and expired client certificates before sending', t=>{
  const f=fixture(t); if(!f) return;
  const credentials=loadSdiCredentials(f.config);
  assert.ok(credentials.secureContext); assert.ok(credentials.expiresAt>Date.now());
  assert.throws(()=>loadSdiCredentials({...f.config,keyPath:join(f.dir,'other-key.pem')}),{code:'SDI_CREDENTIALS'});
  assert.throws(()=>loadSdiCredentials({...f.config,caPath:join(f.dir,'missing.pem')}),{code:'SDI_CREDENTIALS'});
  assert.throws(()=>loadSdiCredentials(f.config,Date.now()+30*86400000),{code:'SDI_CREDENTIALS'});
});
test('transport performs one verified mutual TLS request, preserving SOAPAction and request bytes', async t=>{
  const f=fixture(t); if(!f) return;
  let received,identity;
  f.config.endpoint=await listen(t,f,(req,res)=>{
    identity=req.socket.authorized; let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      received={body,action:req.headers.soapaction};res.writeHead(200,{'Content-Type':'text/xml'});res.end('<response/>');
    });
  });
  const response=await postSdiSoap(f.config,loadSdiCredentials(f.config),request);
  assert.equal(identity,true);assert.deepEqual(received,{body:request.xml,action:'"urn:test-action"'});
  assert.equal(response.status,200);assert.equal(response.body.toString(),'<response/>');
});
test('transport verifies hostname even when the issuing CA is trusted', async t=>{
  const f=fixture(t); if(!f) return; let requests=0;
  f.config.endpoint=(await listen(t,f,(_,res)=>{requests++;res.end('unexpected');})).replace('localhost','127.0.0.1');
  await assert.rejects(postSdiSoap(f.config,loadSdiCredentials(f.config),request),/SDI_TRANSPORT_FAILED/);
  assert.equal(requests,0);
});
test('transport never follows redirects or retries an interrupted response', async t=>{
  const f=fixture(t); if(!f) return;let requests=0,redirect=true;
  f.config.endpoint=await listen(t,f,(req,res)=>{
    requests++;
    if(redirect){res.writeHead(307,{Location:'/other'});res.end();}
    else {res.writeHead(200);res.write('partial');req.socket.destroy();}
  });
  const credentials=loadSdiCredentials(f.config);
  assert.equal((await postSdiSoap(f.config,credentials,request)).status,307);assert.equal(requests,1);
  redirect=false;
  await assert.rejects(postSdiSoap(f.config,credentials,request),/SDI_(?:TRANSPORT_FAILED|RESPONSE_INTERRUPTED)/);
  assert.equal(requests,2);
});
test('transport aborts oversized responses and times out without retries', async t=>{
  const f=fixture(t); if(!f) return;let requests=0,oversized=true;
  f.config.endpoint=await listen(t,f,(_,res)=>{requests++;if(oversized)res.end('x'.repeat(2048));});
  const credentials=loadSdiCredentials(f.config);
  await assert.rejects(postSdiSoap(f.config,credentials,request),/SDI_RESPONSE_TOO_LARGE/);
  oversized=false;
  await assert.rejects(postSdiSoap(f.config,credentials,request),/SDI_TIMEOUT/);
  assert.equal(requests,2);
});
