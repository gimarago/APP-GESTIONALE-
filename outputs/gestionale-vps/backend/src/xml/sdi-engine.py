"""Bounded SOAP 1.1/MTOM codec for the pinned SdICoop contracts.

Authentication is performed by the mTLS gateway before this decoder is called.
XSD validation does not claim to verify XMLDSig/CAdES signatures.
"""
import base64
import hashlib
import json
import re
import sys
import uuid
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.parse import unquote
from lxml import etree as E

ROOT = Path(__file__).resolve().parents[2] / 'contracts'
TRUSTED = {row['file']: row for row in json.loads((ROOT / 'manifest.json').read_text('utf-8'))}
SOAP = 'http://schemas.xmlsoap.org/soap/envelope/'
XOP = 'http://www.w3.org/2004/08/xop/include'
FISCAL = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2'
B2B = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fattura/messaggi/v1.0'
B2G = 'http://www.fatturapa.gov.it/sdi/messaggi/v1.0'
NS = {'w': 'http://schemas.xmlsoap.org/wsdl/', 's': 'http://schemas.xmlsoap.org/wsdl/soap/'}
MAX_BODY = 18 * 1024 * 1024
MAX_FILE = 10 * 1024 * 1024
MAX_JSON = 32 * 1024 * 1024


def fail(code):
    raise ValueError(code)


def trusted(name):
    if name not in TRUSTED or Path(name).name != name:
        fail('SDI_CONTRACT_UNKNOWN')
    data = (ROOT / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != TRUSTED[name]['sha256']:
        fail('SDI_CONTRACT_HASH')
    return data


class Resolver(E.Resolver):
    def resolve(self, url, public_id, context):
        if url in ['xmldsig-core-schema.xsd',
                   'http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd']:
            return self.resolve_string(trusted('xmldsig-core-schema.xsd'), context)
        fail('SDI_EXTERNAL_RESOURCE_DISABLED')


def parser():
    p = E.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                    huge_tree=False, recover=False, remove_comments=True, remove_pis=True)
    p.resolvers.add(Resolver())
    return p


def parse(data, limit=MAX_FILE):
    if isinstance(data, str):
        data = data.encode('utf-8')
    if not isinstance(data, bytes) or not data or len(data) > limit:
        fail('SDI_XML_SIZE')
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        fail('SDI_DTD_DISABLED')
    root = E.fromstring(data, parser())
    if root.getroottree().docinfo.doctype:
        fail('SDI_DTD_DISABLED')
    for index, node in enumerate(root.iter()):
        if index > 100000 or sum(1 for _ in node.iterancestors()) > 64:
            fail('SDI_XML_COMPLEXITY')
    return root


def validate(root, name):
    schema = E.XMLSchema(E.fromstring(trusted(name), parser()))
    if not schema.validate(root):
        fail('SDI_XSD_INVALID:' + ','.join(e.type_name for e in list(schema.error_log)[:5]))


def b64(value, limit=MAX_FILE):
    if not isinstance(value, str) or len(value) > (limit * 4 // 3 + 65536):
        fail('SDI_BASE64_SIZE')
    # XML Schema permits whitespace in base64Binary.
    content = base64.b64decode(re.sub(r'[ \r\n\t]', '', value), validate=True)
    if not content or len(content) > limit:
        fail('SDI_ATTACHMENT_SIZE')
    return content


def name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.]{9,50}', value) or '..' in value:
        fail('SDI_FILENAME')
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,11}', value):
        fail('SDI_IDENTIFIER')
    return value


def contract(filename):
    root = E.fromstring(trusted(filename), parser())
    result = []
    for op in root.findall('w:portType/w:operation', NS):
        op_name = op.get('name')
        def element(direction):
            entry = op.find('w:' + direction, NS)
            if entry is None:
                return None
            msg = entry.get('message').split(':')[-1]
            part = root.find("w:message[@name='%s']/w:part" % msg, NS)
            prefix, local = part.get('element').split(':')
            return '{' + part.nsmap[prefix] + '}' + local
        binding = root.find("w:binding/w:operation[@name='%s']/s:operation" % op_name, NS)
        result.append({'operation': op_name, 'action': binding.get('soapAction'),
                       'input': element('input'), 'output': element('output')})
    return result


def envelope(child):
    root = E.Element('{' + SOAP + '}Envelope', nsmap={'soap': SOAP})
    E.SubElement(root, '{' + SOAP + '}Body').append(child)
    return E.tostring(root, encoding='utf-8', xml_declaration=True)


def soap_body(root):
    if root.tag != '{' + SOAP + '}Envelope' or root.get('{' + SOAP + '}encodingStyle'):
        fail('SDI_SOAP_ENVELOPE')
    bodies = root.findall('{' + SOAP + '}Body')
    headers = root.findall('{' + SOAP + '}Header')
    if len(headers) > 1 or any(len(h) or (h.text or '').strip() for h in headers):
        fail('SDI_SOAP_HEADER')
    if len(bodies) != 1 or len(bodies[0]) != 1 or any(n.tag not in ['{' + SOAP + '}Body', '{' + SOAP + '}Header'] for n in root):
        fail('SDI_SOAP_BODY')
    if (root.text or '').strip() or any((n.tail or '').strip() for n in root) or (headers and root[0] is not headers[0]):
        fail('SDI_SOAP_BODY')
    if any(n.get('{' + SOAP + '}encodingStyle') is not None for n in root):
        fail('SDI_SOAP_ENVELOPE')
    if (bodies[0].text or '').strip() or (bodies[0][0].tail or '').strip():
        fail('SDI_SOAP_BODY')
    return bodies[0][0]


def decode_soap(v):
    data = b64(v['bodyBase64'], MAX_BODY) if v.get('bodyBase64') else str(v.get('xml', '')).encode('utf-8')
    if len(data) > MAX_BODY:
        fail('SDI_BODY_SIZE')
    content_type = v.get('contentType') or 'text/xml; charset=utf-8'
    if not isinstance(content_type, str) or len(content_type) > 1024 or '\r' in content_type or '\n' in content_type:
        fail('SDI_CONTENT_TYPE')
    header = BytesParser(policy=policy.default).parsebytes(('Content-Type: ' + content_type + '\r\n\r\n').encode('ascii'))
    media = header.get_content_type()
    if media == 'text/xml':
        root = parse(data, MAX_BODY)
        if root.find('.//{' + XOP + '}Include') is not None:
            fail('SDI_XOP_MISSING_PART')
        return soap_body(root)
    if media != 'multipart/related' or header.get_param('type') != 'application/xop+xml':
        fail('SDI_CONTENT_TYPE')
    if not header.get_boundary() or len(header.get_boundary()) > 100:
        fail('SDI_MIME_BOUNDARY')
    msg = BytesParser(policy=policy.default).parsebytes(('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode('ascii') + data)
    if not msg.is_multipart() or msg.defects or len(msg.get_payload()) > 8:
        fail('SDI_MIME_INVALID')
    parts = {}
    for part in msg.iter_parts():
        if part.is_multipart() or part.defects or sum(len(k) + len(v) + 4 for k, v in part.raw_items()) > 8192:
            fail('SDI_MIME_INVALID')
        if len(part.get_all('Content-Type', [])) != 1:
            fail('SDI_MIME_INVALID')
        if len(part.get_all('Content-ID', [])) != 1 or len(part.get_all('Content-Transfer-Encoding', [])) > 1:
            fail('SDI_MIME_ID')
        cid = part['Content-ID'].strip()
        if not re.fullmatch(r'<[^<>\s]{1,200}>', cid) or cid in parts:
            fail('SDI_MIME_ID')
        if str(part.get('Content-Transfer-Encoding', 'binary')).lower() not in ['binary', '8bit', '7bit', 'base64']:
            fail('SDI_MIME_ENCODING')
        payload = part.get_payload(decode=True)
        if part.defects or not payload or len(payload) > MAX_FILE:
            fail('SDI_MIME_INVALID')
        parts[cid] = (part, payload)
    start = header.get_param('start') or next(iter(parts), None)
    if start not in parts or parts[start][0].get_content_type() != 'application/xop+xml':
        fail('SDI_MIME_ROOT')
    root_part, root_bytes = parts.pop(start)
    if root_part.get_param('type') != 'text/xml':
        fail('SDI_MIME_SOAP_VERSION')
    root = parse(root_bytes, MAX_FILE)
    used = set()
    for include in list(root.iter('{' + XOP + '}Include')):
        href = include.get('href', '')
        if not href.startswith('cid:') or len(include) or set(include.attrib) != {'href'}:
            fail('SDI_XOP_REFERENCE')
        key = '<' + unquote(href[4:]) + '>'
        parent = include.getparent()
        if key not in parts or len(parent) != 1 or (parent.text or '').strip() or (include.tail or '').strip() or parent.tag not in ['File', 'Metadati']:
            fail('SDI_XOP_REFERENCE')
        parent.remove(include)
        parent.text = base64.b64encode(parts[key][1]).decode('ascii')
        used.add(key)
    if used != set(parts):
        fail('SDI_MIME_UNUSED_PART')
    return soap_body(root)


def inspect_invoice(data):
    root = parse(data)
    validate(root, 'Schema_VFPR12_v1.2.3.xsd')
    if root.tag != '{' + FISCAL + '}FatturaElettronica' or root.get('versione') != 'FPR12':
        fail('SDI_FPR12_REQUIRED')
    def identity(path):
        p = root.find('FatturaElettronicaHeader/' + path + '/DatiAnagrafici')
        return {'country': p.findtext('IdFiscaleIVA/IdPaese'), 'vat': p.findtext('IdFiscaleIVA/IdCodice'), 'cf': p.findtext('CodiceFiscale'),
                'name': p.findtext('Anagrafica/Denominazione') or ' '.join(filter(None, [p.findtext('Anagrafica/Nome'), p.findtext('Anagrafica/Cognome')]))}
    docs = []
    for i, body in enumerate(root.findall('FatturaElettronicaBody')):
        doc = body.find('DatiGenerali/DatiGeneraliDocumento')
        deadlines = [e.text for e in body.findall('DatiPagamento/DettaglioPagamento/DataScadenzaPagamento') if e.text]
        docs.append({'bodyIndex': i, 'type': doc.findtext('TipoDocumento'), 'number': doc.findtext('Numero'), 'date': doc.findtext('Data'),
                     'currency': doc.findtext('Divisa'), 'total': doc.findtext('ImportoTotaleDocumento'), 'dueDate': deadlines[0] if len(deadlines) == 1 else None})
    return {'seller': identity('CedentePrestatore'), 'buyer': identity('CessionarioCommittente'), 'documents': docs,
            'xsdValidated': True, 'signatureVerification': 'NOT_PERFORMED'}, root


def prepare(v):
    filename = name(v['filename'])
    if not re.fullmatch(r'IT[A-Za-z0-9]{11,16}_[A-Za-z0-9]{1,5}\.xml', filename):
        fail('SDI_TRANSPORT_FILENAME')
    data = v['xml'].encode('utf-8')
    invoice, fiscal = inspect_invoice(data)
    transmitter = fiscal.find('FatturaElettronicaHeader/DatiTrasmissione/IdTrasmittente')
    if filename.split('_')[0] != (transmitter.findtext('IdPaese') or '') + (transmitter.findtext('IdCodice') or ''):
        fail('SDI_TRANSMITTER_FILENAME')
    c = contract('SdIRiceviFile_v1.0.wsdl')[0]
    root = E.Element(c['input'], nsmap={'t': E.QName(c['input']).namespace})
    E.SubElement(root, 'NomeFile').text = filename
    file_node = E.SubElement(root, 'File')
    file_node.text = base64.b64encode(data).decode('ascii')
    validate(root, 'TrasmissioneTypes_v1.0.xsd')
    xml = envelope(root).decode('utf-8')
    file_node.text = None
    E.SubElement(file_node, '{' + XOP + '}Include', nsmap={'xop': XOP}, href='cid:invoice@officina')
    soap = envelope(root)
    boundary = 'officina_' + uuid.uuid4().hex
    body = (b'--' + boundary.encode() + b'\r\nContent-Type: application/xop+xml; charset=utf-8; type="text/xml"\r\nContent-Transfer-Encoding: 8bit\r\nContent-ID: <soap@officina>\r\n\r\n' + soap +
            b'\r\n--' + boundary.encode() + b'\r\nContent-Type: application/xml\r\nContent-Transfer-Encoding: binary\r\nContent-ID: <invoice@officina>\r\n\r\n' + data + b'\r\n--' + boundary.encode() + b'--\r\n')
    return {'xml': xml, 'action': c['action'], 'invoice': invoice, 'bodyBase64': base64.b64encode(body).decode('ascii'),
            'contentType': 'multipart/related; type="application/xop+xml"; start="<soap@officina>"; start-info="text/xml"; boundary="' + boundary + '"'}


def message(data):
    root = parse(data, 2 * 1024 * 1024)
    namespace = E.QName(root).namespace
    if namespace == B2B:
        validate(root, 'MessaggiFatturaTypes_v1.0.xsd')
    elif namespace == B2G:
        validate(root, 'MessaggiTypes_v1.1.xsd')
    else:
        fail('SDI_MESSAGE_NAMESPACE')
    return root


def callback(v):
    kind = v.get('kind')
    if kind not in ['notifications', 'invoices']:
        fail('SDI_CALLBACK_KIND')
    child = decode_soap(v)
    action = v.get('soapAction', '')
    if not isinstance(action, str):
        fail('SDI_SOAP_ACTION')
    if action.startswith('"') and action.endswith('"'):
        action = action[1:-1]
    candidates = contract('RicezioneFatture_v1.0.wsdl' if kind == 'invoices' else 'TrasmissioneFatture_v1.1.wsdl')
    matches = [c for c in candidates if c['input'] == child.tag and c['action'] == action]
    if len(matches) != 1:
        fail('SDI_SOAP_ACTION')
    c = matches[0]
    validate(child, 'RicezioneTypes_v1.0.xsd' if kind == 'invoices' else 'TrasmissioneTypes_v1.1.xsd')
    sid = identifier(child.findtext('IdentificativoSdI'))
    filename = name(child.findtext('NomeFile'))
    payload = b64(child.findtext('File'))
    result = {'kind': 'invoices' if c['operation'] == 'RiceviFatture' else 'notifications', 'operation': c['operation'],
              'identifier': sid, 'filename': filename, 'payloadBase64': base64.b64encode(payload).decode('ascii')}
    if c['operation'] == 'RiceviFatture':
        metadata = b64(child.findtext('Metadati'), 2 * 1024 * 1024)
        meta = message(metadata)
        if E.QName(meta).localname not in ['FileMetadati', 'MetadatiInvioFile'] or meta.findtext('IdentificativoSdI') != sid or meta.findtext('NomeFile') != filename:
            fail('SDI_METADATA_MISMATCH')
        file_hash = meta.findtext('Hash')
        if file_hash is not None and (not re.fullmatch(r'[A-Fa-f0-9]{64}', file_hash) or hashlib.sha256(payload).hexdigest() != file_hash.lower()):
            fail('SDI_METADATA_HASH')
        result.update({'metadataBase64': base64.b64encode(metadata).decode('ascii'), 'metadataFilename': name(child.findtext('NomeFileMetadati'))})
        reply = E.Element(c['output'], nsmap={'t': E.QName(c['output']).namespace})
        E.SubElement(reply, 'Esito').text = 'ER01'
        validate(reply, 'RicezioneTypes_v1.0.xsd')
        result['response'] = {'status': 200, 'contentType': 'text/xml; charset=utf-8', 'body': envelope(reply).decode('utf-8')}
        return result
    receipt = message(payload)
    local = E.QName(receipt).localname
    allowed = {'RicevutaConsegna': ['RicevutaConsegna'], 'NotificaScarto': ['NotificaScarto', 'RicevutaScarto'],
               'NotificaMancataConsegna': ['NotificaMancataConsegna', 'RicevutaImpossibilitaRecapito'],
               'NotificaEsito': ['NotificaEsito'], 'NotificaDecorrenzaTermini': ['NotificaDecorrenzaTermini'],
               'AttestazioneTrasmissioneFattura': ['AttestazioneTrasmissioneFattura']}
    if local not in allowed[c['operation']] or receipt.findtext('IdentificativoSdI') != sid:
        fail('SDI_NOTIFICATION_MISMATCH')
    if c['operation'] == 'NotificaEsito' and receipt.findtext('EsitoCommittente/IdentificativoSdI') != sid:
        fail('SDI_NOTIFICATION_MISMATCH')
    outcomes = {'RicevutaConsegna': 'CONSEGNA', 'NotificaScarto': 'SCARTO', 'NotificaMancataConsegna': 'MANCATA_CONSEGNA',
                'NotificaEsito': 'ESITO', 'NotificaDecorrenzaTermini': 'DECORRENZA_TERMINI', 'AttestazioneTrasmissioneFattura': 'ATTESTAZIONE_TRASMISSIONE'}
    result['notification'] = {'outcome': outcomes[c['operation']], 'identifier': sid, 'invoiceFilename': name(receipt.findtext('NomeFile')),
                              'messageId': receipt.findtext('MessageId'), 'fileHash': receipt.findtext('Hash') or receipt.findtext('HashFileOriginale'),
                              'receivedAt': receipt.findtext('DataOraRicezione'), 'deliveredAt': receipt.findtext('DataOraConsegna'),
                              'description': receipt.findtext('Descrizione'), 'recipientOutcome': receipt.findtext('EsitoCommittente/Esito'),
                              'errors': [{'code': e.findtext('Codice'), 'description': e.findtext('Descrizione')} for e in receipt.findall('ListaErrori/Errore')],
                              'xsdValidated': True, 'signatureVerification': 'NOT_PERFORMED'}
    result['response'] = {'status': 202, 'contentType': 'text/xml; charset=utf-8', 'body': ''}
    return result


def response(v):
    if v.get('status') != 200:
        return {'kind': 'UNKNOWN', 'reason': 'Stato HTTP SdI non conclusivo.'}
    child = decode_soap(v)
    c = contract('SdIRiceviFile_v1.0.wsdl')[0]
    if child.tag != c['output']:
        fail('SDI_RESPONSE_ELEMENT')
    validate(child, 'TrasmissioneTypes_v1.0.xsd')
    code = child.findtext('Errore')
    if code:
        return {'kind': 'TRANSPORT_REJECTED', 'code': code}
    return {'kind': 'SDI_RECEIVED', 'identifier': identifier(child.findtext('IdentificativoSdI')), 'receivedAt': child.findtext('DataOraRicezione')}


def inspect(v):
    filename = name(v['filename'])
    data = b64(v['base64'])
    if filename.lower().endswith('.p7m'):
        return {'quarantineReason': 'Fattura firmata CAdES (.p7m): originale conservato, verifica firma e lettura manuale richieste.'}
    if not filename.lower().endswith('.xml'):
        return {'quarantineReason': 'Formato non supportato per la lettura automatica: originale conservato.'}
    parsed, _ = inspect_invoice(data)
    if not re.fullmatch(r'[0-9]{11}', str(v.get('shopVat', ''))) or parsed['buyer']['country'] != 'IT' or parsed['buyer']['vat'] != v['shopVat']:
        return {'quarantineReason': 'Destinatario della fattura diverso dalla partita IVA configurata: verificare l’originale.'}
    seller = parsed['seller']
    tax_id = (seller['country'] or 'IT') + seller['vat'] if seller['vat'] else seller['cf']
    if not tax_id or len(tax_id) > 32 or not seller['name'] or len(seller['name'].strip()) > 200:
        return {'quarantineReason': 'Dati del fornitore incompleti o non importabili: verificare l’originale.'}
    items = []
    for d in parsed['documents']:
        total = None
        if d['type'] not in ['TD04', 'TD08'] and d['currency'] == 'EUR' and re.fullmatch(r'\d{1,12}(?:\.\d{1,2})?', d['total'] or ''):
            whole, _, fraction = d['total'].partition('.')
            cents = int(whole) * 100 + int(fraction.ljust(2, '0') or '0')
            if 0 < cents <= 1000000000000:
                total = cents
        due = d['dueDate'] if d['dueDate'] and d['dueDate'] >= d['date'] else None
        items.append({'bodyIndex': d['bodyIndex'], 'supplierName': seller['name'].strip(), 'supplierTaxId': tax_id,
                      'number': d['number'], 'issueDate': d['date'], 'dueDate': due, 'totalCents': total, 'documentType': d['type']})
    return items


try:
    raw = sys.stdin.buffer.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        fail('SDI_INPUT_LIMIT')
    value = json.loads(raw)
    mode = value.get('mode')
    if mode not in ['prepare', 'response', 'callback', 'inspect']:
        fail('SDI_MODE')
    result = globals()[mode](value)
    print(json.dumps({'ok': True, 'result': result}))
except Exception as error:
    # Parser exception messages can contain invoice content. Expose only own codes.
    reason = str(error) if type(error) is ValueError and str(error).startswith('SDI_') else 'SDI_XML_INVALID'
    print(json.dumps({'ok': False, 'error': reason}))
    sys.exit(1)
