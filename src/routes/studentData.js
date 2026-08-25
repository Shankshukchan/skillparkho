import express from 'express';
import { upsertHrContact, listHrContacts, upsertCallLog, listCallLogs, syncAll, deleteHrContact, deleteCallLog, authenticateStudent } from '../controllers/studentDataController.js';

const router = express.Router();

// All routes require student JWT
router.use(authenticateStudent);

router.post('/hr-contacts', upsertHrContact);
router.get('/hr-contacts', listHrContacts);
router.delete('/hr-contacts/:id', deleteHrContact);
router.post('/call-logs', upsertCallLog);
router.get('/call-logs', listCallLogs);
router.delete('/call-logs/:id', deleteCallLog);
router.post('/sync', syncAll);

export default router;
