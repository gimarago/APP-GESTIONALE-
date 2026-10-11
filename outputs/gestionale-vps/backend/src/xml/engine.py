"""Motore isolato lxml: schemi locali verificati, nessuna risoluzione di rete."""
import sys, json, hashlib, base64, io, zipfile, stat
from pathlib import Path
from lxml import etree as E
ROOT = Path(__file__).resolve().parents[2] / 'contracts'
NS = {'w':'http://schemas.xmlsoap.org/wsdl/', 's':'http://schemas.xmlsoap.org/wsdl/soap/', 'x':'http://www.w3.org/2001/XMLSchema'}
SOAP = 'http://schemas.xmlsoap.org/soap/envelope/'
FISCAL = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2'
MAX_XML = 2_000_000
manifest = json.loads((ROOT/'manifest.json').read_text('utf-8'))
trusted = {row['file']: row for row in manifest}

def read_trusted(name):
    if name not in trusted or Path(name).name != name: raise ValueError('UNTRUSTED_CONTRACT')
    data = (ROOT/name).read_bytes()
    if hashlib.sha256(data).hexdigest() != trusted[name]['sha256']: raise ValueError('CONTRACT_HASH_MISMATCH')
    return data

class Resolver(E.Resolver):
    def resolve(self, url, public_id, context):
        # Due soli import ammessi. Tutto il resto, inclusi DTD e file arbitrari, fallisce.
        if url == 'http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd':
            return self.resolve_string(read_trusted('xmldsig-core-schema.xsd'), context)
        raise ValueError('EXTERNAL_RESOURCE_DISABLED')

def parser():
    p=E.XMLParser(resolve_entities=False,load_dtd=False,no_network=True,huge_tree=False,recover=False)
    p.resolvers.add(Resolver()); return p

def parse_payload(xml):
    if not isinstance(xml,str) or len(xml.encode('utf-8'))>MAX_XML: raise ValueError('INVALID_PAYLOAD_SIZE')
    data=xml.encode('utf-8')
    if '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper(): raise ValueError('DTD_DISABLED')
    root=E.fromstring(data,parser())
    if root.getroottree().docinfo.doctype: raise ValueError('DTD_DISABLED')
    count=0
    for el in root.iter():
        count+=1
        if count>30000 or len(list(el.iterancestors()))>64: raise ValueError('XML_COMPLEXITY_LIMIT')
    return root

def schema(name): return E.XMLSchema(E.fromstring(read_trusted(name),parser()))

def validate(root,name):
    s=schema(name)
    if not s.validate(root):
        # Non restituire messaggi libxml contenenti valori fiscali o payload.
        raise ValueError('XSD_INVALID:'+','.join(f'{e.type_name}@{e.line}' for e in list(s.error_log)[:8]))

def qname(node,value):
    prefix,local=value.split(':'); return '{'+node.nsmap[prefix]+'}'+local

def contract():
    w=E.fromstring(read_trusted('SdIRiceviFile_v1.0.wsdl'),parser())
    op=w.find('w:portType/w:operation',NS)
    def element(direction):
        message=op.find('w:'+direction,NS).get('message').split(':')[-1]
        part=w.find("w:message[@name='%s']/w:part"%message,NS)
        return qname(part,part.get('element'))
    return {'operation':op.get('name'),'action':w.find('w:binding/w:operation/s:operation',NS).get('soapAction'),
            'input':element('input'),'output':element('output'),'wsdlAddress':w.find('w:service/w:port/s:address',NS).get('location')}

def dispatch(v):
    mode=v['mode']
    if mode=='unpack-export':
        data=base64.b64decode(v['base64'],validate=True)
        if len(data)>2_000_000: raise ValueError('ZIP_SIZE_LIMIT')
        result=[];total=0;seen=set()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            entries=z.infolist()
            if len(entries)>200: raise ValueError('ZIP_ENTRY_LIMIT')
            for item in entries:
                name=item.filename.replace('\\','/')
                if name.startswith('/') or ':' in name or any(p in ['..','.'] for p in name.split('/')) or '\x00' in name: raise ValueError('UNSAFE_ZIP_PATH')
                if name.casefold() in seen: raise ValueError('DUPLICATE_ZIP_PATH')
                seen.add(name.casefold())
                if stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1: raise ValueError('UNSUPPORTED_ZIP_ENTRY')
                if item.is_dir(): continue
                if item.file_size>2_000_000 or item.file_size>max(item.compress_size,1)*100: raise ValueError('ZIP_EXPANSION_LIMIT')
                total+=item.file_size
                if total>2_000_000: raise ValueError('ZIP_EXPANSION_LIMIT')
                if not name.lower().endswith('.xml'):
                    result.append({'name':name,'error':'UNSUPPORTED_EXPORT_FILE'});continue
                with z.open(item) as f: content=f.read(2_000_001)
                if len(content)!=item.file_size: raise ValueError('ZIP_SIZE_MISMATCH')
                result.append({'name':name,'base64':base64.b64encode(content).decode('ascii')})
        return result
    if mode=='inspect-invoice':
        root=parse_payload(v['xml']);validate(root,'Schema_VFPR12_v1.2.3.xsd')
        if root.tag!='{'+FISCAL+'}FatturaElettronica' or root.get('versione')!='FPR12': raise ValueError('FPR12_REQUIRED')
        def identity(path):
            p=root.find('FatturaElettronicaHeader/'+path+'/DatiAnagrafici')
            return {'country':p.findtext('IdFiscaleIVA/IdPaese'),'vat':p.findtext('IdFiscaleIVA/IdCodice'),'cf':p.findtext('CodiceFiscale'),
                    'name':p.findtext('Anagrafica/Denominazione') or ' '.join(filter(None,[p.findtext('Anagrafica/Nome'),p.findtext('Anagrafica/Cognome')]))}
        docs=[]
        for i,b in enumerate(root.findall('FatturaElettronicaBody')):
            d=b.find('DatiGenerali/DatiGeneraliDocumento')
            deadlines=[node.text for node in b.findall('DatiPagamento/DettaglioPagamento/DataScadenzaPagamento') if node.text]
            docs.append({'bodyIndex':i,'type':d.findtext('TipoDocumento'),'number':d.findtext('Numero'),'date':d.findtext('Data'),'currency':d.findtext('Divisa'),'total':d.findtext('ImportoTotaleDocumento'),
                         'dueDate':deadlines[0] if len(deadlines)==1 else None})
        return {'seller':identity('CedentePrestatore'),'buyer':identity('CessionarioCommittente'),'documents':docs,'xsdValidated':True,'signatureVerification':'NOT_PERFORMED'}
    if mode=='contract': return contract()
    if mode=='validate':
        root=parse_payload(v['xml']);validate(root,'Schema_VFPR12_v1.2.3.xsd')
        if root.tag!='{'+FISCAL+'}FatturaElettronica' or root.get('versione')!='FPR12': raise ValueError('FPR12_REQUIRED')
        return {'xsdValidated':True,'schema':'Schema_VFPR12_v1.2.3.xsd'}
    c=contract()
    if mode=='request':
        # Preflight anche sul documento incorporato; non accetta XML simulati.
        dispatch({'mode':'validate','xml':v['xml']})
        root=E.Element(c['input'],nsmap={'t':c['input'].split('}')[0][1:]})
        E.SubElement(root,'NomeFile').text=v['filename']
        E.SubElement(root,'File').text=base64.b64encode(v['xml'].encode('utf-8')).decode('ascii')
        validate(root,'TrasmissioneTypes_v1.0.xsd')
        envelope=E.Element('{'+SOAP+'}Envelope',nsmap={'soap':SOAP});E.SubElement(envelope,'{'+SOAP+'}Body').append(root)
        return {'xml':E.tostring(envelope,encoding='unicode'),'action':c['action']}
    if mode=='response':
        root=parse_payload(v['xml'])
        if root.tag!='{'+SOAP+'}Envelope': raise ValueError('INVALID_SOAP_ENVELOPE')
        bodies=root.findall('{'+SOAP+'}Body')
        headers=root.findall('{'+SOAP+'}Header')
        if len(headers)>1 or any(len(h)>0 for h in headers): raise ValueError('UNSUPPORTED_SOAP_HEADER')
        if len(bodies)!=1 or len(bodies[0])!=1 or any(x.tag not in ['{'+SOAP+'}Header','{'+SOAP+'}Body'] for x in root): raise ValueError('INVALID_SOAP_BODY')
        child=bodies[0][0]
        if child.tag=='{'+SOAP+'}Fault': return {'kind':'SOAP_FAULT'}
        if child.tag!=c['output']: raise ValueError('UNEXPECTED_SOAP_RESPONSE')
        validate(child,'TrasmissioneTypes_v1.0.xsd')
        code=child.findtext('Errore')
        if code: return {'kind':'TRANSPORT_REJECTED','code':code}
        identifier=child.findtext('IdentificativoSdI')
        if int(identifier)<=0: raise ValueError('INVALID_SDI_ID')
        return {'kind':'SDI_RECEIVED','identifier':identifier,'receivedAt':child.findtext('DataOraRicezione')}
    raise ValueError('UNKNOWN_MODE')

try:
    data=sys.stdin.buffer.read(4_000_001)
    if len(data)>4_000_000: raise ValueError('INPUT_TOO_LARGE')
    result=dispatch(json.loads(data))
    print(json.dumps({'ok':True,'result':result}))
except Exception as e:
    message=str(e) if isinstance(e,ValueError) else 'XML_ENGINE_FAILURE'
    print(json.dumps({'ok':False,'error':message}));sys.exit(1)
