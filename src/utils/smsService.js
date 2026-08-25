import { sendOtpEmail } from './emailService.js';

// Providers: console (dev), telecrm_whatsapp (TeleCRM WhatsApp API), fast2sms (legacy), twilio, msg91

async function sendViaTeleCrmWhatsapp(phone, otp) {
  const apiKey = process.env.TELECRM_API_KEY || process.env.TELECRM_WHATSAPP_API_KEY;
  const enterpriseId = process.env.TELECRM_ENTERPRISE_ID;
  // Allow full URL override, otherwise construct from enterpriseId
  let url = process.env.TELECRM_WA_URL || process.env.TELECRM_WHATSAPP_URL || process.env.TELECRM_WHATSAPP_API_URL;
  if (!url) {
    if (!enterpriseId) return { sent: false, error: 'TELECRM_ENTERPRISE_ID not set' };
    if (!apiKey) return { sent: false, error: 'TELECRM_API_KEY not set' };
    url = `https://api.telecrm.in/enterprise/${enterpriseId}/whatsapp/send`;
  }
  if (!apiKey) return { sent: false, error: 'TELECRM_API_KEY not set' };

  const normalized = phone.replace(/\D/g, '').slice(-10);
  const to = `91${normalized}`;
  const template = process.env.TELECRM_WA_TEMPLATE || process.env.TELECRM_WA_TEMPLATE_NAME || 'otp_verification';
  const language = process.env.TELECRM_WA_LANGUAGE || 'en';
  // TeleCRM expects template with OTP param; fallback to simple text if template fails
  const payloadsToTry = [
    // Standard WhatsApp template payload
    {
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: language },
        components: [{ type: 'body', parameters: [{ type: 'text', text: String(otp) }] }],
      },
    },
    // Fallback simple text payload (some TeleCRM setups use this)
    {
      to,
      type: 'text',
      text: { body: `Your SkillParkho OTP is ${otp}. Valid for 5 minutes. Do not share.` },
    },
    // Legacy TeleCRM autoUpdateLead style
    {
      phone: to,
      whatsapp_template: template,
      otp: String(otp),
      message: `Your SkillParkho OTP is ${otp}. Valid for 5 minutes.`,
    },
  ];

  for (let i = 0; i < payloadsToTry.length; i++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(process.env.TELECRM_API_HEADER ? { 'X-API-KEY': apiKey } : {}),
        },
        body: JSON.stringify(payloadsToTry[i]),
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (resp.ok) {
        // TeleCRM often returns {success:true} or {status:'success'} or HTTP 200 with no error
        const ok = data.success === true || data.status === 'success' || data.sent === true || resp.status === 200;
        if (ok || i === 0) {
          // Consider first payload success if HTTP 200 even without explicit success flag
          return { sent: true, provider: 'telecrm_whatsapp', response: data, payloadIndex: i };
        }
      }
      // If first payload failed with 4xx, try next fallback payload
      if (i < payloadsToTry.length - 1) continue;
      return { sent: false, error: data.message || data.error || text.slice(0, 500) };
    } catch (e) {
      if (i < payloadsToTry.length - 1) continue;
      return { sent: false, error: e.message };
    }
  }
  return { sent: false, error: 'TeleCRM WhatsApp send failed after retries' };
}

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
  const provider = (process.env.SMS_PROVIDER || 'telecrm').toLowerCase();
  const normalized = phone.replace(/\D/g, '').slice(-10);

  // Provider priority: explicit provider -> fallback chain
  let result = { sent: false, error: 'No provider' };

  if (provider === 'console' || provider === '') {
    console.log(`\n📱 [SMS CONSOLE] To: +91${normalized} | OTP: ${otp}\n`);
    return { sent: true, provider: 'console', devMode: true, previewOtp: otp };
  }

  if (provider === 'telecrm' || provider === 'whatsapp' || provider === 'telecrm_whatsapp' || provider === 'wa') {
    result = await sendViaTeleCrmWhatsapp(normalized, otp);
  } else if (provider === 'fast2sms') result = await sendViaFast2SMS(normalized, otp);
  else if (provider === 'twilio') result = await sendViaTwilio(normalized, otp);
  else if (provider === 'msg91') result = await sendViaMsg91(normalized, otp);
  else if (provider === 'auto') {
    // Try TeleCRM WhatsApp -> fast2sms -> twilio -> msg91
    result = await sendViaTeleCrmWhatsapp(normalized, otp);
    if (!result.sent) result = await sendViaFast2SMS(normalized, otp);
    if (!result.sent) result = await sendViaTwilio(normalized, otp);
    if (!result.sent) result = await sendViaMsg91(normalized, otp);
  } else {
    // Unknown provider string, try TeleCRM as default
    result = await sendViaTeleCrmWhatsapp(normalized, otp);
  }

  if (result.sent) {
    console.log(`📱 OTP WhatsApp sent via ${result.provider} to +91${normalized}`);
    return result;
  }

  console.warn(`📱 WhatsApp via ${provider} failed: ${result.error}`);
  // Return failed, caller will try email fallback
  return { sent: false, error: result.error, provider };
}

export async function sendOtpWithFallback(phone, otp, fallbackEmail) {
  // 1. Try WhatsApp via TeleCRM
  const smsResult = await sendSmsOtp(phone, otp);
  if (smsResult.sent) {
    const ch = smsResult.provider === 'telecrm_whatsapp' || smsResult.provider === 'whatsapp' || smsResult.provider === 'wa' ? 'whatsapp' : 'sms';
    return { sent: true, channel: ch, provider: smsResult.provider, smsResult, previewOtp: smsResult.previewOtp };
  }

  // 2. Fallback to Email
  console.log(`📱 WhatsApp failed (${smsResult.error}), falling back to Email -> ${fallbackEmail}`);
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
