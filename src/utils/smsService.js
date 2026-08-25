import { sendOtpEmail } from './emailService.js';

// SMS Providers: console (dev), fast2sms, twilio, msg91, textlocal

async function sendViaFast2SMS(phone, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) return { sent: false, error: 'FAST2SMS_API_KEY not set' };
  try {
    // Fast2SMS DLT approved route
    const resp = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        route: process.env.FAST2SMS_ROUTE || 'otp',
        variables_values: otp,
        numbers: phone,
        // For custom template, use message param:
        // message: `Your SkillParkho OTP is ${otp}. Valid for 5 minutes.`
      }),
    });
    const data = await resp.json();
    if (data.return === true || data.status_code === 200) {
      return { sent: true, provider: 'fast2sms', response: data };
    }
    return { sent: false, error: data.message || JSON.stringify(data) };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

async function sendViaTwilio(phone, otp) {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return { sent: false, error: 'TWILIO_SID/TOKEN/FROM not set' };
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: from,
        To: `+91${phone.slice(-10)}`,
        Body: `Your SkillParkho OTP is ${otp}. Valid for 5 minutes. Do not share.`,
      }),
    });
    const data = await resp.json();
    if (resp.ok) return { sent: true, provider: 'twilio', sid: data.sid };
    return { sent: false, error: data.message || JSON.stringify(data) };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

async function sendViaMsg91(phone, otp) {
  const key = process.env.MSG91_API_KEY;
  const template = process.env.MSG91_TEMPLATE_ID;
  if (!key) return { sent: false, error: 'MSG91_API_KEY not set' };
  try {
    const resp = await fetch('https://api.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: { authkey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobile: `91${phone.slice(-10)}`,
        otp,
        template_id: template,
      }),
    });
    const data = await resp.json();
    if (data.type === 'success') return { sent: true, provider: 'msg91' };
    return { sent: false, error: JSON.stringify(data) };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

export async function sendSmsOtp(phone, otp) {
  const provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();
  const normalized = phone.replace(/\D/g, '').slice(-10);

  // Provider priority: explicit provider -> fallback chain
  let result = { sent: false, error: 'No provider' };

  if (provider === 'console' || provider === '') {
    console.log(`\n📱 [SMS CONSOLE] To: +91${normalized} | OTP: ${otp}\n`);
    return { sent: true, provider: 'console', devMode: true, previewOtp: otp };
  }

  if (provider === 'fast2sms') result = await sendViaFast2SMS(normalized, otp);
  else if (provider === 'twilio') result = await sendViaTwilio(normalized, otp);
  else if (provider === 'msg91') result = await sendViaMsg91(normalized, otp);
  else if (provider === 'auto') {
    // Try fast2sms -> twilio -> msg91 -> console
    result = await sendViaFast2SMS(normalized, otp);
    if (!result.sent) result = await sendViaTwilio(normalized, otp);
    if (!result.sent) result = await sendViaMsg91(normalized, otp);
  }

  if (result.sent) {
    console.log(`📱 OTP SMS sent via ${result.provider} to +91${normalized}`);
    return result;
  }

  console.warn(`📱 SMS via ${provider} failed: ${result.error}`);
  // Return failed, caller will try email fallback
  return { sent: false, error: result.error, provider };
}

export async function sendOtpWithFallback(phone, otp, fallbackEmail) {
  // 1. Try SMS
  const smsResult = await sendSmsOtp(phone, otp);
  if (smsResult.sent) {
    return { sent: true, channel: 'sms', provider: smsResult.provider, smsResult, previewOtp: smsResult.previewOtp };
  }

  // 2. Fallback to Email
  console.log(`📱 SMS failed (${smsResult.error}), falling back to Email -> ${fallbackEmail}`);
  if (!fallbackEmail || !fallbackEmail.includes('@')) {
    console.warn('⚠️ No valid fallback email, OTP logged only');
    console.log(`🔐 [FALLBACK OTP] Phone: ${phone} | OTP: ${otp} | Email missing`);
    return { sent: false, channel: 'none', smsError: smsResult.error, emailError: 'No valid email', previewOtp: otp, fallbackLogged: true };
  }

  const emailResult = await sendOtpEmail(fallbackEmail, otp, phone);
  if (emailResult.sent || emailResult.devMode || emailResult.fallbackLogged) {
    return {
      sent: true,
      channel: 'email',
      provider: 'email',
      smsError: smsResult.error,
      emailResult,
      previewOtp: emailResult.preview || otp,
      fallback: true,
    };
  }

  // Both failed, but still log OTP for dev
  console.log(`🔐 [BOTH FAILED OTP] Phone: ${phone} | Email: ${fallbackEmail} | OTP: ${otp}`);
  return { sent: false, channel: 'none', smsError: smsResult.error, emailError: emailResult.error, previewOtp: otp, fallbackLogged: true };
}
