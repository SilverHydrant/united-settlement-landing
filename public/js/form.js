/**
 * form.js - Schedule-a-call form validation, phone masking, and submission
 */
(function() {
  'use strict';

  var form = document.getElementById('scheduleForm');
  var btnSubmit = document.getElementById('btnSubmit');
  var formMessage = document.getElementById('formMessage');
  var phoneInput = document.getElementById('phone');

  // Phone number auto-formatting
  if (phoneInput) {
    phoneInput.addEventListener('input', function(e) {
      var digits = e.target.value.replace(/\D/g, '');
      if (digits.length > 10) digits = digits.substring(0, 10);

      var formatted = '';
      if (digits.length > 0) formatted = '(' + digits.substring(0, 3);
      if (digits.length >= 3) formatted += ') ';
      if (digits.length > 3) formatted += digits.substring(3, 6);
      if (digits.length >= 6) formatted += '-' + digits.substring(6, 10);

      e.target.value = formatted;
    });
  }

  // Validation
  function validateField(id, condition, message) {
    var el = document.getElementById(id);
    var errorEl = document.getElementById(id + 'Error');
    if (!el) return true;

    if (!condition) {
      el.classList.add('error');
      if (errorEl) errorEl.textContent = message;
      return false;
    } else {
      el.classList.remove('error');
      if (errorEl) errorEl.textContent = '';
      return true;
    }
  }

  function validateForm() {
    var fname = document.getElementById('fname').value.trim();
    var lname = document.getElementById('lname').value.trim();
    var phone = document.getElementById('phone').value.replace(/\D/g, '');
    var email = document.getElementById('email').value.trim();
    var dob = document.getElementById('dob').value;
    var state = document.getElementById('state').value;
    var pripolicy = document.getElementById('pripolicy').checked;

    var valid = true;

    if (!validateField('fname', fname.length >= 2 && /^[a-zA-Z\s\-']+$/.test(fname), 'Please enter a valid first name.')) valid = false;
    if (!validateField('lname', lname.length >= 2 && /^[a-zA-Z\s\-']+$/.test(lname), 'Please enter a valid last name.')) valid = false;
    if (!validateField('phone', phone.length === 10, 'Please enter a valid 10-digit phone number.')) valid = false;
    if (!validateField('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Please enter a valid email address.')) valid = false;
    // DOB: must be a valid date AND age 18-99
    var dobValid = false;
    if (dob) {
      var dobDate = new Date(dob);
      if (!isNaN(dobDate.getTime())) {
        var age = (Date.now() - dobDate.getTime()) / (365.25 * 24 * 3600 * 1000);
        dobValid = age >= 18 && age <= 99;
      }
    }
    if (!validateField('dob', dobValid, 'You must be 18 or older.')) valid = false;
    if (!validateField('state', state !== '', 'Please select your state.')) valid = false;
    if (!validateField('pripolicy', pripolicy, 'Please check the box to agree before continuing.')) {
      valid = false;
      shakeConsent();
    }

    return valid;
  }

  // Shake + highlight the consent row, and scroll it into view so the user
  // sees exactly what they missed. Triggered when they hit Continue without
  // checking the "I agree to the Privacy Policy" box.
  function shakeConsent() {
    var cb = document.getElementById('pripolicy');
    if (!cb) return;
    var wrapper = cb.closest('.form-checkbox');
    if (!wrapper) return;
    wrapper.classList.add('error');
    // Restart the animation if it's already running (re-clicks shouldn't be silent)
    wrapper.classList.remove('shake');
    // Force reflow so removing+re-adding actually restarts the keyframes
    void wrapper.offsetWidth;
    wrapper.classList.add('shake');
    wrapper.addEventListener('animationend', function onEnd() {
      wrapper.classList.remove('shake');
      wrapper.removeEventListener('animationend', onEnd);
    });
    // Bring the checkbox into view (below the fold on small screens)
    try { wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_) {}
  }

  // Clear the consent error state as soon as the user checks the box
  var pripolicyCb = document.getElementById('pripolicy');
  if (pripolicyCb) {
    pripolicyCb.addEventListener('change', function() {
      if (pripolicyCb.checked) {
        var wrapper = pripolicyCb.closest('.form-checkbox');
        if (wrapper) wrapper.classList.remove('error');
      }
    });
  }

  // Get user IP
  var userIP = '';
  fetch('https://api.ipify.org?format=json')
    .then(function(r) { return r.json(); })
    .then(function(data) { userIP = data.ip || ''; })
    .catch(function() { /* silent fail */ });

  // Capture UTM params from URL
  function getUTMParams() {
    var params = new URLSearchParams(window.location.search);
    return {
      utmid: params.get('utm_id') || '',
      utmsource: params.get('utm_source') || '',
      utmmedium: params.get('utm_medium') || '',
      utmcampaign: params.get('utm_campaign') || '',
      utmcontent: params.get('utm_content') || '',
      utmterm: params.get('utm_term') || '',
      gclid: params.get('gclid') || '',
      fbclid: params.get('fbclid') || '',
      sidcamid: params.get('sid') || '',
      sourceid: params.get('sourceid') || '',
      subidone: params.get('sub1') || '',
      subidtwo: params.get('sub2') || '',
      subidthree: params.get('sub3') || '',
      subidfour: params.get('sub4') || ''
    };
  }

  // Form submission
  if (form) {
    form.addEventListener('submit', function(e) {
      e.preventDefault();

      // Validate
      if (!validateForm()) return;

      // Validate picked time if "Pick a Time" is selected
      var activeBtn = document.querySelector('.calltime-btn.active');
      if (activeBtn && activeBtn.getAttribute('data-value') === 'picktime') {
        if (!validatePickedTime()) return;
      }

      // Check honeypot
      var honeypot = form.querySelector('input[name="website"]');
      if (honeypot && honeypot.value) return; // Bot detected, fail silently

      // Disable button, show loading
      btnSubmit.disabled = true;
      btnSubmit.classList.add('loading');
      hideMessage();

      // Collect data
      var formData = {
        fname: document.getElementById('fname').value.trim(),
        lname: document.getElementById('lname').value.trim(),
        phone: document.getElementById('phone').value.replace(/\D/g, ''),
        email: document.getElementById('email').value.trim(),
        dob: document.getElementById('dob').value,
        calltime: document.getElementById('calltime').value,
        state: document.getElementById('state').value,
        lamount: window.DebtSlider ? window.DebtSlider.getValue() : 15,
        pripolicy: true,
        userip: userIP
      };

      // Add UTM params
      var utm = getUTMParams();
      Object.keys(utm).forEach(function(key) {
        formData[key] = utm[key];
      });

      // Add bot guard data
      if (window.BotGuard) {
        formData.behavior = window.BotGuard.getData();
      }

      // Submit to our backend
      fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      .then(function(res) { return res.json().then(function(body){ return { status: res.status, body: body }; }); })
      .then(function(r) {
        var data = r.body || {};
        btnSubmit.disabled = false;
        btnSubmit.classList.remove('loading');

        // Queue is at capacity — flip to the overload screen with the call-us
        // CTA instead of the normal success/progress flow. 503 is what the
        // backend sends when isFull() returns true.
        if (r.status === 503 && data.overloaded) {
          document.getElementById('formSection').style.display = 'none';
          document.getElementById('successSection').style.display = 'block';
          document.getElementById('successProcessing').style.display = 'none';
          document.getElementById('successFinal').style.display = 'none';
          document.getElementById('successOverload').style.display = 'block';
          document.getElementById('successSection').scrollIntoView({ behavior: 'smooth' });
          return;
        }

        // Any non-overload failure also flips to the friendly call-us screen
        // instead of a red banner — when the backend is unhappy for ANY
        // reason we'd rather push the user to pick up the phone than have
        // them retry in frustration. Overload already handled above.
        if (!data.success && r.status !== 503) {
          showFriendlyFailure(data.message);
          return;
        }

        if (data.success) {
          // Fire pixel event
          if (window.Pixel) {
            window.Pixel.leadSubmitted(formData.lamount * 1000);
          }

          // Swap form → success section. Start in the "processing" state; the
          // poller will flip to the "final" state once the bot reports back.
          document.getElementById('formSection').style.display = 'none';
          document.getElementById('successSection').style.display = 'block';
          document.getElementById('successProcessing').style.display = 'block';
          document.getElementById('successFinal').style.display = 'none';
          var overloadEl = document.getElementById('successOverload');
          if (overloadEl) overloadEl.style.display = 'none';

          // Remember the submitted call-time — we'll use it to pick the final
          // copy ("in 1 hour" / "tomorrow morning" / etc.) once the bot is done.
          window._submittedCalltime = formData.calltime;

          // Start live status polling if we got a leadId back
          if (data.leadId) {
            startLeadStatusPolling(data.leadId);
          } else {
            // No leadId (old backend?) — skip straight to the final state
            transitionToFinalState(formData.calltime, 'submitted');
          }

          // Scroll to success
          document.getElementById('successSection').scrollIntoView({ behavior: 'smooth' });
        } else {
          showMessage(data.message || 'Something went wrong. Please try again or call us directly.', 'error');
        }
      })
      .catch(function() {
        btnSubmit.disabled = false;
        btnSubmit.classList.remove('loading');
        // Network error — same friendly fallback, no red banner
        showFriendlyFailure('Connection issue reaching our server. Please call us at (516) 231-9239 and a specialist will take your info right now.');
        showMessage('Connection error. Please try again or call us at (516) 231-9239.', 'error');
      });
    });
  }

  // ============================================================
  // Eastern-time helpers (call center hours are 9am–9pm ET, 7 days)
  // Using Intl so we don't depend on the user's device clock or tz setting.
  // ============================================================
  var BUSINESS_OPEN_ET = 9;   // inclusive (9am)
  var BUSINESS_CLOSE_ET = 21; // exclusive (9pm)

  function getETHourAtOffset(offsetMinutes) {
    var t = new Date(Date.now() + (offsetMinutes || 0) * 60 * 1000);
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false
    }).formatToParts(t);
    var h = parts.find(function(p) { return p.type === 'hour'; });
    return h ? parseInt(h.value, 10) % 24 : 12;
  }

  function withinBusinessHours(etHour) {
    return etHour >= BUSINESS_OPEN_ET && etHour < BUSINESS_CLOSE_ET;
  }

  // Minutes from "now" until the call based on the chosen option
  function minutesFromNowForValue(v) {
    if (v === 'now') return 0;
    if (v === '1hour') return 60;
    if (v === '2hours') return 120;
    return null; // tomorrow / picktime / morning / etc — not a direct offset
  }

  // ============================================================
  // Business-hours notice — shows inline when user picks a calltime
  // that falls outside 9am-9pm ET.
  // ============================================================
  var noticeEl = document.getElementById('calltimeNotice');

  function showNotice(html) {
    if (!noticeEl) return;
    noticeEl.innerHTML = html;
    noticeEl.style.display = 'block';
  }
  function hideNotice() {
    if (noticeEl) noticeEl.style.display = 'none';
  }

  function validateCalltimeChoice(value) {
    if (!value || value === 'tomorrow' || value === 'morning' || value === 'afternoon' || value === 'evening') {
      hideNotice();
      return;
    }
    if (value === 'picktime') {
      // pick-time has its own validator (9-19 on the picked time)
      return;
    }
    var offset = minutesFromNowForValue(value);
    if (offset === null) { hideNotice(); return; }
    var etHour = getETHourAtOffset(offset);
    if (withinBusinessHours(etHour)) {
      hideNotice();
      return;
    }
    showNotice(
      'Heads up: our specialists are available <strong>9am\u20139pm Eastern</strong>. ' +
      (etHour >= BUSINESS_CLOSE_ET ? 'We\u2019re closed for the evening.' : 'We open at 9am ET.') +
      ' Your lead will go through, and <strong>we\u2019ll call you tomorrow morning instead</strong>. ' +
      'Or tap <strong>&ldquo;Tomorrow&rdquo;</strong> above.'
    );
  }

  // Run validation whenever the user picks a different call-time
  document.querySelectorAll('.calltime-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var v = btn.getAttribute('data-value');
      // Let the existing handler populate #calltime first; validate after
      setTimeout(function() { validateCalltimeChoice(v); }, 0);
    });
  });
  // On initial load, validate the default ("now")
  setTimeout(function() { validateCalltimeChoice('now'); }, 0);

  // ============================================================
  // Lead status polling — drives the progress card and the final swap
  // ============================================================
  var STEP_ORDER = ['queued', 'load', 'debt-slider', 'name', 'contact', 'address', 'dob', 'ssn', 'submit'];

  function updateProgressUI(rec) {
    var curr = rec.step || 'queued';
    var currIdx = STEP_ORDER.indexOf(curr);
    var steps = document.querySelectorAll('.lead-progress-step');
    steps.forEach(function(el) {
      var idx = STEP_ORDER.indexOf(el.getAttribute('data-step'));
      el.classList.remove('done', 'active', 'failed');
      if (rec.state === 'submitted') {
        el.classList.add('done');
      } else if (rec.state === 'failed') {
        if (idx < currIdx) el.classList.add('done');
        else if (idx === currIdx) el.classList.add('failed');
      } else if (idx < currIdx) {
        el.classList.add('done');
      } else if (idx === currIdx) {
        el.classList.add('active');
      }
    });
  }

  // Build the dynamic "a specialist will call you…" line based on the
  // call-time the user picked. Accounts for business hours — e.g. "now" at
  // 11pm ET becomes "first thing tomorrow morning at 9am ET".
  function buildCallCopy(calltime) {
    var ET_HOUR = getETHourAtOffset(0);

    function tomorrowMorning() {
      return 'A specialist will call you <strong>tomorrow morning at 9am Eastern</strong>.';
    }

    if (!calltime || calltime === 'now') {
      if (!withinBusinessHours(ET_HOUR)) return tomorrowMorning();
      return 'A specialist will call you <strong>within the next few minutes</strong>.';
    }
    if (calltime === '1hour') {
      if (!withinBusinessHours(getETHourAtOffset(60))) return tomorrowMorning();
      return 'A specialist will call you <strong>in about 1 hour</strong>.';
    }
    if (calltime === '2hours') {
      if (!withinBusinessHours(getETHourAtOffset(120))) return tomorrowMorning();
      return 'A specialist will call you <strong>in about 2 hours</strong>.';
    }
    if (calltime === 'tomorrow' || calltime === 'morning') {
      return 'A specialist will call you <strong>tomorrow morning</strong> (9am\u201312pm Eastern).';
    }
    if (calltime === 'afternoon') {
      return 'A specialist will call you <strong>tomorrow afternoon</strong> (12pm\u20135pm Eastern).';
    }
    if (calltime === 'evening') {
      return 'A specialist will call you <strong>tomorrow evening</strong> (5pm\u20139pm Eastern).';
    }
    if (calltime.indexOf('pick:') === 0) {
      // Format: pick:YYYY-MM-DD HH:MM  (user treats this as ET per the label)
      var dt = calltime.slice(5).split(' ');
      var datePart = dt[0], timePart = dt[1] || '';
      var dateStr = '', timeStr = '';
      try {
        var d = new Date(datePart + 'T00:00:00');
        dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      } catch (_) { dateStr = datePart; }
      if (timePart) {
        var hm = timePart.split(':');
        var hh = parseInt(hm[0], 10);
        var mm = hm[1] || '00';
        var ampm = hh >= 12 ? 'pm' : 'am';
        var h12 = ((hh + 11) % 12) + 1;
        timeStr = h12 + ':' + mm + ' ' + ampm;
      }
      return 'A specialist will call you on <strong>' + dateStr + ' at ' + timeStr + ' Eastern</strong>.';
    }
    return 'A specialist will reach out shortly.';
  }

  function transitionToFinalState(calltime, state) {
    var processing = document.getElementById('successProcessing');
    var finalCard  = document.getElementById('successFinal');
    var headline   = document.getElementById('successHeadline');
    var message    = document.getElementById('successMessage');
    if (processing) processing.style.display = 'none';
    if (finalCard)  finalCard.style.display = 'block';

    if (state === 'failed') {
      // Bot + proxy fallback both failed — very rare. Give the user a clear
      // "call us" path rather than promising a callback we can't guarantee.
      if (headline) headline.innerHTML = 'Thanks \u2014 we got your info.';
      if (message) message.innerHTML =
        'We hit a temporary snag auto-submitting your request. ' +
        'Please call us at <strong>(516) 231-9239</strong> and a specialist will help you right now.';
    } else {
      if (headline) headline.innerHTML = 'Congratulations \u2014 your request is in!';
      if (message) message.innerHTML = buildCallCopy(calltime);
    }
  }

  function startLeadStatusPolling(leadId) {
    var attempts = 0;
    var maxAttempts = 40; // ~60s at 1.5s
    var intervalId = null;
    var finalized = false;

    function finalize(state) {
      if (finalized) return;
      finalized = true;
      clearInterval(intervalId);
      transitionToFinalState(window._submittedCalltime, state);
    }

    function tick() {
      attempts++;
      fetch('/api/lead-status/' + encodeURIComponent(leadId))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.success || !data.lead) return;
          updateProgressUI(data.lead);
          if (data.lead.state === 'submitted') finalize('submitted');
          else if (data.lead.state === 'failed') finalize('failed');
          else if (attempts >= maxAttempts) finalize('submitted'); // optimistic on timeout
        })
        .catch(function() { /* transient, keep polling */ });
    }

    // Show initial "queued" state immediately so the user sees motion
    updateProgressUI({ state: 'queued', step: 'queued' });
    tick();
    intervalId = setInterval(tick, 1500);

    // Safety net: if polling never finalizes (network flake), still show the
    // final state after the max window so the user isn't stuck watching a spinner.
    setTimeout(function() { finalize('submitted'); }, (maxAttempts * 1500) + 1000);
  }

  // Any failure that ISN'T the queue-is-full case (which has its own dedicated
   // message) swaps to the overload card too — same friendly "call us" vibe,
   // with the specific error inlined below the main call-to-action so the user
   // knows what happened without being yelled at.
  function showFriendlyFailure(detailMsg) {
    var overload = document.getElementById('successOverload');
    var processing = document.getElementById('successProcessing');
    var finalCard = document.getElementById('successFinal');
    var section = document.getElementById('successSection');
    if (!overload || !section) return;
    document.getElementById('formSection').style.display = 'none';
    section.style.display = 'block';
    if (processing) processing.style.display = 'none';
    if (finalCard) finalCard.style.display = 'none';
    overload.style.display = 'block';
    // Update the heading copy for a non-overload failure so it reads accurately.
    var headline = overload.querySelector('h2');
    var lead = overload.querySelector('.success-lead');
    if (headline) headline.innerHTML = 'Sorry &mdash; we hit a snag.';
    if (lead) {
      lead.innerHTML = '<strong>Please call us directly</strong> and a specialist will take your info right now &mdash; no form, no wait.';
    }
    // Tuck the specific error at the bottom so the user can tell support what happened
    var footnote = overload.querySelector('.success-cta-text');
    if (footnote && detailMsg) {
      footnote.innerHTML = 'Details: ' + detailMsg;
    }
    section.scrollIntoView({ behavior: 'smooth' });
  }

  function showMessage(text, type) {
    if (formMessage) {
      formMessage.textContent = text;
      formMessage.className = 'form-message ' + type;
      formMessage.style.display = 'block';
    }
  }

  function hideMessage() {
    if (formMessage) {
      formMessage.style.display = 'none';
    }
  }

  // Call time button toggles
  var calltimeBtns = document.querySelectorAll('.calltime-btn');
  var calltimeInput = document.getElementById('calltime');
  var picktimeWrapper = document.getElementById('picktimeWrapper');
  var pickDate = document.getElementById('pickDate');
  var pickTime = document.getElementById('pickTime');
  var picktimeError = document.getElementById('picktimeError');

  // Set min date to today
  if (pickDate) {
    var today = new Date();
    pickDate.value = today.toISOString().split('T')[0];
    pickDate.min = today.toISOString().split('T')[0];
  }

  calltimeBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      calltimeBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var val = btn.getAttribute('data-value');

      if (val === 'picktime') {
        picktimeWrapper.style.display = 'block';
      } else {
        picktimeWrapper.style.display = 'none';
        if (picktimeError) picktimeError.textContent = '';
        if (calltimeInput) calltimeInput.value = val;
      }
    });
  });

  // Validate picked time: only 9am-9pm
  function validatePickedTime() {
    if (!pickTime || !pickDate) return true;

    var hour = parseInt(pickTime.value.split(':')[0], 10);
    if (hour < 9 || hour >= 21) {
      if (picktimeError) picktimeError.textContent = 'Please pick a time between 9:00 AM and 9:00 PM Eastern.';
      return false;
    }
    if (picktimeError) picktimeError.textContent = '';
    // Store the picked date/time in the hidden field
    if (calltimeInput) calltimeInput.value = 'pick:' + pickDate.value + ' ' + pickTime.value;
    return true;
  }

  if (pickTime) {
    pickTime.addEventListener('change', validatePickedTime);
  }

  // Clear error on input
  ['fname', 'lname', 'phone', 'email', 'dob', 'calltime', 'state', 'pripolicy'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      var eventType = el.type === 'checkbox' ? 'change' : 'input';
      el.addEventListener(eventType, function() {
        el.classList.remove('error');
        var errorEl = document.getElementById(id + 'Error');
        if (errorEl) errorEl.textContent = '';
      });
    }
  });
})();
