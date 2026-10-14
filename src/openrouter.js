import { env } from "./env.js";

// Decision models (Jev, Clef, Mercury Decide, ...) return typed choices with probabilities, not text,
// and are served only by OpenRouter's Decisions API (not chat/completions).
const DEFAULT_MODEL = "typesafe/jev-1.13";
// Used when OpenRouter doesn't report a context length for the model.
const DEFAULT_CONTEXT = 32_768;

export function config() {
  const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    apiKey: process.env.OPENROUTER_API_KEY,
    url: env("DECISIONS_URL") || "https://openrouter.ai/api/alpha/decisions",
    modelsUrl: env("MODELS_URL") || "https://openrouter.ai/api/v1/models?output_modalities=decisions",
    model: env("MODEL") || DEFAULT_MODEL,
    fallbacks: list(env("FALLBACK_MODELS")),
    concurrency: Number(env("CONCURRENCY")) || 8,
    timeoutMs: Number(env("TIMEOUT_MS")) || 120_000,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Model catalog

let catalog;
/** All decision models OpenRouter lists: [{id, name, context, pricePerM}]. Cached; [] if the catalog is unreachable. */
export function listDecisionModels() {
  catalog ??= fetch(config().modelsUrl, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : { data: [] }))
    .then((d) =>
      (d.data || []).map((m) => ({
        id: m.id,
        name: m.name,
        context: m.context_length || 0,
        pricePerM: Number(m.pricing?.prompt || 0) * 1e6,
      })),
    )
    .catch(() => {
      catalog = undefined; // retry on the next call
      return [];
    });
  return catalog;
}

/** Context window of a model in tokens (falls back to a safe default). */
export async function contextOf(model) {
  const m = (await listDecisionModels()).find((x) => x.id === model);
  return m?.context || DEFAULT_CONTEXT;
}

/**
 * How many characters of file text fit into one request for every model that may serve it
 * (the primary and its fallbacks): ~60% of the smallest context at a conservative 2.5 chars/token.
 */
export async function charBudget(model) {
  const cfg = config();
  const models = model ? [model] : [cfg.model, ...cfg.fallbacks];
  const ctx = Math.min(...(await Promise.all(models.map(contextOf))));
  return Math.floor(ctx * 0.6 * 2.5);
}

// ---- Per-model request adaptations, learned from the provider's 400 errors and remembered.
// Some decision models accept only a string `state` (ScaleDown, Respan) or only yes/no
// questions with plain-string criteria (Respan).
const quirks = new Map();

function stateToString(state) {
  return Object.entries(state)
    .map(([k, v]) => (k === "content" ? `\n${v}` : `${k}: ${v}`))
    .join("\n");
}

function adaptBody(model, questions, state) {
  const q = quirks.get(model) || {};
  let qs = questions;
  if (q.stringCriteria) {
    qs = Object.fromEntries(
      Object.entries(questions).map(([k, v]) => [
        k,
        v.type === "noul" && typeof v.criteria === "object"
          ? { ...v, criteria: `Yes: ${v.criteria.true}. No: ${v.criteria.false}.` }
          : v,
      ]),
    );
  }
  return { model, questions: qs, state: q.stringState ? stateToString(state) : state };
}

/**
 * Learn a quirk from a 400 response. `sent` = the quirks the failed request was built with
 * (parallel requests may have learned it meanwhile). Returns true if it should be retried adapted.
 */
function learnQuirk(model, raw, questions, sent) {
  const q = quirks.get(model) || {};
  if (!sent.stringState && /state must be a string/i.test(raw)) {
    quirks.set(model, { ...q, stringState: true });
    return true;
  }
  if (/only accepts noul|plain strings/i.test(raw)) {
    if (Object.values(questions).some((v) => v.type !== "noul")) {
      const err = new Error(`${model} supports only yes/no questions; use another model for choice/score questions`);
      err.status = 400;
      throw err;
    }
    if (!sent.stringCriteria) {
      quirks.set(model, { ...q, stringCriteria: true });
      return true;
    }
  }
  return false;
}

/**
 * One Decisions API request, with fallback to DECISIONS_FALLBACK_MODELS when the primary model fails.
 * `questions`: { key: { type: "choice"|"noul"|"score", instructions, criteria } }, `state`: { key: string }.
 * Returns { answers, model, usage: {prompt, completion, cost} }.
 */
export async function decide({ questions, state, model, signal }) {
  const cfg = config();
  if (!cfg.apiKey) throw new Error("OPENROUTER_API_KEY is not set in the MCP server env");
  const candidates = model ? [model] : [cfg.model, ...cfg.fallbacks.filter((m) => m !== cfg.model)];
  let lastErr;
  for (const m of candidates) {
    try {
      return await decideWith(cfg, m, questions, state, signal);
    } catch (e) {
      lastErr = e;
      // Auth/credit problems and cancellations are the same for every model.
      if (signal?.aborted || e.status === 401 || e.status === 402) throw e;
    }
  }
  throw lastErr;
}

/** Retries on 429/5xx/network errors with exponential backoff; adapts the request on known 400s. */
async function decideWith(cfg, model, questions, state, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    const sent = quirks.get(model) || {};
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/GorOhanyan/decisions-mcp",
          "X-Title": "decisions-mcp",
        },
        body: JSON.stringify(adaptBody(model, questions, state)),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        if (res.status === 400 && learnQuirk(model, raw, questions, sent)) {
          attempt--; // an adaptation is not a failed attempt
          continue;
        }
        let hint = "";
        if (res.status === 401 && /user not found/i.test(raw))
          hint = " (this usually means a management/provisioning key — model calls need a regular API key from openrouter.ai/keys)";
        const err = new Error(`OpenRouter ${res.status} (${model}): ${raw.slice(0, 500)}${hint}`);
        err.status = res.status;
        err.retry = res.status === 429 || res.status >= 500;
        throw err;
      }
      const data = JSON.parse(raw);
      if (data.error) {
        const err = new Error(`OpenRouter error (${model}): ${JSON.stringify(data.error).slice(0, 500)}`);
        err.retry = true;
        throw err;
      }
      return {
        answers: data.answers || {},
        model: data.model || model,
        usage: {
          prompt: data.usage?.input_tokens ?? 0,
          completion: data.usage?.output_tokens ?? 0,
          cost: data.usage?.cost ?? 0,
        },
      };
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
      const retriable = e.retry || e.name === "AbortError" || e.name === "TypeError";
      if (!retriable || attempt === 3) throw e;
      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr;
}

/** Run async fn over items with limited concurrency, preserving order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
