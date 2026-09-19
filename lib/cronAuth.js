// Vercel signs its own cron requests with `Authorization: Bearer $CRON_SECRET`
// (once CRON_SECRET is set as a project env var) — this stops the public
// from hitting a cron route directly to force a regeneration.
function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

module.exports = { isAuthorizedCron };
