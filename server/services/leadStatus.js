/**
 * leadStatus.js — in-memory lead status tracker so the frontend can poll
 * /api/lead-status/:id and show real progress (queued → filling → submitted).
 *
 * Entries expire after 10 minutes to bound memory on a busy day. This is
 * process-local state; if Railway scales to >1 replica, switch to Redis.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const statuses = new Map();

function makeId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

function create(initial = {}) {
  const id = makeId();
  const record = {
    id,
    state: 'queued',        // queued | running | submitted | failed
    step: null,             // init | load | debt-slider | name | contact | address | dob | ssn | submit
    method: null,           // 'bot' | 'proxy'
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    httpStatus: null,
    error: null,
    createdAt: Date.now(),
    ...initial
  };
  statuses.set(id, record);
  return record;
}

function update(id, patch) {
  const record = statuses.get(id);
  if (!record) return null;
  Object.assign(record, patch);
  return record;
}

function get(id) {
  return statuses.get(id) || null;
}

// Reap old records periodically
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, rec] of statuses) {
    if (rec.createdAt < cutoff) statuses.delete(id);
  }
}, 60 * 1000).unref();

module.exports = { create, update, get };
