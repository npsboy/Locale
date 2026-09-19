// Builds an in-memory India place-name -> coordinates index from GeoNames'
// public "cities15000" dataset (all populated places worldwide with 15,000+
// people), fetched fresh at server startup. This is what lets the backend
// resolve a place mentioned in a live news headline without needing a
// live geocoding API call for every single round — no place data is
// authored or hardcoded by this app; it's pulled straight from GeoNames.

const AdmZip = require('adm-zip');

const CITIES_URL = 'http://download.geonames.org/export/dump/cities15000.zip';
const ADMIN1_URL = 'http://download.geonames.org/export/dump/admin1CodesASCII.txt';
const USER_AGENT = 'LocaleGame/1.0 (educational geo-guessing game)';

let cityIndex = null; // Map<lowercase name, {name, lat, lng, admin1Key}>
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

async function init() {
  if (ready) return ready;
  ready = (async () => {
    const [cities, admin1] = await Promise.all([buildCityIndex(), buildAdmin1Names()]);
    cityIndex = cities;
    admin1Names = admin1;
    console.log(`Gazetteer ready: ${cityIndex.size} India place names indexed.`);
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
