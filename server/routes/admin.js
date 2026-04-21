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
  latestDeliveryByLeadId
} = require('../services/leadStore');
const { getStats } = require('../services/leadQueue');

function requireAdmin(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
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
  const supplied = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (supplied !== pw) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).type('text/plain').send('Wrong password');
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
    return `
    <tr>
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
  <meta http-equiv="refresh" content="30">
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
    .delivery-meta{font-size:10px;color:#8a95a0;margin-top:4px}
    .empty{padding:60px;text-align:center;color:#8a95a0;background:#fff;border-radius:8px}
    .search{margin-bottom:12px;padding:10px 14px;border:1px solid #d8dde3;border-radius:6px;width:100%;font-size:14px;background:#fff}
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

  ${leads.length === 0 ? `
    <div class="empty">No leads yet. Submit one on the public site to see it appear here.</div>
  ` : `
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
function filter(){
  var q=(document.getElementById('q').value||'').toLowerCase();
  document.querySelectorAll('#tbl tbody tr').forEach(function(r){
    r.style.display = r.innerText.toLowerCase().indexOf(q)>=0 ? '' : 'none';
  });
}
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
  res.json({ count: leadCount(), dataFile: getDataFilePath() });
});

module.exports = router;
