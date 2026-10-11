import test from 'node:test';
import assert from 'node:assert/strict';
import { isPasswordResetEmailConfigured, sendPasswordResetEmail, sendReportEmail } from './email.mjs';

const attachment={name:'Rapporto-RI-ABC123.pdf',base64:Buffer.from('%PDF-1.7 rapporto').toString('base64')};

test('report email uses the selected SMTP provider and attaches the printable PDF',async()=>{
  for(const [provider,host,port]of [['gmail','smtp.gmail.com',465],['outlook','smtp.office365.com',587]]){
    let options,message,closed=false;
    const nodemailer={createTransport(value){options=value;return {async sendMail(data){message=data;return {accepted:[data.to]};},close(){closed=true;}};}};
    const result=await sendReportEmail({provider,from:'sender@example.test',to:'customer@example.test',subject:'Rapporto',body:'Lavori completati',attachment},{SMTP_USER:'sender@example.test',SMTP_PASSWORD:'app-password',SMTP_FROM:'sender@example.test',RECOVERY_SMTP_USER:'recovery@example.test',RECOVERY_SMTP_PASSWORD:'recovery-password',RECOVERY_SMTP_FROM:'recovery@example.test'},{nodemailer});
    assert.equal(result.ok,true);assert.equal(result.provider,provider);assert.equal(options.host,host);assert.equal(options.port,port);assert.equal(message.from,'sender@example.test');assert.equal(message.attachments.length,1);assert.equal(message.attachments[0].contentType,'application/pdf');assert.deepEqual(message.attachments[0].content,Buffer.from(attachment.base64,'base64'));assert.equal(closed,true);
  }
});

test('password recovery uses a dedicated SMTP account and sender without changing customer mail',async()=>{
  const env={
    OFFICINA_ORIGIN:'https://officina.example.test',
    SMTP_USER:'clients@example.test',SMTP_PASSWORD:'client-password',SMTP_FROM:'clients@example.test',
    RECOVERY_SMTP_HOST:'smtp.office365.com',RECOVERY_SMTP_PORT:'587',
    RECOVERY_SMTP_USER:'account-recovery@example.test',RECOVERY_SMTP_PASSWORD:'recovery-password',
    RECOVERY_SMTP_FROM:'account-recovery@example.test'
  };
  let options,message,closed=false;
  const nodemailer={createTransport(value){options=value;return {async sendMail(data){message=data;return {accepted:[data.to]};},close(){closed=true;}};}};
  assert.equal(isPasswordResetEmailConfigured(env),true);
  await sendPasswordResetEmail({to:'user@example.test',resetUrl:'https://officina.example.test/reset-password?token=token',expiresMinutes:30},env,{nodemailer});
  assert.equal(options.host,'smtp.office365.com');assert.equal(options.port,587);assert.equal(options.auth.user,'account-recovery@example.test');assert.equal(options.auth.pass,'recovery-password');
  assert.equal(message.from,'account-recovery@example.test');assert.equal(message.to,'user@example.test');assert.equal(closed,true);
});

test('password recovery keeps the existing SMTP configuration as a migration fallback',()=>{
  assert.equal(isPasswordResetEmailConfigured({SMTP_USER:'legacy@example.test',SMTP_PASSWORD:'legacy-password',SMTP_FROM:'legacy@example.test'}),true);
  assert.equal(isPasswordResetEmailConfigured({RECOVERY_SMTP_USER:'recovery@example.test',RECOVERY_SMTP_PASSWORD:'recovery-password',RECOVERY_SMTP_FROM:'recovery@example.test'}),true);
  assert.equal(isPasswordResetEmailConfigured({SMTP_USER:'clients@example.test',SMTP_PASSWORD:'client-password',RECOVERY_SMTP_USER:'recovery@example.test'}),false);
});

test('report email rejects sender mismatch and invalid PDF attachments before SMTP',async()=>{
  const input={provider:'gmail',from:'forged@example.test',to:'customer@example.test',subject:'Rapporto',body:'Lavori completati',attachment};
  await assert.rejects(()=>sendReportEmail(input,{SMTP_USER:'sender@example.test',SMTP_PASSWORD:'app-password'}),{code:'EMAIL_SENDER'});
  await assert.rejects(()=>sendReportEmail({...input,from:'sender@example.test',attachment:{...attachment,base64:Buffer.from('not pdf').toString('base64')}},{SMTP_USER:'sender@example.test',SMTP_PASSWORD:'app-password'}),{code:'EMAIL_ATTACHMENT'});
});
