const { kv } = require('../../lib/kv');
const { todayKey } = require('../../lib/dateKey');
const { generateAndStore, dispatchKey } = require('../../lib/dispatchGen');
const { isAuthorizedCron } = require('../../lib/cronAuth');

// Runs at 00:30 UTC (6:00 AM IST) — see vercel.json. Generates today's
// dispatch if it isn't already there. A second cron (retry-daily.js) runs
// an hour later as a cheap safety net in case this run finds nothing.
module.exports = async (req, res) => {
  try {
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

    await generateAndStore(dateKey);
    res.status(200).json({ ok: true, dateKey });
  } catch (e) {
    console.error('[cron/generate-daily] failed:', e.stack || e.message);
    res.status(500).json({ error: e.message });
  }
};
