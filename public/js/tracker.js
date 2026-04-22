/**
 * tracker.js — lightweight server-side engagement tracker.
 *
 * Pairs with POST /api/track. Uses navigator.sendBeacon() when available so
 * events still fire when the page is unloading (critical for call-click,
 * which opens the dialer and navigates away from the tab).
 */
(function() {
  'use strict';

  var ENDPOINT = '/api/track';

  function send(event, meta) {
    if (!event) return;
    var payload = JSON.stringify({ event: event, meta: meta || null });

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

  // Public API — call Tracker.track('call_click') etc.
  window.Tracker = {
    track: send,
    // Shortcuts so callers don't typo the event name
    callClick:      function(meta) { send('call_click', meta); },
    scheduleClick:  function(meta) { send('schedule_click', meta); },
    learnMoreClick: function(meta) { send('learn_more_click', meta); },
    sliderMove:     function(meta) { send('slider_move', meta); },
    tabClick:       function(meta) { send('tab_click', meta); },
    faqClick:       function(meta) { send('faq_click', meta); },
    formStart:      function(meta) { send('form_start', meta); },
    formError:      function(meta) { send('form_error', meta); },
    pageView:       function(meta) { send('page_view', meta); }
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
