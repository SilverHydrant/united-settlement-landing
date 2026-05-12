/**
 * admin.js — password-protected endpoints for viewing/exporting leads.
 *
 * Basic Auth keyed off the ADMIN_PASSWORD env var. Username can be anything.
 * If ADMIN_PASSWORD is not set, the endpoints return 503 (fail closed).
 *
 * Routes:
 *   GET /admin/leads        — HTML table of all leads (newest first)
 *   GET /admin/leads.csv    — CSV download
 *   GET /admin/leads.json   — Raw JSON array
 */

const express = require('express');
const router = express.Router();
const {
  readAllLeads,
  leadCount,
  getDataFilePath,
  readAllDeliveries,
  latestDeliveryByLeadId,
  readAllEvents
} = require('../services/leadStore');
const { getStats } = require('../services/leadQueue');
const abConfig = require('../lib/abConfig');

function requireAdmin(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  const expectedUser = process.env.ADMIN_USERNAME; // optional — if set, enforce
  if (!pw) {
    return res.status(503).type('text/plain').send(
      'Admin disabled: set the ADMIN_PASSWORD environment variable in Railway to enable.'
    );
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).type('text/plain').send('Authentication required');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const suppliedUser = idx >= 0 ? decoded.slice(0, idx) : '';
  const suppliedPass = idx >= 0 ? decoded.slice(idx + 1) : '';
  // Check password always; check username only if ADMIN_USERNAME is set.
  const userOk = !expectedUser || suppliedUser === expectedUser;
  const passOk = suppliedPass === pw;
  if (!userOk || !passOk) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).type('text/plain').send('Wrong username or password');
  }
  next();
}

function htmlEscape(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
}

function fmtPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}

// Map a delivery-status value to a human label + color.
const STATUS_STYLE = {
  'submitted':               { label: 'Delivered',   color: '#1a7a6d', bg: '#e8f8f5' },
  'running':                 { label: 'Running',     color: '#0b5ba8', bg: '#e8f1fb' },
  'queued':                  { label: 'Queued',      color: '#8a5d0a', bg: '#fff7ed' },
  'bot-failed-falling-back': { label: 'Retrying',    color: '#8a5d0a', bg: '#fff7ed' },
  'failed':                  { label: 'Failed',      color: '#c0392b', bg: '#fdf0ef' },
  'rejected-overloaded':     { label: 'Overloaded',  color: '#c0392b', bg: '#fdf0ef' },
  'unknown':                 { label: 'Unknown',     color: '#8a95a0', bg: '#f0f2f4' }
};

function renderStatusPill(statusKey) {
  const s = STATUS_STYLE[statusKey] || STATUS_STYLE.unknown;
  return `<span class="pill" style="background:${s.bg};color:${s.color}">${htmlEscape(s.label)}</span>`;
}

// Bucket a lead into one of the filter chips based on its callback preference.
// Anything starting with "pick:" collapses into the generic "scheduled" bucket.
function callbackBucket(calltime) {
  if (!calltime) return 'unknown';
  if (calltime.indexOf('pick:') === 0) return 'picktime';
  if (['now','1hour','2hours','tomorrow'].indexOf(calltime) >= 0) return calltime;
  if (['morning','afternoon','evening','asap'].indexOf(calltime) >= 0) return 'tomorrow';
  return 'unknown';
}

// Render the "call schedule" filter chips. Clicking a chip filters the table
// rows to just that callback group; clicking "All" resets.
function renderCallbackFilter(leads) {
  const counts = { all: leads.length, now: 0, '1hour': 0, '2hours': 0, tomorrow: 0, picktime: 0 };
  for (const l of leads) {
    const b = callbackBucket(l.calltime);
    if (counts[b] !== undefined) counts[b]++;
  }
  // Each chip: data-filter matches the value stamped on row.data-calltime so
  // the client-side filter is a simple attribute match.
  const chips = [
    { key: '',         icon: '',    label: 'All',       n: counts.all },
    { key: 'now',      icon: '📞',  label: 'Now',       n: counts.now },
    { key: '1hour',    icon: '⏰',  label: '1 Hour',    n: counts['1hour'] },
    { key: '2hours',   icon: '⏰',  label: '2 Hours',   n: counts['2hours'] },
    { key: 'tomorrow', icon: '🌅',  label: 'Tomorrow',  n: counts.tomorrow },
    { key: 'picktime', icon: '📅',  label: 'Scheduled', n: counts.picktime }
  ];
  return `
    <div class="callback-filter" role="tablist">
      <div class="cb-title">Callback schedule</div>
      <div class="cb-chips">
        ${chips.map((c, i) => `
          <button class="cb-chip${i === 0 ? ' active' : ''}" data-filter="${c.key}" type="button">
            ${c.icon ? `<span class="cb-chip-icon">${c.icon}</span>` : ''}
            <span class="cb-chip-label">${c.label}</span>
            <span class="cb-chip-count">${c.n}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function computeSummary(leads, deliveriesByLeadId) {
  const summary = {
    total: leads.length,
    delivered: 0,
    deliveredBot: 0,
    deliveredProxy: 0,
    failed: 0,
    overloaded: 0,
    running: 0,
    queued: 0,
    avgDurationMs: null
  };
  let totalDurMs = 0, durSamples = 0;
  for (const l of leads) {
    const d = l.leadId ? deliveriesByLeadId[l.leadId] : null;
    const s = d ? d.status : null;
    if (s === 'submitted') {
      summary.delivered++;
      if (d.method === 'bot') summary.deliveredBot++;
      else if (d.method === 'proxy') summary.deliveredProxy++;
      if (d.durationMs) { totalDurMs += d.durationMs; durSamples++; }
    } else if (s === 'failed') summary.failed++;
    else if (s === 'rejected-overloaded') summary.overloaded++;
    else if (s === 'running' || s === 'bot-failed-falling-back') summary.running++;
    else if (s === 'queued') summary.queued++;
  }
  if (durSamples > 0) summary.avgDurationMs = Math.round(totalDurMs / durSamples);
  return summary;
}

function renderSummaryCards(summary, queueStats) {
  const successRate = summary.total > 0
    ? Math.round((summary.delivered / summary.total) * 100)
    : 0;
  const avgSec = summary.avgDurationMs ? (summary.avgDurationMs / 1000).toFixed(1) : '—';
  return `
    <div class="cards">
      <div class="card">
        <div class="card-label">Total Submissions</div>
        <div class="card-value">${summary.total.toLocaleString()}</div>
      </div>
      <div class="card ok">
        <div class="card-label">Delivered to US</div>
        <div class="card-value">${summary.delivered.toLocaleString()}</div>
        <div class="card-sub">${summary.deliveredBot} bot · ${summary.deliveredProxy} proxy</div>
      </div>
      <div class="card ${successRate >= 90 ? 'ok' : successRate >= 70 ? 'warn' : 'err'}">
        <div class="card-label">Success Rate</div>
        <div class="card-value">${successRate}%</div>
        <div class="card-sub">${summary.total - summary.delivered} not delivered</div>
      </div>
      <div class="card ${summary.failed > 0 ? 'err' : ''}">
        <div class="card-label">Failed</div>
        <div class="card-value">${summary.failed}</div>
      </div>
      <div class="card ${summary.overloaded > 0 ? 'err' : ''}">
        <div class="card-label">Overloaded (rejected)</div>
        <div class="card-value">${summary.overloaded}</div>
      </div>
      <div class="card">
        <div class="card-label">In Queue Now</div>
        <div class="card-value">${queueStats.pending + queueStats.size}</div>
        <div class="card-sub">${queueStats.pending} running · ${queueStats.size} waiting · cap ${queueStats.maxSize}</div>
      </div>
      <div class="card">
        <div class="card-label">Avg Bot Run</div>
        <div class="card-value">${avgSec}<span class="card-unit">s</span></div>
      </div>
    </div>
  `;
}

// Aggregate events.jsonl into counts per event type, split across three time
// windows. "Today" is the calendar day in the server's UTC wall clock —
// close enough to America/New_York that the boss's "today so far" reading
// matches reality within a few hours near midnight. Good enough for ops.
function computeEngagement(events) {
  const nowMs = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  const sevenDaysAgoMs = nowMs - 7 * DAY_MS;

  const EVENT_TYPES = [
    'call_click', 'schedule_click', 'form_start', 'form_error',
    'learn_more_click', 'slider_move', 'tab_click', 'faq_click', 'page_view'
  ];
  const counts = {};
  EVENT_TYPES.forEach(function(k) { counts[k] = { all: 0, today: 0, week: 0 }; });

  let scheduleSubmits = { all: 0, today: 0, week: 0 };

  for (const e of events) {
    const t = Date.parse(e.savedAt || e.ts || 0);
    if (!counts[e.event]) continue;
    counts[e.event].all++;
    if (t >= sevenDaysAgoMs) counts[e.event].week++;
    if (t >= startOfTodayMs) counts[e.event].today++;
    // schedule_click events with {submitted:true} are actual form completions
    if (e.event === 'schedule_click' && e.meta && e.meta.submitted) {
      scheduleSubmits.all++;
      if (t >= sevenDaysAgoMs) scheduleSubmits.week++;
      if (t >= startOfTodayMs) scheduleSubmits.today++;
    }
  }

  return { counts: counts, scheduleSubmits: scheduleSubmits };
}

function renderEngagementCards(engagement, leads, events) {
  // "Submitted the form" preferentially uses the leads table (the persisted
  // ground truth). Event counts are a secondary signal in case the volume
  // lost data between a deploy and now, or sendBeacon was blocked.
  const c = engagement.counts;

  // Build the per-card detail panels. Each click on a card toggles the
  // matching panel; only one panel open at a time.
  // For form submissions we pull rows from the leads list (has names).
  // For everything else we filter the events log.
  const leadsPanel = renderLeadsDetailPanel(leads.slice().reverse());
  const byEvent = {
    call_click:       renderEventsDetailPanel(events, 'call_click'),
    schedule_opens:   renderScheduleOpensPanel(events, leads),
    learn_more_click: renderEventsDetailPanel(events, 'learn_more_click'),
    tab_click:        renderEventsDetailPanel(events, 'tab_click'),
    faq_click:        renderEventsDetailPanel(events, 'faq_click'),
    page_view:        renderEventsDetailPanel(events, 'page_view')
  };

  // Each card gets a data-panel pointing to the <div> it reveals.
  const card = function(panelKey, label, color, total, today, week, note) {
    return `
      <div class="eng-card" data-panel="${panelKey}" style="border-top-color:${color}" tabindex="0" role="button" aria-label="${label} — click to view details">
        <div class="eng-label">${label}</div>
        <div class="eng-value">${total.toLocaleString()}</div>
        <div class="eng-breakdown">
          <span title="Since midnight local">Today: <b>${today}</b></span>
          <span title="Last 7 days">7d: <b>${week}</b></span>
        </div>
        ${note ? `<div class="eng-note">${note}</div>` : ''}
        <div class="eng-expand">↓ click to view</div>
      </div>
    `;
  };

  const openGap = c.schedule_click.all - engagement.scheduleSubmits.all;

  return `
    <div class="eng-section">
      <div class="eng-title">Engagement — click any card to see the details</div>
      <div class="eng-cards">
        ${card('form_submissions', '📋 Form submissions', '#1a7a6d',
            leads.length,
            engagement.scheduleSubmits.today, engagement.scheduleSubmits.week,
            'Actual completed leads — names / phones / emails inside')}
        ${card('call_click', '📞 Call button clicks', '#19a4ac',
            c.call_click.all, c.call_click.today, c.call_click.week,
            'Every phone-call CTA tapped')}
        ${card('schedule_opens', '🗓 Schedule opens (no submit)', '#435a6a',
            Math.max(0, openGap),
            Math.max(0, c.schedule_click.today - engagement.scheduleSubmits.today),
            Math.max(0, c.schedule_click.week - engagement.scheduleSubmits.week),
            'Opened the form but didn\u2019t submit')}
        ${card('learn_more_click', '📖 Learn More', '#8a95a0',
            c.learn_more_click.all, c.learn_more_click.today, c.learn_more_click.week)}
        ${card('tab_click', '📑 Tab clicks', '#8a95a0',
            c.tab_click.all, c.tab_click.today, c.tab_click.week,
            'How-It-Works tabs')}
        ${card('faq_click', '❓ FAQ opens', '#8a95a0',
            c.faq_click.all, c.faq_click.today, c.faq_click.week)}
        ${card('page_view', '👀 Page views', '#0b304a',
            c.page_view.all, c.page_view.today, c.page_view.week,
            'One beacon per page load')}
      </div>

      <div class="eng-panels">
        <div class="eng-panel" data-panel="form_submissions" hidden>
          <div class="eng-panel-title">📋 Form submissions (${leads.length})</div>
          ${leadsPanel}
        </div>
        <div class="eng-panel" data-panel="call_click" hidden>
          <div class="eng-panel-title">📞 Call button clicks (${c.call_click.all})</div>
          ${byEvent.call_click}
        </div>
        <div class="eng-panel" data-panel="schedule_opens" hidden>
          <div class="eng-panel-title">🗓 Schedule opens that didn\u2019t submit (${Math.max(0, openGap)})</div>
          ${byEvent.schedule_opens}
        </div>
        <div class="eng-panel" data-panel="learn_more_click" hidden>
          <div class="eng-panel-title">📖 Learn More clicks (${c.learn_more_click.all})</div>
          ${byEvent.learn_more_click}
        </div>
        <div class="eng-panel" data-panel="tab_click" hidden>
          <div class="eng-panel-title">📑 Tab clicks (${c.tab_click.all})</div>
          ${byEvent.tab_click}
        </div>
        <div class="eng-panel" data-panel="faq_click" hidden>
          <div class="eng-panel-title">❓ FAQ opens (${c.faq_click.all})</div>
          ${byEvent.faq_click}
        </div>
        <div class="eng-panel" data-panel="page_view" hidden>
          <div class="eng-panel-title">👀 Page views (${c.page_view.all})</div>
          ${byEvent.page_view}
        </div>
      </div>
    </div>
  `;
}

// Session timing — bot vs. human heuristic.
//
// Walks events.jsonl, groups by meta.sid (random per-pageload id stamped
// by tracker.js), and for each session computes:
//   duration_ms      — from session_end meta if present, else last - first
//                      observed event timestamp.
//   first_click_ms   — from time_to_first_click meta if present.
//   interactions     — count of meaningful clicks (everything but
//                      page_view/session_end/time_to_first_click).
//   variant          — 'a' / 'b' (server-stamped on each event).
//
// We then surface medians + bot-shape buckets:
//   <3s sessions         — instant bounce, near-certain bot
//   0-interaction sessions — landed and left without touching anything
//   <500ms first click   — automation, not a real tap
//   long humans          — >30s with >=1 interaction
//
// Older events (pre-tracker session-id) get a synthetic sid so they don't
// pollute the bot bucket. We just skip sessions with no sid in meta.
function computeSessionMetrics(events) {
  const sessions = new Map(); // sid -> { firstMs, lastMs, durationMs, firstClickMs, interactions, variant }
  const NON_INTERACTION = new Set(['page_view', 'session_end', 'time_to_first_click']);

  for (const e of events) {
    const sid = e.meta && e.meta.sid;
    if (!sid) continue;
    const t = Date.parse(e.savedAt || e.ts || 0);
    if (!isFinite(t)) continue;
    let s = sessions.get(sid);
    if (!s) {
      s = {
        firstMs: t, lastMs: t,
        durationMs: null, firstClickMs: null,
        interactions: 0, variant: null
      };
      sessions.set(sid, s);
    }
    if (t < s.firstMs) s.firstMs = t;
    if (t > s.lastMs)  s.lastMs  = t;
    if (!s.variant && (e.variant === 'a' || e.variant === 'b')) s.variant = e.variant;
    if (e.event === 'session_end' && e.meta && typeof e.meta.duration_ms === 'number') {
      s.durationMs = e.meta.duration_ms;
    }
    if (e.event === 'time_to_first_click' && e.meta && typeof e.meta.ms_to_first === 'number') {
      s.firstClickMs = e.meta.ms_to_first;
    }
    if (!NON_INTERACTION.has(e.event)) s.interactions++;
  }

  // Backfill duration from observed timestamps if no session_end fired
  for (const s of sessions.values()) {
    if (s.durationMs == null) s.durationMs = Math.max(0, s.lastMs - s.firstMs);
  }

  function median(arr) {
    if (!arr.length) return 0;
    const sorted = arr.slice().sort(function(x, y) { return x - y; });
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
  }

  function bucket(filter) {
    const list = Array.from(sessions.values()).filter(filter);
    const durations = list.map(function(s) { return s.durationMs; });
    const firstClicks = list.map(function(s) { return s.firstClickMs; })
      .filter(function(v) { return typeof v === 'number'; });
    const fastBounce = list.filter(function(s) { return s.durationMs < 3000; }).length;
    const noInteract = list.filter(function(s) { return s.interactions === 0; }).length;
    const instaClick = firstClicks.filter(function(v) { return v < 500; }).length;
    const longHuman  = list.filter(function(s) { return s.durationMs >= 30000 && s.interactions >= 1; }).length;
    return {
      total: list.length,
      medianDurationMs: median(durations),
      medianFirstClickMs: median(firstClicks),
      fastBounce: fastBounce,
      fastBouncePct: list.length ? Math.round(fastBounce * 100 / list.length) : 0,
      noInteract: noInteract,
      noInteractPct: list.length ? Math.round(noInteract * 100 / list.length) : 0,
      instaClick: instaClick,
      longHuman: longHuman,
      longHumanPct: list.length ? Math.round(longHuman * 100 / list.length) : 0
    };
  }

  return {
    overall: bucket(function() { return true; }),
    a:       bucket(function(s) { return s.variant === 'a'; }),
    b:       bucket(function(s) { return s.variant === 'b'; })
  };
}

function fmtMs(ms) {
  if (!ms || ms < 0) return '\u2014';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return m + 'm ' + s + 's';
}

function renderSessionMetricsCards(metrics) {
  const o = metrics.overall;
  const a = metrics.a;
  const b = metrics.b;
  if (!o.total) return '';
  // One block per metric, with the variant split underneath. Color cues:
  // green = healthy human signal, red = likely-bot signal, gray = neutral.
  const card = function(label, value, color, sub, note) {
    return `
      <div class="eng-card" style="border-top-color:${color};cursor:default">
        <div class="eng-label">${label}</div>
        <div class="eng-value" style="font-size:1.6rem">${value}</div>
        <div class="eng-breakdown">${sub}</div>
        ${note ? `<div class="eng-note">${note}</div>` : ''}
      </div>
    `;
  };
  const split = function(aVal, bVal) {
    return `<span title="Variant A">A: <b>${aVal}</b></span> <span title="Variant B">B: <b>${bVal}</b></span>`;
  };
  return `
    <div class="eng-section">
      <div class="eng-title">Session quality \u2014 time on site, time-to-click, bot-shape buckets</div>
      <div class="eng-cards">
        ${card('\u23F1 Median time on site',
            fmtMs(o.medianDurationMs), '#1a7a6d',
            split(fmtMs(a.medianDurationMs), fmtMs(b.medianDurationMs)),
            'How long the median visitor sticks around')}
        ${card('\u23F2 Median time-to-first-click',
            fmtMs(o.medianFirstClickMs), '#19a4ac',
            split(fmtMs(a.medianFirstClickMs), fmtMs(b.medianFirstClickMs)),
            'Real users pause to read; bots click fast')}
        ${card('\u26A0 Bounced under 3s',
            o.fastBouncePct + '% (' + o.fastBounce + ')', '#c0392b',
            split(a.fastBouncePct + '%', b.fastBouncePct + '%'),
            'Likely bots / accidental opens')}
        ${card('\uD83D\uDC7B 0 interactions',
            o.noInteractPct + '% (' + o.noInteract + ')', '#7f8c8d',
            split(a.noInteractPct + '%', b.noInteractPct + '%'),
            'Landed, didn\u2019t touch a thing')}
        ${card('\uD83E\uDD16 Insta-click <500ms',
            o.instaClick.toString(), '#c0392b',
            split(a.instaClick, b.instaClick),
            'Faster than human reaction time')}
        ${card('\uD83D\uDC64 Engaged \u226530s + click',
            o.longHumanPct + '% (' + o.longHuman + ')', '#1a7a6d',
            split(a.longHumanPct + '%', b.longHumanPct + '%'),
            'Real evaluators worth optimizing for')}
        ${card('\uD83D\uDCDA Sessions with timing',
            o.total.toLocaleString(), '#0b304a',
            split(a.total, b.total),
            'Pageloads with the new tracker SID')}
      </div>
    </div>
  `;
}

// Newest-first mini-table of leads — name, phone, email, state, debt, time.
// Same shape as the big leads table but trimmed and shown inline when the
// user taps the "Form submissions" card.
function renderLeadsDetailPanel(leadsNewestFirst) {
  if (!leadsNewestFirst.length) {
    return '<div class="eng-empty">No form submissions yet.</div>';
  }
  const rows = leadsNewestFirst.map(function(l) {
    return `
      <tr>
        <td class="muted">${htmlEscape(fmtTime(l.savedAt))}</td>
        <td><b>${htmlEscape((l.fname || '') + ' ' + (l.lname || ''))}</b></td>
        <td><a href="tel:${htmlEscape(l.phone)}">${htmlEscape(fmtPhone(l.phone))}</a></td>
        <td><a href="mailto:${htmlEscape(l.email)}">${htmlEscape(l.email)}</a></td>
        <td>${htmlEscape(l.state)}</td>
        <td>$${Number(l.debtUSD || 0).toLocaleString()}</td>
        <td>${htmlEscape(l.calltime)}</td>
      </tr>
    `;
  }).join('');
  return `
    <table class="eng-table">
      <thead><tr><th>Time</th><th>Name</th><th>Phone</th><th>Email</th><th>State</th><th>Debt</th><th>Callback</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Generic event panel: time / details / IP / UA. Shows the 200 newest
// matching events (anything older is there in /admin/events.json if
// someone needs it).
function renderEventsDetailPanel(events, eventType) {
  const matching = events
    .filter(function(e) { return e.event === eventType; })
    .slice(-200)
    .reverse();
  if (!matching.length) {
    return '<div class="eng-empty">No events of this type recorded yet.</div>';
  }
  const rows = matching.map(function(e) {
    let detail = '';
    if (e.meta && typeof e.meta === 'object') {
      const parts = [];
      for (const k of Object.keys(e.meta)) {
        parts.push(htmlEscape(k) + ': ' + htmlEscape(String(e.meta[k]).slice(0, 60)));
      }
      detail = parts.join(' · ');
    }
    return `
      <tr>
        <td class="muted">${htmlEscape(fmtTime(e.savedAt))}</td>
        <td>${detail}</td>
        <td class="muted">${htmlEscape(e.ip || '')}</td>
        <td class="muted ua">${htmlEscape((e.ua || '').slice(0, 80))}</td>
      </tr>
    `;
  }).join('');
  return `
    <table class="eng-table">
      <thead><tr><th>Time</th><th>Details</th><th>IP</th><th>User-Agent</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// "Schedule opens that didn't submit" = schedule_click events whose meta
// does NOT say submitted:true AND whose IP never appears in the leads
// table. Approximation since we don't have a session id — good enough
// for "how many abandoned the form" reporting.
function renderScheduleOpensPanel(events, leads) {
  const submitterIps = new Set(leads.map(function(l) { return l.userip; }).filter(Boolean));
  const opens = events
    .filter(function(e) {
      return e.event === 'schedule_click'
        && !(e.meta && e.meta.submitted)
        && !submitterIps.has(e.ip);
    })
    .slice(-200)
    .reverse();
  if (!opens.length) {
    return '<div class="eng-empty">No unconverted schedule-opens yet.</div>';
  }
  const rows = opens.map(function(e) {
    return `
      <tr>
        <td class="muted">${htmlEscape(fmtTime(e.savedAt))}</td>
        <td class="muted">${htmlEscape(e.ip || '')}</td>
        <td class="muted ua">${htmlEscape((e.ua || '').slice(0, 80))}</td>
      </tr>
    `;
  }).join('');
  return `
    <table class="eng-table">
      <thead><tr><th>Time</th><th>IP</th><th>User-Agent</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderLeadsHtml(leads, queueStats) {
  const deliveriesByLeadId = latestDeliveryByLeadId();
  const summary = computeSummary(leads, queueStats ? { ...deliveriesByLeadId } : deliveriesByLeadId);
  const newest = leads.slice().reverse();
  const rows = newest.map((l, i) => {
    const d = l.leadId ? deliveriesByLeadId[l.leadId] : null;
    const statusKey = d ? d.status : 'unknown';
    const method = d && d.method ? d.method : '';
    const durationMs = d && d.durationMs ? d.durationMs : null;
    const deliveryMeta = [];
    if (method && method !== 'none') deliveryMeta.push(method);
    if (durationMs) deliveryMeta.push((durationMs / 1000).toFixed(1) + 's');
    if (d && d.error) deliveryMeta.push(htmlEscape(String(d.error).slice(0, 60)));
    const bucket = callbackBucket(l.calltime);
    return `
    <tr data-calltime="${htmlEscape(bucket)}">
      <td>${newest.length - i}</td>
      <td class="muted">${htmlEscape(fmtTime(l.savedAt))}</td>
      <td>${renderStatusPill(statusKey)}${deliveryMeta.length ? `<div class="delivery-meta">${deliveryMeta.map(htmlEscape).join(' · ')}</div>` : ''}</td>
      <td>${htmlEscape((l.fname || '') + ' ' + (l.lname || ''))}</td>
      <td><a href="tel:${htmlEscape(l.phone)}">${htmlEscape(fmtPhone(l.phone))}</a></td>
      <td><a href="mailto:${htmlEscape(l.email)}">${htmlEscape(l.email)}</a></td>
      <td>${htmlEscape(l.state)}</td>
      <td>$${Number(l.debtUSD || 0).toLocaleString()}</td>
      <td>${htmlEscape(l.dob)}</td>
      <td>${htmlEscape(l.calltime)}</td>
      <td class="muted">${htmlEscape(l.utm && l.utm.source || '')}</td>
    </tr>
  `;
  }).join('');

  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Leads · Admin</title>
  <meta http-equiv="refresh" content="30" id="autoRefreshMeta">
  <style>
    *{box-sizing:border-box}
    body{font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f4f6f8;margin:0;padding:24px;color:#222}
    .wrap{max-width:1400px;margin:0 auto}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px}
    h1{margin:0;color:#0b304a;font-size:26px}
    .count{color:#666;font-size:13px;margin-top:2px}
    .auto-refresh{color:#8a95a0;font-size:11px;margin-top:2px}
    .actions a{display:inline-block;background:#19a4ac;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;margin-left:8px;font-weight:600;font-size:13px}
    .actions a.alt{background:#0b304a}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
    .card{background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.05);border-top:4px solid #d8dde3}
    .card.ok{border-top-color:#1a7a6d}
    .card.warn{border-top-color:#e29a3a}
    .card.err{border-top-color:#c0392b}
    .card-label{font-size:11px;font-weight:700;color:#7a848c;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
    .card-value{font-size:28px;font-weight:900;color:#0b304a;line-height:1}
    .card-unit{font-size:14px;color:#8a95a0;margin-left:2px}
    .card-sub{font-size:11px;color:#8a95a0;margin-top:4px}
    table{width:100%;background:#fff;border-collapse:collapse;box-shadow:0 1px 3px rgba(0,0,0,.08);border-radius:8px;overflow:hidden}
    th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #eef1f4;font-size:13px;white-space:nowrap;vertical-align:top}
    th{background:#fafbfc;font-weight:700;color:#555;font-size:11px;letter-spacing:.5px;text-transform:uppercase}
    tr:hover td{background:#f8fafc}
    td a{color:#19a4ac;text-decoration:none}
    td a:hover{text-decoration:underline}
    .muted{color:#8a95a0}
    .pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px}
    .callback-filter{background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
    .cb-title{font-size:10px;font-weight:800;color:#7a848c;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px}
    .cb-chips{display:flex;flex-wrap:wrap;gap:6px}
    .cb-chip{display:inline-flex;align-items:center;gap:6px;background:#f4f6f8;border:1px solid #e1e7ec;color:#4a5863;padding:7px 12px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;font-family:inherit}
    .cb-chip:hover{background:#eaf0f4;color:#0b304a}
    .cb-chip.active{background:#0b304a;color:#fff;border-color:#0b304a}
    .cb-chip.active .cb-chip-count{background:rgba(255,255,255,.2);color:#fff}
    .cb-chip-icon{font-size:13px;line-height:1}
    .cb-chip-count{display:inline-block;background:#fff;color:#0b304a;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:800;min-width:18px;text-align:center}
    .delivery-meta{font-size:10px;color:#8a95a0;margin-top:4px}
    .empty{padding:60px;text-align:center;color:#8a95a0;background:#fff;border-radius:8px}
    .search{margin-bottom:12px;padding:10px 14px;border:1px solid #d8dde3;border-radius:6px;width:100%;font-size:14px;background:#fff}
    .eng-section{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
    .eng-title{font-size:11px;font-weight:800;color:#7a848c;text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px}
    .eng-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
    .eng-card{background:#f8fafc;border-radius:8px;padding:12px 14px;border-top:3px solid #d8dde3}
    .eng-label{font-size:11px;font-weight:700;color:#4a5863;margin-bottom:4px}
    .eng-value{font-size:24px;font-weight:900;color:#0b304a;line-height:1}
    .eng-breakdown{font-size:11px;color:#6a747d;margin-top:4px;display:flex;gap:12px}
    .eng-breakdown b{color:#0b304a;font-weight:700}
    .eng-note{font-size:10px;color:#8a95a0;margin-top:6px;line-height:1.35}
    .eng-card{cursor:pointer;transition:transform .12s, box-shadow .12s, background .12s}
    .eng-card:hover{background:#fff;box-shadow:0 2px 6px rgba(11,48,74,.08);transform:translateY(-1px)}
    .eng-card.active{background:#fff;box-shadow:0 2px 8px rgba(11,48,74,.15);outline:2px solid #19a4ac;outline-offset:-2px}
    .eng-expand{font-size:10px;color:#19a4ac;margin-top:6px;font-weight:700;letter-spacing:.3px}
    .eng-card.active .eng-expand{color:#0b304a}
    .eng-card.active .eng-expand::after{content:' (close)'}
    .eng-panel{background:#fff;border-radius:8px;margin-top:14px;padding:14px 16px;border:1px solid #e1e7ec;max-height:520px;overflow:auto}
    .eng-panel-title{font-size:13px;font-weight:800;color:#0b304a;margin-bottom:10px}
    .eng-table{width:100%;border-collapse:collapse;font-size:12px}
    .eng-table th{text-align:left;padding:6px 10px;font-size:10px;color:#7a848c;border-bottom:1px solid #eef1f4;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:#fafbfc}
    .eng-table td{padding:7px 10px;border-bottom:1px solid #f2f4f7;font-size:12px;vertical-align:top}
    .eng-table td.ua{font-size:10px;color:#8a95a0;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .eng-table tr:hover td{background:#f8fafc}
    .eng-table a{color:#19a4ac;text-decoration:none}
    .eng-table a:hover{text-decoration:underline}
    .eng-empty{padding:24px;text-align:center;color:#8a95a0;font-size:12px}
  </style>
</head><body>
<div class="wrap">
  <div class="header">
    <div>
      <h1>Leads</h1>
      <div class="count">${leads.length} total · newest first</div>
      <div class="auto-refresh">Auto-refreshes every 30 seconds · Last loaded ${new Date().toLocaleString()}</div>
    </div>
    <div class="actions">
      <a href="/admin/jarvis" style="background:#0e1726;color:#19c8d2;border:1px solid #19c8d2">⚡ Mission Control</a>
      <a href="/admin/leads" style="background:#19a4ac">Refresh now</a>
      <a href="/admin/leads.csv" class="alt">Download CSV</a>
      <a href="/admin/leads.json" class="alt">JSON</a>
    </div>
  </div>

  ${renderSummaryCards(summary, queueStats || { pending: 0, size: 0, maxSize: 30 })}

  ${(function() {
    const events = readAllEvents();
    return renderEngagementCards(computeEngagement(events), leads, events) +
           renderSessionMetricsCards(computeSessionMetrics(events));
  })()}

  ${leads.length === 0 ? `
    <div class="empty">No form submissions yet — but call clicks and page views are still being tracked in the Engagement card above. Submit one on the public site to see it appear here.</div>
  ` : `
    ${renderCallbackFilter(leads)}
    <input class="search" id="q" placeholder="Search name, email, phone, state, status…" oninput="filter()">
    <table id="tbl">
      <thead><tr>
        <th>#</th><th>Time</th><th>Status</th><th>Name</th><th>Phone</th><th>Email</th><th>State</th><th>Debt</th><th>DOB</th><th>Callback</th><th>UTM</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `}
</div>
<script>
// Current filter state, composed from: (a) callback-time chip and
// (b) free-text search box. A row is visible only when it passes both.
var activeChip = '';
function applyFilters(){
  var q = (document.getElementById('q').value || '').toLowerCase();
  document.querySelectorAll('#tbl tbody tr').forEach(function(r){
    var chipMatch = !activeChip || r.getAttribute('data-calltime') === activeChip;
    var textMatch = !q || r.innerText.toLowerCase().indexOf(q) >= 0;
    r.style.display = (chipMatch && textMatch) ? '' : 'none';
  });
}
function filter(){ applyFilters(); }  // existing search uses this name
document.querySelectorAll('.cb-chip').forEach(function(btn){
  btn.addEventListener('click', function(){
    document.querySelectorAll('.cb-chip').forEach(function(b){ b.classList.remove('active'); });
    btn.classList.add('active');
    activeChip = btn.getAttribute('data-filter') || '';
    applyFilters();
  });
});

// Engagement card click → toggle the matching detail panel. Only one open
// at a time. While any panel is open we disable the meta-refresh so the
// user's inspection doesn't get wiped mid-scroll.
(function(){
  var cards = document.querySelectorAll('.eng-card');
  var panels = document.querySelectorAll('.eng-panel');
  function closeAll(){
    cards.forEach(function(c){ c.classList.remove('active'); });
    panels.forEach(function(p){ p.hidden = true; });
  }
  function setRefresh(enabled){
    var m = document.getElementById('autoRefreshMeta');
    if (!m) return;
    if (enabled) m.setAttribute('content', '30');
    else m.removeAttribute('content');
  }
  cards.forEach(function(card){
    card.addEventListener('click', function(){
      var key = card.getAttribute('data-panel');
      var target = document.querySelector('.eng-panel[data-panel="' + key + '"]');
      var isOpen = card.classList.contains('active');
      closeAll();
      if (!isOpen && target){
        card.classList.add('active');
        target.hidden = false;
        setRefresh(false);
        // Scroll the panel into view but keep cards visible for context
        setTimeout(function(){
          target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      } else {
        setRefresh(true);
      }
    });
    card.addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
    });
  });
})();
</script>
</body></html>`;
}

function toCsv(leads) {
  const header = ['savedAt','fname','lname','phone','email','dob','state','debtUSD','calltime','userip','utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.join(',')];
  for (const l of leads) {
    lines.push([
      l.savedAt, l.fname, l.lname, l.phone, l.email, l.dob, l.state, l.debtUSD, l.calltime, l.userip,
      l.utm && l.utm.source, l.utm && l.utm.medium, l.utm && l.utm.campaign, l.utm && l.utm.content, l.utm && l.utm.term,
      l.click && l.click.gclid, l.click && l.click.fbclid
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

router.get('/leads', requireAdmin, async (req, res) => {
  let queueStats = null;
  try { queueStats = await getStats(); } catch (_) {}
  res.type('html').send(renderLeadsHtml(readAllLeads(), queueStats));
});

router.get('/leads.csv', requireAdmin, (req, res) => {
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="leads-' + new Date().toISOString().slice(0,10) + '.csv"');
  res.send(toCsv(readAllLeads()));
});

router.get('/leads.json', requireAdmin, (req, res) => {
  res.json(readAllLeads());
});

router.get('/stats', requireAdmin, (req, res) => {
  const engagement = computeEngagement(readAllEvents());
  res.json({
    leads: leadCount(),
    engagement: engagement,
    dataFile: getDataFilePath()
  });
});

// Raw event log for debugging / Excel exports
router.get('/events.json', requireAdmin, (req, res) => {
  res.json(readAllEvents());
});

/* ============================================================
   A/B test stats + suspicious-traffic analysis
   ============================================================
   /admin/api/ab-stats       → JSON snapshot of variant performance,
                                config state, and flagged IPs.
   /admin/api/ab-config      → POST { mode, weightB } to update split.
   /admin/jarvis             → "Mission Control" dashboard HTML.
*/

// Anything matching this regex on the User-Agent string is treated as a
// likely-bot signal. Conservative — false positives waste a row in the
// admin panel; false negatives let botnets pad event counts.
const BOT_UA_RX = /(curl|wget|python-requests|python\/|httpclient|libwww|java\/|go-http|node-fetch|axios|okhttp|headlesschrome|phantomjs|puppeteer|playwright|selenium|crawler|spider|bot\b|scrape)/i;

function isBotUA(ua) {
  if (!ua) return true; // missing UA is itself suspicious
  return BOT_UA_RX.test(ua);
}

/**
 * Build a per-IP rollup from the event log. Returns an array of:
 *   { ip, events, calls, schedules, pageViews, variants:Set, sampleUA,
 *     firstAt, lastAt, maxBurstPerMin, flags:[reasons] }
 *
 * Flags applied:
 *   BOT-UA          User-Agent matches BOT_UA_RX or is missing
 *   NO-CALLS        ≥10 events but zero call_clicks
 *   MULTI-VARIANT   Same IP saw both 'a' and 'b' (cookie clearing /
 *                   shared NAT — combined with high volume = bot signal)
 *   RAPID-FIRE      Any 60-second window had ≥20 events from this IP
 *   HIGH-VOLUME     ≥50 events from one IP in last 24h (just informational)
 */
function analyzeIPs(events) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const byIp = {};

  for (const e of events) {
    const ip = e.ip || '';
    if (!ip) continue;
    if (!byIp[ip]) {
      byIp[ip] = {
        ip,
        events: 0,
        calls: 0,
        schedules: 0,
        pageViews: 0,
        formStarts: 0,
        variants: new Set(),
        sampleUA: e.ua || '',
        firstAt: e.savedAt,
        lastAt: e.savedAt,
        timestamps: []
      };
    }
    const r = byIp[ip];
    r.events++;
    if (e.event === 'call_click') r.calls++;
    if (e.event === 'schedule_click') r.schedules++;
    if (e.event === 'page_view') r.pageViews++;
    if (e.event === 'form_start') r.formStarts++;
    if (e.variant === 'a' || e.variant === 'b') r.variants.add(e.variant);
    if (e.savedAt) {
      r.lastAt = e.savedAt;
      const t = Date.parse(e.savedAt);
      if (isFinite(t)) r.timestamps.push(t);
    }
    // Keep the earliest UA so we can detect bot UAs even if they later
    // rotated to a real-looking one.
    if (e.ua && (!r.sampleUA || isBotUA(r.sampleUA) === false && isBotUA(e.ua))) {
      r.sampleUA = e.ua;
    }
  }

  const rows = [];
  for (const ip of Object.keys(byIp)) {
    const r = byIp[ip];
    // Compute the worst 60-second burst by sliding window over sorted ts
    r.timestamps.sort((a, b) => a - b);
    let maxBurst = 0;
    let j = 0;
    for (let i = 0; i < r.timestamps.length; i++) {
      while (r.timestamps[i] - r.timestamps[j] > 60_000) j++;
      const burst = i - j + 1;
      if (burst > maxBurst) maxBurst = burst;
    }
    r.maxBurstPerMin = maxBurst;

    // Recent (24h) event count for the HIGH-VOLUME flag
    let recent = 0;
    for (const t of r.timestamps) {
      if (nowMs - t < DAY_MS) recent++;
    }
    r.events24h = recent;

    const flags = [];
    if (isBotUA(r.sampleUA)) flags.push('BOT-UA');
    if (r.events >= 10 && r.calls === 0) flags.push('NO-CALLS');
    if (r.variants.size >= 2) flags.push('MULTI-VARIANT');
    if (r.maxBurstPerMin >= 20) flags.push('RAPID-FIRE');
    if (r.events24h >= 50) flags.push('HIGH-VOLUME');
    r.flags = flags;

    rows.push({
      ip: r.ip,
      events: r.events,
      events24h: r.events24h,
      calls: r.calls,
      schedules: r.schedules,
      pageViews: r.pageViews,
      formStarts: r.formStarts,
      variants: Array.from(r.variants),
      sampleUA: r.sampleUA.slice(0, 140),
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      maxBurstPerMin: r.maxBurstPerMin,
      flags: r.flags,
      // Internal sort weight: more flags + more events = more suspicious
      _sortKey: flags.length * 1000 + Math.min(r.events, 999)
    });
  }

  // Suspicious = at least one flag. Top of list = most suspicious.
  const suspicious = rows
    .filter((r) => r.flags.length > 0)
    .sort((a, b) => b._sortKey - a._sortKey)
    .slice(0, 100);

  // Top by raw volume regardless of flags (so legitimate hot IPs are visible)
  const topByVolume = rows
    .slice()
    .sort((a, b) => b.events - a.events)
    .slice(0, 25);

  return {
    totalIps: rows.length,
    suspiciousCount: suspicious.length,
    suspicious,
    topByVolume
  };
}

/**
 * Build a complete A/B stats snapshot. Returns:
 *   {
 *     config: {...},
 *     variants: { a: {...}, b: {...} },
 *     leader: 'a' | 'b' | null,
 *     deltaPct: number,        // +X% means leader is X% better
 *     suspicious: { suspicious:[...], topByVolume:[...], totalIps, ... }
 *   }
 */
function buildAbSnapshot() {
  const events = readAllEvents();
  const tally = abConfig.tallyByVariant(events);
  const cfg = abConfig.get();

  const fmtVariant = (key) => {
    const t = tally[key];
    const pv = t.pv;
    const calls = t.calls;
    const convRate = pv > 0 ? calls / pv : 0;
    return {
      pageViews: pv,
      calls: calls,
      schedules: t.schedules,
      formStarts: t.forms,
      conversionRate: convRate,
      conversionPct: (convRate * 100).toFixed(2)
    };
  };

  const a = fmtVariant('a');
  const b = fmtVariant('b');

  // Leader = whichever variant has the higher conversion rate, but only
  // declare a winner if BOTH have at least the cold-start threshold.
  // Otherwise we surface "TBD" so the admin doesn't read a leader off
  // 5 sample points.
  let leader = null;
  let deltaPct = 0;
  if (a.pageViews >= abConfig.COLD_START_MIN_PAGEVIEWS &&
      b.pageViews >= abConfig.COLD_START_MIN_PAGEVIEWS &&
      (a.calls + b.calls) > 0) {
    if (a.conversionRate > b.conversionRate) {
      leader = 'a';
      deltaPct = b.conversionRate > 0
        ? ((a.conversionRate - b.conversionRate) / b.conversionRate) * 100
        : 100;
    } else if (b.conversionRate > a.conversionRate) {
      leader = 'b';
      deltaPct = a.conversionRate > 0
        ? ((b.conversionRate - a.conversionRate) / a.conversionRate) * 100
        : 100;
    }
  }

  return {
    config: {
      mode: cfg.mode,
      weightB: cfg.weightB,
      weightA: 1 - cfg.weightB,
      coldStartMin: abConfig.COLD_START_MIN_PAGEVIEWS,
      weightFloor: abConfig.WEIGHT_FLOOR,
      weightCeil: abConfig.WEIGHT_CEIL,
      updatedAt: cfg.updatedAt,
      updatedBy: cfg.updatedBy,
      history: (cfg.history || []).slice(-20)
    },
    variants: { a, b },
    leader,
    deltaPct: Math.round(deltaPct * 10) / 10,
    suspicious: analyzeIPs(events),
    serverNow: new Date().toISOString()
  };
}

router.get('/api/ab-stats', requireAdmin, (req, res) => {
  res.json(buildAbSnapshot());
});

router.post('/api/ab-config', requireAdmin, (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const patch = {};
  if (body.mode === 'manual' || body.mode === 'auto') patch.mode = body.mode;
  if (body.weightB != null) {
    const w = Number(body.weightB);
    if (isFinite(w)) patch.weightB = w;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: 'Nothing to update' });
  }
  // Tag with the basic-auth username so the audit trail in history.updatedBy
  // is more useful than just "admin".
  let by = 'admin';
  try {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) by = decoded.slice(0, idx) || 'admin';
    }
  } catch (_) {}
  const updated = abConfig.update(patch, by);
  res.json({ ok: true, config: updated });
});

router.get('/jarvis', requireAdmin, (req, res) => {
  res.type('html').send(renderJarvisHtml());
});

function renderJarvisHtml() {
  // The dashboard polls /admin/api/ab-stats every 4s and re-renders. All
  // computation happens server-side; the page is just a presentation
  // shell. Stats come back as JSON, and the front-end painter swaps
  // numbers in place so the screen feels live without flicker.
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control · United Settlement</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#05080d; --bg2:#0a1320; --panel:#0e1726; --panel-2:#13202f;
    --line:#1c2c41; --line-soft:#172435;
    --cyan:#19c8d2; --cyan-bright:#3df5ff; --cyan-soft:#0e6e76;
    --red:#ff3b48; --red-soft:#7a1820;
    --green:#2ecc8c; --amber:#f5b400;
    --text:#cfe3f0; --text-dim:#7a8fa3; --text-muted:#4d6378;
    --mono:'SF Mono','Menlo','Consolas','Roboto Mono',monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  }
  html,body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh}
  body{
    background:
      radial-gradient(1200px 800px at 50% -20%, rgba(25,200,210,.07) 0%, transparent 60%),
      radial-gradient(800px 600px at 100% 100%, rgba(255,59,72,.05) 0%, transparent 70%),
      linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
    background-attachment:fixed;
  }
  body::before{
    content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
    background-image:
      linear-gradient(0deg, rgba(25,200,210,.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(25,200,210,.03) 1px, transparent 1px);
    background-size:44px 44px;
    mask-image:radial-gradient(ellipse at 50% 30%, #000 30%, transparent 80%);
  }
  .wrap{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:24px}

  /* Top bar */
  .topbar{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:24px}
  .brand{display:flex;align-items:center;gap:12px}
  .brand-mark{width:34px;height:34px;border-radius:8px;background:linear-gradient(135deg,var(--cyan) 0%, var(--cyan-soft) 100%);display:flex;align-items:center;justify-content:center;color:#001216;font-weight:900;font-family:var(--mono);font-size:18px;box-shadow:0 0 22px rgba(25,200,210,.4)}
  .brand-text{display:flex;flex-direction:column}
  .brand-title{font-family:var(--mono);font-size:14px;font-weight:700;color:var(--cyan);letter-spacing:3px;text-transform:uppercase}
  .brand-sub{font-size:11px;color:var(--text-dim);letter-spacing:1.5px;text-transform:uppercase}
  .topbar-right{display:flex;align-items:center;gap:14px}
  .live-pill{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--cyan-soft);border-radius:999px;font-family:var(--mono);font-size:11px;color:var(--cyan);text-transform:uppercase;letter-spacing:2px}
  .live-dot{width:7px;height:7px;border-radius:999px;background:var(--cyan);box-shadow:0 0 10px var(--cyan);animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.6;transform:scale(1)}50%{opacity:1;transform:scale(1.3)}}
  .topbar-time{font-family:var(--mono);font-size:12px;color:var(--text-dim);letter-spacing:1px}
  .topbar-link{font-family:var(--mono);font-size:11px;color:var(--text-dim);text-decoration:none;text-transform:uppercase;letter-spacing:1.5px;border:1px solid var(--line);padding:7px 12px;border-radius:6px;transition:all .15s}
  .topbar-link:hover{color:var(--cyan);border-color:var(--cyan-soft)}

  /* Section heading */
  .section-head{display:flex;align-items:center;gap:12px;margin:32px 0 14px}
  .section-bar{flex:1;height:1px;background:linear-gradient(90deg, var(--cyan-soft) 0%, transparent 100%)}
  .section-title{font-family:var(--mono);font-size:11px;color:var(--cyan);letter-spacing:3px;text-transform:uppercase;font-weight:700}

  /* Variant arms */
  .arms{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .arm{position:relative;background:linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);border:1px solid var(--line);border-radius:12px;padding:22px;overflow:hidden;transition:border-color .25s, box-shadow .25s}
  .arm.leader{border-color:var(--cyan);box-shadow:0 0 30px rgba(25,200,210,.25), inset 0 0 0 1px rgba(25,200,210,.15)}
  .arm-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
  .arm-tag{font-family:var(--mono);font-size:11px;color:var(--text-dim);letter-spacing:3px;text-transform:uppercase}
  .arm-name{font-size:22px;font-weight:900;color:var(--text);margin-top:2px;letter-spacing:-.3px}
  .arm-leader-pill{display:none;background:rgba(25,200,210,.12);border:1px solid var(--cyan-soft);color:var(--cyan);font-family:var(--mono);font-size:10px;font-weight:700;padding:4px 10px;border-radius:4px;letter-spacing:2px;text-transform:uppercase}
  .arm.leader .arm-leader-pill{display:inline-flex;align-items:center;gap:6px}
  .arm.leader .arm-leader-pill::before{content:'▲';color:var(--cyan)}
  .arm-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:18px}
  .stat{}
  .stat-label{font-family:var(--mono);font-size:10px;color:var(--text-muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:4px}
  .stat-value{font-family:var(--mono);font-size:32px;font-weight:700;color:var(--text);line-height:1;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
  .stat-value.big{font-size:40px;color:var(--cyan-bright)}
  .arm.leader .stat-value.big{text-shadow:0 0 18px rgba(61,245,255,.5)}
  .stat-unit{font-size:14px;color:var(--text-muted);font-weight:400;margin-left:4px}
  .arm-conv-line{padding-top:14px;border-top:1px solid var(--line-soft);font-family:var(--mono);font-size:11px;color:var(--text-dim);letter-spacing:1px}
  .arm-conv-line b{color:var(--cyan);font-weight:700}

  /* Verdict bar between arms */
  .verdict{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 22px;display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}
  .verdict-text{font-family:var(--mono);font-size:13px;letter-spacing:1px;color:var(--text-dim)}
  .verdict-text b{color:var(--text);font-weight:700}
  .verdict-text .delta{color:var(--cyan-bright);font-weight:700}
  .verdict-text.tbd{color:var(--text-muted)}

  /* Mode + slider control panel */
  .control{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px}
  .control-row{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:18px}
  .mode-toggle{display:inline-flex;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:3px;gap:0}
  .mode-btn{font-family:var(--mono);font-size:11px;letter-spacing:2px;text-transform:uppercase;background:transparent;border:none;color:var(--text-dim);padding:9px 18px;border-radius:999px;cursor:pointer;transition:all .2s}
  .mode-btn.active{background:var(--cyan);color:#001216;font-weight:800;box-shadow:0 0 16px rgba(25,200,210,.4)}
  .mode-btn:not(.active):hover{color:var(--text)}
  .control-meta{font-family:var(--mono);font-size:11px;color:var(--text-muted);letter-spacing:1px}
  .slider-row{display:flex;align-items:center;gap:18px}
  .slider-end{font-family:var(--mono);font-size:13px;letter-spacing:1px;font-weight:700;color:var(--text);min-width:70px}
  .slider-end.right{text-align:right}
  .slider-wrap{flex:1;position:relative;height:42px;display:flex;align-items:center}
  .slider-track{position:absolute;left:0;right:0;height:8px;border-radius:999px;background:linear-gradient(90deg, rgba(25,200,210,.18) 0%, rgba(25,200,210,.18) var(--w), rgba(255,255,255,.05) var(--w), rgba(255,255,255,.05) 100%);border:1px solid var(--line)}
  .slider-track::after{content:'';position:absolute;left:0;width:var(--w);top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg, rgba(255,59,72,.55) 0%, var(--cyan) 100%);box-shadow:0 0 14px rgba(25,200,210,.4)}
  .slider-input{position:relative;width:100%;-webkit-appearance:none;appearance:none;background:transparent;height:42px;cursor:pointer;z-index:2}
  .slider-input:disabled{cursor:not-allowed;opacity:.5}
  .slider-input::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:var(--cyan-bright);border:2px solid #001216;box-shadow:0 0 18px rgba(61,245,255,.6);cursor:pointer}
  .slider-input::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:var(--cyan-bright);border:2px solid #001216;box-shadow:0 0 18px rgba(61,245,255,.6);cursor:pointer}
  .ramp-history{margin-top:14px;padding-top:14px;border-top:1px solid var(--line-soft);font-family:var(--mono);font-size:11px;color:var(--text-muted);letter-spacing:.5px;line-height:1.7}
  .ramp-history b{color:var(--text-dim)}

  /* Suspicious traffic panel */
  .sus-panel{margin-top:22px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .sus-head{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid var(--line)}
  .sus-head-title{font-family:var(--mono);font-size:13px;color:var(--text);letter-spacing:2px;text-transform:uppercase}
  .sus-head-stat{font-family:var(--mono);font-size:11px;color:var(--text-dim);letter-spacing:1px}
  .sus-head-stat b{color:var(--red);font-weight:700}
  .sus-table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11px}
  .sus-table th{text-align:left;padding:10px 12px;color:var(--text-muted);font-size:10px;letter-spacing:2px;text-transform:uppercase;background:var(--panel-2);border-bottom:1px solid var(--line);font-weight:700}
  .sus-table td{padding:10px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top;color:var(--text-dim)}
  .sus-table tr:hover td{background:rgba(25,200,210,.04)}
  .sus-table .ip{color:var(--text);font-weight:700;letter-spacing:.5px}
  .sus-table .ua{color:var(--text-muted);font-size:10px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .flag{display:inline-block;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:1.5px;padding:2px 6px;border-radius:3px;margin-right:4px;margin-bottom:2px;border:1px solid currentColor;background:rgba(255,255,255,.02)}
  .flag.bot-ua{color:var(--red)}
  .flag.no-calls{color:var(--amber)}
  .flag.multi-variant{color:#a685ff}
  .flag.rapid-fire{color:var(--red)}
  .flag.high-volume{color:var(--cyan)}
  .sus-empty{padding:40px;text-align:center;color:var(--text-muted);font-family:var(--mono);font-size:12px;letter-spacing:1px}

  .small{font-size:11px;color:var(--text-muted);letter-spacing:.5px}
  .num-flicker{transition:color .25s}

  @media (max-width: 720px){
    .arms{grid-template-columns:1fr}
    .control-row{flex-direction:column;align-items:flex-start}
    .stat-value{font-size:26px}
    .stat-value.big{font-size:32px}
  }
</style>
</head><body>
<div class="wrap">

  <div class="topbar">
    <div class="brand">
      <div class="brand-mark">U</div>
      <div class="brand-text">
        <div class="brand-title">Mission Control</div>
        <div class="brand-sub">United Settlement · A/B Telemetry</div>
      </div>
    </div>
    <div class="topbar-right">
      <span class="live-pill"><span class="live-dot"></span> Live</span>
      <span class="topbar-time" id="serverClock">--:--:--</span>
      <a href="/admin/leads" class="topbar-link">Leads ↗</a>
    </div>
  </div>

  <div class="section-head">
    <div class="section-title">Arm Performance</div>
    <div class="section-bar"></div>
  </div>

  <div class="arms">
    <div class="arm" id="armA">
      <div class="arm-head">
        <div>
          <div class="arm-tag">Variant A</div>
          <div class="arm-name">Original (v1)</div>
        </div>
        <div class="arm-leader-pill">Leader</div>
      </div>
      <div class="arm-stats">
        <div class="stat">
          <div class="stat-label">Page Views</div>
          <div class="stat-value num-flicker" data-stat="a.pageViews">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Call Clicks</div>
          <div class="stat-value num-flicker" data-stat="a.calls">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Schedule Opens</div>
          <div class="stat-value num-flicker" data-stat="a.schedules">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Conversion Rate</div>
          <div class="stat-value big num-flicker" data-stat="a.conversionPct">—<span class="stat-unit">%</span></div>
        </div>
      </div>
      <div class="arm-conv-line">
        Split allocation: <b data-stat="config.weightAPct">—%</b>
      </div>
    </div>

    <div class="arm" id="armB">
      <div class="arm-head">
        <div>
          <div class="arm-tag">Variant B</div>
          <div class="arm-name">Call-First (v2)</div>
        </div>
        <div class="arm-leader-pill">Leader</div>
      </div>
      <div class="arm-stats">
        <div class="stat">
          <div class="stat-label">Page Views</div>
          <div class="stat-value num-flicker" data-stat="b.pageViews">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Call Clicks</div>
          <div class="stat-value num-flicker" data-stat="b.calls">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Schedule Opens</div>
          <div class="stat-value num-flicker" data-stat="b.schedules">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Conversion Rate</div>
          <div class="stat-value big num-flicker" data-stat="b.conversionPct">—<span class="stat-unit">%</span></div>
        </div>
      </div>
      <div class="arm-conv-line">
        Split allocation: <b data-stat="config.weightBPct">—%</b>
      </div>
    </div>
  </div>

  <div class="verdict" id="verdict">
    <div class="verdict-text tbd" id="verdictText">Awaiting cold-start data — both arms need ≥<span data-stat="config.coldStartMin">50</span> page views before a leader is declared.</div>
    <div class="small" id="verdictMeta">Updated <span id="updatedAt">—</span></div>
  </div>

  <div class="section-head">
    <div class="section-title">Split Control</div>
    <div class="section-bar"></div>
  </div>

  <div class="control">
    <div class="control-row">
      <div class="mode-toggle" role="tablist">
        <button class="mode-btn" data-mode="manual" id="modeManual">◆ Manual</button>
        <button class="mode-btn" data-mode="auto" id="modeAuto">↻ Auto-Ramp</button>
      </div>
      <div class="control-meta" id="modeStatus">—</div>
    </div>

    <div class="slider-row">
      <div class="slider-end">A · <span data-stat="config.weightAPct">—%</span></div>
      <div class="slider-wrap" style="--w:50%">
        <input type="range" min="0" max="100" step="1" value="50" class="slider-input" id="splitSlider">
      </div>
      <div class="slider-end right"><span data-stat="config.weightBPct">—%</span> · B</div>
    </div>

    <div class="ramp-history" id="rampHistory">
      <b>Ramp history will appear here once the split has been adjusted.</b>
    </div>
  </div>

  <div class="section-head">
    <div class="section-title">Suspicious Traffic</div>
    <div class="section-bar"></div>
  </div>

  <div class="sus-panel">
    <div class="sus-head">
      <div class="sus-head-title">⚠ Flagged IPs</div>
      <div class="sus-head-stat"><b id="susCount">0</b> flagged · <span id="totalIps">0</span> total IPs seen</div>
    </div>
    <div id="susTableWrap">
      <div class="sus-empty">Scanning event log…</div>
    </div>
  </div>

  <div style="margin-top:32px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-muted);letter-spacing:2px">
    Data refreshes every 4 seconds · /admin/api/ab-stats
  </div>
</div>

<script>
(function(){
  'use strict';

  var state = { config: {}, lastSnapshot: null };

  function fmt(n){ if (n == null) return '—'; if (typeof n === 'number') return n.toLocaleString(); return String(n); }
  function pct(x){ return (Math.round(x * 1000) / 10) + '%'; }

  function setStat(key, value){
    document.querySelectorAll('[data-stat="' + key + '"]').forEach(function(el){
      var prev = el.textContent;
      // Preserve trailing inline tags (e.g. .stat-unit) by writing to first text node
      var next = String(value);
      if (el.querySelector('.stat-unit')){
        var unit = el.querySelector('.stat-unit').outerHTML;
        el.innerHTML = next + unit;
      } else {
        el.textContent = next;
      }
      if (prev !== next && prev !== '—'){
        el.style.color = 'var(--cyan-bright)';
        setTimeout(function(){ el.style.color = ''; }, 350);
      }
    });
  }

  function paint(s){
    state.lastSnapshot = s;
    state.config = s.config;

    setStat('a.pageViews', fmt(s.variants.a.pageViews));
    setStat('a.calls', fmt(s.variants.a.calls));
    setStat('a.schedules', fmt(s.variants.a.schedules));
    setStat('a.conversionPct', s.variants.a.conversionPct);
    setStat('b.pageViews', fmt(s.variants.b.pageViews));
    setStat('b.calls', fmt(s.variants.b.calls));
    setStat('b.schedules', fmt(s.variants.b.schedules));
    setStat('b.conversionPct', s.variants.b.conversionPct);

    setStat('config.weightAPct', pct(s.config.weightA));
    setStat('config.weightBPct', pct(s.config.weightB));
    setStat('config.coldStartMin', s.config.coldStartMin);

    // Leader highlight
    document.getElementById('armA').classList.toggle('leader', s.leader === 'a');
    document.getElementById('armB').classList.toggle('leader', s.leader === 'b');

    // Verdict text
    var v = document.getElementById('verdictText');
    if (s.leader){
      v.classList.remove('tbd');
      var name = s.leader === 'a' ? 'Variant A (Original)' : 'Variant B (Call-First)';
      v.innerHTML = '<b>' + name + '</b> is leading by <span class="delta">+' + s.deltaPct + '%</span> in conversion rate ('
        + s.variants[s.leader].conversionPct + '% vs ' + s.variants[s.leader === 'a' ? 'b' : 'a'].conversionPct + '%).';
    } else {
      v.classList.add('tbd');
      v.innerHTML = 'Awaiting cold-start data — both arms need ≥<span>' + s.config.coldStartMin + '</span> page views before a leader is declared.';
    }
    document.getElementById('updatedAt').textContent = new Date(s.serverNow).toLocaleTimeString();

    // Mode buttons
    var manual = document.getElementById('modeManual');
    var auto = document.getElementById('modeAuto');
    manual.classList.toggle('active', s.config.mode === 'manual');
    auto.classList.toggle('active', s.config.mode === 'auto');
    document.getElementById('modeStatus').textContent =
      s.config.mode === 'auto'
        ? 'Auto-ramp active · weight rebalances every 60s based on conversion'
        : 'Manual mode · drag slider to set traffic split';

    // Slider — only writable in manual mode. Don't fight the user mid-drag.
    var sl = document.getElementById('splitSlider');
    sl.disabled = (s.config.mode !== 'manual');
    if (!sl.matches(':active')){
      var pctB = Math.round(s.config.weightB * 100);
      sl.value = pctB;
      sl.parentElement.style.setProperty('--w', pctB + '%');
    }

    // Ramp history (last 8)
    var hist = (s.config.history || []).slice(-8).reverse();
    var rh = document.getElementById('rampHistory');
    if (!hist.length){
      rh.innerHTML = '<b>Ramp history will appear here once the split has been adjusted.</b>';
    } else {
      rh.innerHTML = hist.map(function(h){
        var t = new Date(h.ts).toLocaleTimeString();
        return '<b>' + t + '</b> · ' + h.mode.toUpperCase() + ' → B=' + Math.round(h.weightB*100) + '% <span style="color:var(--text-muted)">(' + (h.reason || h.updatedBy || 'admin') + ')</span>';
      }).join('<br>');
    }

    // Suspicious traffic
    document.getElementById('susCount').textContent = s.suspicious.suspiciousCount;
    document.getElementById('totalIps').textContent = s.suspicious.totalIps;
    var rows = s.suspicious.suspicious;
    var wrap = document.getElementById('susTableWrap');
    if (!rows.length){
      wrap.innerHTML = '<div class="sus-empty">No suspicious activity detected. All clean. ✓</div>';
    } else {
      var html = '<table class="sus-table"><thead><tr><th>IP</th><th>Flags</th><th>Events</th><th>Calls</th><th>Burst/min</th><th>Variants</th><th>Last Seen</th><th>User-Agent</th></tr></thead><tbody>';
      rows.forEach(function(r){
        var flagsHtml = r.flags.map(function(f){
          return '<span class="flag ' + f.toLowerCase() + '">' + f + '</span>';
        }).join('');
        html += '<tr>'
          + '<td class="ip">' + r.ip + '</td>'
          + '<td>' + flagsHtml + '</td>'
          + '<td>' + r.events + ' <span class="small">(' + r.events24h + '/24h)</span></td>'
          + '<td>' + r.calls + '</td>'
          + '<td>' + r.maxBurstPerMin + '</td>'
          + '<td>' + (r.variants.join('+') || '—') + '</td>'
          + '<td>' + new Date(r.lastAt).toLocaleString() + '</td>'
          + '<td class="ua" title="' + (r.sampleUA || '').replace(/"/g,'&quot;') + '">' + (r.sampleUA || '—') + '</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
      wrap.innerHTML = html;
    }
  }

  function tickClock(){
    var d = new Date();
    var pad = function(n){ return String(n).padStart(2,'0'); };
    document.getElementById('serverClock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  setInterval(tickClock, 1000); tickClock();

  function fetchSnapshot(){
    fetch('/admin/api/ab-stats', { credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(paint)
      .catch(function(err){ console.error('snapshot failed', err); });
  }
  fetchSnapshot();
  setInterval(fetchSnapshot, 4000);

  // Mode toggle
  document.querySelectorAll('.mode-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var mode = btn.getAttribute('data-mode');
      fetch('/admin/api/ab-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ mode: mode })
      }).then(function(r){ return r.json(); }).then(function(){
        fetchSnapshot();
      });
    });
  });

  // Slider — debounce while dragging, commit on release
  var sl = document.getElementById('splitSlider');
  function commitSlider(){
    var pctB = Number(sl.value) / 100;
    fetch('/admin/api/ab-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ weightB: pctB })
    }).then(function(r){ return r.json(); }).then(function(){
      fetchSnapshot();
    });
  }
  sl.addEventListener('input', function(){
    sl.parentElement.style.setProperty('--w', sl.value + '%');
  });
  sl.addEventListener('change', commitSlider);
})();
</script>
</body></html>`;
}

module.exports = router;
