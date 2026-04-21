/**
 * alerter.js — best-effort webhook alerts for ops events you care about.
 *
 * Set ALERT_WEBHOOK_URL in Railway env to one of:
 *   • ntfy.sh          → https://ntfy.sh/<your-chosen-topic>
 *                        (subscribe to the same topic in the ntfy iOS/Android
 *                        app — free, anonymous, phone push notifications)
 *   • Slack webhook    → https://hooks.slack.com/services/T.../B.../xxx
 *   • Discord webhook  → https://discord.com/api/webhooks/<id>/<token>
 *   • Any endpoint that accepts a POST with JSON or text body
 *
 * Auto-detects Slack/Discord by URL and formats the body accordingly. Falls
 * back to plain text (ntfy and generic endpoints).
 *
 * All alert sends are fire-and-forget — an alert-send failure will never
 * break a request. Throttled per category so one bad bot run doesn't spam
 * your phone 30 times.
 */

const WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || '').trim();

// Don't resend the same category of alert more than once per 5 minutes.
// Keeps a runaway failure loop from dumping 500 notifications on you.
const THROTTLE_MS = 5 * 60 * 1000;
const lastSentAt = new Map();

function throttled(category) {
  const now = Date.now();
  const last = lastSentAt.get(category) || 0;
  if (now - last < THROTTLE_MS) return true;
  lastSentAt.set(category, now);
  return false;
}

function isSlack(url) { return url.includes('hooks.slack.com'); }
function isDiscord(url) { return url.includes('discord.com/api/webhooks') || url.includes('discordapp.com/api/webhooks'); }
function isNtfy(url) { return /ntfy\.sh/i.test(url); }

function buildBody(url, title, message) {
  if (isSlack(url)) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({ text: `*${title}*\n${message}` })
    };
  }
  if (isDiscord(url)) {
    return {
      contentType: 'application/json',
      body: JSON.stringify({ content: `**${title}**\n${message}` })
    };
  }
  if (isNtfy(url)) {
    return {
      contentType: 'text/plain',
      body: message,
      title
    };
  }
  // Generic: send both title + body as JSON
  return {
    contentType: 'application/json',
    body: JSON.stringify({ title, message })
  };
}

/**
 * Send an alert. Never throws.
 * @param {string} category - used for throttling (e.g. 'bot-fail', 'overload')
 * @param {string} title    - short headline
 * @param {string} message  - longer context (lead name, error, etc.)
 */
async function sendAlert(category, title, message) {
  if (!WEBHOOK_URL) return; // alerts disabled — ok, silent no-op
  if (throttled(category)) return;

  try {
    const built = buildBody(WEBHOOK_URL, title, message);
    const headers = { 'Content-Type': built.contentType };
    if (built.title) headers['Title'] = built.title;
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: built.body,
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    // An alert that can't be sent isn't worth crashing a request over.
    console.error('[ALERT] send failed:', err.message);
  }
}

module.exports = { sendAlert };
