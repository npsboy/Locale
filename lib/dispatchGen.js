// Single entry point for producing "today's dispatch" and writing it to
// Vercel KV, shared by the two cron routes (api/cron/generate-daily.js,
// api/cron/retry-daily.js) and the on-demand fallback in api/dispatch.js —
// so there's exactly one place that decides what happens when a fresh
// story can't be found.
const { kv } = require('./kv');
const gazetteer = require('./gazetteer');
const { findDispatches } = require('./newswire');
const { yesterdayKey } = require('./dateKey');

const DISPATCH_TTL_SECONDS = 14 * 24 * 60 * 60; // keep recent days around for the fallback below
const POOL_SIZE = 5; // stories banked per successful day; one is shown, the rest are reserve
const LOOKBACK_DAYS = 14; // matches the TTL — older days have expired anyway
// A banked story keeps ageing while it waits, so the reserve is capped at
// serve time too. Stories banked before dispatches carried a publish date
// have no verifiable age and are skipped rather than risked.
const MAX_RESERVE_AGE_DAYS = 14;

function dispatchKey(dateKey) {
  return `dispatch:${dateKey}`;
}

function poolKey(dateKey) {
  return `dispatch:pool:${dateKey}`;
}

function parse(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// Reads back the whole retained window in one round trip: which stories have
// actually been shown (so they're never shown again, whether they'd come
// from a fresh scrape or the reserve) and what each day banked.
async function loadRecentHistory(dateKey) {
  const cursors = [];
  let cursor = dateKey;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    cursor = yesterdayKey(cursor);
    cursors.push(cursor);
  }

  const [shownRaws, poolRaws] = await Promise.all([
    Promise.all(cursors.map(c => kv.get(dispatchKey(c)))),
    Promise.all(cursors.map(c => kv.get(poolKey(c)))),
  ]);

  const shownLinks = new Set();
  for (const raw of shownRaws) {
    if (!raw) continue;
    const shown = parse(raw);
    if (shown.link) shownLinks.add(shown.link);
  }

  const pools = poolRaws.map(raw => (raw ? parse(raw) : []));
  return { shownLinks, pools };
}

// Generates today's dispatch plus a small pool of other stories found along
// the way. If today's scrape comes up empty (dead feeds, nothing geocodable),
// falls back to a story banked on a previous day that has never actually
// been shown — so a failed day still serves a real, unseen puzzle instead of
// repeating one. Only throws if today's scrape AND the entire retained
// reserve come up empty; callers surface that as a "no puzzle today" state.
async function generateAndStore(dateKey) {
  await gazetteer.init();

  const { shownLinks, pools } = await loadRecentHistory(dateKey);

  const pool = await findDispatches({ count: POOL_SIZE, excludeLinks: shownLinks });
  if (pool.length > 0) {
    await kv.set(poolKey(dateKey), JSON.stringify(pool), { ex: DISPATCH_TTL_SECONDS });
    const chosen = pool[0];
    await kv.set(dispatchKey(dateKey), JSON.stringify(chosen), { ex: DISPATCH_TTL_SECONDS });
    return chosen;
  }

  console.error(`[dispatchGen] no fresh story for ${dateKey}, drawing from the reserve`);
  const now = Date.now();
  const eligible = [];
  for (const priorPool of pools) {
    for (const item of priorPool) {
      if (shownLinks.has(item.link) || !item.publishedAt) continue;
      const published = Date.parse(item.publishedAt);
      if (Number.isNaN(published)) continue;
      const ageDays = (now - published) / 86400000;
      if (ageDays > MAX_RESERVE_AGE_DAYS) continue;
      eligible.push({ item, ageDays });
    }
  }

  if (eligible.length > 0) {
    eligible.sort((a, b) => a.ageDays - b.ageDays); // newest unseen story wins
    const reused = { ...eligible[0].item, reused: true };
    await kv.set(dispatchKey(dateKey), JSON.stringify(reused), { ex: DISPATCH_TTL_SECONDS });
    return reused;
  }

  throw new Error(`No dispatch available for ${dateKey} and no unseen, recent story left in the reserve`);
}

module.exports = { generateAndStore, dispatchKey, DISPATCH_TTL_SECONDS };
