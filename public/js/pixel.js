/**
 * pixel.js - Meta + TikTok Pixel event management
 * Strategic events at each engagement level to filter bots from real users
 */
(function() {
  'use strict';

  var firedEvents = {};
  var viewContentTimer = null;

  window.Pixel = {

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
        if (typeof ttq !== 'undefined') ttq.track('ViewContent');
      }, 2000);
    },

    fireOnce: function(eventName, params) {
      if (firedEvents[eventName]) return;
      firedEvents[eventName] = true;
      this._fire(eventName, params);
    },

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
        var standardEvents = ['PageView', 'ViewContent', 'Lead', 'Contact', 'CompleteRegistration', 'CustomizeProduct'];
        if (standardEvents.indexOf(eventName) >= 0) {
          fbq('track', eventName, params);
        } else {
          fbq('trackCustom', eventName, params);
        }
      }
    },

    sliderInteracted: function(debtAmount) {
      this.fireOnce('CustomizeProduct', {
        content_name: 'debt_slider',
        value: debtAmount,
        currency: 'USD'
      });
      if (typeof ttq !== 'undefined') ttq.track('ClickButton');
    },

    callClicked: function() {
      this.fireOnce('Lead', {
        content_name: 'click_to_call',
        content_category: 'phone_call'
      });
      if (typeof ttq !== 'undefined') ttq.track('Contact');
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
      if (typeof ttq !== 'undefined') ttq.track('SubmitForm');
    },

    learnMoreClicked: function() {
      this.fireOnce('ViewContent', {
        content_name: 'learn_more',
        content_category: 'outbound_click'
      });
    }

  };

})();
