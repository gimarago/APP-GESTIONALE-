import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LIMIT = 32 * 1024 * 1024;
// The subprocess has no network resolver and loads only hash-pinned contracts.
function engine(mode, input) {
  const clean = { ...input, mode };
  if (clean.bodyBase64) delete clean.xml; // Keep binary MTOM intact without duplicating it.
  const body = JSON.stringify(clean);
  if (Buffer.byteLength(body) > LIMIT) return Promise.reject(Error('SDI_INPUT_LIMIT'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.OFFICINA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      [fileURLToPath(new URL('../backend/src/xml/sdi-engine.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = []; let size = 0, settled = false;
    function done(error, result) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); }
    const timer = setTimeout(() => { child.kill(); done(Error('SDI_XML_TIMEOUT')); }, 20000);
    child.on('error', () => done(Error('SDI_XML_UNAVAILABLE: configurare Python con lxml')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > LIMIT) { child.kill(); done(Error('SDI_OUTPUT_LIMIT')); } else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('close', () => {
      try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); done(value.ok ? null : Error(value.error), value.result); }
      catch { done(Error('SDI_XML_FAILURE')); }
    });
    child.stdin.end(body);
  });
}

export const prepareOutgoing = input => engine('prepare', input);
export const parseCallback = input => engine('callback', input);
export const inspectIncoming = input => engine('inspect', input);
export async function parseOutgoingResponse(input) {
  try { return await engine('response', input); }
  catch { return { kind: 'UNKNOWN', reason: 'Risposta SdI non verificabile. Nessun nuovo invio automatico.' }; }
}
