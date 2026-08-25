import express from 'express';
import multer from 'multer';
import {
  listVerifiedContacts,
  getVerifiedContact,
  createVerifiedContact,
  updateVerifiedContact,
  deleteVerifiedContact,
  bulkCreateVerifiedContacts,
  importFile,
  exportCsv,
  publicListVerifiedContacts,
  checkPhoneVerified,
  getStats
} from '../controllers/verifiedContactsController.js';
import { authenticateAdmin } from '../middleware/auth.js';

const router = express.Router();

// Multer for file imports (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/json', 'text/plain'];
    // also allow by extension
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (['csv', 'xlsx', 'xls', 'json'].includes(ext) || allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Use csv, xlsx, xls, json'));
    }
  }
});

// --- Public routes (for Flutter app) ---
router.get('/public/verified-contacts', publicListVerifiedContacts);
router.get('/public/verified-contacts/check/:phone', checkPhoneVerified);

// --- Protected admin routes ---
router.get('/verified-contacts/stats/summary', authenticateAdmin, getStats);
router.get('/verified-contacts/export/csv', authenticateAdmin, exportCsv);
router.get('/verified-contacts', authenticateAdmin, listVerifiedContacts);
router.get('/verified-contacts/:id', authenticateAdmin, getVerifiedContact);
router.post('/verified-contacts', authenticateAdmin, createVerifiedContact);
router.put('/verified-contacts/:id', authenticateAdmin, updateVerifiedContact);
router.delete('/verified-contacts/:id', authenticateAdmin, deleteVerifiedContact);
router.post('/verified-contacts/bulk', authenticateAdmin, bulkCreateVerifiedContacts);
router.post('/verified-contacts/import', authenticateAdmin, upload.single('file'), importFile);

export default router;
