import { hash, transaction } from './database.mjs';
import { HttpError } from './validation.mjs';

export const MAX_MODULE_FILE_BYTES = 10 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MIME_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const invalid = message => fail(400, 'MODULE_FILE_INPUT', message);

function payload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).some(key => !['id', 'filename', 'contentType', 'data'].includes(key))) invalid('Dati del file non validi.');
  if (typeof data.id !== 'string' || !UUID.test(data.id)) invalid('Identificativo del file non valido.');
  if (typeof data.filename !== 'string') invalid('Nome del file non valido.');
  const filename = data.filename.trim().normalize('NFC');
  if (!filename || filename === '.' || filename === '..' ||
      /[/\\\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(filename) || Buffer.byteLength(filename, 'utf8') > 240) invalid('Usa un nome del file senza percorsi e lungo al massimo 240 byte.');
  if (!MIME_TYPES.has(data.contentType)) invalid('Carica un file PDF, PNG, JPEG o WebP.');
  if (typeof data.data !== 'string' || !data.data.length) invalid('Il file è vuoto o non valido.');
  if (data.data.length > Math.ceil(MAX_MODULE_FILE_BYTES / 3) * 4) fail(413, 'MODULE_FILE_TOO_LARGE', 'Il file supera il limite di 10 MB.');
  if (data.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.data)) invalid('Contenuto del file non valido.');
  const bytes = Buffer.from(data.data, 'base64');
  if (!bytes.length || bytes.toString('base64') !== data.data) invalid('Contenuto del file non valido.');
  if (bytes.length > MAX_MODULE_FILE_BYTES) fail(413, 'MODULE_FILE_TOO_LARGE', 'Il file supera il limite di 10 MB.');
  const matches = data.contentType === 'application/pdf' ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) :
    data.contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    data.contentType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
  if (!matches) invalid('Il contenuto del file non corrisponde al formato PDF o immagine selezionato.');
  return { id: data.id.toLowerCase(), filename, contentType: data.contentType, bytes, size: bytes.length, digest: hash(bytes) };
}

const viewMetadata = row => ({ id: row.id, filename: row.filename, contentType: row.content_type, size: row.size });

// Files are staged before the module record is committed. Download access is
// granted by the HTTP layer only after the snapshot references their identity.
// SQLite's normal backup includes both committed files and staged uploads.
export function moduleFileStore(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS workshop_module_files (
    id TEXT PRIMARY KEY,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK(content_type IN ('application/pdf','image/png','image/jpeg','image/webp')),
    size INTEGER NOT NULL CHECK(size > 0 AND size <= ${MAX_MODULE_FILE_BYTES}),
    digest TEXT NOT NULL,
    bytes BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK(length(bytes) = size)
  );`);
  const find = db.prepare('SELECT id,uploaded_by,filename,content_type,size,digest FROM workshop_module_files WHERE id=?');
  const findMetadata = db.prepare('SELECT id,filename,content_type,size FROM workshop_module_files WHERE id=?');
  const findOriginal = db.prepare('SELECT id,filename,content_type,size,bytes FROM workshop_module_files WHERE id=?');
  function upload(auth, data) {
    if (!auth) fail(401, 'AUTH_REQUIRED', 'Accedi per caricare un modulo.');
    if (!['admin', 'operator'].includes(auth.role) || !Number.isSafeInteger(auth.id) || auth.id < 1) fail(403, 'FORBIDDEN', 'Non puoi caricare moduli con questo account.');
    const file = payload(data);
    return transaction(db, () => {
      const previous = find.get(file.id);
      if (previous) {
        if (previous.uploaded_by !== auth.id || previous.digest !== file.digest ||
            previous.filename !== file.filename || previous.content_type !== file.contentType || previous.size !== file.size) {
          fail(409, 'IDEMPOTENCY_CONFLICT', 'Identificativo già usato per un altro file.');
        }
        return viewMetadata(previous);
      }
      const at = now();
      db.prepare('INSERT INTO workshop_module_files(id,uploaded_by,filename,content_type,size,digest,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(file.id, auth.id, file.filename, file.contentType, file.size, file.digest, file.bytes, at);
      const result = { id: file.id, filename: file.filename, contentType: file.contentType, size: file.size };
      db.prepare('INSERT INTO audit(at,user_id,username,action,revision,details) VALUES(?,?,?,?,?,?)')
        .run(at, auth.id, auth.username || null, 'module-file-uploaded', null, JSON.stringify(result));
      return result;
    });
  }
  function original(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const row = findOriginal.get(id.toLowerCase());
    return row ? { ...viewMetadata(row), bytes: Buffer.from(row.bytes) } : null;
  }
  function metadata(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const row = findMetadata.get(id.toLowerCase());
    return row ? viewMetadata(row) : null;
  }
  function validateState(state) {
    const source = state?.storage?.['officina-moduli-v1'];
    if (source === undefined) return;
    let records;
    try { records = JSON.parse(source); } catch { invalid('Archivio moduli non valido.'); }
    if (!Array.isArray(records)) invalid('Archivio moduli non valido.');
    for (const record of records) {
      if (!record || !Object.hasOwn(record, 'Attachment')) continue;
      const file = record.Attachment;
      if (!['privacy', 'refusal', 'parts'].includes(record.type) ||
          !file || typeof file !== 'object' || Array.isArray(file) ||
          Object.keys(file).length !== 4 || Object.keys(file).some(key => !['id','filename','contentType','size'].includes(key)) ||
          typeof file.id !== 'string' || !UUID.test(file.id) ||
          !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_MODULE_FILE_BYTES) invalid('Allegato del modulo non valido.');
      const saved = metadata(file.id);
      if (!saved || saved.id !== file.id || saved.filename !== file.filename ||
          saved.contentType !== file.contentType || saved.size !== file.size) invalid('Il file del modulo non è stato caricato o i suoi dati sono stati modificati.');
    }
  }
  return { upload, original, metadata, validateState };
}
