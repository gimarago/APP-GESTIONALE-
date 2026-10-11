// Dati sintetici di test, mai da trasmettere in produzione.
export function sampleInvoice() {
  return {
    seller:{name:'OFFICINA DI PROVA',vat:'12345678903',address:'Via di prova 1',zip:'00100',city:'Roma',province:'RM',country:'IT',regime:'RF01'},
    customer:{name:'CLIENTE DI PROVA',vat:'12345678903',address:'Via di prova 2',zip:'00100',city:'Roma',province:'RM',country:'IT'},
    transmission:{country:'IT',id:'12345678903',progressive:'TEST1',recipientCode:'0000000'},
    type:'TD01',currency:'EUR',date:'2026-09-11',number:'TEST-1',numberSource:'external',
    lines:[{description:'Manodopera & prova <XML>',quantity:'2',unitPrice:'100',vat:'22',discount:'10'}],
    payment:{method:'MP05'},notes:'DOCUMENTO SINTETICO DI COLLAUDO - NON EMETTERE'
  };
}
