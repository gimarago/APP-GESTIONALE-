import {assertSimulation} from '../config.js';
import {xmlEngine} from '../xml/engine.js';
import {postSoap} from './https-transport.js';
export class SdiClient {
  #prepared=new WeakSet();
  constructor(config) { Object.defineProperty(this,'config',{value:config?Object.freeze(structuredClone(config)):undefined}); }
  async prepare({filename,xml}) {
    const c=this.config;
    if(!c || !['local-contract-test','sdi-test'].includes(c.environment) || process.env.APP_ENV==='production') throw Error('PRODUCTION_DISABLED');
    const u=new URL(c.endpoint);
    if(u.protocol!=='https:' || u.username || u.password || u.hash || u.search) throw Error('INVALID_ENDPOINT');
    if(c.environment==='local-contract-test' && !['localhost','127.0.0.1','[::1]'].includes(u.hostname)) throw Error('LOCAL_ENDPOINT_REQUIRED');
    if(c.environment==='sdi-test' && (c.authorizedTestChannel!==true || typeof c.endpointSource!=='string' || !c.endpointSource.trim())) throw Error('ACCREDITED_TEST_CHANNEL_REQUIRED');
    const contract=await xmlEngine({mode:'contract'});
    if(u.hostname===new URL(contract.wsdlAddress).hostname) throw Error('PRODUCTION_ENDPOINT_DISABLED');
    if(![c.certPath,c.keyPath,c.caPath].every(v=>typeof v==='string' && v)) throw Error('CERTIFICATE_PATHS_REQUIRED');
    if(c.timeoutMs!==undefined && (!Number.isInteger(c.timeoutMs)||c.timeoutMs<100||c.timeoutMs>60000)) throw Error('INVALID_TIMEOUT');
    if(typeof filename!=='string' || !/^IT(?:[A-Z0-9]{11}|[A-Z0-9]{16})_[A-Za-z0-9]{1,5}\.xml$/.test(filename)) throw Error('INVALID_FILENAME');
    const prepared=Object.freeze(await xmlEngine({mode:'request',filename,xml}));
    this.#prepared.add(prepared);return prepared;
  }
  async send(payload) {
    const prepared=await this.prepare(payload);
    return this.sendPrepared(prepared);
  }
  async sendPrepared(prepared) {
    // Chiamata riservata al coordinatore persistente dopo il preflight.
    const c=this.config;
    if(!this.#prepared.has(prepared)) throw Error('PREFLIGHT_REQUIRED');
    this.#prepared.delete(prepared);
    if(!c || !['local-contract-test','sdi-test'].includes(c.environment) || process.env.APP_ENV==='production') throw Error('PRODUCTION_DISABLED');
    try {
      const r=await postSoap({...c,body:prepared.xml,action:prepared.action});
      if(![200,500].includes(r.status) || !/^text\/xml(?:;|$)/i.test(r.contentType)) return {kind:'UNKNOWN',reason:'HTTP_RESPONSE'};
      const result=await xmlEngine({mode:'response',xml:r.body});
      if(r.status!==200 || result.kind==='SOAP_FAULT') return {kind:'UNKNOWN',reason:'SOAP_FAULT'};
      return result;
    } catch {return {kind:'UNKNOWN',reason:'TRANSPORT_OR_RESPONSE_FAILURE'};}
  }
  async reconcile() { throw new Error('NOT_IMPLEMENTED: riconciliazione canale reale'); }
}
export class SimulatorSdiClient {
  constructor({uncertain = false} = {}) { this.uncertain = uncertain; }
  async send({attemptId}) {
    assertSimulation();
    if (this.uncertain) throw new Error('SIMULATED_TIMEOUT');
    return {simulation: true, correlation: `SIM-${attemptId}`};
  }
}
