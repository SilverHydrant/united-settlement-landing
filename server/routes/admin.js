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
      <a href="/admin/leads" style="background:#19a4ac">Refresh now</a>
      <a href="/admin/leads.csv" class="alt">Download CSV</a>
      <a href="/admin/leads.json" class="alt">JSON</a>
    </div>
  </div>

  ${renderSummaryCards(summary, queueStats || { pending: 0, size: 0, maxSize: 30 })}

  ${(function() {
    const events = readAllEvents();
    return renderEngagementCards(computeEngagement(events), leads, events);
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

module.exports = router;
