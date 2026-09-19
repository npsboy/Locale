// Builds an in-memory India place-name -> coordinates index from GeoNames'
// public "cities15000" dataset (all populated places worldwide with 15,000+
// people). No place data is authored or hardcoded by this app; it's pulled
// straight from GeoNames.
//
// This only ever runs from the once-daily generation path now (the cron
// routes and the on-demand fallback in api/dispatch.js), never on the
// per-request read path, so its ~1-few-second cold cost doesn't affect
// normal visitors. It's still worth caching the parsed result in KV (see
// loadFromCache/saveToCache below) so a cold generation invocation doesn't
// have to re-fetch+re-unzip GeoNames every single day.

const AdmZip = require('adm-zip');
const { kv } = require('./kv');

const CITIES_URL = 'http://download.geonames.org/export/dump/cities15000.zip';
const ADMIN1_URL = 'http://download.geonames.org/export/dump/admin1CodesASCII.txt';
const USER_AGENT = 'LocaleGame/1.0 (educational geo-guessing game)';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — GeoNames data barely changes
const CITIES_CACHE_KEY = 'gazetteer:v1:cities';
const ADMIN1_CACHE_KEY = 'gazetteer:v1:admin1';

let cityIndex = null; // Map<lowercase name, {name, lat, lng, admin1Key, population}>
let admin1Names = null; // Map<"IN.19", "Karnataka">
let ready = null;

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function titleCase(str) {
  if (str !== str.toUpperCase()) return str; // already mixed-case, leave it alone
  return str.replace(/\w\S*/g, w => w[0] + w.slice(1).toLowerCase());
}

async function buildAdmin1Names() {
  const text = await fetchText(ADMIN1_URL);
  const map = new Map();
  for (const line of text.split('\n')) {
    const [code, name] = line.split('\t');
    if (code && code.startsWith('IN.')) map.set(code, name);
  }
  return map;
}

async function buildCityIndex() {
  const zipBuffer = await fetchBuffer(CITIES_URL);
  const zip = new AdmZip(zipBuffer);
  const entry = zip.getEntries().find(e => e.entryName.endsWith('.txt'));
  const text = entry.getData().toString('utf8');

  const index = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const cols = line.split('\t');
    // geonameid, name, asciiname, alternatenames, lat, lng, featureClass,
    // featureCode, countryCode, cc2, admin1Code, admin2Code, admin3Code,
    // admin4Code, population, ...
    const [, name, asciiname, , lat, lng, , , countryCode, , admin1Code, , , , population] = cols;
    if (countryCode !== 'IN') continue;
    const pop = Number(population) || 0;
    // Small towns are more likely to collide with an ordinary capitalized
    // English word (e.g. a hamlet literally named "More"). Requiring a
    // reasonably sized place cuts that noise while still covering any town
    // a real news story would plausibly name.
    if (pop < 20000) continue;

    const record = {
      // A handful of GeoNames rows store the name in ALL CAPS (e.g. "JOHAL
      // NANGAL") — normalize to Title Case so it displays like the rest.
      name: titleCase(asciiname || name),
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      admin1Key: `IN.${admin1Code}`,
      population: pop,
    };

    // Deliberately NOT indexing GeoNames' `alternatenames` column — it's
    // full of transliterations, festival/local names and generic short
    // strings that collide constantly with ordinary English words. Sticking
    // to the canonical name/asciiname is far more precise, and it's what a
    // news headline would use anyway.
    for (const n of new Set([name, asciiname])) {
      const key = (n || '').trim().toLowerCase();
      if (key.length < 3) continue;
      // If the same name belongs to multiple places, keep whichever is
      // more populous — it's the one a headline is more likely to mean.
      const existing = index.get(key);
      if (!existing || existing.population < record.population) index.set(key, record);
    }
  }
  return index;
}

async function loadFromCache() {
  try {
    const [citiesRaw, admin1Raw] = await Promise.all([
      kv.get(CITIES_CACHE_KEY),
      kv.get(ADMIN1_CACHE_KEY),
    ]);
    if (!citiesRaw || !admin1Raw) return null;
    return {
      cities: new Map(citiesRaw),
      admin1: new Map(admin1Raw),
    };
  } catch (e) {
    console.error('[gazetteer] cache read failed, falling back to GeoNames:', e.message);
    return null;
  }
}

async function saveToCache(cities, admin1) {
  try {
    await Promise.all([
      kv.set(CITIES_CACHE_KEY, [...cities.entries()], { ex: CACHE_TTL_SECONDS }),
      kv.set(ADMIN1_CACHE_KEY, [...admin1.entries()], { ex: CACHE_TTL_SECONDS }),
    ]);
  } catch (e) {
    console.error('[gazetteer] cache write failed (non-fatal):', e.message);
  }
}

async function init() {
  if (ready) return ready;
  ready = (async () => {
    const cached = await loadFromCache();
    if (cached) {
      cityIndex = cached.cities;
      admin1Names = cached.admin1;
      console.log(`Gazetteer ready from cache: ${cityIndex.size} India place names indexed.`);
      return;
    }
    const [cities, admin1] = await Promise.all([buildCityIndex(), buildAdmin1Names()]);
    cityIndex = cities;
    admin1Names = admin1;
    console.log(`Gazetteer ready from GeoNames: ${cityIndex.size} India place names indexed.`);
    await saveToCache(cities, admin1);
  })();
  return ready;
}

function isReady() {
  return cityIndex !== null;
}

// Looks up a candidate phrase (e.g. "Navi Mumbai" or "Bengaluru") against
// the index. Returns { matchedText, place, lat, lng } or null.
//
// A single common word (e.g. "Are", "More") is far more likely to
// accidentally share a name with some obscure small town than a genuinely
// well-known city is, so single-word candidates need a much higher
// population to be trusted; multi-word phrases are already specific enough
// that a lower bar is fine.
function lookup(candidate) {
  if (!cityIndex) return null;
  const key = candidate.trim().toLowerCase();
  const hit = cityIndex.get(key);
  if (!hit) return null;

  const isSingleWord = !candidate.trim().includes(' ');
  const minPopulation = isSingleWord ? 150000 : 20000;
  if (hit.population < minPopulation) return null;

  const state = admin1Names ? admin1Names.get(hit.admin1Key) : null;
  const displayPlace = state && state !== hit.name ? `${hit.name}, ${state}` : hit.name;

  return {
    matchedText: candidate,
    place: displayPlace,
    lat: hit.lat,
    lng: hit.lng,
  };
}

module.exports = { init, isReady, lookup };
