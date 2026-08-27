import express from 'express';
import multer from 'multer';
import { authenticateStudent } from '../controllers/studentDataController.js';
import {
  uploadRecording,
  getRecordingPlaybackUrl,
  listRecordings,
  createSignedUrlGeneric,
  uploadInterviewVideo,
  listInterviewVideos,
  deleteInterviewVideo,
  getVideoPlaybackUrl,
  streamRecording,
  streamVideo,
} from '../controllers/recordingsController.js';

const router = express.Router();

// All routes require student JWT
router.use(authenticateStudent);

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 700 * 1024 * 1024 },
});

// Recordings (call recordings) - chunked streaming
router.post('/recordings/upload', memUpload.single('file'), uploadRecording);
router.get('/recordings/playback/:callLogId', getRecordingPlaybackUrl);
router.get('/recordings/stream/:callLogId', streamRecording);
router.get('/recordings', listRecordings);
router.post('/storage/signed-url', createSignedUrlGeneric);

// Interview videos - chunked streaming
router.post('/videos/upload', memUpload.single('file'), uploadInterviewVideo);
router.get('/videos', listInterviewVideos);
router.delete('/videos/:id', deleteInterviewVideo);
router.get('/videos/playback/:id', getVideoPlaybackUrl);
router.get('/videos/stream/:id', streamVideo);

export default router;
