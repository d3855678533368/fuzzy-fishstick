(function () {
  'use strict';

  // --- Constants ---
  var API_BASE = 'https://api.carbonintensity.org.uk';
  var SLOT_MINUTES = 30;
  var MAX_DELAY_HOURS = 4;

  var INDEX_COLOURS = {
    'very low':  '#2aa745',
    'low':       '#6fcf41',
    'moderate':  '#f5b731',
    'high':      '#ef7124',
    'very high': '#d1232a'
  };

  var INDEX_RANK = {
    'very low': 0,
    'low': 1,
    'moderate': 2,
    'high': 3,
    'very high': 4
  };

  // --- DOM refs ---
  var cycleDurationSelect = document.getElementById('cycle-duration');
  var postcodeInput = document.getElementById('postcode');
  var recommendationEl = document.getElementById('recommendation');
  var delayOptionsEl = document.getElementById('delay-options');
  var chartContainer = document.getElementById('chart-container');
  var forecastSection = document.getElementById('forecast-section');
  var loadingEl = document.getElementById('loading');
  var errorEl = document.getElementById('error');
  var errorMsgEl = document.getElementById('error-message');
  var retryBtn = document.getElementById('retry-btn');
  var lastUpdatedEl = document.getElementById('last-updated');

  var cachedSlots = null;
  var refreshTimer = null;

  // --- Utilities ---

  function formatTimeUK(date) {
    return new Date(date).toLocaleTimeString('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function indexRank(index) {
    return INDEX_RANK[index] != null ? INDEX_RANK[index] : 2;
  }

  function worstIndex(slots) {
    return slots.reduce(function (worst, s) {
      var idx = s.intensity.index;
      return indexRank(idx) > indexRank(worst) ? idx : worst;
    }, 'very low');
  }

  function colourForIndex(index) {
    return INDEX_COLOURS[index] || '#999';
  }

  function roundToHalfHour(date) {
    var d = new Date(date.getTime());
    d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
    return d;
  }

  // UK outward postcode patterns: A9, A99, A9A, AA9, AA99, AA9A
  var OUTWARD_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/;

  function sanitisePostcode(raw) {
    // Strip all whitespace and non-alphanumeric, uppercase
    var cleaned = raw.replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length === 0) return null;

    // If the user entered a full postcode (e.g. "SW1A1AA" or "SW11AA"),
    // the inward part is always the last 3 characters (digit + 2 letters).
    // Strip it to extract just the outward code.
    if (cleaned.length >= 5 && /\d[A-Z]{2}$/.test(cleaned)) {
      cleaned = cleaned.slice(0, -3);
    }

    // Validate against known UK outward postcode patterns
    if (OUTWARD_RE.test(cleaned)) {
      return cleaned;
    }
    return null;
  }

  // --- API ---

  function buildApiUrl(postcode) {
    var from = roundToHalfHour(new Date());
    var iso = from.toISOString().replace(/\.\d{3}Z$/, 'Z');

    if (postcode) {
      return API_BASE + '/regional/intensity/' + iso + '/fw24h/postcode/' + encodeURIComponent(postcode);
    }
    return API_BASE + '/intensity/' + iso + '/fw24h';
  }

  function extractSlots(json, isRegional) {
    if (isRegional) {
      // Regional response: { data: { data: [{ from, to, intensity }] } }
      // or sometimes { data: [{ regionid, data: [...] }] }
      var regional = json.data;
      if (regional && regional.data && Array.isArray(regional.data)) {
        return regional.data;
      }
      if (Array.isArray(regional) && regional.length > 0 && regional[0].data) {
        return regional[0].data;
      }
      return null;
    }
    return json.data && Array.isArray(json.data) ? json.data : null;
  }

  function fetchForecast(postcode) {
    showLoading(true);
    hideError();

    var url = buildApiUrl(postcode);
    var isRegional = !!postcode;

    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (response) {
        if (!response.ok) {
          if (response.status === 400 && isRegional) {
            throw new Error('Invalid postcode. Please check and try again.');
          }
          throw new Error('Could not load forecast data (error ' + response.status + ').');
        }
        return response.json();
      })
      .then(function (json) {
        var slots = extractSlots(json, isRegional);
        if (!slots || slots.length === 0) {
          throw new Error('No forecast data available.');
        }
        return slots;
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          showError('You appear to be offline. Please check your connection and try again.');
        } else {
          showError(err.message);
        }
        return null;
      })
      .then(function (result) {
        showLoading(false);
        return result;
      });
  }

  // --- Calculation ---

  function calculateDelayOptions(slots, cycleMins) {
    var slotsPerCycle = Math.ceil(cycleMins / SLOT_MINUTES);
    var results = [];

    for (var delay = 0; delay <= MAX_DELAY_HOURS; delay++) {
      var startIdx = (delay * 60) / SLOT_MINUTES;
      var endIdx = startIdx + slotsPerCycle;

      if (endIdx > slots.length) break;

      var cycleSlots = slots.slice(startIdx, endIdx);
      var sum = 0;
      for (var i = 0; i < cycleSlots.length; i++) {
        sum += cycleSlots[i].intensity.forecast;
      }
      var avg = sum / cycleSlots.length;

      results.push({
        delayHours: delay,
        avgIntensity: Math.round(avg),
        startTime: cycleSlots[0].from,
        endTime: cycleSlots[cycleSlots.length - 1].to,
        index: worstIndex(cycleSlots)
      });
    }

    return results;
  }

  function findBestDelay(options) {
    return options.reduce(function (best, opt) {
      return opt.avgIntensity < best.avgIntensity ? opt : best;
    });
  }

  // --- Rendering ---

  function renderRecommendation(best, options) {
    var delayText = best.delayHours === 0
      ? 'Start now'
      : 'Wait ' + best.delayHours + ' hour' + (best.delayHours > 1 ? 's' : '');

    var timeText = formatTimeUK(best.startTime) + ' \u2013 ' + formatTimeUK(best.endTime);

    var savingsHtml = '';
    if (best.delayHours > 0 && options[0]) {
      var nowIntensity = options[0].avgIntensity;
      if (nowIntensity > 0) {
        var savedPct = Math.round(((nowIntensity - best.avgIntensity) / nowIntensity) * 100);
        if (savedPct > 0) {
          savingsHtml = '<span class="rec-card__savings">' + savedPct + '% less carbon vs starting now</span>';
        }
      }
    }

    recommendationEl.innerHTML =
      '<div class="rec-card">' +
        '<p class="rec-card__delay">' + delayText + '</p>' +
        '<p class="rec-card__time">' + timeText + '</p>' +
        '<p class="rec-card__detail">' + best.avgIntensity + ' gCO\u2082/kWh average (' + best.index + ')</p>' +
        savingsHtml +
      '</div>';
  }

  function renderDelayOptions(options, best) {
    var max = 0;
    for (var i = 0; i < options.length; i++) {
      if (options[i].avgIntensity > max) max = options[i].avgIntensity;
    }

    var html = '';
    for (var j = 0; j < options.length; j++) {
      var opt = options[j];
      var isBest = opt.delayHours === best.delayHours;
      var barWidth = max > 0 ? (opt.avgIntensity / max) * 100 : 0;
      var colour = colourForIndex(opt.index);

      html +=
        '<div class="delay-card' + (isBest ? ' delay-card--best' : '') + '">' +
          (isBest ? '<span class="badge badge--best">Greenest</span>' : '') +
          '<p class="delay-card__label">' + (opt.delayHours === 0 ? 'Now' : '+' + opt.delayHours + 'h') + '</p>' +
          '<p class="delay-card__intensity">' + opt.avgIntensity + '</p>' +
          '<span class="delay-card__unit">gCO\u2082/kWh</span>' +
          '<p class="delay-card__time">' + formatTimeUK(opt.startTime) + ' \u2013 ' + formatTimeUK(opt.endTime) + '</p>' +
          '<div class="delay-card__bar-bg"><div class="delay-card__bar" style="width:' + barWidth + '%;background:' + colour + ';"></div></div>' +
          '<span class="badge" style="background:' + colour + ';">' + opt.index + '</span>' +
        '</div>';
    }

    delayOptionsEl.innerHTML = html;
  }

  function renderChart(slots, cycleMins, best) {
    var chartSlots = slots.slice(0, 12); // 6 hours = 12 half-hour slots
    var maxVal = 0;
    for (var i = 0; i < chartSlots.length; i++) {
      if (chartSlots[i].intensity.forecast > maxVal) maxVal = chartSlots[i].intensity.forecast;
    }

    var bestStart = (best.delayHours * 60) / SLOT_MINUTES;
    var bestEnd = bestStart + Math.ceil(cycleMins / SLOT_MINUTES);

    var bars = '';
    for (var j = 0; j < chartSlots.length; j++) {
      var slot = chartSlots[j];
      var height = maxVal > 0 ? (slot.intensity.forecast / maxVal) * 100 : 0;
      var colour = colourForIndex(slot.intensity.index);
      var isActive = j >= bestStart && j < bestEnd;

      bars +=
        '<div class="chart__bar-group' + (isActive ? ' chart__bar-group--active' : '') + '">' +
          '<div class="chart__value">' + slot.intensity.forecast + '</div>' +
          '<div class="chart__bar" style="height:' + height + '%;background:' + colour + ';" title="' + slot.intensity.forecast + ' gCO\u2082/kWh (' + slot.intensity.index + ')"></div>' +
          '<div class="chart__label">' + formatTimeUK(slot.from) + '</div>' +
        '</div>';
    }

    chartContainer.innerHTML = '<div class="chart">' + bars + '</div>';
    forecastSection.removeAttribute('hidden');
  }

  // --- UI state ---

  function showLoading(on) {
    if (on) {
      loadingEl.removeAttribute('hidden');
    } else {
      loadingEl.setAttribute('hidden', '');
    }
  }

  function showError(msg) {
    errorMsgEl.textContent = msg;
    errorEl.removeAttribute('hidden');
    // Hide content sections when error is shown
    recommendationEl.innerHTML = '';
    delayOptionsEl.innerHTML = '';
    chartContainer.innerHTML = '';
    forecastSection.setAttribute('hidden', '');
  }

  function hideError() {
    errorEl.setAttribute('hidden', '');
  }

  function updateLastUpdated() {
    lastUpdatedEl.textContent = 'Last updated: ' + formatTimeUK(new Date());
  }

  // --- Main update ---

  function update(forceRefresh) {
    var postcode = sanitisePostcode(postcodeInput.value);

    var fetchPromise;
    if (forceRefresh || !cachedSlots) {
      fetchPromise = fetchForecast(postcode).then(function (slots) {
        if (slots) {
          cachedSlots = slots;
          updateLastUpdated();
        }
        return slots;
      });
    } else {
      fetchPromise = Promise.resolve(cachedSlots);
    }

    return fetchPromise.then(function (slots) {
      if (!slots) return;

      var cycleMins = parseInt(cycleDurationSelect.value, 10);
      var options = calculateDelayOptions(slots, cycleMins);

      if (options.length === 0) {
        showError('Not enough forecast data available. Please try again later.');
        return;
      }

      var best = findBestDelay(options);
      renderRecommendation(best, options);
      renderDelayOptions(options, best);
      renderChart(slots, cycleMins, best);
    });
  }

  // --- Init ---

  document.addEventListener('DOMContentLoaded', function () {
    // Hide forecast section until data loads
    forecastSection.setAttribute('hidden', '');

    // Initial load
    update(true);

    // Cycle duration change: recalculate from cache
    cycleDurationSelect.addEventListener('change', function () {
      if (cachedSlots) {
        update(false);
      }
    });

    // Postcode change: debounce and re-fetch only when the postcode
    // is either empty (national) or a valid UK outward code.
    // While the user is mid-typing an incomplete postcode, do nothing
    // so we don't fire failed API calls or flash the national data.
    var postcodeTimer = null;
    var lastUsedPostcode = null;
    postcodeInput.addEventListener('input', function () {
      clearTimeout(postcodeTimer);
      postcodeTimer = setTimeout(function () {
        var raw = postcodeInput.value;
        var parsed = sanitisePostcode(raw);
        var isEmpty = raw.trim().length === 0;

        // Only re-fetch if the postcode is empty (switch to national)
        // or is a valid outward code that differs from the last fetch.
        if (isEmpty || parsed) {
          var effective = parsed || null;
          if (effective !== lastUsedPostcode) {
            lastUsedPostcode = effective;
            cachedSlots = null;
            update(true);
          }
        }
        // Otherwise the user is mid-typing — do nothing, keep current data
      }, 800);
    });

    // Retry button
    retryBtn.addEventListener('click', function () {
      cachedSlots = null;
      update(true);
    });

    // Auto-refresh every 30 minutes
    refreshTimer = setInterval(function () {
      cachedSlots = null;
      update(true);
    }, 30 * 60 * 1000);

    // Refresh when page becomes visible after being hidden for a while
    var lastVisible = Date.now();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        var elapsed = Date.now() - lastVisible;
        if (elapsed > 15 * 60 * 1000) { // 15 minutes
          cachedSlots = null;
          update(true);
        }
      } else {
        lastVisible = Date.now();
      }
    });
  });
})();
