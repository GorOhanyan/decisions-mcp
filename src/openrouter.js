import { config, stripInlineMediaEnabled } from "./config.js";
import { stripInlineMedia } from "./media.js";
import { listNaceModels, naceContextOf, naceDecide } from "./nace.js";

export { config };

// Used when the provider doesn't report a context length for the model.
const DEFAULT_CONTEXT = 32_768;
// Longest wait honoured from a retry-after-ms header.
const MAX_RETRY_WAIT_MS = 60_000;

// ---- Model catalog

const catalogs = new Map();
/**
 * All decision models the provider lists: [{id, name, context, pricePerM}] (pricePerM is null when
 * the provider doesn't publish prices). Cached per provider; [] if OpenRouter's catalog is unreachable.
 */
export function listDecisionModels() {
  const cfg = config();
  const cacheKey = `${cfg.provider} ${cfg.modelsUrl}`;
  if (catalogs.has(cacheKey)) return catalogs.get(cacheKey);
  const forget = () => {
    catalogs.delete(cacheKey); // retry on the next call
    return [];
  };
  if (cfg.provider === "nace") {
    // Errors are passed on (with Drex's message and request_id) so list_models can show them.
    if (!cfg.apiKey) return Promise.reject(new Error(`${cfg.keyName} is not set in the MCP server env`));
    const p = listNaceModels(cfg).catch((e) => {
      catalogs.delete(cacheKey);
      throw e;
    });
    catalogs.set(cacheKey, p);
    return p;
  }
  const catalog = fetch(cfg.modelsUrl, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : { data: [] }))
    .then((d) =>
      (d.data || []).map((m) => ({
        id: m.id,
        name: m.name,
        context: m.context_length || 0,
        pricePerM: Number(m.pricing?.prompt || 0) * 1e6,
      })),
    )
    .catch(forget);
  catalogs.set(cacheKey, catalog);
  return catalog;
}

/** Context window of a model in tokens (falls back to a safe default). */
export async function contextOf(model) {
  // Drex context sizes are published, not listed by the API, so no catalog request is needed.
  if (config().provider === "nace") return naceContextOf(model) || DEFAULT_CONTEXT;
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
 * One decision request to the configured provider, with fallback to DECISIONS_FALLBACK_MODELS when the primary model fails.
 * `questions`: { key: { type: "choice"|"noul"|"score", instructions, criteria } }, `state`: { key: string }.
 * Returns { answers, model, usage: {prompt, completion, cost} }; cost is null when Nace doesn't report it.
 */
export async function decide({ questions, state, model, signal }) {
  const cfg = config();
  if (!cfg.apiKey) throw new Error(`${cfg.keyName} is not set in the MCP server env`);
  const send = cfg.provider === "nace" ? naceDecide : openRouterDecide;
  // Auth and credit problems are the same for every model; on Nace so is a rejected request body.
  const final = cfg.provider === "nace" ? [401, 402, 422] : [401, 402];
  const candidates = model ? [model] : [cfg.model, ...cfg.fallbacks.filter((m) => m !== cfg.model)];
  let lastErr;
  for (const m of candidates) {
    // Media in question text is rejected like media in files, so it gets the same scrub.
    const qs = stripInlineMediaEnabled([m]) ? scrubStrings(questions) : questions;
    try {
      return await withRetries(cfg, m, signal, (attemptSignal) => send(cfg, m, qs, state, attemptSignal));
    } catch (e) {
      lastErr = e;
      if (signal?.aborted || final.includes(e.status)) throw e;
    }
  }
  throw lastErr;
}

function scrubStrings(v) {
  if (typeof v === "string") return stripInlineMedia(v);
  if (Array.isArray(v)) return v.map(scrubStrings);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubStrings(x)]));
  return v;
}

function cancelled(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error("The request was cancelled");
  err.name = "AbortError";
  return err;
}

/** setTimeout as a promise that rejects as soon as `signal` aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Up to 4 attempts, each with its own DECISIONS_TIMEOUT_MS. Timed-out attempts and 429/5xx/network errors
 * are retried with exponential backoff, or the server's retry-after-ms when longer (capped at 60 s).
 * A cancelled call stops at once, also during a wait, and sends nothing more.
 */
async function withRetries(cfg, model, signal, attemptFn) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw cancelled(signal);
    const ctrl = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      ctrl.abort();
    }, cfg.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let err;
    try {
      return await attemptFn(ctrl.signal);
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw cancelled(signal);
    if (expired) {
      err = new Error(`${cfg.label} request timed out after ${cfg.timeoutMs / 1000}s (${model}); raise DECISIONS_TIMEOUT_MS if needed`);
      err.retry = true;
    }
    if (!(err.retry || err.name === "AbortError" || err.name === "TypeError") || attempt === 3) throw err;
    await sleep(Math.max(Math.min(err.retryAfterMs || 0, MAX_RETRY_WAIT_MS), 1000 * 2 ** attempt), signal);
  }
}

/** One OpenRouter Decisions API attempt; adapts and resends on known 400s (an adaptation is not a failed attempt). */
async function openRouterDecide(cfg, model, questions, state, signal) {
  for (;;) {
    const sent = quirks.get(model) || {};
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/GorOhanyan/decisions-mcp",
        "X-Title": "decisions-mcp",
      },
      body: JSON.stringify(adaptBody(model, questions, state)),
      signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      if (res.status === 400 && learnQuirk(model, raw, questions, sent)) continue;
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
  }
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
