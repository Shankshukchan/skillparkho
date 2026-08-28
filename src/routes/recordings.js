import express from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
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
  downloadRecording,
  downloadVideo,
} from '../controllers/recordingsController.js';

const router = express.Router();

// All routes require student JWT
router.use(authenticateStudent);

// ---------------------------------------------------------------------------
// Streaming-aware upload middleware
// ---------------------------------------------------------------------------
// We deliberately DO NOT use multer.memoryStorage() because buffering a 150MB /
// 700MB file (and then buffering it again in the Supabase SDK) would blow past
// the 512MB RAM budget on the backend and crash it under concurrent traffic.
// Instead we write the incoming multipart stream straight to a temp file on
// disk (chunk by chunk), then the controller streams that file to Supabase
// Storage. RAM stays roughly constant regardless of file size.
const uploadTmpDir = process.env.UPLOAD_TMP_DIR
  ? path.resolve(process.env.UPLOAD_TMP_DIR)
  : path.join(os.tmpdir(), 'skillparkho-uploads');
fs.mkdirSync(uploadTmpDir, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadTmpDir),
  filename: (req, file, cb) => {
    const safeBase = String(file.originalname || 'upload').replace(/[^A-Za-z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${randomUUID()}-${safeBase}`);
  },
});

// 700MB upper bound (video is the larger of the two limits).
const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 700 * 1024 * 1024 },
});

// Recordings (call recordings) - chunked streaming
router.post('/recordings/upload', upload.single('file'), uploadRecording);
router.get('/recordings/playback/:callLogId', getRecordingPlaybackUrl);
router.get('/recordings/stream/:callLogId', streamRecording);
router.get('/recordings/download/:callLogId', downloadRecording);
router.get('/recordings', listRecordings);
router.post('/storage/signed-url', createSignedUrlGeneric);

// Interview videos - chunked streaming
router.post('/videos/upload', upload.single('file'), uploadInterviewVideo);
router.get('/videos', listInterviewVideos);
router.delete('/videos/:id', deleteInterviewVideo);
router.get('/videos/playback/:id', getVideoPlaybackUrl);
router.get('/videos/stream/:id', streamVideo);
router.get('/videos/download/:id', downloadVideo);

export default router;
