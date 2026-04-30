/**
 * abConfig.js — A/B test split configuration + auto-rebalance loop.
 *
 * Persists to <DATA_DIR>/abconfig.json. Two modes:
 *   manual: weightB is fixed, set by an admin via slider
 *   auto:   weightB recomputes every 60s based on observed conversion
 *           rates (call_click ÷ page_view) per variant. Bounded to
 *           [0.15, 0.85] so the losing arm keeps getting fresh signal.
 *
 * Cold start: until each variant has ≥50 page_views, weightB stays at 0.5
 * regardless of mode (no early conclusions on a handful of samples).
 *
 * Smoothing: target weight is blended 30/70 with current so the split
 * doesn't whipsaw on a single lucky hour.
 */

const fs = require('fs');
const path = require('path');
const { readAllEvents } = require('../services/leadStore');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'abconfig.json');

const DEFAULT_CONFIG = {
  mode: 'manual',
  weightB: 0.5,
  updatedAt: null,
  updatedBy: 'default',
  history: [] // { ts, mode, weightB, reason, statsSnapshot }
};

const COLD_START_MIN_PAGEVIEWS = 50;
const WEIGHT_FLOOR = 0.15;
const WEIGHT_CEIL = 0.85;
const SMOOTHING = 0.3; // new = current*(1-S) + target*S
const REBALANCE_INTERVAL_MS = 60 * 1000;

let cache = null;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cache = { ...DEFAULT_CONFIG, ...raw };
    } else {
      cache = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error('[abConfig] load failed, using default:', err.message);
    cache = { ...DEFAULT_CONFIG };
  }
  return cache;
}

function save(cfg) {
  ensureDataDir();
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    cache = cfg;
    return true;
  } catch (err) {
    console.error('[abConfig] save failed:', err.message);
    return false;
  }
}

function get() {
  return load();
}

/**
 * Apply an admin-driven update. Caller passes any subset of {mode, weightB}.
 * Returns the saved config.
 */
function update(patch, by) {
  const cfg = { ...load() };
  if (patch.mode === 'manual' || patch.mode === 'auto') cfg.mode = patch.mode;
  if (typeof patch.weightB === 'number' && isFinite(patch.weightB)) {
    cfg.weightB = Math.max(0, Math.min(1, patch.weightB));
  }
  cfg.updatedAt = new Date().toISOString();
  cfg.updatedBy = by || 'admin';
  cfg.history = (cfg.history || []).slice(-49); // keep last 50
  cfg.history.push({
    ts: cfg.updatedAt,
    mode: cfg.mode,
    weightB: cfg.weightB,
    reason: by ? ('manual:' + by) : 'manual'
  });
  save(cfg);
  return cfg;
}

/**
 * Walk the event log once and return per-variant counts.
 *   { a: { pv, calls, schedules, forms }, b: { ... } }
 * Variant resolved server-side at /api/track time, so events have e.variant.
 * Falls back to e.meta.variant for legacy events that were tagged client-side.
 */
function tallyByVariant(events) {
  const tally = {
    a: { pv: 0, calls: 0, schedules: 0, forms: 0 },
    b: { pv: 0, calls: 0, schedules: 0, forms: 0 }
  };
  for (const e of events) {
    let v = e.variant;
    if (!v && e.meta && e.meta.variant) {
      v = e.meta.variant === 'option_b' ? 'b' : (e.meta.variant === 'option_a' ? 'a' : null);
    }
    if (v !== 'a' && v !== 'b') continue;
    const bucket = tally[v];
    if (e.event === 'page_view') bucket.pv++;
    else if (e.event === 'call_click') bucket.calls++;
    else if (e.event === 'schedule_click') bucket.schedules++;
    else if (e.event === 'form_start') bucket.forms++;
  }
  return tally;
}

/**
 * Compute the auto-mode target weight for B given current event tallies.
 * Returns { weightB, reason, eligible }.
 *   eligible=false → cold start, keep at 0.5
 */
function computeTarget(tally) {
  const a = tally.a, b = tally.b;
  if (a.pv < COLD_START_MIN_PAGEVIEWS || b.pv < COLD_START_MIN_PAGEVIEWS) {
    return { weightB: 0.5, reason: 'cold-start', eligible: false };
  }
  const convA = a.calls / Math.max(1, a.pv);
  const convB = b.calls / Math.max(1, b.pv);
  if (convA + convB === 0) {
    return { weightB: 0.5, reason: 'no-conversions-yet', eligible: false };
  }
  let target = convB / (convA + convB);
  target = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEIL, target));
  return { weightB: target, reason: 'auto-rebalance', eligible: true };
}

/**
 * Run one rebalance tick. No-op if mode !== 'auto'. Returns the updated config.
 */
function tickRebalance() {
  const cfg = load();
  if (cfg.mode !== 'auto') return cfg;
  const tally = tallyByVariant(readAllEvents());
  const target = computeTarget(tally);
  if (!target.eligible) return cfg;
  // Smooth toward target so we don't whipsaw
  const smoothed = cfg.weightB * (1 - SMOOTHING) + target.weightB * SMOOTHING;
  if (Math.abs(smoothed - cfg.weightB) < 0.005) return cfg; // skip tiny moves
  const next = { ...cfg };
  next.weightB = Math.round(smoothed * 1000) / 1000;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = 'auto';
  next.history = (next.history || []).slice(-49);
  next.history.push({
    ts: next.updatedAt,
    mode: 'auto',
    weightB: next.weightB,
    reason: target.reason,
    snapshot: { a: tally.a, b: tally.b }
  });
  save(next);
  return next;
}

let intervalHandle = null;
function startRebalanceLoop() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    try { tickRebalance(); } catch (err) {
      console.error('[abConfig] rebalance tick failed:', err.message);
    }
  }, REBALANCE_INTERVAL_MS);
  if (intervalHandle.unref) intervalHandle.unref();
}

module.exports = {
  get,
  update,
  tallyByVariant,
  computeTarget,
  tickRebalance,
  startRebalanceLoop,
  COLD_START_MIN_PAGEVIEWS,
  WEIGHT_FLOOR,
  WEIGHT_CEIL
};
