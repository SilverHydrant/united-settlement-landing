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
    if (!validateField('pripolicy', pripolicy, 'You must agree to the privacy policy.')) valid = false;

    return valid;
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
      .then(function(res) { return res.json(); })
      .then(function(data) {
        btnSubmit.disabled = false;
        btnSubmit.classList.remove('loading');

        if (data.success) {
          // Fire pixel event
          if (window.Pixel) {
            window.Pixel.leadSubmitted(formData.lamount * 1000);
          }

          // Show success section
          document.getElementById('formSection').style.display = 'none';
          document.getElementById('successSection').style.display = 'block';

          document.getElementById('successMessage').textContent =
            'A debt relief specialist will call you shortly.';

          // Start live status polling if we got a leadId back
          if (data.leadId) {
            startLeadStatusPolling(data.leadId);
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
        showMessage('Connection error. Please try again or call us at (516) 231-9239.', 'error');
      });
    });
  }

  // ----- Lead status polling -----
  // Poll /api/lead-status/:id every ~1.5s and update the progress UI until
  // the bot reaches 'submitted' or 'failed' (or we hit the max attempts).
  var STEP_ORDER = ['queued', 'load', 'debt-slider', 'name', 'contact', 'address', 'dob', 'ssn', 'submit'];
  var STEP_LABELS = {
    queued:       'Queued',
    load:         'Opening the form\u2026',
    'debt-slider':'Entering debt amount\u2026',
    name:         'Entering your name\u2026',
    contact:      'Entering contact info\u2026',
    address:      'Entering address\u2026',
    dob:          'Entering date of birth\u2026',
    ssn:          'Final info\u2026',
    submit:       'Submitting to United Settlement\u2026'
  };

  function updateProgressUI(rec) {
    var wrap = document.getElementById('leadProgress');
    var label = document.getElementById('leadProgressLabel');
    var spinner = document.getElementById('leadProgressSpinner');
    if (!wrap) return;
    wrap.style.display = 'block';

    // Figure out the current step — fall back to 'queued' if none set yet
    var curr = rec.step || 'queued';
    var currIdx = STEP_ORDER.indexOf(curr);

    // Mark steps as done (before current), active (at current), or pending (after)
    var steps = document.querySelectorAll('.lead-progress-step');
    steps.forEach(function(el) {
      var s = el.getAttribute('data-step');
      var idx = STEP_ORDER.indexOf(s);
      el.classList.remove('done', 'active', 'failed');
      if (rec.state === 'submitted' || s === 'submit' && rec.state === 'submitted') {
        if (idx <= STEP_ORDER.length) el.classList.add('done');
      } else if (rec.state === 'failed') {
        if (idx < currIdx) el.classList.add('done');
        else if (idx === currIdx) el.classList.add('failed');
      } else if (idx < currIdx) {
        el.classList.add('done');
      } else if (idx === currIdx) {
        el.classList.add('active');
      }
    });

    if (rec.state === 'submitted') {
      // Mark all steps done
      steps.forEach(function(el) {
        el.classList.remove('active', 'failed');
        el.classList.add('done');
      });
      label.textContent = rec.method === 'proxy'
        ? 'Lead delivered to United Settlement.'
        : 'Submitted successfully to United Settlement.';
      spinner.classList.add('done');
    } else if (rec.state === 'failed') {
      label.textContent = 'Could not deliver to United Settlement. A rep will still call you shortly.';
      spinner.classList.add('failed');
    } else {
      label.textContent = STEP_LABELS[curr] || 'Working\u2026';
    }
  }

  function startLeadStatusPolling(leadId) {
    var attempts = 0;
    var maxAttempts = 40; // ~60 seconds at 1.5s interval
    var intervalId = null;

    function tick() {
      attempts++;
      fetch('/api/lead-status/' + encodeURIComponent(leadId))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.success || !data.lead) return;
          updateProgressUI(data.lead);
          if (data.lead.state === 'submitted' || data.lead.state === 'failed' || attempts >= maxAttempts) {
            clearInterval(intervalId);
          }
        })
        .catch(function() { /* transient, keep polling */ });
    }

    // Show initial "queued" state right away
    updateProgressUI({ state: 'queued', step: 'queued' });
    // Then poll
    tick();
    intervalId = setInterval(tick, 1500);
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

  // Validate picked time: only 9am-7pm
  function validatePickedTime() {
    if (!pickTime || !pickDate) return true;

    var hour = parseInt(pickTime.value.split(':')[0], 10);
    if (hour < 9 || hour >= 19) {
      if (picktimeError) picktimeError.textContent = 'Please pick a time between 9:00 AM and 7:00 PM.';
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
