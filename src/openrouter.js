// Jev is a decisions model: it returns typed choices with probabilities, not text,
// and is served only by OpenRouter's Decisions API (not chat/completions).
const DEFAULT_MODEL = "typesafe/jev-1.13";

export function config() {
  return {
    apiKey: process.env.OPENROUTER_API_KEY,
    url: process.env.JEV_DECISIONS_URL || "https://openrouter.ai/api/alpha/decisions",
    model: process.env.JEV_MODEL || DEFAULT_MODEL,
    concurrency: Number(process.env.JEV_CONCURRENCY) || 8,
    timeoutMs: Number(process.env.JEV_TIMEOUT_MS) || 120_000,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Decisions API request.
 * `questions`: { key: { type: "choice"|"noul"|"score", instructions, criteria } }, `state`: { key: string }.
 * Returns { answers, model, usage: {prompt, completion, cost} }.
 * Retries on 429/5xx/network errors with exponential backoff.
 */
export async function decide({ questions, state, model, signal }) {
  const cfg = config();
  if (!cfg.apiKey) throw new Error("OPENROUTER_API_KEY is not set in the MCP server env");
  const body = JSON.stringify({ model: model || cfg.model, questions, state });

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/GorOhanyan/jev-offload-mcp",
          "X-Title": "jev-offload-mcp",
        },
        body,
        signal: ctrl.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        let hint = "";
        if (res.status === 401 && /user not found/i.test(raw))
          hint = " (this usually means a management/provisioning key — model calls need a regular API key from openrouter.ai/keys)";
        const err = new Error(`OpenRouter ${res.status}: ${raw.slice(0, 500)}${hint}`);
        err.status = res.status;
        err.retry = res.status === 429 || res.status >= 500;
        throw err;
      }
      const data = JSON.parse(raw);
      if (data.error) {
        const err = new Error(`OpenRouter error: ${JSON.stringify(data.error).slice(0, 500)}`);
        err.retry = true;
        throw err;
      }
      return {
        answers: data.answers || {},
        model: data.model || model || cfg.model,
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
