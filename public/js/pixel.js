/**
 * pixel.js - Meta Pixel event management
 * Strategic events at each engagement level to filter bots from real users
 */
(function() {
  'use strict';

  var firedEvents = {};
  var viewContentTimer = null;

  window.Pixel = {
    // Initialize the pixel - call with your Pixel ID
    init: function(pixelId) {
      if (!pixelId || pixelId === 'YOUR_PIXEL_ID_HERE') {
        console.warn('[Pixel] No valid Meta Pixel ID configured. Events will be logged but not sent.');
        this._debug = true;
        return;
      }

      this._debug = false;

      if (typeof fbq === 'function') {
        fbq('init', pixelId);
        fbq('track', 'PageView');
      }

      // Fire ViewContent after 2 seconds (filters instant-bounce bots)
      viewContentTimer = setTimeout(function() {
        window.Pixel.fireOnce('ViewContent', {
          content_name: 'debt_relief_landing'
        });
      }, 2000);
    },

    // Fire an event only once per session
    fireOnce: function(eventName, params) {
      if (firedEvents[eventName]) return;
      firedEvents[eventName] = true;
      this._fire(eventName, params);
    },

    // Fire an event (can be called multiple times)
    fire: function(eventName, params) {
      this._fire(eventName, params);
    },

    _fire: function(eventName, params) {
      params = params || {};

      if (this._debug) {
        console.log('[Pixel] Event:', eventName, params);
        return;
      }

      if (typeof fbq === 'function') {
        // Standard events use 'track', custom events use 'trackCustom'
        var standardEvents = ['PageView', 'ViewContent', 'Lead', 'Contact', 'CompleteRegistration', 'CustomizeProduct'];
        if (standardEvents.indexOf(eventName) >= 0) {
          fbq('track', eventName, params);
        } else {
          fbq('trackCustom', eventName, params);
        }
      }
    },

    // Pre-built event triggers
    sliderInteracted: function(debtAmount) {
      this.fireOnce('CustomizeProduct', {
        content_name: 'debt_slider',
        value: debtAmount,
        currency: 'USD'
      });
    },

    callClicked: function() {
      this.fireOnce('Lead', {
        content_name: 'click_to_call',
        content_category: 'phone_call'
      });
    },

    scheduleClicked: function() {
      this.fireOnce('Schedule', {
        content_name: 'schedule_call',
        content_category: 'form_open'
      });
    },

    leadSubmitted: function(debtAmount) {
      this.fire('Lead', {
        content_name: 'debt_relief_callback',
        content_category: 'schedule_call',
        value: debtAmount,
        currency: 'USD'
      });
    },

    learnMoreClicked: function() {
      this.fireOnce('ViewContent', {
        content_name: 'learn_more',
        content_category: 'outbound_click'
      });
    }
  };
})();
