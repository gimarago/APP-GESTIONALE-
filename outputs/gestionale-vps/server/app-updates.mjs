import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

export const APP_UPDATE_PATH = '/app-updates/windows-x86_64/';
export const MAX_UPDATE_ARTIFACT_BYTES = 150 * 1024 * 1024;
export const MAX_UPDATE_MANIFEST_BYTES = 64 * 1024;
export const APP_UPDATE_UNAVAILABLE = 'Aggiornamenti dell’app non ancora pubblicati.';
const platform = 'windows-x86_64';
const fileName = value => typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(value);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const unavailable = () => {throw Error(APP_UPDATE_UNAVAILABLE);};
const json = (req, res, status, code, message, extra = {}) => {
  const bytes = Buffer.from(JSON.stringify({error:{code,message}}));
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store',...extra});
  res.end(req.method === 'HEAD' ? undefined : bytes);
};
function base64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}
export function validUpdateSignature(value) {
  if (typeof value !== 'string' || value.length > 16 * 1024) return false;
  const decoded = base64(value);
  if (!decoded || decoded.length > 8 * 1024) return false;
  const text = decoded.toString('utf8');
  if (!Buffer.from(text).equals(decoded)) return false;
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) return false;
  const signature = base64(lines[1]), globalSignature = base64(lines[3]);
  return !!signature && signature.length === 74 && ['Ed','ED'].includes(signature.subarray(0,2).toString('ascii'))
    && !!globalSignature && globalSignature.length === 64;
}
function publicationDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [,year,month,day,hour,minute,second,zone] = match;
  const lastDay = new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= lastDay
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (zone === 'Z' || Number(zone.slice(1,3)) < 24 && Number(zone.slice(4)) < 60);
}
function validateManifest(value, origin, allowHttp) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.version !== 'string' || value.version.length > 80 || !semver.test(value.version)
      || !publicationDate(value.pub_date) || typeof value.notes !== 'string' || value.notes.length > 32 * 1024
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.notes)
      || !value.platforms || typeof value.platforms !== 'object' || Array.isArray(value.platforms)) unavailable();
  const target = value.platforms[platform];
  if (!target || typeof target !== 'object' || Array.isArray(target) || typeof target.url !== 'string' || !validUpdateSignature(target.signature)) unavailable();
  let url;
  try {url = new URL(target.url);} catch {unavailable();}
  const name = url.pathname.slice(APP_UPDATE_PATH.length);
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
      || !(url.protocol === 'https:' || allowHttp && url.protocol === 'http:')
      || !url.pathname.startsWith(APP_UPDATE_PATH) || !fileName(name)
      || target.url !== origin + APP_UPDATE_PATH + name) unavailable();
  return {manifest:{version:value.version,notes:value.notes,pub_date:value.pub_date,platforms:{[platform]:{url:target.url,signature:target.signature}}}, name};
}
async function openReleaseFile(directory, name, maximum) {
  const path = join(directory, name), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maximum) unavailable();
  const canonical = await realpath(path);
  if (dirname(canonical) !== directory) unavailable();
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    // Pin the checked inode before streaming; reject symlink/replacement races.
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximum || stat.dev !== before.dev || stat.ino !== before.ino) unavailable();
    return {handle,stat};
  } catch (error) {await handle.close();throw error;}
}
async function release(directory, origin, allowHttp) {
  const canonical = await realpath(directory);
  const source = await openReleaseFile(canonical, 'latest.json', MAX_UPDATE_MANIFEST_BYTES);
  let value;
  try {
    // A concurrent bad publication cannot grow readFile's allocation beyond the limit.
    const bytes = Buffer.alloc(MAX_UPDATE_MANIFEST_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const {bytesRead} = await source.handle.read(bytes,count,bytes.length-count,count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_UPDATE_MANIFEST_BYTES) unavailable();
    value = JSON.parse(bytes.subarray(0,count).toString('utf8'));
  } finally {await source.handle.close();}
  const validated = validateManifest(value, origin, allowHttp);
  const artifact = await openReleaseFile(canonical, validated.name, MAX_UPDATE_ARTIFACT_BYTES);
  try {
    const magic = Buffer.alloc(2), {bytesRead} = await artifact.handle.read(magic,0,2,0);
    if (bytesRead !== 2 || magic.toString('ascii') !== 'MZ') unavailable();
    return {...validated,...artifact};
  } catch (error) {await artifact.handle.close();throw error;}
}
function singleRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0,size-suffix); end = size-1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size-1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end,size-1);
  }
  return {start,end};
}
const matchesEtag = (value, etag) => typeof value === 'string' && (value.trim() === '*' || value.split(',').some(item => item.trim().replace(/^W\//,'') === etag));

export function createAppUpdateHandler({releaseDir, origin, allowHttp = false}) {
  const directory = resolve(releaseDir), expectedOrigin = new URL(origin).origin;
  return async (req, res, pathname) => {
    // Also intercept raw traversal attempts that URL parsing has normalized away.
    if (!pathname.startsWith('/app-updates/') && !/^\/app-updates(?:\/|\?|$)/.test(req.url || '')) return false;
    if (!['GET','HEAD'].includes(req.method)) {json(req,res,405,'APP_UPDATE_METHOD','Metodo non consentito.',{allow:'GET, HEAD'});return true;}
    const name = pathname.startsWith(APP_UPDATE_PATH) ? pathname.slice(APP_UPDATE_PATH.length) : '';
    if ((name !== 'latest.json' && !fileName(name)) || /(?:%2e|%2f|%5c|\\|\.{2})/i.test(req.url || '')) {
      json(req,res,404,'APP_UPDATE_NOT_FOUND','File di aggiornamento non trovato.');return true;
    }
    let current;
    try {current = await release(directory, expectedOrigin, allowHttp);} catch {json(req,res,503,'APP_UPDATE_UNAVAILABLE',APP_UPDATE_UNAVAILABLE,{'retry-after':'60'});return true;}
    const {handle,stat,manifest} = current;
    if (name === 'latest.json') {
      await handle.close();
      const bytes = Buffer.from(JSON.stringify(manifest));
      res.writeHead(200, {'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store'});
      res.end(req.method === 'HEAD' ? undefined : bytes);return true;
    }
    if (name !== current.name) {await handle.close();json(req,res,404,'APP_UPDATE_NOT_FOUND','File di aggiornamento non trovato.');return true;}
    const etag = '"officina-update-' + createHash('sha256').update([manifest.version,manifest.platforms[platform].signature,stat.size,stat.mtimeMs,stat.ino].join('|')).digest('hex') + '"';
    const headers = {'content-type':'application/octet-stream','content-disposition':`attachment; filename="${name}"`,'cache-control':'public, max-age=31536000, immutable','etag':etag,'last-modified':stat.mtime.toUTCString(),'accept-ranges':'bytes','x-content-type-options':'nosniff'};
    if (matchesEtag(req.headers['if-none-match'],etag)) {await handle.close();res.writeHead(304,headers).end();return true;}
    let range;
    if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag || req.headers['if-range'] === headers['last-modified'])) {
      range = singleRange(req.headers.range,stat.size);
      if (!range) {await handle.close();json(req,res,416,'APP_UPDATE_RANGE','Intervallo del download non valido.',{'content-range':`bytes */${stat.size}`});return true;}
      headers['content-range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    }
    headers['content-length'] = range ? range.end-range.start+1 : stat.size;
    res.writeHead(range ? 206 : 200,headers);
    if (req.method === 'HEAD') {await handle.close();res.end();return true;}
    try {await pipeline(handle.createReadStream({autoClose:true,start:range?.start ?? 0,end:range?.end ?? stat.size-1}),res);} catch {res.destroy();}
    return true;
  };
}
