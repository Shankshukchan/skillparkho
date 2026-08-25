import express from 'express';
import multer from 'multer';
import {
  listAllowedUsers,
  getAllowedUser,
  createAllowedUser,
  updateAllowedUser,
  deleteAllowedUser,
  bulkCreateAllowedUsers,
  importAllowedUsersFile,
  exportAllowedUsersCsv,
  getAllowedUsersStats
} from '../controllers/allowedUsersController.js';
import { authenticateAdmin } from '../middleware/auth.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    if (['csv', 'xlsx', 'xls', 'json'].includes(ext)) cb(null, true);
    else cb(new Error('Invalid file type. Use csv, xlsx, xls, json'));
  }
});

// Admin protected
router.get('/allowed-users/stats/summary', authenticateAdmin, getAllowedUsersStats);
router.get('/allowed-users/export/csv', authenticateAdmin, exportAllowedUsersCsv);
router.get('/allowed-users', authenticateAdmin, listAllowedUsers);
router.get('/allowed-users/:id', authenticateAdmin, getAllowedUser);
router.post('/allowed-users', authenticateAdmin, createAllowedUser);
router.put('/allowed-users/:id', authenticateAdmin, updateAllowedUser);
router.delete('/allowed-users/:id', authenticateAdmin, deleteAllowedUser);
router.post('/allowed-users/bulk', authenticateAdmin, bulkCreateAllowedUsers);
router.post('/allowed-users/import', authenticateAdmin, upload.single('file'), importAllowedUsersFile);

export default router;
