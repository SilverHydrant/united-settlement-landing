const express = require('express');
const router = express.Router();
const rateLimiter = require('../middleware/rateLimiter');
const botDetection = require('../middleware/botDetection');
const validateInput = require('../middleware/validateInput');
const formProxy = require('../services/formProxy');
const { submitViaBot } = require('../services/botSubmitter');
const { enqueue, getStats } = require('../services/leadQueue');
const leadStatus = require('../services/leadStatus');
const leadStore = require('../services/leadStore');

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
        leadStatus.update(statusId, {
          state: 'submitted',
          step: r.step,
          httpStatus: r.httpStatus,
          finishedAt: Date.now(),
          durationMs: r.durationMs
        });
        return r;
      }
      console.error(`[BOT FAIL] ${ts()} | ${tag} | step=${r.step} | ${r.error} | ${r.durationMs}ms — falling back to proxy`);
      leadStatus.update(statusId, { method: 'proxy', step: 'fallback' });
    }

    // Proxy fallback (or primary if USE_BOT=false)
    const proxyResult = await formProxy.submit(lead);
    if (proxyResult.success) {
      console.log(`[PROXY OK] ${ts()} | ${tag}`);
      leadStatus.update(statusId, {
        state: 'submitted',
        step: 'proxy-submitted',
        finishedAt: Date.now(),
        durationMs: Date.now() - (leadStatus.get(statusId)?.startedAt || Date.now())
      });
    } else {
      console.error(`[PROXY FAIL] ${ts()} | ${tag} | ${proxyResult.error}`);
      leadStatus.update(statusId, {
        state: 'failed',
        error: proxyResult.error || 'Unknown error',
        finishedAt: Date.now()
      });
    }
    return proxyResult;
  }).catch((err) => {
    console.error(`[QUEUE ERROR] ${ts()} | ${tag} | ${err.message}`);
    leadStatus.update(statusId, { state: 'failed', error: err.message, finishedAt: Date.now() });
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

      // Persist the lead to our own storage FIRST (before queueing the bot).
      // This way every submission is captured even if the bot/proxy later
      // fails. Best-effort — saveLead never throws.
      leadStore.saveLead(lead, { statusId: null });

      // Create a lead-status record so the frontend can poll progress, then
      // enqueue the background job and return the ID to the client.
      const status = leadStatus.create();
      console.log(`[LEAD QUEUED] ${new Date().toISOString()} | ${lead.fname} ${lead.lname} | ${lead.state} | $${lead.lamount * 1000} | CallTime: ${lead.calltime} | id=${status.id}`);
      processLeadInBackground(lead, status.id);

      res.json({
        success: true,
        message: 'Your consultation request has been submitted!',
        leadId: status.id
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

module.exports = router;
