/**
 * leadStore.js — persistent lead storage on a Railway volume.
 *
 * Every form submission gets appended to `<DATA_DIR>/leads.jsonl` as one
 * JSON object per line. This is dead-simple (no SQLite / native deps),
 * survives restarts on a mounted volume, and is easy to parse or export.
 *
 * DATA_DIR defaults to ./data for local dev. On Railway, set the env var
 * DATA_DIR=/data and mount a Railway Volume at /data so rows persist.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.jsonl');

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    return true;
  } catch (err) {
    console.error('[leadStore] Could not create data dir:', DATA_DIR, err.message);
    return false;
  }
}

/**
 * Append a lead record. Best-effort: never throws — lead capture should
 * degrade gracefully if the disk is full or the volume isn't mounted.
 */
function saveLead(lead, extra = {}) {
  if (!ensureDataDir()) return false;
  try {
    const record = {
      savedAt: new Date().toISOString(),
      fname:    lead.fname    || '',
      lname:    lead.lname    || '',
      phone:    lead.phone    || '',
      email:    lead.email    || '',
      dob:      lead.dob      || '',
      state:    lead.state    || '',
      lamount:  lead.lamount  || 0,
      debtUSD:  (lead.lamount || 0) * 1000,
      calltime: lead.calltime || '',
      userip:   lead.userip   || '',
      utm: {
        source:   lead.utmsource   || '',
        medium:   lead.utmmedium   || '',
        campaign: lead.utmcampaign || '',
        content:  lead.utmcontent  || '',
        term:     lead.utmterm     || '',
        id:       lead.utmid       || ''
      },
      click: {
        gclid:  lead.gclid  || '',
        fbclid: lead.fbclid || ''
      },
      sub: {
        sidcamid:   lead.sidcamid   || '',
        sourceid:   lead.sourceid   || '',
        subidone:   lead.subidone   || '',
        subidtwo:   lead.subidtwo   || '',
        subidthree: lead.subidthree || '',
        subidfour:  lead.subidfour  || ''
      },
      ...extra
    };
    fs.appendFileSync(LEADS_FILE, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('[leadStore] Failed to append lead:', err.message);
    return false;
  }
}

/**
 * Read every lead from disk. Returns an array (most recent last). Safe to
 * call with no file present — returns []. Handles trailing newlines and
 * malformed lines gracefully.
 */
function readAllLeads() {
  try {
    if (!fs.existsSync(LEADS_FILE)) return [];
    const text = fs.readFileSync(LEADS_FILE, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[leadStore] Read failed:', err.message);
    return [];
  }
}

function leadCount() {
  return readAllLeads().length;
}

function getDataFilePath() {
  return LEADS_FILE;
}

module.exports = { saveLead, readAllLeads, leadCount, getDataFilePath };
