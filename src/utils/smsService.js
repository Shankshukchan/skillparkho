import { sendOtpEmail } from './emailService.js';

// Email-only OTP delivery via Resend (student email from Google Sheet)
// SMS/WhatsApp providers removed - Resend is the sole channel now.

export async function sendSmsOtp(phone, otp) {
  // Kept for backwards compat but not used - Resend email is primary
  console.warn('sendSmsOtp called but SMS providers removed - use Resend email');
  return { sent: false, error: 'SMS providers removed - email OTP only via Resend' };
}

export async function sendOtpWithFallback(phone, otp, fallbackEmail, fullName = '') {
  const isPlaceholderEmail = fallbackEmail && (fallbackEmail.startsWith('noemail_') || fallbackEmail.includes('placeholder.test'));
  const hasValidEmail = fallbackEmail && fallbackEmail.includes('@') && !isPlaceholderEmail;

  if (!hasValidEmail) {
    console.warn(`⚠️ No valid student email from Sheet for phone ${phone} — cannot send OTP via Resend`);
    console.log(`🔐 [FALLBACK OTP] Phone: ${phone} | OTP: ${otp} | Email missing/invalid: ${fallbackEmail || 'none'}`);
    return { sent: false, channel: 'none', error: 'No valid email — add student email in Google Sheet', previewOtp: otp, fallbackLogged: true };
  }

  console.log(`📧 Resend OTP -> ${fallbackEmail} for phone ${phone}`);
  const emailResult = await sendOtpEmail(fallbackEmail, otp, phone, fullName);
  if (emailResult.sent || emailResult.devMode || emailResult.fallbackLogged) {
    return {
      sent: true,
      channel: 'email',
      provider: emailResult.provider || 'resend',
      emailResult,
      previewOtp: emailResult.preview || (emailResult.devMode ? otp : undefined),
    };
  }

  console.error(`📧 Resend email failed for ${fallbackEmail}: ${emailResult.error}`);
  console.log(`🔐 [RESEND FAILED OTP] Phone: ${phone} | Email: ${fallbackEmail} | OTP: ${otp}`);
  return { sent: false, channel: 'none', error: emailResult.error || 'Resend failed', emailError: emailResult.error, previewOtp: otp, fallbackLogged: true };
}
