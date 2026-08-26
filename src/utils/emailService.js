import nodemailer from 'nodemailer';
import { sendOtpViaResend } from './resendService.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  // If no SMTP configured, use ethereal / log-only fallback
  if (!host || !user || !pass) {
    console.warn('⚠️  SMTP not configured (SMTP_HOST/USER/PASS missing) - OTP emails will be logged to console only');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: { user, pass },
  });
  return transporter;
}

export async function sendOtpEmail(toEmail, otp, phone, fullName = '') {
  // Prefer Resend if configured — primary OTP channel is Resend to student's Sheet email
  if (process.env.RESEND_API_KEY || process.env.RESEND_API_TOKEN) {
    try {
      const r = await sendOtpViaResend(toEmail, otp, phone, fullName);
      if (r.sent) return r;
      // If Resend failed but we are in dev, still allow preview flow
      if (r.preview || r.fallbackLogged) return r;
      // Otherwise fall through to SMTP fallback
      console.warn('Resend failed, falling back to SMTP:', r.error);
    } catch (e) {
      console.warn('Resend exception, falling back to SMTP:', e.message);
    }
  }

  const from = process.env.FROM_EMAIL || process.env.SMTP_USER || 'noreply@skillparkho.com';
  const subject = `Your SkillParkho OTP is ${otp} - Valid for 5 minutes`;
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;background:#0F172A;color:#E2E8F0;border-radius:16px;overflow:hidden;border:1px solid #1E293B">
    <div style="background:linear-gradient(135deg,#2563EB,#4F46E5);padding:24px;text-align:center">
      <h1 style="margin:0;color:white;font-size:22px">SkillParkho HR Tracker</h1>
      <p style="margin:4px 0 0;color:#BFDBFE;font-size:13px">Secure Email Verification</p>
    </div>
    <div style="padding:28px">
      <p style="color:#94A3B8;font-size:14px;margin:0 0 8px">Hello${fullName ? ' ' + fullName : ''},</p>
      <p style="color:#E2E8F0;font-size:14px;line-height:1.6;margin:0 0 16px">
        You requested to log in with your mobile number <b style="color:white">${phone}</b>. Use the OTP below to continue. It expires in <b>5 minutes</b>.
      </p>
      <div style="text-align:center;margin:20px 0">
        <div style="display:inline-block;background:#020617;border:1px solid #1E293B;border-radius:12px;padding:16px 32px">
          <div style="font-size:11px;letter-spacing:0.15em;color:#64748B;font-weight:700">YOUR OTP CODE</div>
          <div style="font-size:32px;font-weight:800;letter-spacing:0.25em;color:white;margin-top:6px;font-family:monospace">${otp}</div>
        </div>
      </div>
      <p style="color:#64748B;font-size:12px;text-align:center;margin:16px 0 0">
        Do not share this code. If you didn't request it, please ignore this email.<br/>
        Valid for 5 minutes • 3 attempts only
      </p>
      <div style="margin-top:24px;padding:12px;background:#020617;border-radius:8px;border:1px solid #1E293B">
        <p style="margin:0;color:#64748B;font-size:11px;text-align:center">This is an automated email from SkillParkho. Need help? Contact your placement coordinator.</p>
      </div>
    </div>
  </div>
  `;
  const text = `Your SkillParkho OTP is ${otp}. It is valid for 5 minutes for phone ${phone}. Do not share this code.`;

  const tx = getTransporter();
  if (!tx) {
    // Dev fallback: log and pretend sent
    console.log(`\n📧 [DEV OTP EMAIL] To: ${toEmail} | Phone: ${phone} | OTP: ${otp}\n`);
    return { sent: true, devMode: true, preview: otp };
  }
  try {
    await tx.verify().catch(() => {});
    const info = await tx.sendMail({ from, to: toEmail, subject, html, text });
    console.log(`📧 OTP email sent via SMTP to ${toEmail} (phone ${phone}) msgId=${info.messageId}`);
    return { sent: true, messageId: info.messageId, provider: 'smtp', channel: 'email' };
  } catch (err) {
    console.error('📧 OTP email failed, falling back to log:', err.message);
    console.log(`📧 [FALLBACK OTP] To: ${toEmail} | OTP: ${otp}`);
    // Don't fail request - still allow OTP in dev preview
    return { sent: false, error: err.message, preview: otp, fallbackLogged: true };
  }
}

export function maskEmail(email) {
  if (!email || !email.includes('@')) return '***';
  const [user, domain] = email.split('@');
  if (user.length <= 2) return `${user[0]}***@${domain}`;
  return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
}
