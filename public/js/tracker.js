/**
 * tracker.js — lightweight server-side engagement tracker.
 *
 * Pairs with POST /api/track. Uses navigator.sendBeacon() when available so
 * events still fire when the page is unloading (critical for call-click,
 * which opens the dialer and navigates away from the tab).
 *
 * Session timing:
 *   Every event is stamped with { sid, ms } where:
 *     - sid: random per-page-load session id (lets admin group events)
 *     - ms:  whole ms since this page loaded
 *   First time the user interacts (any click/scroll/key beyond the page
 *   load itself), we also send a `time_to_first_click` event so the admin
 *   can spot bots that bounce instantly. On unload we send `session_end`
 *   with the total session duration. These three signals together are
 *   strong bot vs. human evidence:
 *     - 0 interactions + <3s session  → near-certain bot
 *     - first click <500ms after load → automation, not a real tap
 *     - long session, many interactions → real human evaluating
 */
(function() {
  'use strict';

  var ENDPOINT = '/api/track';
  var pageStart = Date.now();
  var sid = (function() {
    try {
      var arr = new Uint8Array(8);
      (window.crypto || window.msCrypto).getRandomValues(arr);
      return Array.prototype.map.call(arr, function(b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } catch (_) {
      return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  })();

  // First-interaction + interaction-count state for the session-end event.
  var firstInteractionAt = null;
  var interactionCount = 0;
  var sessionEnded = false;

  function send(event, meta) {
    if (!event) return;
    var stampedMeta = Object.assign({ sid: sid, ms: Date.now() - pageStart }, meta || {});
    var payload = JSON.stringify({ event: event, meta: stampedMeta });

    // Preferred: sendBeacon. Guaranteed to be sent before page unload, no
    // matter how fast the user taps "Call" and leaves the tab.
    try {
      if (navigator && typeof navigator.sendBeacon === 'function') {
        var blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (_) { /* fall through to fetch */ }

    // Fallback: keepalive fetch. Modern browsers also guarantee this
    // completes across navigation.
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        credentials: 'same-origin'
      }).catch(function() {});
    } catch (_) {}
  }

  function recordInteraction(kind) {
    interactionCount++;
    if (firstInteractionAt === null) {
      firstInteractionAt = Date.now() - pageStart;
      send('time_to_first_click', { ms_to_first: firstInteractionAt, kind: kind || 'unknown' });
    }
  }

  // Wrap send so any tracked event also counts as an interaction (except
  // page_view and session_end / time_to_first_click themselves, which would
  // be circular).
  function trackedSend(event, meta) {
    if (event !== 'page_view' && event !== 'session_end' && event !== 'time_to_first_click') {
      recordInteraction(event);
    }
    send(event, meta);
  }

  // Passive interaction listeners — catch real human signals (scroll,
  // pointermove, keydown) even if the user never clicks anything we wired.
  // These count toward bot-vs-human heuristics but don't spam the server;
  // we only fire `time_to_first_click` once.
  function passiveOnce(kind) {
    return function() {
      if (firstInteractionAt !== null) return;
      recordInteraction(kind);
    };
  }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function(evt) {
    window.addEventListener(evt, passiveOnce(evt), { once: true, passive: true, capture: true });
  });

  // session_end — fire once on the first signal that the page is going away.
  // pagehide is the most reliable on iOS Safari; visibilitychange covers tab
  // switches; beforeunload is desktop fallback.
  function sendSessionEnd() {
    if (sessionEnded) return;
    sessionEnded = true;
    send('session_end', {
      duration_ms: Date.now() - pageStart,
      interactions: interactionCount,
      first_click_ms: firstInteractionAt
    });
  }
  window.addEventListener('pagehide', sendSessionEnd);
  window.addEventListener('beforeunload', sendSessionEnd);
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') sendSessionEnd();
  });

  // Public API — call Tracker.track('call_click') etc.
  window.Tracker = {
    track: trackedSend,
    // Shortcuts so callers don't typo the event name
    callClick:      function(meta) { trackedSend('call_click', meta); },
    scheduleClick:  function(meta) { trackedSend('schedule_click', meta); },
    learnMoreClick: function(meta) { trackedSend('learn_more_click', meta); },
    sliderMove:     function(meta) { trackedSend('slider_move', meta); },
    tabClick:       function(meta) { trackedSend('tab_click', meta); },
    faqClick:       function(meta) { trackedSend('faq_click', meta); },
    formStart:      function(meta) { trackedSend('form_start', meta); },
    formError:      function(meta) { trackedSend('form_error', meta); },
    pageView:       function(meta) { trackedSend('page_view', meta); }
  };

  // Beacon every page view so we can sanity-check traffic against the Meta
  // Pixel and against our lead rate.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      window.Tracker.pageView({ path: location.pathname });
    });
  } else {
    window.Tracker.pageView({ path: location.pathname });
  }
})();
