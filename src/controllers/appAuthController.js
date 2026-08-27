import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { supabaseAdmin, supabaseAnon, TABLE_ALLOWED_USERS, TABLE_OTP } from '../config/supabase.js';
import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';
import { maskEmail } from '../utils/emailService.js';
import { findInSheet, getSheetRows } from '../services/googleSheetService.js';
import { sendOtpWithFallback } from '../utils/smsService.js';

const OTP_EXPIRY_MIN = parseInt(process.env.OTP_EXPIRES_MINUTES || '5', 10);
const OTP_RESEND_SECONDS = parseInt(process.env.OTP_RESEND_SECONDS || '45', 10);
const OTP_MAX_ATTEMPTS = 3;

// In-memory fallback when Supabase tables not yet created (dev before migration)
const memOtp = new Map();
const memSupabaseUid = new Map();

// ---------------------------------------------------------------------------
// Auth user management
// ---------------------------------------------------------------------------
async function findAuthUserIdByEmail(email) {
  const pageSize = 200;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: pageSize });
    if (error) throw error;
    const users = data?.users || [];
    const hit = users.find(u => u.email === email);
    if (hit) return hit.id;
    if (users.length < pageSize) break;
  }
  return null;
}

async function ensureAuthUser(email, password, meta) {
  const created = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: meta,
  });
  if (!created.error && created.data?.user) {
    memSupabaseUid.set(meta.normalized_phone_number, created.data.user.id);
    return created.data.user.id;
  }
  if (!/already|registered|exists/i.test(created.error?.message || '')) throw created.error || new Error('createUser failed');

  let uid = memSupabaseUid.get(meta.normalized_phone_number);
  if (!uid) {
    uid = await findAuthUserIdByEmail(email);
    if (uid) memSupabaseUid.set(meta.normalized_phone_number, uid);
  }
  if (!uid) throw new Error('Auth user exists but could not be located');

  const upd = await supabaseAdmin.auth.admin.updateUserById(uid, { password, user_metadata: meta });
  if (upd.error) throw upd.error;
  return uid;
}

function isSupabaseTableMissing(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('Could not find the table') || err.code === '42P01' || msg.includes('schema cache');
}

// ---------------------------------------------------------------------------
// Find allowed user: Google Sheet first, then Supabase
// ---------------------------------------------------------------------------
async function findAllowedUser(norm) {
  // 1. Google Sheet (source of truth)
  try {
    const sheetUser = await findInSheet(norm);
    if (sheetUser && !sheetUser._blockedReason) {
      // Upsert to Supabase for persistence
      try {
        await supabaseAdmin.from(TABLE_ALLOWED_USERS).upsert({
          phone_number: sheetUser.phone_number,
          normalized_phone_number: sheetUser.normalized_phone_number,
          email: sheetUser.email || `noemail_${norm}@placeholder.test`,
          full_name: sheetUser.full_name || '',
          course: sheetUser.course || '',
          batch_name: sheetUser.batch_name || '',
          is_active: sheetUser.is_active,
          created_by: 'google_sheet',
        }, { onConflict: 'normalized_phone_number' });
      } catch (e) {
        if (!isSupabaseTableMissing(e)) console.warn('Supabase upsert sheet user failed:', e.message);
      }
      return {
        id: `sheet-${sheetUser.normalized_phone_number}`,
        phone_number: sheetUser.phone_number,
        normalized_phone_number: sheetUser.normalized_phone_number,
        email: sheetUser.email || '',
        full_name: sheetUser.full_name || 'Student',
        course: sheetUser.course,
        batch_name: sheetUser.batch_name,
        is_active: sheetUser.is_active,
        approved_status: sheetUser.approved_status,
        source: 'sheet',
        sheetUser,
      };
    }
    if (sheetUser && sheetUser._blockedReason) {
      return { _blocked: true, reason: sheetUser._blockedReason, sheetUser };
    }
  } catch (e) {
    console.warn('findInSheet error:', e.message);
  }

  // 2. Supabase fallback
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE_ALLOWED_USERS)
      .select('*')
      .eq('normalized_phone_number', norm)
      .maybeSingle();
    if (error) {
      if (isSupabaseTableMissing(error)) return null;
      throw error;
    }
    if (data) return { ...data, source: 'supabase' };
  } catch (e) {
    if (isSupabaseTableMissing(e)) return null;
    throw e;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OTP store helpers (Supabase + memory fallback)
// ---------------------------------------------------------------------------
async function getRecentOtp(norm) {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE_OTP)
      .select('*')
      .eq('normalized_phone', norm)
      .eq('consumed', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (isSupabaseTableMissing(error)) {
        const m = memOtp.get(norm);
        if (m && !m.consumed && new Date(m.expires_at) > new Date()) return { ...m, id: `mem-${norm}`, _isMem: true };
        return null;
      }
      throw error;
    }
    return data;
  } catch (e) {
    if (isSupabaseTableMissing(e)) {
      const m = memOtp.get(norm);
      if (m && !m.consumed && new Date(m.expires_at) > new Date()) return { ...m, id: `mem-${norm}`, _isMem: true };
      return null;
    }
    throw e;
  }
}

async function storeOtp(norm, email, otp, expiresAt) {
  const payload = { normalized_phone: norm, email, otp_code: otp, attempts_left: OTP_MAX_ATTEMPTS, expires_at: expiresAt, consumed: false, created_at: new Date().toISOString() };
  try {
    const { error } = await supabaseAdmin.from(TABLE_OTP).insert(payload);
    if (error) {
      if (isSupabaseTableMissing(error)) { memOtp.set(norm, { ...payload, id: `mem-${norm}` }); return true; }
      throw error;
    }
    return true;
  } catch (e) {
    if (isSupabaseTableMissing(e)) { memOtp.set(norm, { ...payload, id: `mem-${norm}` }); return true; }
    throw e;
  }
}

async function consumeOtp(otpRow) {
  if (otpRow._isMem || String(otpRow.id).startsWith('mem-')) {
    memOtp.delete(otpRow.normalized_phone);
    return;
  }
  try {
    await supabaseAdmin.from(TABLE_OTP).update({ consumed: true }).eq('id', otpRow.id);
    await supabaseAdmin.from(TABLE_OTP).delete().eq('normalized_phone', otpRow.normalized_phone).neq('id', otpRow.id);
  } catch (e) {
    if (!isSupabaseTableMissing(e)) throw e;
    memOtp.delete(otpRow.normalized_phone);
  }
}

async function decrementAttempts(otpRow) {
  if (otpRow._isMem) {
    const left = (otpRow.attempts_left || 3) - 1;
    if (left <= 0) memOtp.delete(otpRow.normalized_phone);
    else memOtp.set(otpRow.normalized_phone, { ...otpRow, attempts_left: left });
    return left;
  }
  try {
    const left = otpRow.attempts_left - 1;
    if (left <= 0) await supabaseAdmin.from(TABLE_OTP).delete().eq('id', otpRow.id);
    else await supabaseAdmin.from(TABLE_OTP).update({ attempts_left: left }).eq('id', otpRow.id);
    return left;
  } catch (e) {
    if (isSupabaseTableMissing(e)) {
      const left = (otpRow.attempts_left || 3) - 1;
      if (left <= 0) memOtp.delete(otpRow.normalized_phone);
      else memOtp.set(otpRow.normalized_phone, { ...otpRow, attempts_left: left });
      return left;
    }
    throw e;
  }
}

async function deleteOtp(otpRow) {
  if (otpRow._isMem || String(otpRow.id).startsWith('mem-')) {
    memOtp.delete(otpRow.normalized_phone);
    return;
  }
  try { await supabaseAdmin.from(TABLE_OTP).delete().eq('id', otpRow.id); } catch (e) { if (!isSupabaseTableMissing(e)) throw e; memOtp.delete(otpRow.normalized_phone); }
}

// ---------------------------------------------------------------------------
// POST /api/auth/request-otp
// ---------------------------------------------------------------------------
export async function requestOtp(req, res) {
  try {
    const { phone, phone_number, mobile } = req.body;
    const rawPhone = phone || phone_number || mobile;
    if (!rawPhone) return res.status(400).json({ success: false, error: 'phone is required' });
    const norm = normalizePhoneNumber(String(rawPhone));
    if (!/^\d{10}$/.test(norm)) return res.status(400).json({ success: false, error: 'phone must be 10-digit Indian number' });

    const allowed = await findAllowedUser(norm);
    if (!allowed) {
      return res.status(403).json({ success: false, error: 'This mobile number is not whitelisted. Please contact SkillParkho Support.' });
    }
    if (allowed._blocked) {
      if (allowed.reason === 'inactive') return res.status(403).json({ success: false, error: `Your number ${norm} is marked inactive. Contact Support.` });
      if (allowed.reason === 'not_approved') return res.status(403).json({ success: false, error: `Your number ${norm} is pending approval. Contact Support.` });
      return res.status(403).json({ success: false, error: 'Your account is not allowed.' });
    }
    if (allowed.is_active === false) {
      return res.status(403).json({ success: false, error: 'Your account is inactive. Please contact SkillParkho Support.' });
    }

    // Cooldown
    const recentOtp = await getRecentOtp(norm);
    if (recentOtp) {
      const elapsed = (Date.now() - new Date(recentOtp.created_at).getTime()) / 1000;
      if (elapsed < OTP_RESEND_SECONDS) {
        const remaining = Math.ceil(OTP_RESEND_SECONDS - elapsed);
        const masked = allowed.email ? maskEmail(allowed.email) : `+91 ****${norm.slice(-4)}`;
        return res.status(429).json({ success: false, error: `Please wait ${remaining}s before requesting a new OTP`, cooldownRemainingSeconds: remaining, maskedEmail: masked, maskedPhone: masked });
      }
      await deleteOtp(recentOtp);
    }

    // Validate that Sheet has an email for this student — Resend OTP requires it
    const studentEmail = (allowed.email || '').trim();
    const isPlaceholder = studentEmail.startsWith('noemail_') || studentEmail.includes('placeholder.test');
    const emailValid = studentEmail && studentEmail.includes('@') && studentEmail.includes('.') && !isPlaceholder;
    // If email missing/invalid and Resend is the primary, block with helpful message
    // (but allow WhatsApp fallback when Resend not configured and email missing — dev mode)
    const hasResend = !!(process.env.RESEND_API_KEY || process.env.RESEND_API_TOKEN);
    if (!emailValid && hasResend) {
      return res.status(400).json({
        success: false,
        error: 'No email found for this number in SkillParkho records (Google Sheet). Please contact SkillParkho Support to add your email in the Sheet.',
        maskedEmail: '',
        maskedPhone: `+91 ****${norm.slice(-4)}`,
      });
    }

    const otp = String(100000 + Math.floor(Math.random() * 900000));
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000).toISOString();

    await storeOtp(norm, studentEmail || '', otp, expiresAt);
    const sendResult = await sendOtpWithFallback(norm, otp, studentEmail, allowed.full_name || '');

    console.log(`OTP for ${norm} (${allowed.full_name || ''}, ${studentEmail || 'no-email'}) = ${otp} via ${sendResult.channel} provider=${sendResult.provider || sendResult.emailResult?.provider || 'unknown'}`);

    const isDev = process.env.NODE_ENV !== 'production' || (!process.env.RESEND_API_KEY && !process.env.RESEND_API_TOKEN);
    const maskedEmail = studentEmail ? maskEmail(studentEmail) : '';
    const maskedPhone = `+91 ****${norm.slice(-4)}`;

    let message = '';
    if (sendResult.channel === 'email') {
      message = `OTP sent to ${maskedEmail} via Email (Resend)`;
    } else message = `OTP generated for ${maskedPhone}. Check console (dev mode)`;

    res.json({
      success: true, message, channel: sendResult.channel,
      maskedEmail, maskedPhone, expiresAt,
      expiresInSeconds: OTP_EXPIRY_MIN * 60,
      resendAvailableInSeconds: OTP_RESEND_SECONDS,
      ...(isDev || sendResult.previewOtp || sendResult.fallbackLogged ? { previewOtp: otp, devMode: true } : {}),
      ...(sendResult.error ? { emailError: sendResult.error } : {}),
      ...(sendResult.emailError ? { emailError: sendResult.emailError } : {}),
      student: {
        id: allowed.id || `sheet-${norm}`,
        phone_number: allowed.phone_number || norm,
        normalized_phone_number: norm,
        email: allowed.email || '',
        full_name: allowed.full_name || 'Student',
        course: allowed.course || '',
        batch_name: allowed.batch_name || 'SkillParkho Student',
        is_active: true,
      }
    });
  } catch (err) {
    console.error('requestOtp', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/verify-otp
// ---------------------------------------------------------------------------
export async function verifyOtp(req, res) {
  try {
    const { phone, phone_number, mobile, otp, code } = req.body;
    const rawPhone = phone || phone_number || mobile;
    const rawOtp = otp || code;
    if (!rawPhone || !rawOtp) return res.status(400).json({ success: false, error: 'phone and otp are required' });
    const norm = normalizePhoneNumber(String(rawPhone));
    const cleanOtp = String(rawOtp).trim();
    if (!/^\d{6}$/.test(cleanOtp)) return res.status(400).json({ success: false, error: 'OTP must be 6 digits' });

    // Re-check whitelist at verify time
    const allowedAtVerify = await findAllowedUser(norm);
    if (!allowedAtVerify || allowedAtVerify._blocked || allowedAtVerify.is_active === false) {
      try { await deleteOtp(await getRecentOtp(norm)); } catch {}
      return res.status(403).json({ success: false, error: 'This mobile number is no longer whitelisted.' });
    }

    // Fetch latest OTP
    let otpRow = null;
    try {
      const { data, error } = await supabaseAdmin
        .from(TABLE_OTP)
        .select('*')
        .eq('normalized_phone', norm)
        .eq('consumed', false)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        if (isSupabaseTableMissing(error)) {
          const m = memOtp.get(norm);
          if (m && !m.consumed) otpRow = { ...m, id: `mem-${norm}`, _isMem: true };
        } else throw error;
      } else otpRow = data;
    } catch (e) {
      if (isSupabaseTableMissing(e)) {
        const m = memOtp.get(norm);
        if (m && !m.consumed) otpRow = { ...m, id: `mem-${norm}`, _isMem: true };
      } else throw e;
    }
    if (!otpRow) {
      const m = memOtp.get(norm);
      if (m && !m.consumed) otpRow = { ...m, id: `mem-${norm}`, _isMem: true };
    }
    if (!otpRow) return res.status(400).json({ success: false, error: 'No active OTP found. Please request a new OTP.' });

    const now = Date.now();
    if (now > new Date(otpRow.expires_at).getTime()) {
      await deleteOtp(otpRow);
      return res.status(400).json({ success: false, isExpired: true, error: 'OTP has expired.' });
    }
    if ((otpRow.attempts_left ?? 3) <= 0) {
      await deleteOtp(otpRow);
      return res.status(400).json({ success: false, error: 'Maximum attempts exceeded.' });
    }
    if (cleanOtp !== String(otpRow.otp_code)) {
      const left = await decrementAttempts(otpRow);
      if (left <= 0) return res.status(400).json({ success: false, attemptsLeft: 0, error: 'Incorrect OTP. Max attempts reached.' });
      return res.status(400).json({ success: false, attemptsLeft: left, error: `Incorrect OTP. ${left} attempt${left > 1 ? 's' : ''} remaining.` });
    }

    // Correct -> consume
    await consumeOtp(otpRow);
    const allowed = await findAllowedUser(norm);
    if (!allowed || allowed._blocked || allowed.is_active === false) return res.status(403).json({ success: false, error: 'User no longer authorized' });

    // Upsert to Supabase for persistence
    try {
      await supabaseAdmin.from(TABLE_ALLOWED_USERS).upsert({
        phone_number: allowed.phone_number || norm,
        normalized_phone_number: norm,
        email: allowed.email || '',
        full_name: allowed.full_name || 'Student',
        course: allowed.course || '',
        batch_name: allowed.batch_name || '',
        is_active: true,
        created_by: 'google_sheet_verified',
      }, { onConflict: 'normalized_phone_number' });
    } catch (e) { if (!isSupabaseTableMissing(e)) console.warn('verify upsert failed', e.message); }

    const payload = {
      id: allowed.id || `sheet-${norm}`,
      phone: norm,
      email: allowed.email || '',
      full_name: allowed.full_name || 'Student',
      course: allowed.course || '',
      batch_name: allowed.batch_name || 'SkillParkho Student',
      role: 'student',
    };
    // Long-lived student JWT; the app proactively refreshes it (see
    // /api/auth/refresh) so a user stays logged in until explicit logout or
    // their sheet access is removed.
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.STUDENT_JWT_EXPIRES_IN || '30d' });

    res.json({
      success: true, message: 'OTP verified successfully', token,
      student: {
        id: payload.id, auth_user_id: `auth-${payload.id}`,
        full_name: allowed.full_name || 'Student',
        mobile_number: allowed.phone_number || norm,
        normalized_mobile_number: norm,
        email: allowed.email || '',
        batch_name: allowed.batch_name || allowed.course || 'SkillParkho Student',
        course: allowed.course || '',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      maskedEmail: allowed.email ? maskEmail(allowed.email) : undefined,
      maskedPhone: `+91 ****${norm.slice(-4)}`,
    });
  } catch (err) {
    console.error('verifyOtp', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/auth/check-phone/:phone
// ---------------------------------------------------------------------------
export async function checkPhoneAllowed(req, res) {
  try {
    const { phone } = req.params;
    const norm = normalizePhoneNumber(phone);
    if (!/^\d{10}$/.test(norm)) return res.status(400).json({ success: false, error: 'Invalid phone, must be 10 digits' });
    const allowed = await findAllowedUser(norm);
    if (!allowed || allowed._blocked) return res.json({ success: true, isAllowed: false, is_active: false, source: 'sheet' });
    res.json({ success: true, isAllowed: true, is_active: allowed.is_active !== false, source: allowed.source || 'sheet', full_name: allowed.full_name, course: allowed.course });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
export async function appMe(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Missing token' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.role !== 'student') return res.status(403).json({ success: false, error: 'Not a student token' });
    const allowed = await findAllowedUser(decoded.phone);
    res.json({ success: true, user: decoded, allowedUser: allowed });
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/supabase-session (mints real Supabase Auth session for storage)
// ---------------------------------------------------------------------------
export async function supabaseSession(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Missing token' });
  let decoded;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.role !== 'student') return res.status(403).json({ success: false, error: 'Not a student token' });
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
  try {
    const norm = normalizePhoneNumber(String(decoded.phone || req.body?.phone || ''));
    if (!norm) return res.status(400).json({ success: false, error: 'Phone missing in token' });

    const allowed = await findAllowedUser(norm);
    if (!allowed || allowed._blocked || allowed.is_active === false) {
      return res.status(403).json({ success: false, error: 'User no longer authorized' });
    }

    const email = `${norm}@students.skillparkho.app`;
    const password = crypto.randomBytes(24).toString('hex');
    const meta = {
      full_name: allowed.full_name || 'Student',
      phone_number: allowed.phone_number || norm,
      normalized_phone_number: norm,
      student_ref: decoded.id,
      role: 'student',
    };

    let userId;
    try {
      userId = await ensureAuthUser(email, password, meta);
    } catch (e) {
      console.error('supabaseSession ensureAuthUser', e.message);
      return res.status(500).json({ success: false, error: 'Could not provision secure storage user' });
    }
    if (!userId) return res.status(500).json({ success: false, error: 'Secure storage user id missing' });

    const { data: sess, error: sessErr } = await supabaseAnon.auth.signInWithPassword({ email, password });
    if (sessErr || !sess?.session) {
      console.error('supabaseSession signIn', sessErr?.message);
      return res.status(500).json({ success: false, error: 'Could not create secure storage session' });
    }

    res.json({
      success: true, supabaseUserId: userId, email, password,
      expires_at: sess.session.expires_at,
    });
  } catch (err) {
    console.error('supabaseSession', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// Proactively re-issues a student JWT before it expires, and re-checks that
// the student is still whitelisted/active. A 403 (ACCESS_REMOVED) lets the app
// force a logout when access is revoked from the sheet; 401 means the token is
// invalid/expired and the user must re-login. This keeps a user logged in until
// they explicitly log out or their sheet access is removed.
// ---------------------------------------------------------------------------
export async function refreshStudentToken(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, code: 'NO_TOKEN', error: 'Missing token' });
  }
  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, code: 'TOKEN_INVALID', error: 'Token expired or invalid' });
  }
  if (decoded.role !== 'student') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Not a student token' });
  }
  try {
    const allowed = await findAllowedUser(decoded.phone);
    if (!allowed || allowed._blocked || allowed.is_active === false) {
      return res.status(403).json({ success: false, code: 'ACCESS_REMOVED', error: 'Access removed' });
    }
    const payload = {
      id: allowed.id || decoded.id,
      phone: decoded.phone,
      email: allowed.email || decoded.email || '',
      full_name: allowed.full_name || decoded.full_name || 'Student',
      course: allowed.course || decoded.course || '',
      batch_name: allowed.batch_name || decoded.batch_name || 'SkillParkho Student',
      role: 'student',
    };
    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.STUDENT_JWT_EXPIRES_IN || '30d' });
    return res.json({ success: true, token: newToken });
  } catch (err) {
    console.error('refreshStudentToken', err);
    return res.status(500).json({ success: false, code: 'SERVER_ERROR', error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/sheet/status (debug)
// ---------------------------------------------------------------------------
export async function sheetStatus(req, res) {
  try {
    const rows = await getSheetRows();
    res.json({
      success: true,
      stats: {
        sheetId: process.env.GOOGLE_SHEET_ID || '1djvPugtfUfC6ELT_OSxWcwqi9ofJ1Tj-4YilpB4Cogk',
        total: rows.length,
        sample: rows.slice(0, 3).map(r => ({ phone: r.phone_number, norm: r.normalized_phone_number, name: r.full_name, course: r.course, batch: r.batch_name, active: r.is_active, approved: r.approved_status })),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
