![Locale](public/assets/locale-banner.png)

A GeoGuessr-style daily game: read a real, live Indian local news dispatch with the place name redacted, and guess where it happened.

## How to play

1. Each day there's one dispatch — a real excerpt from a live Indian news story, with the town/city name blacked out.
2. Click/tap the map to drop a pin where you think the story is from, then hit **Guess**.
3. You get **5 guesses**. After each one, a gauge shows how hot or cold you were (closer = hotter), and the distance to the true location is shown.
4. Guessing within **50 km** of the real place wins. Solve it in as few guesses as possible.
5. Share your result (guess count out of 5) via the share card once you've solved it or run out of tries.

## How it works

### Where the story comes from
Every dispatch is a real news item, not authored content. A server job (`lib/newswire.js`) pulls headlines directly from the RSS feeds of major Indian outlets (The Hindu, Hindustan Times, The Indian Express), then fetches the actual article page to extract a 200–250 word excerpt of real body text.

### How the location is found and redacted
Place names in the headline are extracted with basic NLP (`compromise`, to filter out person names) and matched against a gazetteer of Indian towns/cities. Once a place is matched, every occurrence of its name is blacked out (`██████`) from the excerpt before it's shown to players — so the redaction is mechanical, not hand-curated.

### Where place data comes from
`lib/gazetteer.js` builds its India place index from [GeoNames](https://www.geonames.org/)' public `cities15000` dataset (all populated places worldwide with 15,000+ residents) plus their admin-region code list. No coordinates or place names are hardcoded — it's rebuilt from that public dataset and cached.

### Generation schedule
A Vercel cron job (`api/cron/generate-daily.js`) runs once a day to find and store that day's dispatch, with a retry cron shortly after in case the first run fails. If neither generates a fresh story (dead feeds, no geocodable place found), the game falls back to reusing the previous day's dispatch rather than showing nothing (`lib/dispatchGen.js`). An on-demand fallback in `api/dispatch.js` also generates on the first request of the day if the cron hasn't run yet, using a lock so concurrent visitors don't trigger duplicate generation.

### Hosting
Deployed on **Vercel** — static frontend (`public/`) served alongside serverless functions (`api/`) for the daily dispatch and cron jobs.

### Database
**Upstash Redis** (via `@upstash/redis`, provisioned through Vercel's Marketplace) is used as a simple key-value store for:
- the day's generated dispatch (keyed by date, kept for 14 days so a failed day can fall back to the prior one)
- a cached, parsed copy of the GeoNames gazetteer (rebuilding it from the raw dataset takes a few seconds, so it's cached for 30 days)
- a short-lived generation lock to prevent duplicate work under concurrent requests

Redis fit well here because everything stored is small, ephemeral, key-addressable data with natural TTLs — no relational structure or querying is needed.
