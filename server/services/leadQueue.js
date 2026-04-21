/**
 * leadQueue.js — Bounded concurrency queue for the Playwright bot.
 *
 * Each headless Chromium instance uses ~150-300MB. On a 512MB Railway dyno we
 * can safely run 1-2 in parallel. p-queue gives us a small async queue with
 * a concurrency cap; jobs run as workers free up. Use ONE shared queue across
 * the whole process so throttling is global, not per-request.
 */

let pQueue;
let queueInstance = null;

// Tunable via Railway env vars. Defaults are chosen for a Pro-tier box
// (24 GB / 24 vCPU) running Playwright Chromium: 3 concurrent bots keeps
// memory well under 1 GB, and a 30-lead cap keeps the max wait at
// roughly 3 × 20s = 60s even at full queue.
const CONCURRENCY   = parseInt(process.env.BOT_CONCURRENCY, 10) || 3;
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE, 10) || 30;

// Rolling estimate of how long one submission takes end-to-end. Seeded from
// our smoke-tests (~20s) and updated with every successful bot run so wait-
// time predictions stay honest. Pure math, no external state.
var avgSubmitMs = 20000;
var avgSamples  = 1;
function recordDuration(ms) {
  if (!ms || ms < 1000 || ms > 120000) return; // ignore bogus outliers
  avgSamples = Math.min(avgSamples + 1, 50);
  avgSubmitMs = Math.round(avgSubmitMs + (ms - avgSubmitMs) / avgSamples);
}

async function getQueue() {
  if (queueInstance) return queueInstance;
  // p-queue v8+ is ESM-only — dynamic import from CJS
  if (!pQueue) {
    const mod = await import('p-queue');
    pQueue = mod.default;
  }
  queueInstance = new pQueue({ concurrency: CONCURRENCY });
  return queueInstance;
}

/**
 * True if the queue is at capacity. Callers should check this BEFORE calling
 * enqueue() — if full, reject the request with a 503 so the user sees the
 * overload message instead of waiting silently.
 */
async function isFull() {
  const q = await getQueue();
  return (q.size + q.pending) >= MAX_QUEUE_SIZE;
}

/**
 * Enqueue a lead-submission job. Returns a Promise that resolves with the
 * job's result. Caller decides whether to await it (sync response) or
 * fire-and-forget (async response to the user).
 */
async function enqueue(jobFn) {
  const q = await getQueue();
  return q.add(jobFn);
}

/**
 * Snapshot of the queue + predicted wait for a NEW submission arriving now.
 * Wait math: every pending/queued job ahead of us has to finish first, and
 * at CONCURRENCY workers the wait for our slot is roughly
 *   ceil((ahead + 1 - concurrency) / concurrency) * avgSubmitMs
 * for the last-to-start, then one more avgSubmitMs for our own job.
 */
async function getStats() {
  const q = await getQueue();
  const ahead = q.size + q.pending; // jobs already in the system
  const slotsToWait = Math.max(0, Math.ceil((ahead + 1 - q.concurrency) / q.concurrency));
  const estimatedWaitMs = slotsToWait * avgSubmitMs;
  return {
    concurrency: q.concurrency,
    maxSize: MAX_QUEUE_SIZE,
    size: q.size,          // queued (not yet running)
    pending: q.pending,    // currently running
    full: ahead >= MAX_QUEUE_SIZE,
    avgSubmitMs: avgSubmitMs,
    estimatedWaitMs: estimatedWaitMs
  };
}

module.exports = { enqueue, getStats, isFull, recordDuration };
