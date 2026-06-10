require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const paymentRoutes = require('./routes/payment');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY HEADERS (H3, L1) ──
// Helmet sets secure HTTP headers: X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, X-XSS-Protection, and disables X-Powered-By
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow onclick= handlers
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'", "https://*.tilda.ws", "https://*.tildacdn.com", "https://alef-bet.tech"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── CORS RESTRICTION (C1) ──
// Only allow requests from trusted domains
const allowedOrigins = [
  'https://alef-bet-payments.onrender.com',
  'https://alef-bet.tech',
  'https://www.alef-bet.tech',
];
if (process.env.KEEPZ_ENV !== 'prod') {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:3456');
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server like Keepz callbacks)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed => origin === allowed || origin.endsWith('.tilda.ws') || origin.endsWith('.tildacdn.com'))) {
      return callback(null, true);
    }
    return callback(new Error('CORS: Origin not allowed'), false);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400, // Pre-flight cache 24h
}));

// ── RATE LIMITING (C2) ──
// Limit payment endpoints to prevent abuse
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // max 30 payment requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please try again later.' },
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, // General API limit
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general limiter to all API routes
app.use('/api', generalLimiter);

// Apply strict limiter to payment creation endpoints
app.use('/api/create-order', paymentLimiter);
app.use('/api/create-subscription', paymentLimiter);

// ── BODY PARSING (M2) ──
// Limit request body size to prevent memory exhaustion
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', paymentRoutes);

// Fallback to index.html for SPA-like behavior
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// Global error handler — never leak stack traces
app.use((err, req, res, _next) => {
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n  🚀 ALEF-BET Payment Server running on port ${PORT}`);
  console.log(`  📍 Environment: ${process.env.KEEPZ_ENV || 'dev'}`);
  console.log(`  🔒 Helmet: enabled | CORS: restricted | Rate-limit: active\n`);
});
