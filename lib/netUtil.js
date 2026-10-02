// Shared network helpers used anywhere this project fetches many URLs within
// a single serverless invocation's time budget (feeds, articles, and the
// per-candidate content-filter calls in contentFilter.js).

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Runs `fn` over `items` with at most `limit` in flight, so dozens of feeds,
// article pages, or filter calls can run within one serverless invocation
// without opening dozens of sockets at once.
async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await fn(items[cursor++]);
    }
  });
  await Promise.all(workers);
}

module.exports = { fetchWithTimeout, mapWithConcurrency };
