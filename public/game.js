(function () {
  const DECAY_KM = 300; // shapes the curve between the hot/cold endpoints below
  const COLD_KM = 1500; // guesses this far (or farther) are all equally "coldest"
  const MAX_ATTEMPTS = 5;
  const WIN_KM = 50; // guess within this radius of the true point wins; also the "hottest" gauge distance
  const PLAYED_PREFIX = 'locale:played:';
  const STREAK_KEY = 'locale:streak';
  const STREAK_DATE_KEY = 'locale:streakDate';

  let guessLatLng = null;
  let guessMarker = null;
  let answerMarker = null;
  let guessLine = null;
  let pastGuessMarkers = [];
  let attempts = []; // { lat, lng, km }
  let locked = false;
  let currentDispatch = null;

  const map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([22.5, 80], 5);
  // Standard OSM tiles label places in their local script (Hindi, Tamil,
  // Bengali, etc.), pulled from each place's local `name` tag. Esri's basemap
  // renders place labels in English worldwide, so use that instead to keep
  // every location on the map in English.
  const labelledTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; OpenStreetMap contributors, Esri, HERE, Garmin, FAO, NOAA, USGS',
    maxZoom: 18,
  }).addTo(map);
  // Label-free basemap used only when revealing the answer, so the only
  // place name visible on the map is the one we add ourselves. Same public
  // Esri service as the labelled layer above, just a style with no place names.
  const unlabelledTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, HERE, Garmin, FAO, NOAA, USGS',
    maxZoom: 8,
  });
  const INDIA_BOUNDS = L.latLngBounds([6.5, 68.0], [37.5, 97.5]);

  const sourceNameEl = document.getElementById('sourceName');
  const dispatchDateEl = document.getElementById('dispatchDate');

  document.getElementById('zoomInBtn').addEventListener('click', () => map.zoomIn());
  document.getElementById('zoomOutBtn').addEventListener('click', () => map.zoomOut());

  const guessIcon = L.divIcon({
    className: 'guess-pin',
    html: '<div style="font-size:28px;line-height:1;">📍</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
  const answerIcon = L.divIcon({
    className: 'answer-pin',
    html: '<span class="material-symbols-outlined" style="font-size:28px;line-height:1;color:#ff1a1a;">my_location</span>',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    tooltipAnchor: [0, -28],
  });
  const pastGuessIcon = L.divIcon({
    className: 'past-guess-pin',
    html: '<div style="font-size:18px;line-height:1;opacity:0.45;">📍</div>',
    iconSize: [18, 18],
    iconAnchor: [9, 18],
  });

  const storyText = document.getElementById('storyText');
  const storyKicker = document.getElementById('storyKicker');
  const guessBtn = document.getElementById('guessBtn');
  const resultInline = document.getElementById('resultInline');
  const resultHeadline = document.getElementById('resultHeadline');
  const resultDetail = document.getElementById('resultDetail');
  const totalScoreEl = document.getElementById('totalScore');
  const streakEl = document.getElementById('streakVal');
  const resetPinBtn = document.getElementById('resetPinBtn');
  const gaugeMarkers = document.getElementById('gaugeMarkers');
  const gaugeHint = document.getElementById('gaugeHint');
  const distanceBadge = document.getElementById('distanceBadge');

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function verdictFor(km) {
    if (km < 15) return { label: "Bullseye! 🎯", tone: 'good' };
    if (km < 75) return { label: "Scarily close! 🔥", tone: 'good' };
    if (km < 250) return { label: "Same neighbourhood-ish 👍", tone: 'mid' };
    if (km < 700) return { label: "Right general vibe 🙃", tone: 'mid' };
    if (km < 1500) return { label: "Well... it's still India 🇮🇳", tone: 'bad' };
    return { label: "You basically guessed a different country's worth of distance 😅", tone: 'bad' };
  }

  function toneColor(tone) {
    return tone === 'good' ? 'var(--good)' : tone === 'mid' ? '#b8860b' : 'var(--bad)';
  }

  // Mirrors the server's 6:00 AM IST rollover (lib/dateKey.js) just enough
  // to compute "yesterday" for streak bookkeeping — the server's dateKey
  // in the API response is always the source of truth for "today".
  function yesterdayOf(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  function formatDateKey(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
  }

  function readStreakFor(dateKey) {
    const storedDate = localStorage.getItem(STREAK_DATE_KEY);
    const storedStreak = Number(localStorage.getItem(STREAK_KEY) || '0');
    if (storedDate === dateKey) return storedStreak;
    return 0;
  }

  function bumpStreak(dateKey) {
    const storedDate = localStorage.getItem(STREAK_DATE_KEY);
    const storedStreak = Number(localStorage.getItem(STREAK_KEY) || '0');
    const newStreak = storedDate === yesterdayOf(dateKey) ? storedStreak + 1 : 1;
    localStorage.setItem(STREAK_DATE_KEY, dateKey);
    localStorage.setItem(STREAK_KEY, String(newStreak));
    return newStreak;
  }

  function resetStreak(dateKey) {
    localStorage.setItem(STREAK_DATE_KEY, dateKey);
    localStorage.setItem(STREAK_KEY, '0');
    return 0;
  }

  async function fetchDispatch() {
    const res = await fetch('/api/dispatch', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load today\'s dispatch.');
    return data;
  }

  function setLoadingState(message) {
    storyKicker.textContent = 'FETCHING TODAY\'S DISPATCH...';
    sourceNameEl.textContent = '';
    storyText.textContent = message;
    guessBtn.disabled = true;
  }

  function clearBoard() {
    if (map.hasLayer(unlabelledTiles)) { map.removeLayer(unlabelledTiles); labelledTiles.addTo(map); }
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    if (answerMarker) { map.removeLayer(answerMarker); answerMarker = null; }
    if (guessLine) { map.removeLayer(guessLine); guessLine = null; }
    pastGuessMarkers.forEach((m) => map.removeLayer(m));
    pastGuessMarkers = [];
    attempts = [];
    guessLatLng = null;
    gaugeMarkers.innerHTML = '';
    gaugeHint.classList.remove('compact');
    distanceBadge.classList.add('hidden');
    distanceBadge.textContent = '';
  }

  function updateDistanceBadge(km) {
    distanceBadge.textContent = `${Math.round(km).toLocaleString('en-IN')} km away`;
    distanceBadge.classList.remove('hidden');
  }

  function markPastGuess(latlng, km, attemptNumber) {
    const marker = L.marker(latlng, { icon: pastGuessIcon }).addTo(map);
    marker.bindTooltip(`Guess ${attemptNumber}: ${Math.round(km).toLocaleString('en-IN')} km away`, {
      direction: 'top',
    });
    pastGuessMarkers.push(marker);
  }

  // Same exponential curve used for scoring, so the gauge's "hot" end
  // lights up in step with how the score actually grows as km shrinks.
  // Clamped so WIN_KM is full-hot and COLD_KM (or farther) is full-cold.
  const HOT_RAW = Math.exp(-WIN_KM / DECAY_KM);
  const COLD_RAW = Math.exp(-COLD_KM / DECAY_KM);
  function proximityFor(km) {
    if (km <= WIN_KM) return 1;
    if (km >= COLD_KM) return 0;
    const raw = Math.exp(-km / DECAY_KM);
    return (raw - COLD_RAW) / (HOT_RAW - COLD_RAW);
  }

  function renderGauge() {
    gaugeMarkers.innerHTML = '';
    gaugeHint.classList.toggle('compact', attempts.length > 0);
    attempts.forEach((a, i) => {
      const marker = document.createElement('div');
      marker.className = 'gauge-marker' + (i === attempts.length - 1 ? ' latest' : '');
      marker.style.top = `${(1 - proximityFor(a.km)) * 100}%`;
      marker.title = `Guess ${i + 1}: ${Math.round(a.km).toLocaleString('en-IN')} km away`;

      const tri = document.createElement('span');
      tri.className = 'gauge-tri';
      const num = document.createElement('span');
      num.className = 'gauge-num';
      num.textContent = String(i + 1);

      marker.appendChild(tri);
      marker.appendChild(num);
      gaugeMarkers.appendChild(marker);
    });
  }

  function updateAttemptsUI() {
    const left = MAX_ATTEMPTS - attempts.length;
    storyKicker.textContent = `LIVE DISPATCH — LOCATION REDACTED (${left} guess${left === 1 ? '' : 'es'} left)`;
  }

  function showAttemptFeedback(km) {
    const left = MAX_ATTEMPTS - attempts.length;
    const verdict = verdictFor(km);
    resultInline.classList.remove('hidden');
    resultHeadline.textContent = `${Math.round(km).toLocaleString('en-IN')} km away`;
    resultHeadline.style.color = toneColor(verdict.tone);
    resultDetail.innerHTML = `${verdict.label} ${left} guess${left === 1 ? '' : 'es'} left — click the map to try again.`;
    updateAttemptsUI();
  }

  function drawResult(story, won, bestKm, guessCount) {
    const last = attempts[attempts.length - 1];
    map.removeLayer(labelledTiles);
    unlabelledTiles.addTo(map);
    answerMarker = L.marker([story.lat, story.lng], { icon: answerIcon, zIndexOffset: 1000 }).addTo(map);
    answerMarker.bindTooltip(story.place, {
      permanent: true, direction: 'top', className: 'answer-label', offset: [0, -4],
    });
    if (last) {
      guessLine = L.polyline([[last.lat, last.lng], [story.lat, story.lng]], {
        color: '#b8342f', weight: 3, dashArray: '6 6'
      }).addTo(map);
    }

    map.fitBounds(INDIA_BOUNDS, { padding: [20, 20] });

    storyKicker.textContent = 'DISPATCH — LOCATION REVEALED';
    storyText.innerHTML = story.excerpt.replace(/█+/g, `<strong class="revealed">${story.place}</strong>`);

    const sourceLine = story.link
      ? ` <a href="${story.link}" target="_blank" rel="noopener noreferrer">Read the real story${story.source ? ` (${story.source})` : ''} →</a>`
      : '';

    if (won) {
      resultHeadline.textContent = `You found it in ${guessCount} guess${guessCount === 1 ? '' : 'es'}! 🎯`;
      resultHeadline.style.color = 'var(--good)';
      resultDetail.innerHTML = `It was <strong>${story.place}</strong>.${sourceLine}`;
    } else {
      resultHeadline.textContent = `Out of guesses! Best: ${Math.round(bestKm).toLocaleString('en-IN')} km away`;
      resultHeadline.style.color = toneColor(verdictFor(bestKm).tone);
      resultDetail.innerHTML = `It was <strong>${story.place}</strong>.${sourceLine}`;
    }

    resultInline.classList.remove('hidden');
    guessBtn.disabled = true;
    guessBtn.style.display = 'none';
    totalScoreEl.textContent = won ? `Guessed in ${guessCount}` : "Missed it :(";
  }

  function finishGame(story, won) {
    locked = true;
    const bestKm = Math.min(...attempts.map((a) => a.km));
    const guessCount = attempts.length;
    const newStreak = won ? bumpStreak(story.dateKey) : resetStreak(story.dateKey);
    streakEl.textContent = newStreak;

    localStorage.setItem(PLAYED_PREFIX + story.dateKey, JSON.stringify({
      attempts, finished: true, won, bestKm, guessCount,
    }));

    drawResult(story, won, bestKm, guessCount);

    const storyArea = document.getElementById('storyArea');
    storyArea.scrollTop = storyArea.scrollHeight;
  }

  function onMapClick(e) {
    if (locked || !currentDispatch) return;
    const pending = e.latlng;
    if (guessMarker) map.removeLayer(guessMarker);
    guessMarker = L.marker(pending, { icon: guessIcon }).addTo(map);
    guessLatLng = pending;
    guessBtn.disabled = false;
  }

  map.on('click', onMapClick);

  resetPinBtn.addEventListener('click', () => {
    if (locked) return;
    guessLatLng = null;
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    guessBtn.disabled = true;
  });

  function submitGuess() {
    if (!guessLatLng || locked || !currentDispatch) return;

    const story = currentDispatch;
    const km = haversineKm(guessLatLng.lat, guessLatLng.lng, story.lat, story.lng);
    attempts.push({ lat: guessLatLng.lat, lng: guessLatLng.lng, km });
    markPastGuess(guessLatLng, km, attempts.length);
    renderGauge();
    updateDistanceBadge(km);

    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    guessLatLng = null;
    guessBtn.disabled = true;

    const won = km <= WIN_KM;
    const outOfTries = attempts.length >= MAX_ATTEMPTS;

    if (won || outOfTries) {
      finishGame(story, won);
    } else {
      showAttemptFeedback(km);
      localStorage.setItem(PLAYED_PREFIX + story.dateKey, JSON.stringify({
        attempts, finished: false,
      }));
    }
  }

  function showNoPuzzle() {
    storyKicker.textContent = 'NO DISPATCH TODAY';
    sourceNameEl.textContent = '';
    storyText.textContent = "Today's puzzle isn't ready yet — check back soon.";
    guessBtn.disabled = true;
    guessBtn.style.display = 'none';
  }

  async function startGame() {
    guessBtn.style.display = '';
    resultInline.classList.add('hidden');
    storyText.classList.remove('hidden');
    setLoadingState('Pulling today\'s real Indian local news dispatch and redacting the place name...');
    clearBoard();

    let dispatch;
    try {
      dispatch = await fetchDispatch();
    } catch (err) {
      showNoPuzzle();
      return;
    }

    currentDispatch = dispatch;
    dispatchDateEl.textContent = formatDateKey(dispatch.dateKey);
    sourceNameEl.textContent = dispatch.source || 'Local Wire';

    const playedRaw = localStorage.getItem(PLAYED_PREFIX + dispatch.dateKey);
    streakEl.textContent = readStreakFor(dispatch.dateKey);

    if (playedRaw) {
      const played = JSON.parse(playedRaw);
      attempts = played.attempts || [];
      attempts.forEach((a, i) => markPastGuess({ lat: a.lat, lng: a.lng }, a.km, i + 1));
      renderGauge();
      if (attempts.length) updateDistanceBadge(attempts[attempts.length - 1].km);

      if (played.finished) {
        locked = true;
        guessBtn.disabled = true;
        drawResult(dispatch, played.won, played.bestKm, played.guessCount || played.attempts.length);
      } else {
        locked = false;
        storyKicker.textContent = dispatch.excerpt ? 'LIVE DISPATCH — LOCATION REDACTED' : '';
        storyText.innerHTML = dispatch.excerpt.replace(/█+/g, '<strong>██████</strong>');
        guessBtn.onclick = submitGuess;
        guessBtn.disabled = true;
        updateAttemptsUI();
      }
      return;
    }

    locked = false;
    storyKicker.textContent = `LIVE DISPATCH — LOCATION REDACTED (${MAX_ATTEMPTS} guesses left)`;
    storyText.innerHTML = dispatch.excerpt.replace(/█+/g, '<strong>██████</strong>');
    guessBtn.onclick = submitGuess;
    guessBtn.disabled = true;
    totalScoreEl.textContent = '';
  }

  startGame();
})();
