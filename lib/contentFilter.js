// Rejects candidate headlines that fall into categories the game doesn't
// want to surface (extreme violence, frivolous filler, routine one-off local
// crime, etc. — see REJECT_CATEGORIES). Runs before article bodies are
// fetched in newswire.js, so a rejected candidate never costs article-fetch
// budget.
//
// Classification is done by Jev (~typesafe/jev-latest), a structured
// decision model on OpenRouter's Decisions API — not a chat model. It takes
// a `state` plus typed `questions` and returns typed probability answers,
// no free text, so one call classifies one candidate rather than a batch.
// See https://openrouter.ai/docs/guides/community/jev

const { fetchWithTimeout, mapWithConcurrency } = require('./netUtil');

const REJECT_CATEGORIES = [
  'petty or routine crime with no wider significance (e.g. a single theft, minor assault, bar fight, or local arrest with no larger angle) — major busts, organized crime, and corruption cases are fine and should NOT be rejected',
  'sexual assault or sexual violence',
  'domestic violence, including a spouse or family member killing or assaulting another over a personal dispute (e.g. "man kills wife over row", dowry disputes)',
  'suicide or self-harm',
  'a child as the victim of violence, abuse, or an accident',
  'celebrity or entertainment-industry gossip',
  'PR, listicle, or advertorial-style content (e.g. "top places to visit", festival roundups, routine ribbon-cutting or inauguration announcements)',
  'a bizarre novelty or "weird news" story with no real substance (e.g. a man suing a company because a chatbot told him he was a prophet)',
  'a purely personal or family matter with no public interest (e.g. a private family dispute or domestic incident)',
];

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = '~typesafe/jev-latest';
const REJECT_THRESHOLD = 0.5;

const FILTER_CONCURRENCY = 8;
const FILTER_CALL_TIMEOUT_MS = 4000;
const FILTER_PHASE_BUDGET_MS = 10000; // see ARTICLE_PHASE_BUDGET_MS in newswire.js for the overall time budget this fits inside
const FILTER_POOL_SIZE = 80; // wider than MAX_ARTICLE_ATTEMPTS so rejections still leave enough candidates to fill the article-fetch queue

async function shouldReject(title, source) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return false; // filtering is opt-in once a key is configured

  try {
    const res = await fetchWithTimeout(DECISIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { headline: title, source },
        // The Decisions API takes `questions` as a record keyed by question
        // name (an array is rejected with a 400), and returns `answers`
        // keyed the same way — confirmed against the live API, not just docs.
        questions: {
          reject: {
            type: 'noul',
            instructions: 'Should this news headline be rejected for belonging to one of the excluded categories?',
            criteria: {
              true: `The headline is about: ${REJECT_CATEGORIES.join('; ')}.`,
              false: 'None of the excluded categories apply.',
            },
          },
        },
      }),
    }, FILTER_CALL_TIMEOUT_MS);

    if (!res.ok) {
      console.warn(`[contentFilter] Jev call failed with status ${res.status}`);
      return false;
    }

    const data = await res.json();
    const answer = data && data.answers && data.answers.reject;
    if (!answer || typeof answer.noul !== 'number') {
      console.warn('[contentFilter] Jev response missing a usable noul answer, failing open');
      return false;
    }

    return answer.noul > REJECT_THRESHOLD;
  } catch (e) {
    console.warn(`[contentFilter] Jev call errored, failing open: ${e.message}`);
    return false;
  }
}

// Filters `candidates` (each with a `.title` and optional `.item._source`)
// down to the ones that passed the content filter, respecting `deadlineMs`
// so a slow OpenRouter response degrades to fail-open rather than eating
// into the article-fetch phase's own budget.
async function filterCandidates(candidates, { deadlineMs } = {}) {
  const kept = [];
  await mapWithConcurrency(candidates, FILTER_CONCURRENCY, async candidate => {
    if (deadlineMs && Date.now() > deadlineMs) {
      kept.push(candidate);
      return;
    }
    const source = candidate.item && candidate.item._source;
    const rejected = await shouldReject(candidate.title, source);
    if (!rejected) kept.push(candidate);
  });
  return kept;
}

module.exports = {
  filterCandidates,
  REJECT_CATEGORIES,
  FILTER_PHASE_BUDGET_MS,
  FILTER_POOL_SIZE,
};
