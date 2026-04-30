/**
 * abVariant.js — assigns each visitor to A/B test arm 'a' or 'b'.
 *
 * Resolution order:
 *   1. ?v=a or ?v=b URL param  → forces variant, writes cookie (so the
 *      override persists for the rest of the session). Useful for sharing
 *      a specific variant link or QA.
 *   2. usv cookie ('a' or 'b') → returning visitor, keep them on the
 *      same variant for consistent experience and clean stats.
 *   3. Random assignment       → coin flip weighted by abConfig.weightB.
 *      Cookie written so they stick on this variant for 30 days.
 *
 * Sets `req.variant = 'a' | 'b'` for downstream use (homepage route,
 * /api/track stamping, admin reporting).
 */

const abConfig = require('../lib/abConfig');

const COOKIE_NAME = 'usv';
const COOKIE_MAX_AGE_DAYS = 30;
const COOKIE_MAX_AGE_SEC = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setVariantCookie(res, variant) {
  // SameSite=Lax: cookie sent on top-level navigations (the common case
  // for landing pages from ads); HttpOnly so JS can't read or change it
  // (the variant is a server-side decision); Secure auto-on in prod via
  // the proto check upstream — we conditionally append it below.
  const isProd = process.env.NODE_ENV === 'production';
  const parts = [
    `${COOKIE_NAME}=${variant}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
    'SameSite=Lax',
    'HttpOnly'
  ];
  if (isProd) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function pickRandomVariant(weightB) {
  return Math.random() < weightB ? 'b' : 'a';
}

/**
 * Express middleware. Sets req.variant and (when assigning a new visitor
 * or honoring a URL override) writes the usv cookie.
 */
function abVariant(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  // Make raw cookies available downstream so /api/track can read usv too
  req.cookies = cookies;

  // 1. URL override
  const qv = (req.query && req.query.v ? String(req.query.v).toLowerCase() : '');
  if (qv === 'a' || qv === 'b') {
    req.variant = qv;
    setVariantCookie(res, qv);
    return next();
  }

  // 2. Existing cookie
  const cv = cookies[COOKIE_NAME];
  if (cv === 'a' || cv === 'b') {
    req.variant = cv;
    return next();
  }

  // 3. Fresh assignment based on current split
  const cfg = abConfig.get();
  const variant = pickRandomVariant(cfg.weightB);
  req.variant = variant;
  setVariantCookie(res, variant);
  next();
}

module.exports = { abVariant, parseCookies, COOKIE_NAME };
