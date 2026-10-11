export function validateApplication(draft) {
  if (!draft || draft.simulation !== true || typeof draft.label !== 'string' || !draft.label.trim()) {
    throw new Error('INVALID_DRAFT: richiesti simulation=true e label');
  }
  if ('number' in draft || 'progressive' in draft) throw new Error('FISCAL_NUMBER_DISABLED');
  if (Buffer.byteLength(JSON.stringify(draft)) > 65536) throw new Error('PAYLOAD_TOO_LARGE');
}
import {xmlEngine} from '../xml/engine.js';
export class XsdValidator {
  async validate(xml) {
    if(typeof xml!=='string' || Buffer.byteLength(xml)>2000000) throw Error('INVALID_PAYLOAD_SIZE');
    return xmlEngine({mode:'validate',xml});
  }
}
export class SimulatorXmlValidator {
  async validate(xml) {
    if (typeof xml !== 'string' || Buffer.byteLength(xml) > 100000) throw new Error('INVALID_PAYLOAD_SIZE');
    // Grammatica chiusa del simulatore: nessun parser XML, DTD, entità o rete.
    if (!/^<OfficinaSimulation fiscal="false"><Payload encoding="base64">[A-Za-z0-9+/]*={0,2}<\/Payload><\/OfficinaSimulation>$/.test(xml)) {
      throw new Error('INVALID_SIMULATION_XML');
    }
    return {simulation: true, xsdValidated: false};
  }
}
