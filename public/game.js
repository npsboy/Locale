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

  const map = L.map('map', { worldCopyJump: true, zoomControl: false });
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
  map.fitBounds(INDIA_BOUNDS, { padding: [10, 10] });

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
  const shareBtn = document.getElementById('shareBtn');
  const shareOverlay = document.getElementById('shareOverlay');
  const shareCloseBtn = document.getElementById('shareCloseBtn');
  const shareCanvas = document.getElementById('shareCanvas');
  const shareStatus = document.getElementById('shareStatus');
  const shareCopyBtn = document.getElementById('shareCopyBtn');
  const shareDownloadBtn = document.getElementById('shareDownloadBtn');
  const shareXBtn = document.getElementById('shareXBtn');
  const shareFbBtn = document.getElementById('shareFbBtn');
  const shareIgBtn = document.getElementById('shareIgBtn');
  const shareNativeBtn = document.getElementById('shareNativeBtn');

  let lastGameSummary = null;

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
      // proximity: 0 = coldest, 1 = hottest. Desktop's vertical track reads
      // hot-at-top (top: 100% - pos); mobile's horizontal track reads
      // hot-at-right (left: pos) — see .gauge-marker rules in style.css.
      marker.style.setProperty('--pos', `${proximityFor(a.km) * 100}%`);
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
    setShareSummary(story, won, bestKm, guessCount, newStreak);

    const storyArea = document.getElementById('storyArea');
    storyArea.scrollTop = storyArea.scrollHeight;
  }

  function setShareSummary(story, won, bestKm, guessCount, streak) {
    lastGameSummary = {
      dateKey: story.dateKey,
      won,
      bestKm,
      guessCount,
      streak,
      attempts: attempts.map((a) => ({ km: a.km })),
    };
    shareBtn.hidden = false;
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
    shareBtn.hidden = true;
    lastGameSummary = null;
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
        const guessCount = played.guessCount || played.attempts.length;
        drawResult(dispatch, played.won, played.bestKm, guessCount);
        setShareSummary(dispatch, played.won, played.bestKm, guessCount, readStreakFor(dispatch.dateKey));
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

  // ---------- share card ----------

  // Background art supplies its own decorative frame; content is drawn
  // inside the plain cream panel at roughly these fractions of the image.
  const SHARE_BG_SRC = 'assets/share_card_bg.png';
  const shareBgImage = new Image();
  let shareBgLoaded = false;
  shareBgImage.addEventListener('load', () => { shareBgLoaded = true; });
  shareBgImage.src = SHARE_BG_SRC;

  function loadShareBg() {
    if (shareBgLoaded) return Promise.resolve();
    return new Promise((resolve) => {
      shareBgImage.addEventListener('load', () => resolve(), { once: true });
      shareBgImage.addEventListener('error', () => resolve(), { once: true });
    });
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Shrinks the font until `text` fits within maxWidth, then draws it centered at x/y.
  function fillFittedText(ctx, text, x, y, maxWidth, maxSize, weight, family) {
    let size = maxSize;
    ctx.font = `${weight} ${size}px ${family}`;
    while (ctx.measureText(text).width > maxWidth && size > 18) {
      size -= 2;
      ctx.font = `${weight} ${size}px ${family}`;
    }
    ctx.fillText(text, x, y);
  }

  function drawShareCard(summary) {
    const ctx = shareCanvas.getContext('2d');
    const W = shareCanvas.width;
    const H = shareCanvas.height;

    ctx.clearRect(0, 0, W, H);
    if (shareBgLoaded) {
      ctx.drawImage(shareBgImage, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#f1ead8';
      ctx.fillRect(0, 0, W, H);
    }

    // safe content area inside the background art's plain cream panel
    const left = 90;
    const right = W - 90;
    const contentW = right - left;

    // title
    ctx.textAlign = 'center';
    ctx.fillStyle = '#b8342f';
    ctx.font = "900 68px 'Playfair Display', Georgia, serif";
    ctx.fillText('LOCALE', W / 2, 150);

    ctx.fillStyle = '#4a4030';
    ctx.font = "italic 28px 'Special Elite', 'Courier New', monospace";
    ctx.fillText('Guess the place from the local news snippet.', W / 2, 208);

    // divider between the tagline and the date
    ctx.strokeStyle = '#b7a980';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 140, 224);
    ctx.lineTo(W / 2 + 140, 224);
    ctx.stroke();

    ctx.font = "24px 'Special Elite', 'Courier New', monospace";
    ctx.fillText(formatDateKey(summary.dateKey), W / 2, 254);

    // headline result
    const verdict = summary.won
      ? { label: `Solved in ${summary.guessCount}/${MAX_ATTEMPTS} guesses`, color: '#2f7a3d' }
      : { label: `Missed it — best ${Math.round(summary.bestKm).toLocaleString('en-IN')} km away`, color: '#b8342f' };
    ctx.fillStyle = verdict.color;
    fillFittedText(ctx, verdict.label, W / 2, 299, contentW - 40, 36, 800, "'Playfair Display', Georgia, serif");

    ctx.font = "700 26px 'Special Elite', monospace";
    ctx.fillStyle = '#201d16';
    ctx.fillText(`Streak: ${summary.streak} day${summary.streak === 1 ? '' : 's'}`, W / 2, 337);

    // "my guesses" ladder: one self-contained row per attempt, each with
    // its own mini hot/cold track + pointer + distance, so every guess is
    // readable on its own instead of crowding markers onto a single track.
    ctx.textAlign = 'left';
    ctx.font = "700 20px 'Special Elite', monospace";
    ctx.fillStyle = '#4a4030';
    ctx.fillText('MY GUESSES', left, 378);

    const badgeR = 24;
    const trackX = left + 62;
    const trackRight = right - 130;
    const trackW = trackRight - trackX;
    const trackH = 14;
    const rowH = 88;
    const rowsTop = 415;

    ctx.textAlign = 'left';
    ctx.font = "700 16px 'Special Elite', monospace";
    ctx.fillStyle = '#8a7c5e';
    ctx.fillText('COLD', trackX, rowsTop - 14);
    ctx.textAlign = 'right';
    ctx.fillText('HOT', trackRight, rowsTop - 14);

    summary.attempts.forEach((a, i) => {
      const rowY = rowsTop + i * rowH;
      const centerY = rowY + badgeR;
      const isLast = i === summary.attempts.length - 1;

      // number badge
      ctx.beginPath();
      ctx.arc(left + badgeR, centerY, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = isLast ? '#b8342f' : '#201d16';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f1ead8';
      ctx.font = "700 22px 'Special Elite', monospace";
      ctx.fillText(String(i + 1), left + badgeR, centerY + 8);

      // mini gradient track for this guess — blue (cold/far) on the left,
      // red (hot/close) on the right, matching where the pointer below
      // actually lands (proximity 0 -> trackX, proximity 1 -> trackRight)
      const grad = ctx.createLinearGradient(trackX, 0, trackRight, 0);
      grad.addColorStop(0, '#2fc2e0');
      grad.addColorStop(0.5, '#ffb020');
      grad.addColorStop(1, '#ff4433');
      ctx.fillStyle = grad;
      roundRectPath(ctx, trackX, centerY - trackH / 2, trackW, trackH, trackH / 2);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1.5;
      roundRectPath(ctx, trackX, centerY - trackH / 2, trackW, trackH, trackH / 2);
      ctx.stroke();
      ctx.restore();

      // pointer at this guess's position on the track
      const px = trackX + proximityFor(a.km) * trackW;
      ctx.beginPath();
      ctx.arc(px, centerY, 11, 0, Math.PI * 2);
      ctx.fillStyle = '#201d16';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, centerY, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#f1ead8';
      ctx.fill();

      // distance label, color-coded to match the in-game verdict tone
      const tone = verdictFor(a.km).tone;
      ctx.fillStyle = tone === 'good' ? '#2f7a3d' : tone === 'mid' ? '#b8860b' : '#b8342f';
      ctx.textAlign = 'right';
      ctx.font = "700 24px 'Special Elite', monospace";
      ctx.fillText(`${Math.round(a.km).toLocaleString('en-IN')} km`, right, centerY + 8);
    });

    // footer
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8a7c5e';
    ctx.font = "20px 'Special Elite', monospace";
    ctx.fillText(`Play at ${window.location.host || 'whereinindia'}`, W / 2, H - 85);
  }

  async function canvasToBlob() {
    return new Promise((resolve) => shareCanvas.toBlob(resolve, 'image/png'));
  }

  function shareText() {
    const s = lastGameSummary;
    if (!s) return '';
    const result = s.won
      ? `I solved today's Locale in ${s.guessCount}/${MAX_ATTEMPTS} guesses`
      : `Today's Locale got me — best guess was ${Math.round(s.bestKm).toLocaleString('en-IN')} km away`;
    return `${result}. Streak: ${s.streak} day${s.streak === 1 ? '' : 's'}. Can you beat me?`;
  }

  async function openShareOverlay() {
    if (!lastGameSummary) return;
    shareStatus.textContent = '';
    shareOverlay.classList.remove('hidden');
    await loadShareBg();
    if (!lastGameSummary) return;
    drawShareCard(lastGameSummary);

    const canShareFiles = !!(navigator.canShare && navigator.share);
    shareNativeBtn.hidden = !canShareFiles;
  }

  function closeShareOverlay() {
    shareOverlay.classList.add('hidden');
  }

  shareBtn.addEventListener('click', openShareOverlay);
  shareCloseBtn.addEventListener('click', closeShareOverlay);
  shareOverlay.addEventListener('click', (e) => {
    if (e.target === shareOverlay) closeShareOverlay();
  });

  shareCopyBtn.addEventListener('click', async () => {
    try {
      const blob = await canvasToBlob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      shareStatus.textContent = 'Image copied to clipboard!';
    } catch (err) {
      shareStatus.textContent = 'Could not copy — try Download instead.';
    }
  });

  shareDownloadBtn.addEventListener('click', async () => {
    const blob = await canvasToBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `where-in-india-${lastGameSummary.dateKey}.png`;
    a.click();
    URL.revokeObjectURL(url);
    shareStatus.textContent = 'Image downloaded!';
  });

  async function copyImageQuietly() {
    try {
      const blob = await canvasToBlob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch (err) {
      return false;
    }
  }

  shareXBtn.addEventListener('click', async () => {
    const copied = await copyImageQuietly();
    shareStatus.textContent = copied ? 'Image copied — paste it into your post!' : '';
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText())}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  shareFbBtn.addEventListener('click', async () => {
    const copied = await copyImageQuietly();
    shareStatus.textContent = copied ? 'Image copied — paste it into your post!' : '';
    const url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}&quote=${encodeURIComponent(shareText())}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  shareIgBtn.addEventListener('click', async () => {
    if (navigator.canShare && navigator.share) {
      try {
        const blob = await canvasToBlob();
        const file = new File([blob], `where-in-india-${lastGameSummary.dateKey}.png`, { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Locale', text: shareText() });
          return;
        }
      } catch (err) {
        // fall through to manual instructions
      }
    }
    const copied = await copyImageQuietly();
    shareStatus.textContent = copied
      ? 'Image copied! Open Instagram and paste it into your story.'
      : 'Download the image, then share it on Instagram.';
  });

  shareNativeBtn.addEventListener('click', async () => {
    try {
      const blob = await canvasToBlob();
      const file = new File([blob], `where-in-india-${lastGameSummary.dateKey}.png`, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Locale', text: shareText() });
      }
    } catch (err) {
      // user cancelled or share unsupported — no-op
    }
  });

  startGame();
})();
