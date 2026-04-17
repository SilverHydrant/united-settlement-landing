require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

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

// CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  methods: ['GET', 'POST'],
  credentials: true
}));

// Body parsing
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Disable caching in development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: false, lastModified: false }));

// API routes
app.use('/api', apiRoutes);

// Admin routes (Basic Auth gated by ADMIN_PASSWORD env var)
app.use('/admin', adminRoutes);

// SPA fallback - serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`United Settlement Landing Page running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});
