/**
 * slider.js - Debt amount slider component
 * Custom range slider matching United Settlement's existing functionality
 */
(function() {
  'use strict';

  var slider = document.getElementById('debtSlider');
  var amountDisplay = document.getElementById('sliderAmount');
  var savingsDisplay = document.getElementById('savingsAmount');
  var hasInteracted = false;

  function formatDollar(value) {
    var amount = value * 1000;
    return '$' + amount.toLocaleString('en-US');
  }

  function updateDisplay() {
    if (amountDisplay) {
      var val = parseInt(slider.value, 10);
      amountDisplay.textContent = val >= 100 ? '$100,000+' : formatDollar(val);

      // Update savings estimate — 45% reflects average savings per client
      // across the program, which is more honest than showing "up to 50%"
      // that's a ceiling few people actually hit.
      if (savingsDisplay) {
        var savings = val >= 100 ? 45000 : Math.round(val * 1000 * 0.45);
        savingsDisplay.textContent = '$' + savings.toLocaleString('en-US');
      }
    }
  }

  function updateSliderFill() {
    var val = (slider.value - slider.min) / (slider.max - slider.min) * 100;
    slider.style.background = 'linear-gradient(to right, #435a6a 0%, #435a6a ' + val + '%, #e6e6e6 ' + val + '%, #e6e6e6 100%)';
  }

  function onSliderInput() {
    updateDisplay();
    updateSliderFill();

    if (!hasInteracted) {
      hasInteracted = true;
      // Show savings estimate on first interaction
      var savingsEl = document.getElementById('savingsEstimate');
      if (savingsEl) savingsEl.style.display = 'block';
      if (window.BotGuard) window.BotGuard.markSliderInteracted();
      if (window.Pixel) window.Pixel.sliderInteracted(parseInt(slider.value, 10) * 1000);
    }
  }

  if (slider) {
    slider.addEventListener('input', onSliderInput);
    // Initialize display
    updateDisplay();
    updateSliderFill();
  }

  // Expose getter for other modules
  window.DebtSlider = {
    getValue: function() {
      return slider ? parseInt(slider.value, 10) : 15;
    },
    getDollarAmount: function() {
      return this.getValue() * 1000;
    }
  };
})();
