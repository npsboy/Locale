const { kv } = require('../../lib/kv');
const { todayKey } = require('../../lib/dateKey');
const { generateAndStore, dispatchKey } = require('../../lib/dispatchGen');
const { isAuthorizedCron } = require('../../lib/cronAuth');

// Runs at 01:30 UTC (7:00 AM IST), one hour after generate-daily.js — only
// does anything if that first run found nothing (e.g. all 3 feeds were
// briefly down). Same logic, just a second automatic shot before the day
// falls back entirely on api/dispatch.js's on-demand generation.
module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const dateKey = todayKey();
  const existing = await kv.get(dispatchKey(dateKey));
  if (existing) {
    res.status(200).json({ skipped: true, dateKey });
    return;
  }

  try {
    await generateAndStore(dateKey);
    res.status(200).json({ ok: true, dateKey });
  } catch (e) {
    console.error('[cron/retry-daily] failed:', e.message);
    res.status(500).json({ error: e.message, dateKey });
  }
};
