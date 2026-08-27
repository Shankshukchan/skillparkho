import express from 'express';
import { requestOtp, verifyOtp, checkPhoneAllowed, appMe, sheetStatus, supabaseSession, refreshStudentToken } from '../controllers/appAuthController.js';

const router = express.Router();

// Public - no admin auth
router.post('/auth/request-otp', requestOtp);
router.post('/auth/verify-otp', verifyOtp);
router.get('/auth/check-phone/:phone', checkPhoneAllowed);
router.get('/auth/me', appMe);
// Student-JWT protected: mints a real Supabase Auth session (storage access)
router.post('/auth/supabase-session', supabaseSession);
// Student-JWT protected: proactively re-issues the JWT before expiry, also
// re-checks whitelist so the app can force logout when sheet access is removed.
router.post('/auth/refresh', refreshStudentToken);

// Also alias under /public for flutter convenience
router.post('/public/auth/request-otp', requestOtp);
router.post('/public/auth/verify-otp', verifyOtp);
router.get('/sheet/status', sheetStatus);
router.get('/public/sheet/status', sheetStatus);

export default router;
