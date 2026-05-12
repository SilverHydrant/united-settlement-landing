/**
 * option-b.js — page-specific behavior for the call-first variant.
 *
 * What it does:
 *  - Initializes the Meta Pixel (same ID as v1 — events get the same
 *    treatment in Ads Manager so we don't have to spin up a second pixel)
 *  - Wires every tel:-link on the page to fire BOTH the Pixel `Lead`
 *    event and our server-side Tracker.callClick — so the admin
 *    dashboard sees them under the same `call_click` bucket as v1
 *  - Stamps every event meta with { variant: "option_b" } so the
 *    admin page (or a CSV export) can split metrics by page version
 *  - Slider drives the "your debt → your savings" pair, no form
 *  - Sticky top phone bar slides in once the user scrolls past the hero
 */
(function() {
  'use strict';

  // ---- Pixel boot ----
  if (window.Pixel) {
    window.Pixel.init('2221485628258289');
  }

  // ---- Variant stamp on every Tracker call ----
  // We monkey-patch the Tracker so we don't have to remember to add
  // {variant:"option_b"} at every call site.
  if (window.Tracker) {
    var origTrack = window.Tracker.track;
    window.Tracker.track = function(event, meta) {
      var stamped = Object.assign({ variant: 'option_b' }, meta || {});
      return origTrack(event, stamped);
    };
  }

  // ---- Every phone-call link on the page ----
  // data-call-source attribute lets us tell hero / sticky / FAB / footer
  // apart in the admin events table.
  // Off-hours (window.__usOffHours, set further down): we never want a user
  // tapping a tel: link to ring an empty room. Intercept the click, route
  // them straight into the callback-schedule modal, and tag the tracker
  // event so admin can split closed-hours-clicks from real calls.
  document.querySelectorAll('a[href^="tel:"]').forEach(function(el) {
    el.addEventListener('click', function(e) {
      var src = el.getAttribute('data-call-source') || el.id || 'tel_link';
      if (window.__usOffHours) {
        e.preventDefault();
        if (window.Tracker) {
          window.Tracker.track('call_click_offhours', { source: src });
        }
        if (window.Pixel) window.Pixel.scheduleClicked();
        var cb = document.getElementById('callbackLink');
        if (cb) cb.click();
        return;
      }
      if (window.Pixel) window.Pixel.callClicked();
      if (window.Tracker) {
        window.Tracker.callClick({ source: src });
      }
    });
  });

  // ---- Outbound proof-link tracking (Google / ConsumerAffairs) ----
  document.querySelectorAll('[data-track]').forEach(function(el) {
    el.addEventListener('click', function() {
      if (window.Tracker) {
        window.Tracker.learnMoreClick({
          target: el.getAttribute('data-track') || 'unknown',
          href: el.getAttribute('href') || ''
        });
      }
    });
  });

  // ---- Slider → debt + savings display ----
  var qSlider = document.getElementById('qSlider');
  var qDebt   = document.getElementById('qDebt');
  var qSav    = document.getElementById('qSavings');
  var sliderTouched = false;
  function fmtUSD(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function updateSlider() {
    var v = parseInt(qSlider.value, 10);   // 5..100 thousands
    var debt = v * 1000;
    var displayDebt = v >= 100 ? '$100,000+' : fmtUSD(debt);
    var sav = v >= 100 ? 45000 : Math.round(debt * 0.45);
    if (qDebt) qDebt.textContent = displayDebt;
    if (qSav)  qSav.textContent  = fmtUSD(sav);
    // Color the slider track up to the thumb so the filled portion
    // matches the UDS palette (navy fill, ice rest).
    var pct = (v - qSlider.min) / (qSlider.max - qSlider.min) * 100;
    qSlider.style.background =
      'linear-gradient(to right, #0b304a 0%, #0b304a ' + pct + '%, #e4ebf1 ' + pct + '%, #e4ebf1 100%)';
    if (!sliderTouched) {
      sliderTouched = true;
      if (window.Pixel) {
        window.Pixel.fireOnce('CustomizeProduct', {
          content_name: 'debt_slider_v2',
          value: debt,
          currency: 'USD'
        });
      }
      if (window.Tracker) {
        window.Tracker.track('slider_move', { debtUSD: debt, savings: sav });
      }
    }
  }
  if (qSlider) {
    qSlider.addEventListener('input', updateSlider);
    updateSlider();
  }

  // ---- Sticky top phone bar — visible after the hero leaves the viewport ----
  var stickybar = document.getElementById('stickybar');
  var hero = document.querySelector('.hero');
  if (stickybar && hero) {
    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        if (e.isIntersecting) {
          stickybar.classList.remove('visible');
          stickybar.hidden = true;
        } else {
          stickybar.hidden = false;
          // Force a reflow so the transition runs the first time
          // eslint-disable-next-line no-unused-expressions
          stickybar.offsetHeight;
          stickybar.classList.add('visible');
        }
      });
    }, { threshold: 0, rootMargin: '-80px 0px 0px 0px' });
    io.observe(hero);
  }

  // ---- Availability indicator — green dot if within business hours,
  //      otherwise show "We open at 9am ET" copy. Uses Intl so it doesn't
  //      depend on the user's timezone. ----
  var heroAvailText = document.getElementById('heroAvailText');
  var stickyAvail   = document.getElementById('stickyAvail');
  function getETHour() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false
    }).formatToParts(new Date());
    var h = parts.find(function(p) { return p.type === 'hour'; });
    return h ? parseInt(h.value, 10) % 24 : 12;
  }
  var et = getETHour();
  var open = et >= 9 && et < 21;
  // Global flag — read by the tel:-link click handler above to route off-hours
  // clicks straight to the schedule-callback modal instead of dialing.
  window.__usOffHours = !open;
  if (!open) {
    document.body.classList.add('us-offhours');
    if (heroAvailText) heroAvailText.textContent = 'We open daily at 9am Eastern';
    if (stickyAvail)   stickyAvail.innerHTML = '●&nbsp;Schedule a callback';
    // Replace the live "call now" copy in every CTA with neutral schedule
    // wording. We swap only the .cta-label-text span (parent stays in the
    // DOM so the dot/structure don't shift).
    document.querySelectorAll('.hero-cta-label').forEach(function(el) {
      el.classList.add('is-closed');
      var t = el.querySelector('.cta-label-text');
      if (t) t.textContent = 'Schedule a callback';
    });
    // Drop the phone number out of every CTA — the user said "say nothing"
    // about calling when we're closed; CSS .us-offhours hides them.
    // (Header phone, hero-cta number, sticky bar number, footer phone.)
    var hideSel = '.hero-cta-num, .header-phone-num, .stickybar-cta span, .footer-phone, .fab span';
    document.querySelectorAll(hideSel).forEach(function(el) {
      // For composite buttons (sticky/footer/fab) we still want the icon
      // visible — so we hide only the text span(s), not the link itself.
      if (el.matches('.footer-phone')) {
        // Replace footer-phone text with "Schedule" but keep the click flow
        // (tel: click handler above will route to modal).
        el.childNodes.forEach(function(n) {
          if (n.nodeType === 3) n.textContent = ' Schedule a callback';
        });
        return;
      }
      el.style.display = 'none';
    });
    // FAB label: change from "Call" to "Schedule"
    document.querySelectorAll('.fab').forEach(function(el) {
      el.setAttribute('aria-label', 'Schedule a callback');
      var span = el.querySelector('span');
      if (span) { span.textContent = 'Schedule'; span.style.display = ''; }
    });
    // Sticky bar CTA: replace number with "Schedule" text
    document.querySelectorAll('.stickybar-cta').forEach(function(el) {
      el.setAttribute('aria-label', 'Schedule a callback');
      var span = el.querySelector('span');
      if (span) { span.textContent = 'Schedule a callback'; span.style.display = ''; }
    });
    // "Call Now to Start Step 1 →" button at end of How-It-Works flow
    document.querySelectorAll('.how-next-cta').forEach(function(el) {
      el.textContent = 'Schedule a callback to start \u2192';
    });
    // Big trust strip under second hero CTA ("A specialist is on right now…")
    document.querySelectorAll('.big-cta-mini').forEach(function(el) {
      var span = el.querySelector('span:not([class*="dot"])') || el.querySelector('span:last-child');
      if (span) span.textContent = 'We open daily at 9am ET \u2014 leave your number, we\u2019ll call back';
    });
  } else {
    // Already correct in the HTML for the open state.
  }

  // ---- "Schedule a callback instead" → opens the inline callback modal.
  //      Lead is submitted to /api/submit (same pipeline as v1's form),
  //      so the Playwright bot delivers it to UDS the same way. ----
  (function initCallbackModal() {
    var modal      = document.getElementById('callbackModal');
    var openLink   = document.getElementById('callbackLink');
    var closeBtn   = document.getElementById('callbackModalClose');
    var form       = document.getElementById('callbackForm');
    var errEl      = document.getElementById('callbackFormError');
    var submitBtn  = document.getElementById('callbackFormSubmit');
    var formWrap   = form;
    var successEl  = document.getElementById('callbackSuccess');
    var winEl      = document.getElementById('callbackSuccessWindow');
    var successClose = document.getElementById('callbackSuccessClose');
    var stateSelect = form && form.querySelector('select[name="state"]');
    var pills        = form && form.querySelectorAll('.calltime-pill');
    var calltimeHidden = document.getElementById('callbackCalltime');
    var picker         = document.getElementById('callbackPicker');
    var pickDate       = document.getElementById('callbackPickDate');
    var pickTime       = document.getElementById('callbackPickTime');
    var pickerNotice   = document.getElementById('callbackPickerNotice');
    if (!modal || !form) return;

    // Default the date picker to tomorrow
    if (pickDate) {
      var d = new Date(); d.setDate(d.getDate() + 1);
      pickDate.min = new Date().toISOString().split('T')[0];
      pickDate.value = d.toISOString().split('T')[0];
    }

    // Pill click handler — same data-value scheme as v1's form
    pills.forEach(function(p) {
      p.addEventListener('click', function() {
        pills.forEach(function(x) {
          x.classList.remove('active');
          x.setAttribute('aria-checked', 'false');
        });
        p.classList.add('active');
        p.setAttribute('aria-checked', 'true');
        var val = p.getAttribute('data-value');
        calltimeHidden.value = val;
        if (val === 'picktime') {
          picker.hidden = false;
        } else {
          picker.hidden = true;
          if (pickerNotice) pickerNotice.hidden = true;
        }
      });
    });

    // Populate state dropdown
    var STATES = [
      ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
      ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
      ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
      ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
      ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
      ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
      ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
      ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],
      ['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
      ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],
      ['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']
    ];
    var frag = document.createDocumentFragment();
    STATES.forEach(function(s) {
      var opt = document.createElement('option');
      opt.value = s[0]; opt.textContent = s[1];
      frag.appendChild(opt);
    });
    stateSelect.appendChild(frag);

    // ---- Auto-fill state from server-side IP geolocation. The server
    //      already runs geoip-lite and exposes city + region at /api/geo,
    //      so no Google Maps / paid API needed. State is filled silently
    //      and a small hint shows the detected city. The user can still
    //      override the dropdown if they're traveling. ----
    var geoCache = null;
    function applyGeoToState(geo) {
      if (!geo || geo.country !== 'US' || !geo.region) return;
      // Only autofill if the user hasn't already picked something
      if (stateSelect.value && stateSelect.value !== '') return;
      var hasOption = Array.prototype.some.call(stateSelect.options, function(o) {
        return o.value === geo.region;
      });
      if (!hasOption) return;
      stateSelect.value = geo.region;
      var hint = document.getElementById('callbackGeoHint');
      if (hint) {
        var label = geo.city ? (geo.city + ', ' + geo.region) : geo.region;
        hint.textContent = '(detected: ' + label + ')';
        hint.hidden = false;
      }
    }
    function fetchGeo() {
      if (geoCache !== null) return Promise.resolve(geoCache);
      return fetch('/api/geo')
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) { geoCache = data || {}; return geoCache; })
        .catch(function() { geoCache = {}; return geoCache; });
    }

    function open() {
      // Pre-fill debt amount from the slider value if present
      modal.hidden = false;
      // eslint-disable-next-line no-unused-expressions
      modal.offsetHeight;
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
      var firstField = form.querySelector('input[name="fname"]');
      if (firstField) firstField.focus();
      // Kick off (or reuse) the geo fetch and autofill the state once it lands
      fetchGeo().then(applyGeoToState);
      if (window.Pixel) window.Pixel.fire('Schedule', { content_name: 'callback_modal_open' });
      if (window.Tracker) window.Tracker.scheduleClick({ source: 'option_b_modal_open' });
    }
    function close() {
      modal.classList.remove('open');
      setTimeout(function() { modal.hidden = true; }, 220);
      document.body.style.overflow = '';
    }

    if (openLink) {
      openLink.addEventListener('click', function(e) {
        e.preventDefault();
        open();
      });
    }
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) close();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && modal.classList.contains('open')) close();
    });
    if (successClose) successClose.addEventListener('click', close);

    // ---- submit handler ----
    function readUtm() {
      var p = new URLSearchParams(window.location.search);
      var pick = function(k) { return p.get(k) || ''; };
      return {
        utmid:       pick('utm_id'),
        utmsource:   pick('utm_source'),
        utmmedium:   pick('utm_medium'),
        utmcampaign: pick('utm_campaign'),
        utmcontent:  pick('utm_content'),
        utmterm:     pick('utm_term'),
        gclid:       pick('gclid')
      };
    }
    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
      errEl.scrollIntoView({ block: 'nearest' });
    }
    function setLoading(on) {
      submitBtn.disabled = on;
      submitBtn.classList.toggle('is-loading', on);
    }

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      errEl.hidden = true;

      // Mark form as validated — CSS now reveals invalid state on fields
      form.classList.add('was-validated');
      // Native HTML5 validation first
      if (!form.checkValidity()) {
        var first = form.querySelector(':invalid');
        if (first) first.focus();
        showError('Please fill in every field and accept the privacy notice.');
        return;
      }

      var fd = new FormData(form);

      // Resolve calltime: pill value, OR "pick:YYYY-MM-DD HH:MM" if Pick Time
      var calltimeVal = calltimeHidden.value || 'now';
      if (calltimeVal === 'picktime') {
        if (!pickDate.value || !pickTime.value) {
          if (pickerNotice) {
            pickerNotice.textContent = 'Pick a date and time before continuing.';
            pickerNotice.hidden = false;
          }
          showError('Pick a date and time, or choose one of the quick options.');
          return;
        }
        // Backend wants "pick:YYYY-MM-DD HH:MM" and validates 9am-9pm ET
        var hour = parseInt(pickTime.value.split(':')[0], 10);
        if (isNaN(hour) || hour < 9 || hour >= 21) {
          if (pickerNotice) {
            pickerNotice.textContent = 'Pick a time between 9:00 AM and 9:00 PM Eastern.';
            pickerNotice.hidden = false;
          }
          showError('Specialists are available 9am–9pm ET. Pick a time in that window.');
          return;
        }
        calltimeVal = 'pick:' + pickDate.value + ' ' + pickTime.value;
      }

      // Slider position → debt bucket (5..100 thousands)
      var lamount = 15;
      var qSlider = document.getElementById('qSlider');
      if (qSlider) lamount = parseInt(qSlider.value, 10) || 15;

      var payload = Object.assign({
        fname:    (fd.get('fname') || '').trim(),
        lname:    (fd.get('lname') || '').trim(),
        phone:    (fd.get('phone') || '').replace(/\D/g, ''),
        email:    (fd.get('email') || '').trim(),
        dob:      fd.get('dob') || '',
        state:    fd.get('state') || '',
        calltime: calltimeVal,
        lamount:  lamount,
        pripolicy: fd.get('pripolicy') ? true : false,
        // Variant tag stuffed into subidone so it lands in the JSONL row
        subidone: 'option_b_callback'
      }, readUtm());

      setLoading(true);
      fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function(r) {
          return r.json().then(function(body) { return { ok: r.ok, status: r.status, body: body }; });
        })
        .then(function(res) {
          setLoading(false);
          if (!res.ok) {
            var msg = (res.body && (res.body.error || (res.body.errors && res.body.errors.join(' ')))) ||
                      'We couldn’t submit that. Please try again, or call us at (516) 231-9239.';
            showError(msg);
            return;
          }
          // Success — swap to the confirmation panel
          var labels = {
            now:     'as soon as a specialist is free',
            '1hour': 'within the next hour',
            '2hours': 'within the next 2 hours',
            tomorrow: 'first thing tomorrow morning'
          };
          var label = labels[payload.calltime];
          if (!label && payload.calltime.indexOf('pick:') === 0) {
            label = 'at ' + payload.calltime.replace('pick:', '').replace(' ', ' at ') + ' ET';
          }
          if (winEl) winEl.textContent = label || 'soon';
          formWrap.hidden = true;
          successEl.hidden = false;
          if (window.Pixel) {
            window.Pixel.fire('Lead', {
              content_name: 'callback_form_submit',
              content_category: 'option_b'
            });
          }
          if (window.Tracker) {
            window.Tracker.track('callback_submit', {
              calltime: payload.calltime,
              lamount: payload.lamount
            });
          }
        })
        .catch(function() {
          setLoading(false);
          showError('Network error. Please try again, or call us at (516) 231-9239.');
        });
    });
  })();

  // ---- Variant tag on the page-view beacon ----
  // Tracker.pageView fires on DOMContentLoaded inside tracker.js BEFORE
  // this file runs, so the first beacon doesn't carry the variant tag.
  // Send a second, page-explicit beacon so the dashboard sees a clean
  // "page_view + variant=option_b" record.
  if (window.Tracker) {
    window.Tracker.pageView({ variant_tag: 'option_b', path: '/option-b.html' });
  }

  // ---- How-It-Works tab switching (matches v1's behavior) ----
  function activateHowPanel(panelId) {
    document.querySelectorAll('.how-tab').forEach(function(t) {
      var on = t.getAttribute('data-panel') === panelId;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.how-panel').forEach(function(p) {
      p.classList.toggle('active', p.getAttribute('data-panel') === panelId);
    });
  }
  document.querySelectorAll('.how-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var panel = tab.getAttribute('data-panel');
      activateHowPanel(panel);
      if (window.Pixel) {
        window.Pixel.fire('TabClick', {
          content_name: 'how_it_works_tab_' + panel,
          content_category: 'how_it_works_engagement'
        });
      }
      if (window.Tracker) window.Tracker.tabClick({ panel: panel, kind: 'direct' });
    });
  });
  document.querySelectorAll('.how-next-btn[data-next]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      var nextPanel = btn.getAttribute('data-next');
      activateHowPanel(nextPanel);
      // Keep the user's eyes locked on the tabs bar after the swap so
      // a different-height panel doesn't yank the page.
      var tabsBar = document.querySelector('.how-tabs');
      if (tabsBar) {
        var prevTop = tabsBar.getBoundingClientRect().top;
        requestAnimationFrame(function() {
          var newTop = tabsBar.getBoundingClientRect().top;
          var delta = newTop - prevTop;
          if (delta !== 0) window.scrollBy({ top: delta, behavior: 'instant' });
        });
      }
      if (window.Pixel) {
        window.Pixel.fire('TabProgress', {
          content_name: 'how_it_works_' + nextPanel,
          content_category: 'tab_progress'
        });
      }
      if (window.Tracker) window.Tracker.tabClick({ panel: nextPanel, kind: 'next' });
    });
  });

  // ---- FAQ open tracking ----
  document.querySelectorAll('.faq-item').forEach(function(item, idx) {
    item.addEventListener('toggle', function() {
      if (!item.open) return;
      var q = (item.querySelector('summary').textContent || '').trim();
      if (window.Pixel) {
        window.Pixel.fire('FAQClick', {
          content_name: 'faq_' + (idx + 1),
          content_category: 'faq_engagement',
          content_ids: [q.slice(0, 80)]
        });
      }
      if (window.Tracker) window.Tracker.faqClick({ index: idx + 1, q: q.slice(0, 80) });
    });
  });

  // ---- Disclosure popover — every "*" on the page is a button that
  //      pops open the matching disclosure. Click outside or press ESC
  //      to dismiss. Matches the FTC requirement that "up to 50%" claims
  //      be qualified inline near the claim, not just buried in footers. ----
  (function initDisclosurePopover() {
    var popover = document.getElementById('disclosurePopover');
    if (!popover) return;
    var titleEl = document.getElementById('disclosurePopoverTitle');
    var bodyEl  = document.getElementById('disclosurePopoverBody');
    var closeEl = document.getElementById('disclosurePopoverClose');
    var disclosures = {
      savings: {
        title: 'About the savings estimate',
        body: 'The 45% average refers to reduction on enrolled debt before fees, based on actual client outcomes — about 20% including fees, over 24 to 48 months. Not all debts are eligible for enrollment, and not every client completes the program. Your actual reduction depends on who you owe, how much, and how far behind you are. We do not guarantee a specific savings amount or timeline.'
      }
    };
    var lastTrigger = null;
    function open(key, trigger) {
      var d = disclosures[key] || disclosures.savings;
      titleEl.textContent = d.title;
      bodyEl.textContent  = d.body;
      popover.hidden = false;
      // Force reflow so the transition runs the first time
      // eslint-disable-next-line no-unused-expressions
      popover.offsetHeight;
      popover.classList.add('open');
      lastTrigger = trigger || null;
      closeEl.focus();
      if (window.Tracker) {
        window.Tracker.track('disclosure_open', { key: key });
      }
    }
    function close() {
      popover.classList.remove('open');
      // After the transition, fully hide for screen readers
      setTimeout(function() { popover.hidden = true; }, 200);
      if (lastTrigger && typeof lastTrigger.focus === 'function') lastTrigger.focus();
      lastTrigger = null;
    }
    document.querySelectorAll('.disclosure-ast').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        open(btn.getAttribute('data-disclosure') || 'savings', btn);
      });
    });
    closeEl.addEventListener('click', close);
    popover.addEventListener('click', function(e) {
      if (e.target === popover) close();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && popover.classList.contains('open')) close();
    });
  })();

  // ---- California CPRA notice banner — only shown to CA visitors per
  //      /api/geo. Identical UX to v1 so the legal footprint matches. ----
  (function initCaliforniaNotice() {
    var notice = document.getElementById('caNotice');
    if (!notice) return;
    if (sessionStorage.getItem('caNoticeDismissed') === '1') return;
    fetch('/api/geo')
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.isCalifornia) notice.hidden = false;
      })
      .catch(function() { /* non-essential */ });
    var close = document.getElementById('caNoticeClose');
    if (close) {
      close.addEventListener('click', function() {
        notice.hidden = true;
        try { sessionStorage.setItem('caNoticeDismissed', '1'); } catch (_) {}
      });
    }
  })();
})();
