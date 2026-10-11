// Nessun endpoint o contratto SMTS inventato. Separato da SdIRiceviFile.
export class PortalProvider {
  async requestDownload() { throw Error('PORTAL_SYNC_NOT_CONFIGURED: contratti ufficiali SMTS e abilitazione da verificare'); }
  async pollDownload() { throw Error('PORTAL_SYNC_NOT_CONFIGURED'); }
  async download() { throw Error('PORTAL_SYNC_NOT_CONFIGURED'); }
}
