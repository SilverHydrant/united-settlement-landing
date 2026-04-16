/**
 * app.js - Main application logic
 * CTA button behavior, form toggle, pixel initialization
 */
(function() {
  'use strict';

  // Initialize Meta Pixel (replace with your actual Pixel ID)
  if (window.Pixel) {
    window.Pixel.init('YOUR_PIXEL_ID_HERE');
  }

  // --- CTA Button Handlers ---

  // Call Now button
  var btnCall = document.getElementById('btnCall');
  var headerPhone = document.getElementById('headerPhone');

  function onCallClick() {
    if (window.Pixel) window.Pixel.callClicked();
  }

  if (btnCall) btnCall.addEventListener('click', onCallClick);
  if (headerPhone) headerPhone.addEventListener('click', onCallClick);

  // Schedule a Call button
  var btnSchedule = document.getElementById('btnSchedule');
  var formSection = document.getElementById('formSection');
  var formVisible = false;

  if (btnSchedule && formSection) {
    btnSchedule.addEventListener('click', function() {
      formVisible = !formVisible;

      if (formVisible) {
        formSection.style.display = 'block';
        // Smooth scroll to form
        setTimeout(function() {
          formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
        btnSchedule.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Hide Form';
      } else {
        formSection.style.display = 'none';
        btnSchedule.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> Schedule a Free Debt Consultation';
      }

      if (window.Pixel) window.Pixel.scheduleClicked();
    });
  }

  // Bottom call button pixel tracking
  var btnCallBottom = document.getElementById('btnCallBottom');
  if (btnCallBottom) btnCallBottom.addEventListener('click', onCallClick);

  // How It Works tabs
  function activateHowPanel(panelId) {
    var tabs = document.querySelectorAll('.how-tab');
    var panels = document.querySelectorAll('.how-panel');
    tabs.forEach(function(t) {
      var isActive = t.getAttribute('data-panel') === panelId;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    panels.forEach(function(p) {
      p.classList.toggle('active', p.getAttribute('data-panel') === panelId);
    });
  }

  document.querySelectorAll('.how-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      activateHowPanel(tab.getAttribute('data-panel'));
    });
  });

  document.querySelectorAll('.how-next-btn[data-next]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      // Anchor scroll to the tabs bar so the panel swap doesn't yank
      // the user up or down when the new panel has a different height
      var tabsBar = document.querySelector('.how-tabs');
      var prevTop = tabsBar ? tabsBar.getBoundingClientRect().top : 0;
      activateHowPanel(btn.getAttribute('data-next'));
      if (tabsBar) {
        var newTop = tabsBar.getBoundingClientRect().top;
        var delta = newTop - prevTop;
        if (delta !== 0) {
          // Keep the tabs bar visually in the same spot on screen
          window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
        }
      }
    });
  });

  // Accordion toggle
  document.querySelectorAll('.accordion-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var item = btn.parentElement;
      var content = item.querySelector('.accordion-content');
      var isOpen = item.classList.contains('open');

      // Close all items in same accordion
      item.parentElement.querySelectorAll('.accordion-item').forEach(function(i) {
        i.classList.remove('open');
        i.querySelector('.accordion-content').style.maxHeight = null;
      });

      // Open clicked one (if it wasn't already open)
      if (!isOpen) {
        item.classList.add('open');
        content.style.maxHeight = content.scrollHeight + 'px';
      }
    });
  });

  // Learn More button
  var btnLearn = document.getElementById('btnLearn');
  if (btnLearn) {
    btnLearn.addEventListener('click', function() {
      if (window.Pixel) window.Pixel.learnMoreClicked();
    });
  }
})();
