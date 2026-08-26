/**
 * Resend Email Service — primary OTP delivery via Resend API
 * Student email comes from Google Sheet (allowed_app_users / sheet row)
 * Docs: https://resend.com/docs/send-with-nodejs
 *
 * Uses fetch directly so no extra SDK needed; also supports `resend` npm package if installed.
 * Falls back gracefully when RESEND_API_KEY is not configured (logs OTP to console for dev).
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

function getResendKey() {
  return process.env.RESEND_API_KEY || process.env.RESEND_API_TOKEN || '';
}

function getFromEmail() {
  // Resend requires a verified domain. Use FROM_EMAIL env; default to onboarding@resend.dev for testing
  return process.env.FROM_EMAIL || process.env.RESEND_FROM_EMAIL || 'SkillParkho <onboarding@resend.dev>';
}

/**
 * Send OTP via Resend to student's email (from Google Sheet)
 * @param {string} toEmail - student email from Sheet
 * @param {string} otp - 6-digit code
 * @param {string} phone - normalized 10-digit phone for context
 * @param {string} fullName - student name for personalization
 * @returns {Promise<{sent:boolean, channel:string, messageId?:string, error?:string, devMode?:boolean, preview?:string}>}
 */
export async function sendOtpViaResend(toEmail, otp, phone, fullName = '') {
  const apiKey = getResendKey();
  const cleanEmail = String(toEmail || '').trim();

  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { sent: false, channel: 'none', error: 'No valid student email (from Google Sheet)' };
  }

  // Dev fallback when key not set — log and allow preview
  if (!apiKey) {
    console.warn('⚠️  RESEND_API_KEY not set — OTP email will be logged to console only (dev mode)');
    console.log(`\n📧 [RESEND DEV OTP] To: ${cleanEmail} | Phone: ${phone} | OTP: ${otp}\n`);
    return { sent: true, channel: 'email', devMode: true, preview: otp, provider: 'resend_dev' };
  }

  const from = getFromEmail();
  const subject = `Your SkillParkho OTP is ${otp} — valid for 5 minutes`;
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#0F172A;color:#E2E8F0;border-radius:16px;overflow:hidden;border:1px solid #1E293B">
    <div style="background:linear-gradient(135deg,#2563EB,#4F46E5);padding:24px;text-align:center">
      <h1 style="margin:0;color:white;font-size:22px">SkillParkho HR Tracker</h1>
      <p style="margin:4px 0 0;color:#BFDBFE;font-size:13px">Secure Email Verification</p>
    </div>
    <div style="padding:28px">
      <p style="color:#94A3B8;font-size:14px;margin:0 0 8px">Hi ${fullName || 'there'},</p>
      <p style="color:#E2E8F0;font-size:14px;line-height:1.6;margin:0 0 16px">
        You requested to log in with your mobile number <b style="color:white">+91 ${phone}</b>. Use the OTP below to continue. It expires in <b>5 minutes</b> and allows <b>3 attempts</b>.
      </p>
      <div style="text-align:center;margin:20px 0">
        <div style="display:inline-block;background:#020617;border:1px solid #1E293B;border-radius:12px;padding:16px 32px">
          <div style="font-size:11px;letter-spacing:0.15em;color:#64748B;font-weight:700">YOUR OTP CODE</div>
          <div style="font-size:32px;font-weight:800;letter-spacing:0.25em;color:white;margin-top:6px;font-family:monospace">${otp}</div>
        </div>
      </div>
      <p style="color:#64748B;font-size:12px;text-align:center;margin:16px 0 0">
        This OTP was sent to <b style="color:#94A3B8">${cleanEmail}</b> — the email registered for your number in SkillParkho records (Google Sheet).<br/>
        Do not share this code. If you didn't request it, please ignore this email.
      </p>
      <div style="margin-top:24px;padding:12px;background:#020617;border-radius:8px;border:1px solid #1E293B">
        <p style="margin:0;color:#64748B;font-size:11px;text-align:center">Automated email from SkillParkho • Need help? Contact your placement coordinator.</p>
      </div>
    </div>
  </div>
  `;
  const text = `Hi ${fullName || ''}, Your SkillParkho OTP is ${otp}. Valid for 5 minutes for phone +91 ${phone}. This was sent to ${cleanEmail}. Do not share this code.`;

  try {
    // Try using `resend` npm package if available, otherwise direct fetch
    try {
      const { Resend } = await import('resend');
      const resend = new Resend(apiKey);
      const { data, error } = await resend.emails.send({
        from,
        to: [cleanEmail],
        subject,
        html,
        text,
      });
      if (error) {
        console.error('📧 Resend SDK error:', error);
        // Fallback to fetch below
        throw new Error(error.message || JSON.stringify(error));
      }
      console.log(`📧 [RESEND SDK] OTP sent to ${cleanEmail} (phone ${phone}) id=${data?.id}`);
      return { sent: true, channel: 'email', provider: 'resend', messageId: data?.id };
    } catch (sdkErr) {
      if (sdkErr?.message && !sdkErr.message.includes('Cannot find package')) {
        // If SDK was available but send failed, try HTTP fallback below instead of returning immediately
        console.warn('📧 Resend SDK send failed, trying HTTP fallback:', sdkErr.message);
      } else if (!String(sdkErr?.message || '').includes('Cannot find package')) {
        // SDK not installed, fall through to HTTP
      }
      // HTTP fallback
    }

    const resp = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [cleanEmail],
        subject,
        html,
        text,
      }),
    });

    const bodyText = await resp.text();
    let bodyJson;
    try { bodyJson = JSON.parse(bodyText); } catch { bodyJson = { raw: bodyText }; }

    if (!resp.ok) {
      const msg = bodyJson?.message || bodyJson?.error || bodyJson?.name || bodyText.slice(0, 500);
      console.error(`📧 Resend HTTP ${resp.status} failed for ${cleanEmail}:`, msg);
      // In dev, still log OTP so testing can continue even without verified domain
      if (process.env.NODE_ENV !== 'production') {
        console.log(`📧 [RESEND FALLBACK OTP] To: ${cleanEmail} | OTP: ${otp}`);
        return { sent: false, channel: 'none', error: msg, preview: otp, fallbackLogged: true, httpStatus: resp.status };
      }
      return { sent: false, channel: 'none', error: msg, httpStatus: resp.status };
    }

    console.log(`📧 [RESEND HTTP] OTP sent to ${cleanEmail} (phone ${phone}) id=${bodyJson?.id}`);
    return { sent: true, channel: 'email', provider: 'resend', messageId: bodyJson?.id, response: bodyJson };
  } catch (err) {
    console.error('📧 Resend send exception:', err.message);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📧 [RESEND EXCEPTION OTP] To: ${cleanEmail} | OTP: ${otp}`);
      return { sent: false, channel: 'none', error: err.message, preview: otp, fallbackLogged: true };
    }
    return { sent: false, channel: 'none', error: err.message };
  }
}

export function maskEmail(email) {
  if (!email || !email.includes('@')) return '***';
  const [user, domain] = email.split('@');
  if (user.length <= 2) return `${user[0]}***@${domain}`;
  return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
}
