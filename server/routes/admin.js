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
const { readAllLeads, leadCount, getDataFilePath } = require('../services/leadStore');

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

function renderLeadsHtml(leads) {
  const newest = leads.slice().reverse();
  const rows = newest.map((l, i) => `
    <tr>
      <td>${newest.length - i}</td>
      <td class="muted">${htmlEscape(fmtTime(l.savedAt))}</td>
      <td>${htmlEscape((l.fname || '') + ' ' + (l.lname || ''))}</td>
      <td><a href="tel:${htmlEscape(l.phone)}">${htmlEscape(fmtPhone(l.phone))}</a></td>
      <td><a href="mailto:${htmlEscape(l.email)}">${htmlEscape(l.email)}</a></td>
      <td>${htmlEscape(l.state)}</td>
      <td>$${Number(l.debtUSD || 0).toLocaleString()}</td>
      <td>${htmlEscape(l.dob)}</td>
      <td>${htmlEscape(l.calltime)}</td>
      <td class="muted">${htmlEscape(l.utm && l.utm.source || '')}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Leads · Admin</title>
  <style>
    *{box-sizing:border-box}
    body{font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f4f6f8;margin:0;padding:24px;color:#222}
    .wrap{max-width:1300px;margin:0 auto}
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px}
    h1{margin:0;color:#0b304a;font-size:26px}
    .count{color:#666;font-size:13px;margin-top:2px}
    .actions a{display:inline-block;background:#19a4ac;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;margin-left:8px;font-weight:600;font-size:13px}
    .actions a.alt{background:#0b304a}
    table{width:100%;background:#fff;border-collapse:collapse;box-shadow:0 1px 3px rgba(0,0,0,.08);border-radius:8px;overflow:hidden}
    th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #eef1f4;font-size:13px;white-space:nowrap}
    th{background:#fafbfc;font-weight:700;color:#555;font-size:11px;letter-spacing:.5px;text-transform:uppercase}
    tr:hover td{background:#f8fafc}
    td a{color:#19a4ac;text-decoration:none}
    td a:hover{text-decoration:underline}
    .muted{color:#8a95a0}
    .empty{padding:60px;text-align:center;color:#8a95a0;background:#fff;border-radius:8px}
    .search{margin-bottom:12px;padding:10px 14px;border:1px solid #d8dde3;border-radius:6px;width:100%;font-size:14px;background:#fff}
  </style>
</head><body>
<div class="wrap">
  <div class="header">
    <div>
      <h1>Leads</h1>
      <div class="count">${leads.length} total · newest first</div>
    </div>
    <div class="actions">
      <a href="/admin/leads.csv" class="alt">Download CSV</a>
      <a href="/admin/leads.json" class="alt">JSON</a>
    </div>
  </div>

  ${leads.length === 0 ? `
    <div class="empty">No leads yet. Submit one on the public site to see it appear here.</div>
  ` : `
    <input class="search" id="q" placeholder="Search name, email, phone, state…" oninput="filter()">
    <table id="tbl">
      <thead><tr>
        <th>#</th><th>Time</th><th>Name</th><th>Phone</th><th>Email</th><th>State</th><th>Debt</th><th>DOB</th><th>Callback</th><th>UTM Source</th>
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

router.get('/leads', requireAdmin, (req, res) => {
  res.type('html').send(renderLeadsHtml(readAllLeads()));
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
