// Thin wrapper so the rest of the app just does `const { kv } = require('./kv')`
// without caring which Redis provider is behind it. `@vercel/kv` is
// deprecated for new projects — Vercel now provisions Redis through its
// Marketplace (typically Upstash), which sets UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN env vars. @upstash/redis's .get/.set/.del API
// shape matches what the rest of this codebase already expects.
const { Redis } = require('@upstash/redis');

const kv = Redis.fromEnv();

module.exports = { kv };
