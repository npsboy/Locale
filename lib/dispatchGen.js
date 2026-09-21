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
const POOL_SIZE = 3; // extra stories kept alongside each day's chosen dispatch, for fallback to draw on
const FALLBACK_LOOKBACK_DAYS = 14; // how far back to search for a story that hasn't actually been shown yet

function dispatchKey(dateKey) {
  return `dispatch:${dateKey}`;
}

function poolKey(dateKey) {
  return `dispatch:pool:${dateKey}`;
}

function parse(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// Walks backward day by day (within the same window the TTL keeps data for)
// looking for a pooled story that was never actually shown as a chosen
// dispatch. Tracks every "shown" link it passes along the way so a story
// that was itself a reused fallback on some prior day doesn't get reused
// again.
async function findUnusedPriorDispatch(dateKey) {
  const usedLinks = new Set();
  let cursor = dateKey;

  for (let i = 0; i < FALLBACK_LOOKBACK_DAYS; i++) {
    cursor = yesterdayKey(cursor);

    const shownRaw = await kv.get(dispatchKey(cursor));
    if (shownRaw) {
      const shown = parse(shownRaw);
      if (shown.link) usedLinks.add(shown.link);
    }

    const poolRaw = await kv.get(poolKey(cursor));
    if (poolRaw) {
      const pool = parse(poolRaw);
      const unused = pool.find(item => !usedLinks.has(item.link));
      if (unused) return unused;
    }
  }
  return null;
}

// Generates today's dispatch, plus a small pool of other geocodable stories
// found along the way. If no geocodable story can be found today (dead
// feeds, nothing matched the gazetteer), falls back to a story pulled from
// a prior day's pool — specifically one that was never actually shown as
// that day's (or any other day's) chosen dispatch, so a fallback day never
// repeats a story players have already seen. Only throws if today's
// generation AND every pooled story within FALLBACK_LOOKBACK_DAYS come up
// empty (e.g. very first day running, or a long stretch of bad days).
async function generateAndStore(dateKey) {
  await gazetteer.init();

  const pool = await findDispatches({ count: POOL_SIZE });
  if (pool.length > 0) {
    await kv.set(poolKey(dateKey), JSON.stringify(pool), { ex: DISPATCH_TTL_SECONDS });
    const chosen = pool[0];
    await kv.set(dispatchKey(dateKey), JSON.stringify(chosen), { ex: DISPATCH_TTL_SECONDS });
    return chosen;
  }

  console.error(`[dispatchGen] no geocodable story found for ${dateKey}, searching prior days for an unused one`);
  const fallback = await findUnusedPriorDispatch(dateKey);
  if (fallback) {
    const reused = { ...fallback, reused: true };
    await kv.set(dispatchKey(dateKey), JSON.stringify(reused), { ex: DISPATCH_TTL_SECONDS });
    return reused;
  }

  throw new Error(`No dispatch available for ${dateKey} and no unused prior-day story to fall back to`);
}

module.exports = { generateAndStore, dispatchKey, DISPATCH_TTL_SECONDS };
