// Locale backend — pulls REAL, LIVE Indian local news straight from major
// outlets' own RSS feeds and resolves whatever place each headline mentions
// against a GeoNames place index (gazetteer.js). Nothing about the game
// content (stories, places, coordinates) is authored here: every round is a
// fresh news item found and located dynamically against public datasets.

const express = require('express');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const nlp = require('compromise');
const gazetteer = require('./gazetteer');

const app = express();
const PORT = process.env.PORT || 8734;

// Pulling straight from each outlet's own RSS (rather than Google News'
// aggregator feed) matters for two reasons: their <link> is the real
// article URL directly — Google News wraps links in an obfuscated,
// client-side-only redirect that can't be resolved without reverse-engineering
// an undocumented internal API — and their <description> is usually a real
// lead paragraph, not a "here's everyone else's coverage of this" list.
// `bodySelector` is where each site's actual article text lives in the page,
// found by inspecting a sample article from each outlet — used to pull a
// full multi-paragraph excerpt rather than just the RSS teaser.
const NEWS_FEEDS = [
  { url: 'https://www.thehindu.com/news/national/feeder/default.rss', source: 'The Hindu', bodySelector: '.articlebodycontent p' },
  { url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', source: 'Hindustan Times', bodySelector: 'p.content' },
  { url: 'https://indianexpress.com/section/india/feed/', source: 'The Indian Express', bodySelector: '#pcl-full-content p' },
];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const STOPWORDS = new Set([
  'India', 'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'It', 'He', 'She',
  'They', 'We', 'You', 'I', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  // Common headline words that capitalize at a sentence start or in a
  // proper-noun-looking cluster ("More Probes", "High Court") but aren't
  // themselves a place — these have caused false gazetteer matches.
  'More', 'Most', 'New', 'Old', 'After', 'Before', 'Amid', 'Over', 'Under',
  'Also', 'Now', 'Then', 'State', 'Centre', 'Center', 'Govt', 'Government',
  'Police', 'Court', 'High', 'Supreme', 'Minister', 'President', 'Chief',
  'National', 'Union', 'Local', 'Man', 'Woman', 'Boy', 'Girl', 'Video',
  'Watch', 'Photos', 'Report', 'Reports', 'Big', 'Major', 'Latest',
  'Breaking', 'Exclusive', 'Viral', 'Shocking', 'Cops', 'Cop', 'Officer',
  'Officers', 'Arrested', 'Dies', 'Killed', 'Found', 'Says', 'Said',
  'Claims', 'Slams', 'Blames', 'Vows', 'Warns', 'Orders', 'Seeks', 'Demands',
  'Plans', 'Announces', 'Launches', 'Opens', 'Closes', 'Bans', 'Approves',
  'Rejects', 'Clears', 'Passes', 'Wins', 'Loses', 'Beats', 'Defeats',
]);

function decodeEntities(str) {
  return String(str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function getPersonNameWords(text) {
  // "Mahua Moitra moves UN..." would otherwise let "Mahua" slip through as
  // a place candidate, because a politician's name happens to also be a
  // town in Bihar. compromise's person tagger catches most byline-style
  // "Firstname Lastname <verb>" patterns so we can exclude those words
  // entirely before place-matching ever sees them.
  const people = nlp(text).people().out('array');
  const words = new Set();
  for (const person of people) {
    for (const w of person.split(/\s+/)) words.add(w.toLowerCase());
  }
  return words;
}

function extractPlaceCandidates(text) {
  const personWords = getPersonNameWords(text);

  // A headline like "Mumbai Police arrest man" capitalizes "Mumbai Police"
  // as one contiguous run — the actual place name is only part of it. So
  // for each run, try every contiguous sub-phrase (not just the whole run),
  // longest first, since the place is usually one or two of those words.
  const matches = text.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)\b/g) || [];
  const seen = new Set();
  const candidates = [];
  for (const m of matches) {
    const words = m.split(/\s+/).filter(w => !STOPWORDS.has(w) && !personWords.has(w.toLowerCase()));
    for (let len = Math.min(words.length, 3); len >= 1; len--) {
      for (let start = 0; start + len <= words.length; start++) {
        const cleaned = words.slice(start, start + len).join(' ');
        if (cleaned.length < 3 || seen.has(cleaned)) continue;
        seen.add(cleaned);
        candidates.push(cleaned);
      }
    }
  }
  // Prefer longer, more specific phrases first (e.g. "Navi Mumbai" over "Mumbai").
  candidates.sort((a, b) => b.split(' ').length - a.split(' ').length);
  return candidates;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function redactPlace(text, matchedText, place) {
  const namesToMask = new Set([matchedText, ...matchedText.split(/\s+/), ...place.split(',')[0].split(/\s+/)]);
  let redacted = text;
  for (const name of namesToMask) {
    const trimmed = name.trim();
    if (trimmed.length < 3) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '██████');
  }
  return redacted;
}

async function fetchFeed(feed) {
  const res = await fetchWithTimeout(feed.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${feed.source} feed responded ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  const list = Array.isArray(items) ? items : [items];
  return list.map(item => ({ ...item, _source: feed.source, _bodySelector: feed.bodySelector }));
}

const TARGET_WORD_COUNT = 230; // land the excerpt in the 200-250 word range
const BOILERPLATE_PATTERN = /^(also read|published -|subscribe|watch|read more|follow us|click here)/i;

// Fetches the real article page and pulls its actual body paragraphs (not
// just the one-line RSS teaser), stopping once we have a full paragraph's
// worth of real reporting — this is what gets the excerpt to 200-250 words
// instead of a single headline-length sentence.
async function fetchArticleBody(link, bodySelector) {
  const res = await fetchWithTimeout(link, { headers: { 'User-Agent': USER_AGENT } }, 8000);
  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);

  const paragraphs = [];
  let wordCount = 0;
  for (const el of $(bodySelector).toArray()) {
    if (wordCount >= TARGET_WORD_COUNT) break;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 30 || BOILERPLATE_PATTERN.test(text)) continue;
    paragraphs.push(text);
    wordCount += text.split(/\s+/).length;
  }

  if (wordCount < 180) return null; // article too short (or paywalled) to hit the 200-250 word target
  return paragraphs.join(' ');
}

function truncateWords(text, maxWords) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '…';
}

async function fetchNewsItems() {
  const results = await Promise.allSettled(NEWS_FEEDS.map(fetchFeed));
  const items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    else console.error('[feed] fetch failed:', r.reason.message);
  }
  if (items.length === 0) throw new Error('All news feeds failed');
  return items;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The same handful of top headlines keep reappearing across calls made
// seconds apart, since the live feed only turns over every few minutes.
// Track recently-served links so back-to-back rounds don't repeat a story.
const recentLinks = [];
const RECENT_LINKS_LIMIT = 25;
function markLinkSeen(link) {
  recentLinks.push(link);
  if (recentLinks.length > RECENT_LINKS_LIMIT) recentLinks.shift();
}
function isLinkSeen(link) {
  return recentLinks.includes(link) || dispatchQueue.some(d => d.link === link);
}

async function findDispatch() {
  const rawItems = await fetchNewsItems();
  const items = shuffle(rawItems).slice(0, 40);

  for (const item of items) {
    const title = decodeEntities(item.title || '').trim();
    const link = item.link || '';
    if (!link || isLinkSeen(link)) continue;

    // Place names most reliably show up in the headline ("Kerala's
    // Kozhikode ferry service suspended..."), so check for a matchable
    // candidate there first — cheap, no network call — before paying the
    // cost of fetching the full article page.
    const candidate = extractPlaceCandidates(title).map(c => ({ c, geo: gazetteer.lookup(c) })).find(x => x.geo);
    if (!candidate) continue;
    const { geo } = candidate;

    let body;
    try {
      body = await fetchArticleBody(link, item._bodySelector);
    } catch (e) {
      body = null;
    }
    if (!body) continue; // paywalled, blocked, or too little real content — try the next story

    const combinedText = `${title}. ${body}`;
    const excerpt = truncateWords(redactPlace(combinedText, geo.matchedText, geo.place), 250);
    if (!excerpt.includes('█')) continue; // redaction failed to apply, skip

    markLinkSeen(link);
    return { excerpt, place: geo.place, lat: geo.lat, lng: geo.lng, source: item._source, link };
  }
  return null;
}

// --- Background prefetch queue -------------------------------------------
// Keeps a small buffer of ready-to-serve dispatches so rounds load instantly.
// Gazetteer lookups are free and instant, so the only real cost per pass is
// fetching the RSS feed once — this loop can run tightly.
const QUEUE_TARGET = 4;
const dispatchQueue = [];
let queueFilling = false;

async function fillQueueLoop() {
  if (queueFilling) return;
  queueFilling = true;
  while (true) {
    if (dispatchQueue.length < QUEUE_TARGET) {
      try {
        const d = await findDispatch();
        if (d) dispatchQueue.push(d);
        else await sleep(2000); // feed had nothing new geocodable; don't hammer it
      } catch (e) {
        console.error('[queue] fill error:', e.message);
        await sleep(3000);
      }
    } else {
      await sleep(2000);
    }
  }
}

app.use(express.static('public'));

// The queue-filler above is the ONLY thing that ever calls findDispatch(), so
// a request just waits for it to hand over a ready dispatch.
const DISPATCH_WAIT_TIMEOUT_MS = 25000;

app.get('/api/dispatch', async (req, res) => {
  const deadline = Date.now() + DISPATCH_WAIT_TIMEOUT_MS;
  while (dispatchQueue.length === 0 && Date.now() < deadline) {
    await sleep(300);
  }
  if (dispatchQueue.length === 0) {
    return res.status(504).json({ error: 'The newsroom is taking unusually long to find a geocodable story — try again.' });
  }
  res.json(dispatchQueue.shift());
});

app.listen(PORT, () => {
  console.log(`Locale running at http://localhost:${PORT}`);
});

gazetteer.init()
  .then(() => fillQueueLoop())
  .catch(err => console.error('Failed to load gazetteer:', err.message));
