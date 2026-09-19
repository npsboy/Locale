(function () {
  const MAX_SCORE = 5000;
  const DECAY_KM = 300; // how forgiving the scoring curve is
  const PLAYED_PREFIX = 'locale:played:';
  const STREAK_KEY = 'locale:streak';
  const STREAK_DATE_KEY = 'locale:streakDate';

  let guessLatLng = null;
  let guessMarker = null;
  let answerMarker = null;
  let guessLine = null;
  let locked = false;
  let currentDispatch = null;

  const map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([22.5, 80], 5);
  // Standard OSM tiles label places in their local script (Hindi, Tamil,
  // Bengali, etc.), pulled from each place's local `name` tag. Esri's basemap
  // renders place labels in English worldwide, so use that instead to keep
  // every location on the map in English.
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; OpenStreetMap contributors, Esri, HERE, Garmin, FAO, NOAA, USGS',
    maxZoom: 18,
  }).addTo(map);

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
    html: '<div style="font-size:28px;line-height:1;">🎯</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
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

  function scoreForDistance(km) {
    return Math.round(MAX_SCORE * Math.exp(-km / DECAY_KM));
  }

  function verdictFor(km) {
    if (km < 15) return { label: "Bullseye! 🎯", tone: 'good' };
    if (km < 75) return { label: "Scarily close! 🔥", tone: 'good' };
    if (km < 250) return { label: "Same neighbourhood-ish 👍", tone: 'mid' };
    if (km < 700) return { label: "Right general vibe 🙃", tone: 'mid' };
    if (km < 1500) return { label: "Well... it's still India 🇮🇳", tone: 'bad' };
    return { label: "You basically guessed a different country's worth of distance 😅", tone: 'bad' };
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

  function drawResult(story, guessLat, guessLng, km, score) {
    guessLatLng = { lat: guessLat, lng: guessLng };
    guessMarker = L.marker(guessLatLng, { icon: guessIcon }).addTo(map);
    answerMarker = L.marker([story.lat, story.lng], { icon: answerIcon }).addTo(map);
    guessLine = L.polyline([guessLatLng, [story.lat, story.lng]], {
      color: '#b8342f', weight: 3, dashArray: '6 6'
    }).addTo(map);

    const bounds = L.latLngBounds([guessLatLng, [story.lat, story.lng]]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });

    storyKicker.textContent = 'DISPATCH — LOCATION REVEALED';
    storyText.innerHTML = story.excerpt.replace(/█+/g, `<strong class="revealed">${story.place}</strong>`);

    const verdict = verdictFor(km);
    resultHeadline.textContent = `You were ${Math.round(km).toLocaleString('en-IN')} km away!`;
    resultHeadline.style.color = verdict.tone === 'good' ? 'var(--good)' : verdict.tone === 'mid' ? '#b8860b' : 'var(--bad)';

    const sourceLine = story.link
      ? ` <a href="${story.link}" target="_blank" rel="noopener noreferrer">Read the real story${story.source ? ` (${story.source})` : ''} →</a>`
      : '';
    resultDetail.innerHTML = `${verdict.label} It was <strong>${story.place}</strong>, earning <span class="score-pop">+${score}</span> points.${sourceLine}`;

    resultInline.classList.remove('hidden');
    guessBtn.disabled = true;
    guessBtn.style.display = 'none';
    totalScoreEl.textContent = score;
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
    locked = true;

    const story = currentDispatch;
    const km = haversineKm(guessLatLng.lat, guessLatLng.lng, story.lat, story.lng);
    const score = scoreForDistance(km);
    const newStreak = bumpStreak(story.dateKey);
    streakEl.textContent = newStreak;

    localStorage.setItem(PLAYED_PREFIX + story.dateKey, JSON.stringify({
      guessLat: guessLatLng.lat, guessLng: guessLatLng.lng, km, score,
    }));

    drawResult(story, guessLatLng.lat, guessLatLng.lng, km, score);

    const storyArea = document.getElementById('storyArea');
    storyArea.scrollTop = storyArea.scrollHeight;
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
      locked = true;
      guessBtn.disabled = true;
      drawResult(dispatch, played.guessLat, played.guessLng, played.km, played.score);
      return;
    }

    locked = false;
    storyKicker.textContent = 'LIVE DISPATCH — LOCATION REDACTED';
    storyText.innerHTML = dispatch.excerpt.replace(/█+/g, '<strong>██████</strong>');
    guessBtn.onclick = submitGuess;
    guessBtn.disabled = true;
    totalScoreEl.textContent = '0';
  }

  startGame();
})();
