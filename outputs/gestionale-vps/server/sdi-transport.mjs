import https from 'node:https';
import tls from 'node:tls';
import { readFileSync, statSync } from 'node:fs';
import { X509Certificate, createPrivateKey } from 'node:crypto';

function readPem(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw Error('SDI_CREDENTIAL_FILE');
  return readFileSync(path);
}

// Run before claiming work: credential problems must not consume an attempt.
export function loadSdiCredentials(config, now = Date.now()) {
  try {
    const cert = readPem(config.certPath), key = readPem(config.keyPath), ca = readPem(config.caPath);
    const leaf = new X509Certificate(cert);
    if (now < Date.parse(leaf.validFrom) || now >= Date.parse(leaf.validTo) || !leaf.checkPrivateKey(createPrivateKey(key))) throw Error('SDI_CREDENTIAL_INVALID');
    const caBlocks = ca.toString('ascii').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!caBlocks?.length) throw Error('SDI_CA_INVALID');
    for (const block of caBlocks) new X509Certificate(block);
    const secureContext = tls.createSecureContext({ cert, key, ca, minVersion: 'TLSv1.2' });
    return { cert, key, ca, secureContext, expiresAt: Date.parse(leaf.validTo) };
  } catch { throw Object.assign(new Error('Certificati SdI mancanti, scaduti o non validi: controllare la configurazione del canale.'), { code: 'SDI_CREDENTIALS' }); }
}

// Exactly one HTTPS request. Redirects, timeouts and malformed responses are
// left to the persistent coordinator as uncertain; NEVER retry automatically.
export function postSdiSoap(config, credentials, { xml, action, bodyBase64, contentType = 'text/xml; charset=utf-8' }) {
  const body = bodyBase64 ? Buffer.from(bodyBase64, 'base64') : Buffer.from(xml, 'utf8');
  if (!body.length || body.length > 18 * 1024 * 1024 || typeof action !== 'string' || /[\r\n]/.test(action)) throw Error('SDI_REQUEST_INVALID');
  if (typeof contentType !== 'string' || /[\r\n]/.test(contentType)) throw Error('SDI_CONTENT_TYPE');
  return new Promise((resolve, reject) => {
    let settled = false;
    const complete = (error, result) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolve(result); };
    const request = https.request(config.endpoint, {
      method: 'POST', agent: false, secureContext: credentials.secureContext,
      rejectUnauthorized: true, minVersion: 'TLSv1.2',
      headers: { 'Content-Type': contentType, SOAPAction: `"${action.replace(/^"|"$/g, '')}"`, 'Content-Length': body.length, Accept: 'text/xml, multipart/related', Connection: 'close' }
    }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        // destroy() can synchronously emit 'aborted'. Preserve the precise
        // failure before closing either stream, and never consume more bytes.
        if (size > config.maxResponseBytes) { complete(Error('SDI_RESPONSE_TOO_LARGE')); response.destroy(); request.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => complete(null, { status: response.statusCode, contentType: response.headers['content-type'] || '', body: Buffer.concat(chunks) }));
      response.on('error', () => complete(Error('SDI_RESPONSE_INTERRUPTED')));
      response.on('aborted', () => complete(Error('SDI_RESPONSE_INTERRUPTED')));
    });
    const deadline = setTimeout(() => { complete(Error('SDI_TIMEOUT')); request.destroy(); }, config.timeoutMs);
    request.on('error', () => complete(Error('SDI_TRANSPORT_FAILED')));
    request.end(body);
  });
}
