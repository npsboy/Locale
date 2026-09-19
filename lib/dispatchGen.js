// Single entry point for producing "today's dispatch" and writing it to
// Vercel KV, shared by the two cron routes (api/cron/generate-daily.js,
// api/cron/retry-daily.js) and the on-demand fallback in api/dispatch.js —
// so there's exactly one place that decides what happens when a fresh
// story can't be found.
const { kv } = require('./kv');
const gazetteer = require('./gazetteer');
const { findDispatch } = require('./newswire');
const { yesterdayKey } = require('./dateKey');

const DISPATCH_TTL_SECONDS = 14 * 24 * 60 * 60; // keep recent days around for the yesterday-fallback below

function dispatchKey(dateKey) {
  return `dispatch:${dateKey}`;
}

// Generates today's dispatch. If no geocodable story can be found today
// (dead feeds, nothing matched the gazetteer), falls back to reusing
// yesterday's stored dispatch — still gives players a puzzle, just a
// repeat, rather than an empty day. Only throws if both today's generation
// AND yesterday's stored dispatch come up empty (e.g. very first day
// running, or two bad days in a row); callers surface that as a
// "no puzzle today" state.
async function generateAndStore(dateKey) {
  await gazetteer.init();

  const fresh = await findDispatch();
  if (fresh) {
    await kv.set(dispatchKey(dateKey), JSON.stringify(fresh), { ex: DISPATCH_TTL_SECONDS });
    return fresh;
  }

  console.error(`[dispatchGen] no geocodable story found for ${dateKey}, trying yesterday's dispatch`);
  const priorRaw = await kv.get(dispatchKey(yesterdayKey(dateKey)));
  if (priorRaw) {
    const prior = typeof priorRaw === 'string' ? JSON.parse(priorRaw) : priorRaw;
    const reused = { ...prior, reused: true };
    await kv.set(dispatchKey(dateKey), JSON.stringify(reused), { ex: DISPATCH_TTL_SECONDS });
    return reused;
  }

  throw new Error(`No dispatch available for ${dateKey} and no prior day to fall back to`);
}

module.exports = { generateAndStore, dispatchKey, DISPATCH_TTL_SECONDS };
