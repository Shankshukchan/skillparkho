import { sendOtpViaResend } from './resendService.js';

export async function sendOtpEmail(toEmail, otp, phone, fullName = '') {
  // Resend is the sole OTP channel - uses student's email from Google Sheet
  if (process.env.RESEND_API_KEY || process.env.RESEND_API_TOKEN) {
    try {
      const r = await sendOtpViaResend(toEmail, otp, phone, fullName);
      if (r.sent) return r;
      if (r.preview || r.fallbackLogged) return r;
      console.warn('Resend failed:', r.error);
      return r;
    } catch (e) {
      console.warn('Resend exception:', e.message);
      return { sent: false, error: e.message, preview: otp, fallbackLogged: true };
    }
  }

  // No Resend key - dev fallback: log OTP to console (useful for local testing)
  console.warn('⚠️ RESEND_API_KEY not set - OTP email will be logged to console only (dev mode)');
  console.log(`\n📧 [DEV OTP EMAIL] To: ${toEmail} | Phone: ${phone} | OTP: ${otp}\n`);
  return { sent: true, devMode: true, preview: otp, provider: 'resend_dev' };
}

export function maskEmail(email) {
  if (!email || !email.includes('@')) return '***';
  const [user, domain] = email.split('@');
  if (user.length <= 2) return `${user[0]}***@${domain}`;
  return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
}
