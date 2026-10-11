export const InvoiceStatus = Object.freeze({DRAFT:'BOZZA', QUEUED:'DA_INVIARE', SENT:'INVIATA', DELIVERED:'CONSEGNATA', REJECTED:'SCARTATA', UNDELIVERED:'MANCATA_CONSEGNA'});
export const AttemptStatus = Object.freeze({RUNNING:'IN_CORSO', ACK:'ACK_SIMULATO', UNKNOWN:'ESITO_INCERTO'});
export const paymentStates = ['DA_SALDARE', 'PARZIALE', 'SALDATA'];
export const simulatedOutcomes = ['CONSEGNATA', 'SCARTATA', 'MANCATA_CONSEGNA'];
