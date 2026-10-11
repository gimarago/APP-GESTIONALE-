// State contains inert DOM descriptions, never HTML or executable handlers.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const deny = new Set(['__proto__', 'prototype', 'constructor']);
const defaultTags = ['tr','td','th','tbody','thead','tfoot','table','div','span','p','strong','b','em','i','small','br','ul','ol','li','button','input','select','option','label','textarea','h2','h3','h4'];
const defaultAttributes = ['id','class','title','type','value','checked','selected','disabled','readonly','placeholder','min','max','step','colspan','rowspan','for','role','hidden','data-action'];

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const invalid = message => { throw new HttpError(400, 'INVALID_STATE', message); };

export function makeStateValidator(schema) {
  const selectors = new Set(schema.selectors);
  const storageKeys = new Set(schema.storageKeys);
  const fields = new Set(schema.fields);
  const tags = new Set(schema.tags || defaultTags);
  const attributes = new Set(schema.attributes || defaultAttributes);
  return state => {
    let nodes = 0;
    if (!plain(state) || state.schemaVersion !== 1 || Object.keys(state).some(k => !['schemaVersion','storage','dom','fields'].includes(k))) invalid('Versione o struttura archivio non valida.');
    for (const name of ['storage','dom','fields']) if (!plain(state[name])) invalid(`Sezione ${name} non valida.`);
    if ([...selectors].some(selector => !Object.hasOwn(state.dom, selector))) invalid('Archivio incompleto: mancano una o più tabelle obbligatorie.');
    function jsonValue(value, depth = 0) {
      if (++nodes > 300_000 || depth > 40) invalid('Archivio JSON troppo complesso.');
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (deny.has(key)) invalid('Chiave JSON riservata non ammessa.');
          jsonValue(child, depth + 1);
        }
      }
    }
    for (const [key,value] of Object.entries(state.storage)) {
      if (!storageKeys.has(key) || deny.has(key) || typeof value !== 'string' || value.length > 8_000_000) invalid(`Chiave archivio non ammessa: ${key}.`);
      if (key === 'officinaWorkshopLogo') {
        if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid('Il logo deve essere un’immagine PNG, JPEG o WebP incorporata.');
        const bytes = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
        const valid = value.startsWith('data:image/png;') ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : value.startsWith('data:image/jpeg;') ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
        if (!valid) invalid('Formato del logo non valido.');
      } else {
        let parsed;
        try { parsed = JSON.parse(value); } catch { invalid(`Dati JSON non validi: ${key}.`); }
        jsonValue(parsed);
      }
    }
    for (const [key,value] of Object.entries(state.fields)) if (!fields.has(key) || deny.has(key) || typeof value !== 'string' || value.length > 200_000) invalid(`Campo non ammesso: ${key}.`);
    function node(value, depth) {
      if (++nodes > 300_000 || depth > 40) invalid('Archivio troppo complesso.');
      if (typeof value === 'string') { if (value.length > 200_000) invalid('Testo troppo lungo.'); return; }
      if (!plain(value) || Object.keys(value).some(k => !['t','a','c'].includes(k)) || !tags.has(value.t) || !plain(value.a) || !Array.isArray(value.c)) invalid('Nodo archivio non valido.');
      for (const [key,attr] of Object.entries(value.a)) {
        if (deny.has(key) || /^on/i.test(key) || ['src','srcdoc','href','style','formaction'].includes(key) || !(attributes.has(key) || /^data-[a-z0-9-]+$/.test(key) || /^aria-[a-z0-9-]+$/.test(key)) || typeof attr !== 'string' || attr.length > 200_000) invalid(`Attributo non ammesso: ${key}.`);
      }
      value.c.forEach(child => node(child, depth + 1));
    }
    for (const [selector, children] of Object.entries(state.dom)) {
      if (!selectors.has(selector) || !Array.isArray(children)) invalid(`Tabella non ammessa: ${selector}.`);
      children.forEach(child => node(child, 0));
    }
    return state;
  };
}
