require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const { geoGuard, geoInfoHandler } = require('./middleware/geoGuard');
const { abVariant } = require('./middleware/abVariant');
const abConfig = require('./lib/abConfig');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers (relaxed for landing page with Meta Pixel + Google Fonts)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://connect.facebook.net", "https://www.facebook.com", "https://fonts.googleapis.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://www.facebook.com", "https://*.facebook.com"],
      connectSrc: ["'self'", "https://api.ipify.org", "https://www.facebook.com"],
      frameSrc: ["https://www.facebook.com"],
      upgradeInsecureRequests: null  // Disable on localhost (HTTP) - Railway provides HTTPS
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS — ALLOWED_ORIGIN can be a single origin or a comma-separated list
// (e.g. "https://myunitedsettlement.com,https://*.up.railway.app"). Requests
// without an Origin header (same-origin, curl, server-to-server) always pass.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET', 'POST'],
  credentials: true
}));

// Trust Railway's proxy so req.hostname reflects the real Host header
app.set('trust proxy', 1);

// Force HTTPS: any http:// request hitting us gets a 301 permanent redirect
// to the https:// equivalent. Railway terminates TLS at its edge and forwards
// with x-forwarded-proto; we trust that header because of `trust proxy` above.
// Skipped for NODE_ENV !== 'production' so local http://localhost works.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  if (proto !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// Body parsing
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ---- Admin-domain split ----
// If ADMIN_HOST env is set, two Railway domains behave differently:
//   * Public host   → /admin routes return 404 (can't be probed/scraped)
//   * Admin host    → GET / redirects straight to /admin/leads; bot form
//                     endpoints (/api/submit) stay blocked (admin-only)
// If ADMIN_HOST is not set, both routes work on every domain (legacy behavior).
const ADMIN_HOST = (process.env.ADMIN_HOST || '').toLowerCase().trim();

app.use((req, res, next) => {
  if (!ADMIN_HOST) return next(); // single-domain mode
  const host = (req.hostname || '').toLowerCase();
  const isAdminHost = host === ADMIN_HOST;

  if (isAdminHost) {
    // On the admin domain, bounce the root to the leads dashboard
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
      return res.redirect(302, '/admin/leads');
    }
    // Public API calls don't belong on the admin domain
    if (req.path.startsWith('/api/submit')) {
      return res.status(404).type('text/plain').send('Not found');
    }
  } else {
    // On the public domain, /admin endpoints are hidden entirely
    if (req.path.startsWith('/admin')) {
      return res.status(404).type('text/plain').send('Not found');
    }
  }
  next();
});

// Disable caching in development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Geo-guard: block EU/UK visitors, tag California requests on req.geo.
// Runs BEFORE static files so blocked visitors never see the landing page.
app.use(geoGuard);

// Lightweight endpoint the frontend polls once on load to decide whether to
// show the California CPRA notice banner. Returns { isCalifornia, country, region }.
app.get('/api/geo', geoInfoHandler);

// Serve static files. We disable the implicit "index" lookup so that
// requests to "/" fall through to the abVariant-aware handler below
// instead of being short-circuited by express.static handing back
// public/index.html before we can pick a variant.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  index: false
}));

// API routes
app.use('/api', apiRoutes);

// Admin routes (Basic Auth gated by ADMIN_PASSWORD env var)
app.use('/admin', adminRoutes);

// A/B-routed homepage. abVariant sets req.variant ('a' | 'b') based on
// the usv cookie / ?v=a|b URL param / weighted random assignment, then
// we serve the matching HTML file.
app.get(['/', '/index.html'], abVariant, (req, res) => {
  const file = req.variant === 'b' ? 'option-b.html' : 'index.html';
  res.sendFile(path.join(__dirname, '..', 'public', file));
});

// Force-variant URLs for sharing / QA. /v1 and /v2 always serve their
// respective version regardless of the assigned cookie. They also
// write the cookie so the visitor stays locked on that variant.
app.get(['/v1'], abVariant, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.get(['/v2', '/test-look-2'], abVariant, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'option-b.html'));
});

// SPA fallback - serve index.html for any other non-API route. Variant
// routing only applies to the canonical homepage URLs above; deep-linked
// junk like /random-path falls through to v1 to avoid breaking shares.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Kick off the auto-rebalance loop (no-op when mode === 'manual').
abConfig.startRebalanceLoop();

app.listen(PORT, () => {
  console.log(`United Settlement Landing Page running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});
