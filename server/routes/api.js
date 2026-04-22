const express = require('express');
const router = express.Router();
const rateLimiter = require('../middleware/rateLimiter');
const botDetection = require('../middleware/botDetection');
const validateInput = require('../middleware/validateInput');
const formProxy = require('../services/formProxy');
const { submitViaBot } = require('../services/botSubmitter');
const { enqueue, getStats, isFull, recordDuration } = require('../services/leadQueue');
const leadStatus = require('../services/leadStatus');
const leadStore = require('../services/leadStore');
const { sendAlert } = require('../services/alerter');

// Submission strategy:
//   primary  — Playwright bot walks the live unitedsettlement.com form
//   fallback — direct PHP-endpoint POST (formProxy)
// USE_BOT defaults to 'true'; set USE_BOT=false to disable bot and use proxy only.
const USE_BOT = (process.env.USE_BOT || 'true').toLowerCase() !== 'false';

// Health check
router.get('/health', async (req, res) => {
  let queueStats = null;
  try { queueStats = await getStats(); } catch (_) {}
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    bot: { enabled: USE_BOT, queue: queueStats }
  });
});

// Lead status polling — frontend hits this to show progress after submit
router.get('/lead-status/:id', (req, res) => {
  const record = leadStatus.get(req.params.id);
  if (!record) {
    return res.status(404).json({ success: false, message: 'Lead not found or expired.' });
  }
  res.json({ success: true, lead: record });
});

/**
 * Run the bot in the background and log the result. Updates the in-memory
 * lead-status record at each step so the frontend can poll for progress.
 * If the bot fails at any step, falls back to the PHP proxy so the lead
 * is never lost.
 */
function processLeadInBackground(lead, statusId) {
  const ts = () => new Date().toISOString();
  const tag = `${lead.fname} ${lead.lname} | ${lead.state} | $${lead.lamount * 1000}`;

  enqueue(async () => {
    leadStatus.update(statusId, { state: 'running', method: USE_BOT ? 'bot' : 'proxy', startedAt: Date.now() });

    if (USE_BOT) {
      console.log(`[BOT START] ${ts()} | ${tag} | id=${statusId}`);
      const r = await submitViaBot(lead, (step) => {
        leadStatus.update(statusId, { step });
      });
      if (r.success) {
        console.log(`[BOT OK] ${ts()} | ${tag} | step=${r.step} | http=${r.httpStatus} | ${r.durationMs}ms`);
        recordDuration(r.durationMs);
        leadStatus.update(statusId, {
          state: 'submitted',
          step: r.step,
          httpStatus: r.httpStatus,
          finishedAt: Date.now(),
          durationMs: r.durationMs
        });
        leadStore.saveDelivery({
          leadId: statusId, status: 'submitted', method: 'bot',
          httpStatus: r.httpStatus, durationMs: r.durationMs, step: r.step
        });
        return r;
      }
      console.error(`[BOT FAIL] ${ts()} | ${tag} | step=${r.step} | ${r.error} | ${r.durationMs}ms — falling back to proxy`);
      leadStatus.update(statusId, { method: 'proxy', step: 'fallback' });
      leadStore.saveDelivery({
        leadId: statusId, status: 'bot-failed-falling-back', method: 'bot',
        step: r.step, error: r.error, durationMs: r.durationMs
      });
    }

    // Proxy fallback (or primary if USE_BOT=false)
    const proxyResult = await formProxy.submit(lead);
    if (proxyResult.success) {
      console.log(`[PROXY OK] ${ts()} | ${tag}`);
      const startedAt = leadStatus.get(statusId)?.startedAt || Date.now();
      const durationMs = Date.now() - startedAt;
      leadStatus.update(statusId, {
        state: 'submitted',
        step: 'proxy-submitted',
        finishedAt: Date.now(),
        durationMs
      });
      leadStore.saveDelivery({
        leadId: statusId, status: 'submitted', method: 'proxy', durationMs
      });
    } else {
      console.error(`[PROXY FAIL] ${ts()} | ${tag} | ${proxyResult.error}`);
      leadStatus.update(statusId, {
        state: 'failed',
        error: proxyResult.error || 'Unknown error',
        finishedAt: Date.now()
      });
      leadStore.saveDelivery({
        leadId: statusId, status: 'failed', method: 'proxy',
        error: proxyResult.error || 'Unknown error'
      });
      // Both bot and proxy failed — alert the operator. Lead is saved in
      // /admin/leads so nothing is lost, but someone should call them back.
      sendAlert(
        'delivery-fail',
        '🚨 Lead delivery failed (both bot + proxy)',
        `${tag}\nPhone: ${lead.phone}\nEmail: ${lead.email}\nError: ${proxyResult.error}\nCheck /admin/leads`
      );
    }
    return proxyResult;
  }).catch((err) => {
    console.error(`[QUEUE ERROR] ${ts()} | ${tag} | ${err.message}`);
    leadStatus.update(statusId, { state: 'failed', error: err.message, finishedAt: Date.now() });
    leadStore.saveDelivery({
      leadId: statusId, status: 'failed', method: 'queue', error: err.message
    });
    sendAlert(
      'queue-error',
      '🚨 Queue runtime error',
      `${tag}\nPhone: ${lead.phone}\nError: ${err.message}`
    );
  });
}

// Form submission endpoint
router.post('/submit',
  rateLimiter,
  botDetection,
  validateInput,
  async (req, res) => {
    try {
      // Snapshot the validated lead so we can hand it to the background worker.
      // (req.body is mutated by middleware; we want the cleaned values.)
      const lead = {
        fname: req.body.fname,
        lname: req.body.lname,
        email: req.body.email,
        phone: req.body.phone,
        dob: req.body.dob,
        state: req.body.state,
        lamount: req.body.lamount,
        calltime: req.body.calltime,
        userip: req.body.userip || req.ip,
        // UTM/tracking passthrough (proxy fallback uses these)
        utmid: req.body.utmid, utmsource: req.body.utmsource,
        utmmedium: req.body.utmmedium, utmcampaign: req.body.utmcampaign,
        utmcontent: req.body.utmcontent, utmterm: req.body.utmterm,
        sidcamid: req.body.sidcamid, sourceid: req.body.sourceid,
        subidone: req.body.subidone, subidtwo: req.body.subidtwo,
        subidthree: req.body.subidthree, subidfour: req.body.subidfour,
        gclid: req.body.gclid
      };

      // Overload guard: if the bot queue is saturated, reject with 503 so the
      // frontend can show the "call us directly" fallback instead of putting
      // the user in a line that'll take 10+ minutes. We STILL save the lead
      // (and a delivery record) so the admin page sees overloaded rejections.
      if (await isFull()) {
        const overloadId = require('crypto').randomBytes(6).toString('hex');
        leadStore.saveLead(lead, { leadId: overloadId, deliveryStatus: 'rejected-overloaded' });
        leadStore.saveDelivery({
          leadId: overloadId, status: 'rejected-overloaded', method: 'none'
        });
        const stats = await getStats();
        console.warn(`[OVERLOAD] ${new Date().toISOString()} | ${lead.fname} ${lead.lname} | ${lead.state} | queue=${stats.size}/${stats.maxSize} | pending=${stats.pending}`);
        // Hot-traffic signal — alert once per 5 min (alerter throttles) so
        // you know traffic is beating the queue and leads are being shed.
        sendAlert(
          'overload',
          '⚠️ Queue is full — overload rejections in progress',
          `Queue at ${stats.size}/${stats.maxSize} running ${stats.pending}. Latest: ${lead.fname} ${lead.lname} (${lead.state}, ${lead.phone}). Consider bumping BOT_CONCURRENCY or MAX_QUEUE_SIZE.`
        );
        return res.status(503).json({
          success: false,
          overloaded: true,
          message: 'Our automated submission system is at capacity right now. Please call us directly at (516) 231-9239 — a specialist is standing by.'
        });
      }

      // Create the status record FIRST so we have a stable leadId to stamp
      // onto both the persisted lead and every delivery row — the admin page
      // joins on this id.
      const preStats = await getStats();
      const position = preStats.size + preStats.pending + 1;
      const estimatedWaitMs = preStats.estimatedWaitMs;
      const status = leadStatus.create({ position: position, estimatedWaitMs: estimatedWaitMs });

      // Persist the lead to our own storage with the leadId embedded.
      leadStore.saveLead(lead, { leadId: status.id });
      // Seed delivery log with a "queued" row so newly-submitted leads show
      // up in the admin page before the bot has even had a chance to run.
      leadStore.saveDelivery({ leadId: status.id, status: 'queued', method: USE_BOT ? 'bot' : 'proxy' });

      console.log(`[LEAD QUEUED] ${new Date().toISOString()} | ${lead.fname} ${lead.lname} | ${lead.state} | $${lead.lamount * 1000} | CallTime: ${lead.calltime} | id=${status.id} | pos=${position}/${preStats.maxSize}`);
      processLeadInBackground(lead, status.id);

      res.json({
        success: true,
        message: 'Your consultation request has been submitted!',
        leadId: status.id,
        position: position,
        estimatedWaitMs: estimatedWaitMs
      });
    } catch (err) {
      console.error(`[SERVER ERROR] ${new Date().toISOString()} | ${err.message}`);
      res.status(500).json({
        success: false,
        message: 'Something went wrong. Please call us directly at (516) 231-9239.'
      });
    }
  }
);

/**
 * Lightweight engagement tracker. Called by the browser (via sendBeacon for
 * call-clicks, fetch otherwise) whenever the user interacts with a tracked
 * element: call button, schedule button, learn-more, slider, etc.
 *
 * Events are appended to /data/events.jsonl. Admin page aggregates them for
 * "N people clicked the call button this week" style reporting.
 */
const ALLOWED_EVENTS = new Set([
  'call_click', 'schedule_click', 'learn_more_click', 'slider_move',
  'tab_click', 'faq_click', 'form_start', 'form_error', 'page_view'
]);

// Permissive limiter for the tracker endpoint. A single page load can fire
// 5-15 events legitimately (page view + ~3 tab clicks + FAQ opens + scroll
// interactions), so the lead-form limiter's 5-per-15-min is obviously
// wrong here. 200/min per IP catches flood abuse without ever blocking a
// real user.
const trackerLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
});

// sendBeacon sends blobs that still carry Content-Type: application/json.
// But *some* Safari versions strip the header, so accept text/plain too —
// we parse the body ourselves either way to be defensive.
const rawJsonBody = express.raw({ type: '*/*', limit: '8kb' });

router.post('/track',
  trackerLimiter,
  (req, res) => {
    // At this point the GLOBAL express.json middleware in server/index.js
    // has already parsed the body. Whatever came through is in req.body.
    // No per-route parser needed — adding one here (express.raw) was
    // stomping on the already-parsed body and silently losing events.
    try {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const rawEvent = String(body.event || '').toLowerCase().trim();
      if (!ALLOWED_EVENTS.has(rawEvent)) {
        console.warn(`[TRACK] 400 unknown event="${rawEvent}" body=${JSON.stringify(body).slice(0,200)}`);
        return res.status(400).json({ success: false, message: 'Unknown event' });
      }
      let meta = body.meta;
      if (meta && typeof meta === 'object') {
        try {
          const s = JSON.stringify(meta);
          if (s.length > 1024) meta = { _truncated: true };
        } catch (_) { meta = null; }
      } else {
        meta = null;
      }
      const saved = leadStore.saveEvent({
        event: rawEvent,
        ip: req.ip,
        ua: (req.headers['user-agent'] || '').slice(0, 200),
        ref: (req.headers.referer || '').slice(0, 200),
        meta: meta
      });
      console.log(`[TRACK] ${rawEvent} saved=${saved} ip=${req.ip}`);
      res.json({ success: saved !== false });
    } catch (err) {
      console.error(`[TRACK ERROR] ${err.message}\n${err.stack}`);
      res.status(500).json({ success: false });
    }
  }
);

// Diagnostic endpoint: proves whether /data is writable, and reports what
// the leadStore would actually do. Useful when the admin page shows zeros
// but 200s are flying in — tells us immediately whether the volume mount
// is the problem or whether something upstream is eating the body.
router.get('/track-diag', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const probe = path.join(dir, '.track-diag-probe');
  const result = { dataDir: dir, env: process.env.DATA_DIR || null };
  try {
    fs.mkdirSync(dir, { recursive: true });
    result.mkdir = 'ok';
  } catch (e) {
    result.mkdir = 'error: ' + e.message;
  }
  try {
    fs.writeFileSync(probe, 'ok\n', 'utf8');
    result.write = 'ok';
    fs.unlinkSync(probe);
    result.cleanup = 'ok';
  } catch (e) {
    result.write = 'error: ' + e.message;
  }
  try {
    const ls = fs.readdirSync(dir);
    result.files = ls.slice(0, 20);
  } catch (e) {
    result.files = 'error: ' + e.message;
  }
  res.json(result);
});

module.exports = router;
