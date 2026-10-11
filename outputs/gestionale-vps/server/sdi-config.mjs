import { timingSafeEqual } from 'node:crypto';

const domain = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const failure = field => { throw Object.assign(new Error(`Configurazione SdI non valida: ${field}.`), { code: 'SDI_CONFIGURATION' }); };
const value = (env, name) => String(env[name] ?? '').trim();
export const fingerprint = value => typeof value === 'string' ? value.replace(/:/g, '').toLowerCase() : '';

// No default endpoint: copy it from the signed agreement for THIS environment.
// This deliberately rejects arbitrary URLs, credentials, redirects and ports.
export function readSdiConfig(env = process.env) {
  if (!['true','false',''].includes(value(env, 'SDI_ENABLED'))) failure('SDI_ENABLED');
  if (value(env, 'SDI_ENABLED') !== 'true') return Object.freeze({ enabled: false, environment: null });
  const environment = value(env, 'SDI_ENVIRONMENT');
  if (!['test','production'].includes(environment)) failure('SDI_ENVIRONMENT');
  const accreditationReference = value(env, 'SDI_ACCREDITATION_REFERENCE');
  if (!accreditationReference || accreditationReference.length > 200) failure('SDI_ACCREDITATION_REFERENCE');
  if (environment === 'production' && value(env, 'SDI_PRODUCTION_APPROVED') !== 'true') failure('SDI_PRODUCTION_APPROVED');
  const shopVat = value(env, 'SHOP_VAT').replace(/^IT/i, '');
  if (!/^\d{11}$/.test(shopVat)) failure('SHOP_VAT');
  let endpoint;
  try { endpoint = new URL(value(env, 'SDI_ENDPOINT')); } catch { failure('SDI_ENDPOINT'); }
  const expectedHost = value(env, 'SDI_ENDPOINT_HOST').toLowerCase();
  const officialDomain = /(?:^|\.)(?:fatturapa\.it|fatturapa\.gov\.it|agenziaentrate\.gov\.it)$/;
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || (endpoint.port && endpoint.port !== '443') || !officialDomain.test(endpoint.hostname) || !expectedHost || endpoint.hostname !== expectedHost) failure('SDI_ENDPOINT / SDI_ENDPOINT_HOST');
  // A test install cannot accidentally target the production service. An
  // agreement using a new hostname needs an explicit code review before use.
  const testHost = /(?:test|collaudo)/i.test(expectedHost.split('.')[0]);
  if ((environment === 'test') !== testHost) failure('ambiente e hostname SDI_ENDPOINT');
  const callbackHost = value(env, 'SDI_DOMAIN').toLowerCase();
  if (!domain.test(callbackHost) || !callbackHost.includes('.') || callbackHost.includes('..') || callbackHost === value(env, 'OFFICINA_DOMAIN').toLowerCase()) failure('SDI_DOMAIN');
  const gatewayToken = value(env, 'SDI_GATEWAY_TOKEN');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(gatewayToken)) failure('SDI_GATEWAY_TOKEN');
  const peerFingerprints = value(env, 'SDI_PEER_FINGERPRINTS').split(',').map(s => fingerprint(s.trim()));
  if (!peerFingerprints.length || peerFingerprints.some(s => !/^[a-f0-9]{64}$/.test(s))) failure('SDI_PEER_FINGERPRINTS');
  const paths = {};
  for (const [key, field] of [['certPath','SDI_CLIENT_CERT_PATH'],['keyPath','SDI_CLIENT_KEY_PATH'],['caPath','SDI_REMOTE_CA_PATH']]) {
    paths[key] = value(env, field);
    if (!paths[key] || paths[key].includes('\0')) failure(field);
  }
  const timeoutMs = Number(value(env, 'SDI_TIMEOUT_MS') || '30000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) failure('SDI_TIMEOUT_MS');
  return Object.freeze({ enabled: true, environment, accreditationReference, shopVat, endpoint: endpoint.href, endpointHost: expectedHost,
    callbackHost, gatewayToken, peerFingerprints: Object.freeze(peerFingerprints), ...paths, timeoutMs, maxResponseBytes: 18 * 1024 * 1024 });
}

export function authenticateSdiGateway(req, config) {
  if (!config?.enabled) return false;
  const received = req.headers['x-sdi-gateway-token'];
  const peer = fingerprint(req.headers['x-sdi-peer-fingerprint']);
  const host = req.headers['x-sdi-gateway-host'];
  if (typeof received !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(received) || received.length !== config.gatewayToken.length || typeof host !== 'string' || host !== config.callbackHost || !/^[a-f0-9]{64}$/.test(peer)) return false;
  const tokenOk = timingSafeEqual(Buffer.from(received), Buffer.from(config.gatewayToken));
  let peerOk = false;
  for (const allowed of config.peerFingerprints) peerOk = timingSafeEqual(Buffer.from(peer), Buffer.from(allowed)) || peerOk;
  return tokenOk && peerOk;
}
