import express from 'express';
import { upsertHrContact, listHrContacts, upsertCallLog, listCallLogs, syncAll, deleteHrContact, deleteCallLog, listUnknownCalls, upsertUnknownCall, authenticateStudent, recordAppOpened } from '../controllers/studentDataController.js';

const router = express.Router();

// All routes require student JWT
router.use(authenticateStudent);

router.post('/hr-contacts', upsertHrContact);
router.get('/hr-contacts', listHrContacts);
router.delete('/hr-contacts/:id', deleteHrContact);
router.post('/call-logs', upsertCallLog);
router.get('/call-logs', listCallLogs);
router.delete('/call-logs/:id', deleteCallLog);
router.get('/unknown-calls', listUnknownCalls);
router.post('/unknown-calls', upsertUnknownCall);
router.post('/sync', syncAll);

// Track when the student last opened the app (DB keeps last_opened_at)
router.post('/activity/opened', recordAppOpened);

export default router;
