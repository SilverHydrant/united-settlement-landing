/**
 * geoGuard.js — IP-based geo middleware.
 *
 * Two jobs:
 * 1. Block EU/UK visitors entirely (403 with a friendly page). We're not
 *    licensed to serve debt relief in those regions and GDPR/ePrivacy
 *    compliance adds cost we don't need.
 * 2. Tag California visitors on `req.geo` so the frontend can show the
 *    required CPRA / CCPA notice.
 *
 * Uses geoip-lite (offline MaxMind GeoLite2 DB bundled in node_modules).
 * No external API calls, no latency cost, no privacy compromise.
 *
 * Behavior is skippable for local dev via X-Dev-Geo header ("GB", "US-CA",
 * "US-TX" etc.) so we can smoke-test the 403 + banner flows without a VPN.
 */

const geoip = require('geoip-lite');
const path = require('path');
const fs = require('fs');

// EU member states + EFTA + UK + crown dependencies.
// Kept as a Set for O(1) lookup.
const BLOCKED_COUNTRIES = new Set([
  // EU 27
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE',
  'IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  // EEA / EFTA
  'IS','LI','NO',
  // Switzerland (adopts EU-like data law)
  'CH',
  // UK + crown dependencies
  'GB','IM','GG','JE',
  // Gibraltar
  'GI'
]);

// Try to pull a usable client IP out of the request. Railway puts the real
// client IP in x-forwarded-for; fall back to req.ip which express sets when
// `trust proxy` is on (it is, see server/index.js).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

// Dev override: set X-Dev-Geo: GB (or US-CA) to simulate a given location
// WITHOUT touching your network. Only honored when NODE_ENV !== 'production'.
function devOverride(req) {
  if (process.env.NODE_ENV === 'production') return null;
  const hdr = req.headers['x-dev-geo'];
  if (!hdr) return null;
  const [country, region] = String(hdr).split('-');
  return { country, region: region || null };
}

function lookup(req) {
  const dev = devOverride(req);
  if (dev) return dev;
  const ip = clientIp(req);
  if (!ip) return null;
  const geo = geoip.lookup(ip);
  if (!geo) return null;
  return { country: geo.country, region: geo.region };
}

function blockedHtml() {
  // Inline a minimal 403 page so there's no dependency on the main app
  // static/CSS pipeline (the guard runs before express.static).
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Service unavailable in your region</title>
<style>
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; background: #f4f6f8; color: #0b304a; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 20px; }
  .card { max-width: 480px; background: #fff; border-radius: 14px; padding: 36px 32px; box-shadow: 0 4px 24px rgba(11,48,74,.08); text-align: center; }
  h1 { font-size: 22px; font-weight: 900; margin: 0 0 10px; }
  p { color: #555; margin: 0 0 12px; font-size: 15px; line-height: 1.55; }
  .muted { color: #8a95a0; font-size: 13px; margin-top: 20px; }
</style>
</head><body>
<div class="card">
  <h1>This service is not available in your region.</h1>
  <p>United Settlement offers debt relief services to residents of the United States only. We cannot serve visitors from the EU, UK, or EEA.</p>
  <p>If you believe you're seeing this in error, please contact us directly.</p>
  <p class="muted">403 &middot; Region restricted</p>
</div>
</body></html>`;
}

function geoGuard(req, res, next) {
  // Never block asset/health requests — those happen before geolocation is
  // meaningful and blocking them can confuse the browser dev tools.
  if (req.path === '/api/health' || req.path === '/api/geo' || req.path.startsWith('/admin')) {
    req.geo = lookup(req); // still compute, in case routes want to read it
    return next();
  }

  const g = lookup(req);
  req.geo = g;

  if (g && BLOCKED_COUNTRIES.has(g.country)) {
    console.warn(`[GEO BLOCK] ${new Date().toISOString()} | ip=${clientIp(req)} | ${g.country}${g.region ? '-' + g.region : ''} | ${req.path}`);
    res.status(403).type('html').send(blockedHtml());
    return;
  }

  next();
}

// Small helper routes export — the frontend polls /api/geo to decide whether
// to show the California CPRA notice banner.
function geoInfoHandler(req, res) {
  const g = req.geo || {};
  const isCalifornia = g.country === 'US' && g.region === 'CA';
  res.json({
    country: g.country || null,
    region: g.region || null,
    isCalifornia
  });
}

module.exports = { geoGuard, geoInfoHandler, BLOCKED_COUNTRIES };
