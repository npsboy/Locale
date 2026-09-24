// Pulls REAL, LIVE Indian local news straight from major outlets' own RSS
// feeds and resolves whatever place each headline mentions against a
// GeoNames place index (./gazetteer). Nothing about the game content
// (stories, places, coordinates) is authored here: every dispatch is a
// fresh news item found and located dynamically against public datasets.
//
// This module is called once per day (by the cron routes, or the on-demand
// fallback in api/dispatch.js), so findDispatches() is bounded on every
// axis — feed count, headlines scanned, article fetches attempted, and a
// wall-clock deadline — to stay inside a Vercel serverless function's
// execution time limit. See the maxDuration note in vercel.json.

const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const nlp = require('compromise');
const gazetteer = require('./gazetteer');
const cityAliases = require('./cityAliases');

// Pulling straight from each outlet's own RSS (rather than Google News'
// aggregator feed) matters for two reasons: their <link> is the real
// article URL directly — Google News wraps links in an obfuscated,
// client-side-only redirect that can't be resolved without reverse-engineering
// an undocumented internal API — and their <description> is usually a real
// lead paragraph, not a "here's everyone else's coverage of this" list.
//
// The city/state feeds matter more than the national ones: national desks
// file overwhelmingly from Delhi, which this game excludes, so scraping only
// national feeds starved the generator of usable stories. City feeds are
// almost entirely datelined somewhere else, and they're what makes a
// geocodable non-Delhi story easy to find rather than a lucky draw.
//
// `bodySelector` is where each site's article text lives, found by
// inspecting a sample article per outlet. It's only a fast path now —
// extractByDensity() below recovers the body without it — so a site
// redesign degrades one outlet's precision instead of killing it outright.
const OUTLETS = [
  {
    source: 'The Hindu',
    bodySelector: '.articlebodycontent p',
    feeds: [
      'https://www.thehindu.com/news/national/feeder/default.rss',
      'https://www.thehindu.com/news/national/andhra-pradesh/feeder/default.rss',
      'https://www.thehindu.com/news/national/karnataka/feeder/default.rss',
      'https://www.thehindu.com/news/national/kerala/feeder/default.rss',
      'https://www.thehindu.com/news/national/tamil-nadu/feeder/default.rss',
      'https://www.thehindu.com/news/national/telangana/feeder/default.rss',
      'https://www.thehindu.com/news/national/other-states/feeder/default.rss',
      'https://www.thehindu.com/news/cities/bangalore/feeder/default.rss',
      'https://www.thehindu.com/news/cities/chennai/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Hyderabad/feeder/default.rss',
      'https://www.thehindu.com/news/cities/mumbai/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Kochi/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Coimbatore/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Madurai/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Thiruvananthapuram/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Vijayawada/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Visakhapatnam/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Mangalore/feeder/default.rss',
      'https://www.thehindu.com/news/cities/Tiruchirapalli/feeder/default.rss',
    ],
  },
  {
    source: 'The Indian Express',
    bodySelector: '#pcl-full-content p',
    feeds: [
      'https://indianexpress.com/section/india/feed/',
      'https://indianexpress.com/section/cities/mumbai/feed/',
      'https://indianexpress.com/section/cities/bangalore/feed/',
      'https://indianexpress.com/section/cities/pune/feed/',
      'https://indianexpress.com/section/cities/ahmedabad/feed/',
      'https://indianexpress.com/section/cities/lucknow/feed/',
      'https://indianexpress.com/section/cities/kolkata/feed/',
      'https://indianexpress.com/section/cities/hyderabad/feed/',
      'https://indianexpress.com/section/cities/chennai/feed/',
      'https://indianexpress.com/section/cities/jaipur/feed/',
      'https://indianexpress.com/section/cities/chandigarh/feed/',
    ],
  },
  {
    source: 'Hindustan Times',
    bodySelector: 'p.content',
    feeds: [
      'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',
      'https://www.hindustantimes.com/feeds/rss/cities/rssfeed.xml',
      'https://www.hindustantimes.com/feeds/rss/cities/mumbai-news/rssfeed.xml',
      'https://www.hindustantimes.com/feeds/rss/cities/bengaluru-news/rssfeed.xml',
      'https://www.hindustantimes.com/feeds/rss/cities/pune-news/rssfeed.xml',
    ],
  },
];

const NEWS_FEEDS = OUTLETS.flatMap(o =>
  o.feeds.map(url => ({ url, source: o.source, bodySelector: o.bodySelector }))
);

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FEED_CONCURRENCY = 8;
const FEED_TIMEOUT_MS = 6000;
const ARTICLE_CONCURRENCY = 8;
const MAX_TITLE_SCAN = 500; // headlines run through the (CPU-bound) place tagger
const MAX_ARTICLE_ATTEMPTS = 30;
const ARTICLE_PHASE_BUDGET_MS = 35000; // leaves room for feeds + gazetteer inside maxDuration

// These feeds are archives as much as news wires: measured across all 35,
// only ~20% of items were published in the last day and over half were more
// than a week old, with some Indian Express section feeds still serving
// two-year-old stories. Picking uniformly at random therefore surfaced
// stale news regularly, so age is now a hard filter rather than something
// the pipeline ignores.
const MAX_STORY_AGE_DAYS = 3;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Runs `fn` over `items` with at most `limit` in flight, so dozens of feeds
// and article pages can be fetched within one serverless invocation without
// opening dozens of sockets at once.
async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await fn(items[cursor++]);
    }
  });
  await Promise.all(workers);
}

// Old/colonial-era city names (e.g. "Madras" for Chennai) are as much a
// giveaway as the place name itself, so they're masked with a distinct
// glyph before the primary pass runs — otherwise an alias word would just
// get swallowed into the primary mask and look identical to it.
function redactAliases(text, place) {
  const aliases = cityAliases[place.split(',')[0]] || [];
  let redacted = text;
  let aliasPlace = null;
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
    if (pattern.test(redacted)) {
      aliasPlace = alias;
      redacted = redacted.replace(pattern, '▓▓▓▓▓▓');
    }
  }
  return { redacted, aliasPlace };
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
  const res = await fetchWithTimeout(feed.url, { headers: { 'User-Agent': USER_AGENT } }, FEED_TIMEOUT_MS);
  if (!res.ok) throw new Error(`${feed.source} feed responded ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  const list = Array.isArray(items) ? items : [items];
  return list.map(item => ({ ...item, _source: feed.source, _bodySelector: feed.bodySelector }));
}

const TARGET_WORD_COUNT = 230; // land the excerpt in the 200-250 word range
const MIN_BODY_WORDS = 150; // below this the excerpt is too thin to be a fair puzzle
const BOILERPLATE_PATTERN = /^(also read|published -|subscribe|watch|read more|follow us|click here)/i;

function usableParagraphs($, elements) {
  const paragraphs = [];
  for (const el of elements) {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 30 || BOILERPLATE_PATTERN.test(text)) continue;
    paragraphs.push(text);
  }
  return paragraphs;
}

function wordCount(paragraphs) {
  return paragraphs.reduce((n, p) => n + p.split(/\s+/).length, 0);
}

// Selector-free body recovery: score every paragraph's parent by how much
// prose it holds and take the densest one. Article pages put the story in
// the heaviest text container on the page, so this finds the body even when
// an outlet redesigns and its hand-tuned selector stops matching.
function extractByDensity($) {
  $('script, style, nav, header, footer, aside, figure, figcaption').remove();
  const scores = new Map();
  const containers = new Map();
  $('p').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 40) return;
    const parent = $(el).parent();
    if (!parent || !parent[0]) return;
    const key = parent[0];
    scores.set(key, (scores.get(key) || 0) + text.split(/\s+/).length);
    containers.set(key, parent);
  });

  let best = null;
  let bestScore = 0;
  for (const [key, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = containers.get(key);
    }
  }
  return best ? usableParagraphs($, best.find('p').toArray()) : [];
}

// Fetches the real article page and pulls its actual body paragraphs (not
// just the one-line RSS teaser), so the excerpt lands at 200-250 words
// instead of a single headline-length sentence.
async function fetchArticleBody(link, bodySelector, timeoutMs) {
  const res = await fetchWithTimeout(link, { headers: { 'User-Agent': USER_AGENT } }, timeoutMs);
  if (!res.ok) return null;
  const html = await res.text();

  const $ = cheerio.load(html);
  let paragraphs = usableParagraphs($, $(bodySelector).toArray());
  if (wordCount(paragraphs) < MIN_BODY_WORDS) {
    const byDensity = extractByDensity(cheerio.load(html));
    if (wordCount(byDensity) > wordCount(paragraphs)) paragraphs = byDensity;
  }
  if (wordCount(paragraphs) < MIN_BODY_WORDS) return null; // paywalled, blocked, or too thin

  const kept = [];
  let words = 0;
  for (const text of paragraphs) {
    if (words >= TARGET_WORD_COUNT) break;
    kept.push(text);
    words += text.split(/\s+/).length;
  }
  return kept.join(' ');
}

function truncateWords(text, maxWords) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '…';
}

async function fetchNewsItems() {
  const collected = [];
  await mapWithConcurrency(NEWS_FEEDS, FEED_CONCURRENCY, async feed => {
    try {
      collected.push(...await fetchFeed(feed));
    } catch (e) {
      console.error(`[feed] ${feed.url} failed:`, e.message);
    }
  });

  // The same story is often carried by both an outlet's national feed and
  // its city feed; dedupe so one story can't occupy several pool slots.
  const byLink = new Map();
  for (const item of collected) {
    const link = typeof item.link === 'string' ? item.link : '';
    if (link && !byLink.has(link)) byLink.set(link, item);
  }
  if (byLink.size === 0) throw new Error('All news feeds failed');
  return [...byLink.values()];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function publishedAtMs(item) {
  const raw = item.pubDate || item['dc:date'] || item.published || null;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

// All three outlets stamp every item with a parseable date, so an item
// whose age can't be established is treated as unusable rather than
// assumed recent — that assumption is exactly what let month-old stories
// through. Slightly future-dated items are tolerated because feeds
// occasionally get timezones wrong.
function isFresh(item, now, maxAgeDays) {
  const published = publishedAtMs(item);
  if (published === null) return false;
  const ageDays = (now - published) / 86400000;
  return ageDays <= maxAgeDays && ageDays >= -1;
}

// Place names most reliably show up in the headline ("Kerala's Kozhikode
// ferry service suspended..."), and geocoding one is pure CPU work — so
// every candidate is resolved here, before any article page is fetched.
// Only headlines that already yielded a usable, non-Delhi place go on to
// cost a network round trip.
function geocodeHeadlines(items, excludeLinks) {
  const located = [];
  for (const item of items) {
    const link = typeof item.link === 'string' ? item.link : '';
    if (!link || excludeLinks.has(link)) continue;

    const title = decodeEntities(item.title || '').trim();
    if (!title) continue;

    const geo = extractPlaceCandidates(title).map(c => gazetteer.lookup(c)).find(Boolean);
    if (!geo) continue;
    if (/\bdelhi\b/i.test(geo.place)) continue; // user doesn't want Delhi datelines

    located.push({ item, title, link, geo });
  }
  return located;
}

async function buildDispatch(candidate, articleTimeoutMs) {
  const { item, title, link, geo } = candidate;

  let body;
  try {
    body = await fetchArticleBody(link, item._bodySelector, articleTimeoutMs);
  } catch (e) {
    return null;
  }
  if (!body) return null; // paywalled, blocked, or too little real content

  const { redacted: aliasMasked, aliasPlace } = redactAliases(`${title}. ${body}`, geo.place);
  const excerpt = truncateWords(redactPlace(aliasMasked, geo.matchedText, geo.place), 250);
  if (!excerpt.includes('█')) return null; // redaction failed to apply

  const published = publishedAtMs(item);
  return {
    excerpt,
    place: geo.place,
    aliasPlace,
    lat: geo.lat,
    lng: geo.lng,
    source: item._source,
    link,
    // Recorded so a story drawn from the reserve days later can still have
    // its age checked before it's served — see dispatchGen.js.
    publishedAt: published === null ? null : new Date(published).toISOString(),
  };
}

// Collects up to `count` ready-to-play dispatches, each from a different
// place. Returning several rather than the first hit is what lets a day
// bank a reserve — see dispatchGen.js — so a later day that finds nothing
// has real unseen stories to fall back on instead of repeating itself.
async function findDispatches({
  count = 5,
  articleTimeoutMs = 6000,
  maxArticleAttempts = MAX_ARTICLE_ATTEMPTS,
  excludeLinks = new Set(),
  maxStoryAgeDays = MAX_STORY_AGE_DAYS,
} = {}) {
  const items = await fetchNewsItems();

  // Age is filtered across every item before the sample is drawn, not after,
  // so the headline scan below spends its budget entirely on recent news.
  const now = Date.now();
  const recent = items.filter(item => isFresh(item, now, maxStoryAgeDays));
  const located = geocodeHeadlines(shuffle(recent).slice(0, MAX_TITLE_SCAN), excludeLinks);
  console.log(`[newswire] ${items.length} items, ${recent.length} within ${maxStoryAgeDays}d, ${located.length} geocodable non-Delhi`);

  const queue = shuffle(located).slice(0, maxArticleAttempts);
  const found = [];
  const claimedPlaces = new Set();
  const deadline = Date.now() + ARTICLE_PHASE_BUDGET_MS;

  await mapWithConcurrency(queue, ARTICLE_CONCURRENCY, async candidate => {
    if (found.length >= count || Date.now() > deadline) return;
    // A pool of five stories about one city is a far weaker reserve than
    // five different places, so only one story per place is kept.
    if (claimedPlaces.has(candidate.geo.place)) return;
    claimedPlaces.add(candidate.geo.place);

    const dispatch = await buildDispatch(candidate, articleTimeoutMs);
    if (!dispatch) {
      claimedPlaces.delete(candidate.geo.place);
      return;
    }
    if (found.length < count) found.push(dispatch);
  });

  return found.slice(0, count);
}

module.exports = { findDispatches };
