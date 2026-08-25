import express from 'express';
import { login, me, verifyToken } from '../controllers/authController.js';
import { authenticateAdmin } from '../middleware/auth.js';

const router = express.Router();

router.post('/admin/login', login);
router.get('/admin/me', authenticateAdmin, me);
router.get('/admin/verify', authenticateAdmin, verifyToken);

export default router;
