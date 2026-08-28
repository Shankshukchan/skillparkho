import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, pipeline } from 'node:stream';
import { randomUUID } from 'crypto';
import {
  supabaseAdmin,
  TABLE_CALL_LOGS,
  TABLE_CALL_NOTES,
  TABLE_STUDENT_HR,
  TABLE_CALL_RECORDINGS,
  TABLE_INTERVIEW_VIDEOS,
} from '../config/supabase.js';

const RECORDING_BUCKET = 'student-call-recordings';
const VIDEO_BUCKET = 'student-interview-videos';

// Supabase buckets have a `file_size_limit`. If it is lower than our app limits
// the resumable upload is rejected with 413 "Maximum size exceeded". We raise
// the bucket limits at startup so large audio/video uploads are permitted.
// App-level enforcement still caps audio at 150MB and video at 700MB, so we
// give a little headroom here to avoid off-by-a-few-bytes rejections.
export async function ensureStorageBucketLimits() {
  const targets = [
    [VIDEO_BUCKET, 800 * 1024 * 1024],     // 800MB headroom over the 700MB app cap
    [RECORDING_BUCKET, 200 * 1024 * 1024], // 200MB headroom over the 150MB app cap
  ];
  for (const [bucket, size] of targets) {
    try {
      const { error } = await supabaseAdmin.storage.updateBucket(bucket, { fileSizeLimit: size });
      if (error) {
        console.warn(`[storage] could not raise file_size_limit for bucket "${bucket}": ${error.message}`);
      } else {
        console.log(`[storage] bucket "${bucket}" file_size_limit set to ${size} bytes`);
      }
    } catch (e) {
      console.warn(`[storage] ensureStorageBucketLimits failed for "${bucket}": ${e.message}`);
    }
  }
}

function sanitizeFilename(name) {
  if (!name) return `recording_${Date.now()}.m4a`;
  const clean = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return clean || `recording_${Date.now()}.m4a`;
}

async function safeUnlink(p) {
  if (!p) return;
  try { await unlink(p); } catch {}
}

// Standard (non-resumable) Supabase upload caps a single object at 50MB. Large
// audio/video must go through the TUS resumable endpoint, which is not exposed
// by this version of @supabase/storage-js. We implement it manually here,
// streaming the temp file from disk in fixed chunks so RAM stays flat.
function b64(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

async function resumableUploadToStorage(bucket, storagePath, filePath, mimeType, fileSize) {
  // Use the storage client's authenticated fetch (it injects apikey + Authorization),
  // not the global fetch — global headers carry no credentials.
  const authedFetch = supabaseAdmin.storage.fetch;

  // Supabase's TUS endpoint performs best against the direct storage hostname.
  const base = new URL(supabaseAdmin.storage.url); // https://<project>/storage/v1
  if (base.hostname.endsWith('.supabase.co')) {
    const projectId = base.hostname.split('.')[0];
    base.hostname = `${projectId}.storage.supabase.co`;
  }
  const createUrl = `${base.origin}/storage/v1/upload/resumable`;

  // TUS Upload-Metadata: Supabase expects these exact key names.
  const uploadMetadata = [
    `bucketName ${b64(bucket)}`,
    `objectName ${b64(storagePath)}`,
    `contentType ${b64(mimeType || 'application/octet-stream')}`,
    `cacheControl ${b64('3600')}`,
  ].join(',');

  const createRes = await authedFetch(createUrl, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(fileSize),
      'Upload-Metadata': uploadMetadata,
      'x-upsert': 'false',
    },
  });
  if (createRes.status !== 201) {
    const body = await createRes.text().catch(() => '');
    throw new Error(`Resumable session create failed (${createRes.status}): ${body}`);
  }
  let location = createRes.headers.get('location');
  if (!location) throw new Error('Resumable upload response missing Location header');
  if (!/^https?:\/\//i.test(location)) location = new URL(location, base).toString();

  // Supabase requires 6MB chunks (do not change). Each chunk is streamed from
  // disk, so RAM stays bounded regardless of total file size.
  const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB
  let offset = 0;
  while (offset < fileSize) {
    const end = Math.min(offset + CHUNK_SIZE, fileSize) - 1;
    const chunkLen = end - offset + 1;
    const nodeStream = createReadStream(filePath, { start: offset, end });
    const webStream = Readable.toWeb(nodeStream);
    const patchRes = await authedFetch(location, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
        'Content-Length': String(chunkLen),
      },
      body: webStream,
      duplex: 'half',
    });
    if (patchRes.status !== 204) {
      const body = await patchRes.text().catch(() => '');
      throw new Error(`Resumable chunk upload failed at offset ${offset} (${patchRes.status}): ${body}`);
    }
    const reported = parseInt(patchRes.headers.get('upload-offset') || '', 10);
    offset = Number.isFinite(reported) && reported > offset ? reported : end + 1;
  }
  if (offset !== fileSize) {
    throw new Error(`Resumable upload incomplete: server received ${offset}/${fileSize} bytes`);
  }
  return { data: { path: storagePath }, error: null };
}

// Upload a temp file to Supabase Storage as a stream. Uses the TUS resumable
// endpoint (no 50MB cap, RAM-bounded). Falls back to the standard streaming
// upload only for small files / environments where resumable is unavailable.
async function streamUploadToStorage(bucket, storagePath, filePath, mimeType, fileSize) {
  try {
    return await resumableUploadToStorage(bucket, storagePath, filePath, mimeType, fileSize);
  } catch (e) {
    if (fileSize > 50 * 1024 * 1024) throw e; // standard endpoint caps at 50MB
    console.warn('resumable upload failed, falling back to standard stream upload:', e.message);
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream);
    return supabaseAdmin.storage.from(bucket).upload(storagePath, webStream, {
      contentType: mimeType,
      upsert: false,
      headers: { 'Content-Length': String(fileSize) },
    });
  }
}

// ---------------------------------------------------------------------------
// POST /api/app/recordings/upload
// ---------------------------------------------------------------------------
export async function uploadRecording(req, res) {
  try {
    const studentId = req.student.id;
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'Audio file is required (field: file)' });

    const callLogId = (req.body.call_log_id || req.body.callLogId || '').toString().trim();
    if (!callLogId) return res.status(400).json({ success: false, error: 'call_log_id is required' });

    const originalFilename = (req.body.original_filename || req.body.originalFilename || file.originalname || 'recording.m4a').toString();
    const mimeType = (req.body.mime_type || req.body.mimeType || file.mimetype || 'audio/mpeg').toString();
    const fileSizeBytes = parseInt(req.body.file_size_bytes || req.body.fileSizeBytes || file.size, 10);

    // Validate call belongs to student and is eligible (>20s + saved HR)
    const { data: callLog } = await supabaseAdmin
      .from(TABLE_CALL_LOGS)
      .select('id,student_id,hr_contact_id,normalized_phone_number,duration_seconds,recording_uploaded')
      .eq('id', callLogId)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!callLog) return res.status(404).json({ success: false, error: 'Call log not found or access denied' });
    if (callLog.recording_uploaded) return res.status(409).json({ success: false, error: 'This call already has a recording. Uploaded recordings cannot be changed.' });
    if (callLog.duration_seconds <= 20) return res.status(400).json({ success: false, error: 'Audio uploads are only allowed for saved HR calls longer than 20 seconds.' });

    // Ensure HR contact exists
    let hasHr = !!callLog.hr_contact_id;
    if (!hasHr && callLog.normalized_phone_number) {
      const { data: hr } = await supabaseAdmin
        .from(TABLE_STUDENT_HR)
        .select('id')
        .eq('student_id', studentId)
        .eq('normalized_phone_number', callLog.normalized_phone_number)
        .maybeSingle();
      if (hr) hasHr = true;
    }
    if (!hasHr) return res.status(400).json({ success: false, error: 'Cannot upload recording for unknown number. Save HR details first.' });

    // Check existing recording
    const { data: existingRec } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS)
      .select('id')
      .eq('call_log_id', callLogId)
      .maybeSingle();
    if (existingRec) return res.status(409).json({ success: false, error: 'This call already has a recording. Uploaded recordings cannot be changed.' });

    if (file.size > 150 * 1024 * 1024) return res.status(400).json({ success: false, error: 'File too large (max 150MB)' });
    const allowedExt = ['.aac', '.m4a', '.mp3', '.wav', '.amr', '.3gp', '.3gpp', '.mp4', '.mpeg'];
    const lower = originalFilename.toLowerCase();
    const extOk = allowedExt.some(e => lower.endsWith(e)) || mimeType.startsWith('audio/') || mimeType.startsWith('video/');
    if (!extOk) return res.status(400).json({ success: false, error: 'Invalid audio file type' });

    const safeName = sanitizeFilename(originalFilename);
    const storagePath = `${studentId}/${callLogId}/${safeName}`;

    // Upload to storage by streaming the temp file (keeps RAM flat).
    const { error: uploadErr } = await streamUploadToStorage(RECORDING_BUCKET, storagePath, file.path, mimeType || 'audio/mpeg', file.size);
    await safeUnlink(file.path);
    if (uploadErr) {
      if (uploadErr.message?.includes('Duplicate') || uploadErr.code === '23505') {
        return res.status(409).json({ success: false, error: 'This call already has a recording. Uploaded recordings cannot be changed.' });
      }
      return res.status(500).json({ success: false, error: 'Storage upload failed: ' + uploadErr.message });
    }

    const now = new Date().toISOString();
    const recId = randomUUID();
    const payload = {
      id: recId, student_id: studentId, call_log_id: callLogId,
      storage_path: storagePath, original_filename: originalFilename,
      mime_type: mimeType, file_size_bytes: fileSizeBytes || file.size,
      uploaded_at: now, created_at: now,
    };

    const { data: recData, error: recErr } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS)
      .insert(payload)
      .select()
      .maybeSingle();
    if (recErr) {
      try { await supabaseAdmin.storage.from(RECORDING_BUCKET).remove([storagePath]); } catch {}
      if (recErr.code === '23505') {
        return res.status(409).json({ success: false, error: 'This call already has a recording.' });
      }
      return res.status(500).json({ success: false, error: 'Failed to save recording metadata: ' + recErr.message });
    }

    // Mark call log as uploaded + clear reminder on notes
    try {
      await Promise.all([
        supabaseAdmin
          .from(TABLE_CALL_LOGS)
          .update({ recording_uploaded: true, updated_at: now })
          .eq('id', callLogId)
          .eq('student_id', studentId),
        supabaseAdmin
          .from(TABLE_CALL_NOTES)
          .update({ reminder_status: 'completed', pending_reason: null, updated_at: now })
          .eq('call_log_id', callLogId),
      ]);
    } catch {}

    return res.json({ success: true, data: recData || payload, storagePath });
  } catch (e) {
    console.error('uploadRecording error', e);
    await safeUnlink(req.file?.path);
    return res.status(500).json({ success: false, error: e.message || 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/recordings/playback/:callLogId
// ---------------------------------------------------------------------------
export async function getRecordingPlaybackUrl(req, res) {
  try {
    const studentId = req.student.id;
    const callLogId = req.params.callLogId || req.params.id;
    if (!callLogId) return res.status(400).json({ success: false, error: 'callLogId required' });
    const ttl = parseInt(req.query.ttl || '3600', 10);

    const { data: rec } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS)
      .select('storage_path,call_log_id,student_id')
      .eq('call_log_id', callLogId)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!rec) return res.status(404).json({ success: false, error: 'Recording not found' });

    const { data, error } = await supabaseAdmin.storage.from(RECORDING_BUCKET).createSignedUrl(rec.storage_path, ttl);
    if (error) return res.status(500).json({ success: false, error: 'Failed to create playback URL: ' + error.message });
    return res.json({ success: true, url: data.signedUrl, storagePath: rec.storage_path });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/recordings?student_id=
// ---------------------------------------------------------------------------
export async function listRecordings(req, res) {
  try {
    const studentId = req.student.id;
    const { data, error } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS)
      .select('*')
      .eq('student_id', studentId)
      .order('uploaded_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/app/storage/signed-url (generic, ownership-verified)
// ---------------------------------------------------------------------------
export async function createSignedUrlGeneric(req, res) {
  try {
    const { storagePath, bucket, ttl } = req.body;
    if (!storagePath) return res.status(400).json({ success: false, error: 'storagePath required' });
    const b = bucket || RECORDING_BUCKET;
    const t = parseInt(ttl || '3600', 10);
    const studentId = req.student.id;

    // Verify ownership via DB
    let owned = false;
    const { data: rec } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS)
      .select('id')
      .eq('student_id', studentId)
      .eq('storage_path', storagePath)
      .maybeSingle();
    if (rec) owned = true;

    if (!owned) {
      const { data: vid } = await supabaseAdmin
        .from(TABLE_INTERVIEW_VIDEOS)
        .select('id')
        .eq('student_id', studentId)
        .eq('storage_path', storagePath)
        .maybeSingle();
      if (vid) owned = true;
    }

    // Fallback: path starts with studentId
    if (!owned && storagePath.startsWith(studentId + '/')) owned = true;

    if (!owned) {
      return res.status(403).json({ success: false, error: 'Access denied to this storage path.' });
    }
    const { data, error } = await supabaseAdmin.storage.from(b).createSignedUrl(storagePath, t);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, url: data.signedUrl });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/app/videos/upload
// ---------------------------------------------------------------------------
export async function uploadInterviewVideo(req, res) {
  try {
    const studentId = req.student.id;
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'Video file is required' });
    const stageName = (req.body.stage_name || req.body.stageName || '').toString().trim();
    if (!stageName) return res.status(400).json({ success: false, error: 'stage_name is required' });
    const originalFilename = (req.body.original_filename || req.body.originalFilename || file.originalname || 'video.mp4').toString();
    const mimeType = (req.body.mime_type || req.body.mimeType || file.mimetype || 'video/mp4').toString();

    if (file.size > 700 * 1024 * 1024) return res.status(400).json({ success: false, error: 'File too large (max 700MB)' });
    const allowedVideoExt = ['.mp4', '.mov', '.webm', '.3gp', '.mkv', '.avi', '.quicktime'];
    const lower = originalFilename.toLowerCase();
    const extOk = allowedVideoExt.some(e => lower.endsWith(e)) || mimeType.startsWith('video/');
    if (!extOk) return res.status(400).json({ success: false, error: 'Invalid video file type' });

    const safeName = sanitizeFilename(originalFilename);
    const storagePath = `${studentId}/videos/${Date.now()}_${safeName}`;

    const { error: uploadErr } = await streamUploadToStorage(VIDEO_BUCKET, storagePath, file.path, mimeType || 'video/mp4', file.size);
    await safeUnlink(file.path);
    if (uploadErr) return res.status(500).json({ success: false, error: 'Video upload failed: ' + uploadErr.message });

    const now = new Date().toISOString();
    const id = randomUUID();
    const payload = {
      id, student_id: studentId, stage_name: stageName,
      storage_path: storagePath, original_filename: originalFilename,
      mime_type: mimeType, file_size_bytes: file.size,
      uploaded_at: now, created_at: now,
    };
    const { data, error } = await supabaseAdmin
      .from(TABLE_INTERVIEW_VIDEOS)
      .insert(payload)
      .select()
      .maybeSingle();
    if (error) {
      try { await supabaseAdmin.storage.from(VIDEO_BUCKET).remove([storagePath]); } catch {}
      return res.status(500).json({ success: false, error: 'Failed to save video metadata: ' + error.message });
    }
    return res.json({ success: true, data });
  } catch (e) {
    console.error('uploadInterviewVideo error', e);
    await safeUnlink(req.file?.path);
    return res.status(500).json({ success: false, error: e.message || 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/videos
// ---------------------------------------------------------------------------
export async function listInterviewVideos(req, res) {
  try {
    const studentId = req.student.id;
    const { data, error } = await supabaseAdmin
      .from(TABLE_INTERVIEW_VIDEOS)
      .select('*')
      .eq('student_id', studentId)
      .order('uploaded_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/app/videos/:id
// ---------------------------------------------------------------------------
export async function deleteInterviewVideo(req, res) {
  try {
    const studentId = req.student.id;
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const { data: video } = await supabaseAdmin
      .from(TABLE_INTERVIEW_VIDEOS)
      .select('storage_path,student_id')
      .eq('id', id)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!video) return res.status(404).json({ success: false, error: 'Video not found' });
    try { await supabaseAdmin.storage.from(VIDEO_BUCKET).remove([video.storage_path]); } catch {}
    const { error } = await supabaseAdmin.from(TABLE_INTERVIEW_VIDEOS).delete().eq('id', id).eq('student_id', studentId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, deleted: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/videos/playback/:id
// ---------------------------------------------------------------------------
export async function getVideoPlaybackUrl(req, res) {
  try {
    const studentId = req.student.id;
    const id = req.params.id;
    const ttl = parseInt(req.query.ttl || '3600', 10);
    const { data: video } = await supabaseAdmin
      .from(TABLE_INTERVIEW_VIDEOS)
      .select('storage_path,student_id')
      .eq('id', id)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!video) return res.status(404).json({ success: false, error: 'Video not found' });
    const { data, error } = await supabaseAdmin.storage.from(VIDEO_BUCKET).createSignedUrl(video.storage_path, ttl);
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, url: data.signedUrl, storagePath: video.storage_path });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Shared streaming helper (Range-aware, chunk-by-chunk, backpressured)
// ---------------------------------------------------------------------------
// Streams a Supabase Storage object to the response without buffering it in RAM.
// - Honors HTTP Range requests so audio/video players can seek.
// - Uses stream.pipeline() which applies backpressure automatically, so memory
//   usage stays flat regardless of file size (150MB audio / 700MB video).
// - Aborts the upstream fetch when the client disconnects.
async function pipeStorageToResponse(req, res, signedUrl, meta, { disposition } = {}) {
  try {
    const range = req.headers.range;
    const headers = {};
    if (range) headers['Range'] = range;

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const fetchRes = await fetch(signedUrl, { headers, signal: controller.signal });
    if (!fetchRes.ok && fetchRes.status !== 206) {
      return res.status(fetchRes.status).json({ success: false, error: 'Storage fetch failed' });
    }

    res.status(fetchRes.status);
    res.setHeader('Content-Type', meta.mimeType || fetchRes.headers.get('content-type') || 'application/octet-stream');
    const cl = fetchRes.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    const cr = fetchRes.headers.get('content-range');
    if (cr) res.setHeader('Content-Range', cr);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (disposition) {
      const fname = meta.filename ? `; filename="${meta.filename.replace(/["\r\n]/g, '_')}"` : '';
      res.setHeader('Content-Disposition', `${disposition}${fname}`);
    } else if (fetchRes.headers.get('content-disposition')) {
      res.setHeader('Content-Disposition', fetchRes.headers.get('content-disposition'));
    }

    if (!fetchRes.body) {
      const buf = await fetchRes.arrayBuffer();
      return res.end(Buffer.from(buf));
    }

    const nodeStream = Readable.fromWeb(fetchRes.body);
    nodeStream.on('error', () => controller.abort());
    await pipeline(nodeStream, res);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!res.headersSent) res.end();
      return;
    }
    if (!res.headersSent) return res.status(500).json({ success: false, error: e.message || 'Stream failed' });
    res.end();
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/recordings/stream/:callLogId (chunked proxy with Range)
// ---------------------------------------------------------------------------
export async function streamRecording(req, res) {
  try {
    const studentId = req.student.id;
    const callLogId = req.params.callLogId || req.params.id;
    if (!callLogId) return res.status(400).json({ success: false, error: 'callLogId required' });

    const { data: rec } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS)
      .select('storage_path,mime_type,original_filename,file_size_bytes')
      .eq('call_log_id', callLogId)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!rec) return res.status(404).json({ success: false, error: 'Recording not found' });

    const { data: signed, error } = await supabaseAdmin.storage.from(RECORDING_BUCKET).createSignedUrl(rec.storage_path, 3600);
    if (error || !signed?.signedUrl) return res.status(500).json({ success: false, error: 'Failed to create stream URL' });

    await pipeStorageToResponse(req, res, signed.signedUrl, {
      mimeType: rec.mime_type || 'audio/mpeg',
      filename: rec.original_filename,
    }, {});
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ success: false, error: e.message });
    res.end();
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/recordings/download/:callLogId (buffered download stream)
// ---------------------------------------------------------------------------
export async function downloadRecording(req, res) {
  try {
    const studentId = req.student.id;
    const callLogId = req.params.callLogId || req.params.id;
    if (!callLogId) return res.status(400).json({ success: false, error: 'callLogId required' });

    const { data: rec } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS)
      .select('storage_path,mime_type,original_filename,file_size_bytes')
      .eq('call_log_id', callLogId)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!rec) return res.status(404).json({ success: false, error: 'Recording not found' });

    const { data: signed, error } = await supabaseAdmin.storage.from(RECORDING_BUCKET).createSignedUrl(rec.storage_path, 3600);
    if (error || !signed?.signedUrl) return res.status(500).json({ success: false, error: 'Failed to create download URL' });

    await pipeStorageToResponse(req, res, signed.signedUrl, {
      mimeType: rec.mime_type || 'audio/mpeg',
      filename: rec.original_filename,
    }, { disposition: 'attachment' });
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ success: false, error: e.message });
    res.end();
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/videos/stream/:id (chunked proxy with Range)
// ---------------------------------------------------------------------------
export async function streamVideo(req, res) {
  try {
    const studentId = req.student.id;
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });

    const { data: video } = await supabaseAdmin
      .from(TABLE_INTERVIEW_VIDEOS)
      .select('storage_path,mime_type,original_filename,file_size_bytes')
      .eq('id', id)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!video) return res.status(404).json({ success: false, error: 'Video not found' });

    const { data: signed, error } = await supabaseAdmin.storage.from(VIDEO_BUCKET).createSignedUrl(video.storage_path, 3600);
    if (error || !signed?.signedUrl) return res.status(500).json({ success: false, error: 'Failed to create stream URL' });

    await pipeStorageToResponse(req, res, signed.signedUrl, {
      mimeType: video.mime_type || 'video/mp4',
      filename: video.original_filename,
    }, {});
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ success: false, error: e.message });
    res.end();
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/videos/download/:id (buffered download stream)
// ---------------------------------------------------------------------------
export async function downloadVideo(req, res) {
  try {
    const studentId = req.student.id;
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });

    const { data: video } = await supabaseAdmin
      .from(TABLE_INTERVIEW_VIDEOS)
      .select('storage_path,mime_type,original_filename,file_size_bytes')
      .eq('id', id)
      .eq('student_id', studentId)
      .maybeSingle();
    if (!video) return res.status(404).json({ success: false, error: 'Video not found' });

    const { data: signed, error } = await supabaseAdmin.storage.from(VIDEO_BUCKET).createSignedUrl(video.storage_path, 3600);
    if (error || !signed?.signedUrl) return res.status(500).json({ success: false, error: 'Failed to create download URL' });

    await pipeStorageToResponse(req, res, signed.signedUrl, {
      mimeType: video.mime_type || 'video/mp4',
      filename: video.original_filename,
    }, { disposition: 'attachment' });
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ success: false, error: e.message });
    res.end();
  }
}
