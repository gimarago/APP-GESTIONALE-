import {validateFiscalApplication,money} from './fiscal-rules.js';
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const tag=(n,v)=>`<${n}>${esc(v)}</${n}>`;
const minTwo=v=>{const [a,b='']=v.split('.');return a+'.'+b.padEnd(2,'0');};
const identity=p=>(p.vat?'<IdFiscaleIVA>'+tag('IdPaese',p.country)+tag('IdCodice',p.vat)+'</IdFiscaleIVA>':'')+(p.cf?tag('CodiceFiscale',p.cf):'')+'<Anagrafica>'+tag('Denominazione',p.name)+'</Anagrafica>';
const address=p=>'<Sede>'+tag('Indirizzo',p.address)+tag('CAP',p.zip)+tag('Comune',p.city)+tag('Provincia',p.province)+tag('Nazione',p.country)+'</Sede>';
export class XmlGenerator {
  async generate(d) {
    const c=validateFiscalApplication(d),t=d.transmission;
    return '<?xml version="1.0" encoding="UTF-8"?>\n'+
      '<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">'+
      '<FatturaElettronicaHeader><DatiTrasmissione><IdTrasmittente>'+tag('IdPaese',t.country)+tag('IdCodice',t.id)+'</IdTrasmittente>'+tag('ProgressivoInvio',t.progressive)+tag('FormatoTrasmissione','FPR12')+tag('CodiceDestinatario',t.recipientCode)+(t.pec?tag('PECDestinatario',t.pec):'')+'</DatiTrasmissione>'+ 
      '<CedentePrestatore><DatiAnagrafici>'+identity(d.seller)+tag('RegimeFiscale',d.seller.regime)+'</DatiAnagrafici>'+address(d.seller)+'</CedentePrestatore>'+ 
      '<CessionarioCommittente><DatiAnagrafici>'+identity(d.customer)+'</DatiAnagrafici>'+address(d.customer)+'</CessionarioCommittente></FatturaElettronicaHeader>'+ 
      '<FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>'+tag('TipoDocumento',d.type)+tag('Divisa',d.currency)+tag('Data',d.date)+tag('Numero',d.number)+tag('ImportoTotaleDocumento',money(c.total))+(d.notes?tag('Causale',d.notes):'')+'</DatiGeneraliDocumento>'+ 
      (d.reference?'<DatiFattureCollegate>'+tag('IdDocumento',d.reference.number)+tag('Data',d.reference.date)+'</DatiFattureCollegate>':'')+'</DatiGenerali><DatiBeniServizi>'+ 
      c.rows.map((l,i)=>'<DettaglioLinee>'+tag('NumeroLinea',i+1)+tag('Descrizione',l.description)+tag('Quantita',minTwo(l.quantity))+tag('PrezzoUnitario',minTwo(l.unitPrice))+(l.discount>0n?'<ScontoMaggiorazione>'+tag('Tipo','SC')+tag('Percentuale',money(l.discount))+'</ScontoMaggiorazione>':'')+tag('PrezzoTotale',money(l.cents))+tag('AliquotaIVA',money(l.rate))+'</DettaglioLinee>').join('')+
      c.summaries.map(g=>'<DatiRiepilogo>'+tag('AliquotaIVA',money(g.rate))+tag('ImponibileImporto',money(g.net))+tag('Imposta',money(g.tax))+tag('EsigibilitaIVA','I')+'</DatiRiepilogo>').join('')+'</DatiBeniServizi>'+ 
      (d.payment?'<DatiPagamento>'+tag('CondizioniPagamento','TP02')+'<DettaglioPagamento>'+tag('ModalitaPagamento',d.payment.method)+(d.payment.dueDate?tag('DataScadenzaPagamento',d.payment.dueDate):'')+tag('ImportoPagamento',money(c.total))+(d.payment.iban?tag('IBAN',d.payment.iban):'')+'</DettaglioPagamento></DatiPagamento>':'')+
      '</FatturaElettronicaBody></p:FatturaElettronica>';
  }
}
// Non produce un documento fiscale, non assegna numeri o progressivi fiscali.
export class SimulatorXmlGenerator {
  async generate(invoice) {
    const encoded = Buffer.from(JSON.stringify(invoice), 'utf8').toString('base64');
    return `<OfficinaSimulation fiscal="false"><Payload encoding="base64">${encoded}</Payload></OfficinaSimulation>`;
  }
}
