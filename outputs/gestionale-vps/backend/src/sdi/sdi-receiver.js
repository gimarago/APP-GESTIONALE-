export class SdiReceiver {
  async receive() { throw new Error('NOT_IMPLEMENTED: ricevitore SdI autenticato e parser XML sicuro'); }
}
// Solo chiamata locale, nessun listener HTTP. JSON di simulazione, mai SOAP/XML SdI.
export class SimulatorReceiver {
  constructor(handler) { this.handler=handler; }
  async receive(payload) {
    if(typeof payload!=='string' || Buffer.byteLength(payload)>4096) throw new Error('INVALID_PAYLOAD_SIZE');
    return this.handler.handle(JSON.parse(payload));
  }
}
