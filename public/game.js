(function () {
  const ROUNDS = 5;
  const MAX_SCORE_PER_ROUND = 5000;
  const DECAY_KM = 300; // how forgiving the scoring curve is

  let roundIndex = 0;
  let totalScore = 0;
  let streak = 0;
  let guessLatLng = null;
  let guessMarker = null;
  let answerMarker = null;
  let guessLine = null;
  let locked = false;
  let currentDispatch = null;
  let loading = false;

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

  dispatchDateEl.textContent = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

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
  const nextBtn = document.getElementById('nextBtn');
  const totalScoreEl = document.getElementById('totalScore');
  const streakEl = document.getElementById('streakVal');
  const endScreen = document.getElementById('endScreen');
  const endScoreEl = document.getElementById('endScore');
  const endFlavorEl = document.getElementById('endFlavor');
  const restartBtn = document.getElementById('restartBtn');
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
    const score = MAX_SCORE_PER_ROUND * Math.exp(-km / DECAY_KM);
    return Math.round(score);
  }

  function verdictFor(km) {
    if (km < 15) return { label: "Bullseye! 🎯", tone: 'good' };
    if (km < 75) return { label: "Scarily close! 🔥", tone: 'good' };
    if (km < 250) return { label: "Same neighbourhood-ish 👍", tone: 'mid' };
    if (km < 700) return { label: "Right general vibe 🙃", tone: 'mid' };
    if (km < 1500) return { label: "Well... it's still India 🇮🇳", tone: 'bad' };
    return { label: "You basically guessed a different country's worth of distance 😅", tone: 'bad' };
  }

  async function fetchDispatch() {
    const res = await fetch('/api/dispatch', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load a dispatch.');
    return data;
  }

  function setLoadingState(message) {
    loading = true;
    storyKicker.textContent = 'FETCHING LIVE DISPATCH...';
    sourceNameEl.textContent = '';
    storyText.textContent = message;
    guessBtn.disabled = true;
  }

  async function startGame() {
    roundIndex = 0;
    totalScore = 0;
    streak = 0;
    totalScoreEl.textContent = '0';
    streakEl.textContent = '0';
    endScreen.classList.add('hidden');
    await loadRound();
  }

  async function loadRound() {
    locked = false;
    guessLatLng = null;
    currentDispatch = null;
    resultInline.classList.add('hidden');
    storyText.classList.remove('hidden');

    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    if (answerMarker) { map.removeLayer(answerMarker); answerMarker = null; }
    if (guessLine) { map.removeLayer(guessLine); guessLine = null; }

    map.setView([22.5, 80], 5);

    setLoadingState('Pulling a real, live Indian local news story off the wire and redacting the place name...');

    try {
      currentDispatch = await fetchDispatch();
      storyKicker.textContent = 'LIVE DISPATCH — LOCATION REDACTED';
      sourceNameEl.textContent = currentDispatch.source || 'Local Wire';
      storyText.innerHTML = currentDispatch.excerpt.replace(/█+/g, '<strong>██████</strong>');
      loading = false;
    } catch (err) {
      storyKicker.textContent = 'COULD NOT REACH THE NEWSROOM';
      storyText.textContent = err.message + ' Tap Submit to try fetching another dispatch.';
      guessBtn.disabled = false;
      guessBtn.onclick = loadRound;
      return;
    }

    guessBtn.onclick = submitGuess;
    guessBtn.disabled = true;
  }

  function onMapClick(e) {
    if (locked || loading || !currentDispatch) return;
    guessLatLng = e.latlng;
    if (guessMarker) map.removeLayer(guessMarker);
    guessMarker = L.marker(guessLatLng, { icon: guessIcon }).addTo(map);
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
    const roundScore = scoreForDistance(km);
    totalScore += roundScore;

    answerMarker = L.marker([story.lat, story.lng], { icon: answerIcon }).addTo(map);
    guessLine = L.polyline([guessLatLng, [story.lat, story.lng]], {
      color: '#b8342f', weight: 3, dashArray: '6 6'
    }).addTo(map);

    const bounds = L.latLngBounds([guessLatLng, [story.lat, story.lng]]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 9 });

    storyText.innerHTML = story.excerpt.replace(/█+/g, `<strong class="revealed">${story.place}</strong>`);

    const verdict = verdictFor(km);
    streak = verdict.tone === 'good' ? streak + 1 : 0;
    streakEl.textContent = streak;

    resultHeadline.textContent = `You were ${Math.round(km).toLocaleString('en-IN')} km away!`;
    resultHeadline.style.color = verdict.tone === 'good' ? 'var(--good)' : verdict.tone === 'mid' ? '#b8860b' : 'var(--bad)';

    const sourceLine = story.link
      ? ` <a href="${story.link}" target="_blank" rel="noopener noreferrer">Read the real story${story.source ? ` (${story.source})` : ''} →</a>`
      : '';
    resultDetail.innerHTML = `${verdict.label} It was <strong>${story.place}</strong>, earning <span class="score-pop">+${roundScore}</span> points.${sourceLine}`;

    resultInline.classList.remove('hidden');
    guessBtn.disabled = true;
    totalScoreEl.textContent = totalScore;

    const storyArea = document.getElementById('storyArea');
    storyArea.scrollTop = storyArea.scrollHeight;

    nextBtn.textContent = roundIndex + 1 < ROUNDS ? 'Next dispatch →' : 'See final score →';
  }

  function nextRound() {
    roundIndex++;
    if (roundIndex >= ROUNDS) {
      showEndScreen();
    } else {
      loadRound();
    }
  }

  function showEndScreen() {
    endScoreEl.textContent = `Final score: ${totalScore} / ${ROUNDS * MAX_SCORE_PER_ROUND}`;
    const avg = totalScore / ROUNDS;
    let flavor;
    if (avg > 4200) flavor = "You either live on Google Maps or you're some kind of geography wizard. Respect. 🧙";
    else if (avg > 3000) flavor = "Solid instincts — you clearly know your dosa belt from your paratha belt.";
    else if (avg > 1500) flavor = "Respectable chaos. You know India exists and roughly where the coasts are.";
    else flavor = "Bold strategy dropping pins like darts at a dartboard blindfolded. Try again?";
    endFlavorEl.textContent = flavor;
    endScreen.classList.remove('hidden');
  }

  nextBtn.addEventListener('click', nextRound);
  restartBtn.addEventListener('click', startGame);

  startGame();
})();
