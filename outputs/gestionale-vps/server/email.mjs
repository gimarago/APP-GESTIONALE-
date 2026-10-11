const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u;
const HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i;

function checkedSmtpSettings({ host: hostValue, port: portValue, user: userValue, password: passwordValue, from: fromValue }) {
  const host = String(hostValue || 'smtp.gmail.com').trim();
  const port = Number(portValue || 465);
  const user = String(userValue || '').trim();
  const password = String(passwordValue || '');
  const from = String(fromValue || user).trim();
  if (!HOST.test(host) || host.includes('..') || ![465, 587].includes(port) ||
      !user || !password.trim() || !EMAIL.test(from)) return null;
  return { host, port, user, password, from };
}

function smtpSettings(env) {
  const user = env.SMTP_USER;
  return checkedSmtpSettings({
    host: env.SMTP_HOST, port: env.SMTP_PORT, user, password: env.SMTP_PASSWORD,
    from: env.SMTP_FROM || user
  });
}

function recoverySmtpSettings(env) {
  const recoveryValues = [env.RECOVERY_SMTP_HOST, env.RECOVERY_SMTP_PORT, env.RECOVERY_SMTP_USER,
    env.RECOVERY_SMTP_PASSWORD, env.RECOVERY_SMTP_FROM];
  const hasDedicatedRecoveryConfig = recoveryValues.some(value => String(value || '').trim());
  if (!hasDedicatedRecoveryConfig) return smtpSettings(env);
  const user = env.RECOVERY_SMTP_USER;
  return checkedSmtpSettings({
    host: env.RECOVERY_SMTP_HOST,
    port: env.RECOVERY_SMTP_PORT,
    user,
    password: env.RECOVERY_SMTP_PASSWORD,
    from: env.RECOVERY_SMTP_FROM || user
  });
}

export function isPasswordResetEmailConfigured(env = process.env) {
  return recoverySmtpSettings(env) !== null;
}

function mailError(code, message) { return Object.assign(new Error(message), { code }); }

export async function sendReportEmail({ provider, from, to, subject, body, attachment }, env = process.env, dependencies = {}) {
  const service = provider === 'gmail' ? { host: 'smtp.gmail.com', port: 465 } : provider === 'outlook' ? { host: 'smtp.office365.com', port: 587 } : null;
  if (!service) throw mailError('EMAIL_PROVIDER', 'Seleziona Gmail o Outlook nelle Impostazioni.');
  const smtp = smtpSettings({ ...env, SMTP_HOST: service.host, SMTP_PORT: String(service.port) });
  if (!smtp) throw mailError('EMAIL_UNCONFIGURED', 'Invio email non configurato sul VPS. Imposta SMTP_USER e SMTP_PASSWORD con le credenziali del servizio selezionato.');
  if (!EMAIL.test(String(to || '')) || !EMAIL.test(String(from || ''))) throw mailError('EMAIL_ADDRESS', 'Indirizzo email del cliente o mittente non valido.');
  if (from.trim().toLowerCase() !== smtp.from.toLowerCase()) throw mailError('EMAIL_SENDER', 'Il mittente nelle Impostazioni deve coincidere con SMTP_FROM (o SMTP_USER) configurato sul VPS.');
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 || /[\r\n]/.test(subject) ||
      typeof body !== 'string' || !body.trim() || body.length > 100_000) throw mailError('EMAIL_CONTENT', 'Oggetto o testo email non valido.');
  if (!attachment || !/^[A-Za-z0-9._-]{1,120}\.pdf$/i.test(attachment.name || '') || typeof attachment.base64 !== 'string' ||
      attachment.base64.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.base64)) throw mailError('EMAIL_ATTACHMENT', 'Allegato PDF non valido o troppo grande.');
  const bytes = Buffer.from(attachment.base64, 'base64');
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || bytes.toString('base64') !== attachment.base64) throw mailError('EMAIL_ATTACHMENT', 'Allegato PDF non valido.');
  let nodemailer = dependencies.nodemailer;
  if (!nodemailer) {
    try { ({ default: nodemailer } = await import('nodemailer')); }
    catch { throw mailError('EMAIL_UNAVAILABLE', 'Modulo SMTP non disponibile sul server.'); }
  }
  const transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.port === 465, requireTLS: smtp.port === 587,
    auth: { user: smtp.user, pass: smtp.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: smtp.host },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
    disableFileAccess: true, disableUrlAccess: true
  });
  try {
    const result = await transport.sendMail({ from: smtp.from, to, subject, text: body, attachments: [{ filename: attachment.name, content: bytes, contentType: 'application/pdf' }] });
    if (!result.accepted?.some(address => String(address).toLowerCase() === to.toLowerCase())) throw new Error('Destinatario non accettato.');
    return { ok: true, provider, email: smtp.from, message: 'Email inviata con il PDF allegato.' };
  } catch {
    throw mailError('EMAIL_SEND_FAILED', 'Invio email non riuscito. Verifica le credenziali SMTP e controlla la Posta inviata prima di riprovare.');
  } finally { transport.close(); }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export async function sendPasswordResetEmail({ to, resetUrl, expiresMinutes }, env = process.env, dependencies = {}) {
  const smtp = recoverySmtpSettings(env);
  if (!smtp) throw new Error('Invio email di recupero non configurato.');
  if (!EMAIL.test(String(to))) throw new Error('Indirizzo di destinazione non valido.');
  if (!Number.isInteger(expiresMinutes) || expiresMinutes < 1 || expiresMinutes > 120) {
    throw new Error('Scadenza del collegamento non valida.');
  }

  let url;
  try { url = new URL(resetUrl); } catch { throw new Error('Collegamento di recupero non valido.'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      (env.OFFICINA_ORIGIN && url.origin !== env.OFFICINA_ORIGIN)) {
    throw new Error('Collegamento di recupero non sicuro.');
  }

  let nodemailer = dependencies.nodemailer;
  try { if (!nodemailer) ({ default: nodemailer } = await import('nodemailer')); }
  catch { throw new Error('Modulo SMTP non disponibile.'); }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    requireTLS: smtp.port === 587,
    auth: { user: smtp.user, pass: smtp.password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: smtp.host },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  const link = url.toString();
  const message = {
    from: smtp.from,
    to,
    subject: 'Reimposta la password del gestionale Officina',
    text: `Hai richiesto di cambiare la password del gestionale Officina.\n\nApri questo collegamento per sceglierne una nuova:\n${link}\n\nIl collegamento scade tra ${expiresMinutes} minuti e può essere usato una sola volta.\nSe non hai richiesto il cambio, ignora questa email. La tua password attuale resta valida.\n`,
    html: `<p>Hai richiesto di cambiare la password del gestionale Officina.</p><p><a href="${escapeHtml(link)}">Scegli una nuova password</a></p><p>Il collegamento scade tra ${expiresMinutes} minuti e può essere usato una sola volta.</p><p>Se non hai richiesto il cambio, ignora questa email. La tua password attuale resta valida.</p>`
  };
  try {
    const result = await transport.sendMail(message);
    if (!result.accepted?.some(address => address.toLowerCase() === to.toLowerCase())) {
      throw new Error('Destinatario non accettato.');
    }
  } catch {
    // SMTP exceptions can contain addresses or provider details. Keep them out of logs/UI.
    throw new Error('Invio email di recupero non riuscito.');
  } finally {
    transport.close();
  }
}
