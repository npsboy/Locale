// The daily puzzle rolls over at 6:00 AM IST (not midnight) so the
// generation cron has the overnight/early news cycle available to pick
// from. IST is UTC+5:30 with no DST, so "6:00 AM IST" is always exactly
// 00:30 UTC — subtracting that fixed offset before taking the UTC date
// is enough; no timezone library needed.
const ROLLOVER_OFFSET_MS = 30 * 60 * 1000;

function keyFor(date) {
  return new Date(date.getTime() - ROLLOVER_OFFSET_MS).toISOString().slice(0, 10);
}

function todayKey() {
  return keyFor(new Date());
}

function yesterdayKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

module.exports = { todayKey, yesterdayKey };
