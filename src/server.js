import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import multer from 'multer';
import { testConnection } from './config/supabase.js';
import verifiedRoutes from './routes/verifiedContacts.js';
import authRoutes from './routes/auth.js';
import allowedUsersRoutes from './routes/allowedUsers.js';
import appAuthRoutes from './routes/appAuth.js';
import studentDataRoutes from './routes/studentData.js';
import recordingsRoutes from './routes/recordings.js';

dotenv.config();

const app = express();
// Trust proxy: required for correct IP via X-Forwarded-For on Render/Railway.
// TRUST_PROXY=0 local, 1 single proxy (Render/Railway default), 2 double proxy.
// Host-agnostic: change via env when migrating without code change.
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxy = trustProxyEnv !== undefined && trustProxyEnv !== ''
  ? (isNaN(Number(trustProxyEnv)) ? trustProxyEnv : Number(trustProxyEnv))
  : (process.env.NODE_ENV === 'production' ? 1 : 0);
app.set('trust proxy', trustProxy);
const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// 1. Core middleware
// ---------------------------------------------------------------------------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({ threshold: 1024 }));  // gzip responses > 1KB
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// 2. CORS
// ---------------------------------------------------------------------------
const corsOrigin = process.env.CORS_ORIGIN || '*';
const allowedOrigins = corsOrigin.split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, true); // dev: allow all; tighten in prod via env
  },
  credentials: true,
}));

// ---------------------------------------------------------------------------
// 3. Global rate limiter (per IP, sliding window)
//    For 1000+ users: 2000 req/window with generous window.
//    OTP endpoints have their own stricter limiters below.
// ---------------------------------------------------------------------------
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 min
  max: parseInt(process.env.RATE_LIMIT_MAX || '2000', 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.originalUrl.startsWith('/api/health'),
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests, please slow down',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000),
    });
  },
});
app.use('/api/', globalLimiter);

// Stricter limiter for OTP endpoints (prevent brute-force / spam)
const otpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 10,              // 10 OTP requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Too many OTP requests. Please wait.' });
  },
});

// ---------------------------------------------------------------------------
// 4. Request timeout middleware (prevents hung requests from blocking workers)
// ---------------------------------------------------------------------------
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10); // 30s default
app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(408).json({ success: false, error: 'Request timeout' });
    }
  });
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({ success: false, error: 'Response timeout' });
    }
  });
  next();
});

// ---------------------------------------------------------------------------
// 5. Health check (always available, never rate-limited, never timed out)
// ---------------------------------------------------------------------------
let cachedHealth = null;
let healthCacheTime = 0;
const HEALTH_CACHE_TTL = 15000; // 15s cache to avoid hammering DB

app.get('/api/health', async (req, res) => {
  // Bypass timeout for health
  req.setTimeout(0);
  res.setTimeout(0);

  const now = Date.now();
  if (cachedHealth && (now - healthCacheTime) < HEALTH_CACHE_TTL) {
    return res.json(cachedHealth);
  }

  const db = await testConnection();
  cachedHealth = {
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    supabase: db,
    version: '2.0.0',
  };
  healthCacheTime = now;
  res.json(cachedHealth);
});

// ---------------------------------------------------------------------------
// 6. Root info
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'SkillParkho Admin Backend - Verified Contacts + Allowed Users + OTP API',
    version: '2.0.0',
    docs: {
      health: 'GET /api/health',
      login: 'POST /api/admin/login { email, password }',
      verifiedContacts: {
        stats: 'GET /api/verified-contacts/stats/summary (auth)',
        list: 'GET /api/verified-contacts?search=&page=&limit= (auth)',
        create: 'POST /api/verified-contacts (auth)',
        update: 'PUT /api/verified-contacts/:id (auth)',
        delete: 'DELETE /api/verified-contacts/:id (auth)',
        bulk: 'POST /api/verified-contacts/bulk { contacts: [...] } (auth)',
        import: 'POST /api/verified-contacts/import (multipart file) (auth)',
        exportCsv: 'GET /api/verified-contacts/export/csv (auth)',
        publicList: 'GET /api/public/verified-contacts?search=&phone=&page=',
        checkPhone: 'GET /api/public/verified-contacts/check/:phone',
      },
      allowedUsers: {
        stats: 'GET /api/allowed-users/stats/summary (auth)',
        list: 'GET /api/allowed-users?search=&page=&limit=&is_active= (auth)',
        create: 'POST /api/allowed-users { phone_number, email, full_name } (auth)',
        update: 'PUT /api/allowed-users/:id (auth)',
        delete: 'DELETE /api/allowed-users/:id (auth)',
        bulk: 'POST /api/allowed-users/bulk { users: [...] } (auth)',
        import: 'POST /api/allowed-users/import (multipart file) (auth)',
        exportCsv: 'GET /api/allowed-users/export/csv (auth)',
      },
      otpAuth: {
        requestOtp: 'POST /api/auth/request-otp { phone }',
        verifyOtp: 'POST /api/auth/verify-otp { phone, otp }',
        checkPhone: 'GET /api/auth/check-phone/:phone -> { isAllowed }',
        appMe: 'GET /api/auth/me (Bearer student JWT)',
      },
    },
  });
});

app.get("/cron-job", (req, res) => {
  console.log("✅ Cron job hit at:", new Date().toLocaleString());
  res.status(200).send("Cron job executed");
});
// ---------------------------------------------------------------------------
// 7. Routes
// ---------------------------------------------------------------------------

// OTP-specific stricter rate limiting (BEFORE routes so it actually runs)
app.use('/api/auth/request-otp', otpLimiter);
app.use('/api/auth/verify-otp', otpLimiter);
app.use('/api/public/auth/request-otp', otpLimiter);
app.use('/api/public/auth/verify-otp', otpLimiter);

app.use('/api', authRoutes);
app.use('/api', verifiedRoutes);
app.use('/api', allowedUsersRoutes);
app.use('/api', appAuthRoutes);
app.use('/api/app', studentDataRoutes);
app.use('/api/app', recordingsRoutes);

// ---------------------------------------------------------------------------
// 8. 404 handler
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.originalUrl} not found` });
});

// ---------------------------------------------------------------------------
// 9. Global error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message, err.stack?.split('\n')[1] || '');

  // Multer file upload errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, error: 'File too large' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }

  // JSON parse errors
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON in request body' });
  }

  // Don't leak internals in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Internal server error';

  res.status(500).json({ success: false, error: message });
});

// ---------------------------------------------------------------------------
// 10. Start server with keep-alive and backpressure settings
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', {
  keepAliveTimeout: 65000,       // 65s (greater than ALB/LB idle timeout of 60s)
  headersTimeout: 66000,         // slightly > keepAliveTimeout
  maxHeadersCount: 100,          // limit total headers
}, () => {
  console.log(`
  SkillParkho Admin Backend v2.0.0 running
  Local:   http://localhost:${PORT}
  Health:  http://localhost:${PORT}/api/health
  Env:     ${process.env.NODE_ENV || 'development'}
  Supabase: ${process.env.SUPABASE_URL}
  Admin:   ${process.env.ADMIN_EMAIL}
  `);
});

// Node.js default maxConnections = Infinity (unlimited concurrent connections).
// Do NOT set to 0 (rejects all) or -1 (also rejects all, since connections >= -1 is always true).

// ---------------------------------------------------------------------------
// 11. Graceful shutdown (critical for 1000+ users — finish in-flight requests)
// ---------------------------------------------------------------------------
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[${signal}] Graceful shutdown initiated...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('[SHUTDOWN] All connections drained. Exiting.');
    process.exit(0);
  });

  // Force exit after 10s if connections don't drain
  setTimeout(() => {
    console.error('[SHUTDOWN] Forced exit after 10s timeout');
    process.exit(1);
  }, 10000).unref();

  // Reject new connections immediately
  server.on('connection', (socket) => {
    socket.destroy();
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} already in use (EADDRINUSE).`);
    console.error(`Kill it: lsof -i :${PORT} -t | xargs kill -9`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});
