const { kv } = require('../../lib/kv');
const { todayKey } = require('../../lib/dateKey');
const { generateAndStore, dispatchKey } = require('../../lib/dispatchGen');
const { isAuthorizedCron } = require('../../lib/cronAuth');

// Runs at 01:30 UTC (7:00 AM IST), one hour after generate-daily.js — a
// second automatic shot before the day falls back entirely on
// api/dispatch.js's on-demand generation. It retries when that first run
// stored nothing at all, and also when it could only serve a story drawn
// from the reserve: a reserve story means the scrape failed, so it's worth
// one more try at genuinely fresh news while the morning is still young.
// A successful fresh generation overwrites it; a failed one leaves the
// reserve story in place, because generateAndStore only writes on success.
module.exports = async (req, res) => {
  try {
    if (!isAuthorizedCron(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const dateKey = todayKey();
    const existingRaw = await kv.get(dispatchKey(dateKey));
    const existing = typeof existingRaw === 'string' ? JSON.parse(existingRaw) : existingRaw;
    if (existing && !existing.reused) {
      res.status(200).json({ skipped: true, dateKey });
      return;
    }

    try {
      await generateAndStore(dateKey);
    } catch (e) {
      if (!existing) throw e;
      console.error('[cron/retry-daily] retry failed, keeping reserve story:', e.message);
      res.status(200).json({ keptReserve: true, dateKey });
      return;
    }
    res.status(200).json({ ok: true, dateKey });
  } catch (e) {
    console.error('[cron/retry-daily] failed:', e.stack || e.message);
    res.status(500).json({ error: e.message });
  }
};
