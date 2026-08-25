// Shared phone normalizer - must match Flutter's lib/services/phone_normalizer.dart
export function normalizePhoneNumber(rawNumber) {
  if (!rawNumber || typeof rawNumber !== 'string') return '';
  let cleaned = rawNumber.trim().replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+91') && cleaned.length === 13) {
    cleaned = cleaned.substring(3);
  } else if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.substring(2);
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }
  // keep only digits, ensure 10 digits
  cleaned = cleaned.replace(/\D/g, '');
  if (cleaned.length > 10) {
    cleaned = cleaned.slice(-10);
  }
  return cleaned;
}

export function isValidPhoneNumber(rawNumber) {
  const norm = normalizePhoneNumber(rawNumber);
  return /^\d{10}$/.test(norm);
}

export function formatDisplayPhone(rawNumber) {
  const norm = normalizePhoneNumber(rawNumber);
  if (norm.length === 10) {
    return `+91 ${norm.substring(0, 5)} ${norm.substring(5)}`;
  }
  return rawNumber || '';
}
