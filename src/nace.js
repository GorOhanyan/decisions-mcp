import { VERSION } from "./config.js";

// Direct Nace API (Drex decision models): POST /v1/systemone takes the same typed questions and
// returns the same answer shapes as OpenRouter's Decisions API, so only transport and errors differ.

// Model ids the Nace API accepts.
const MODEL_ID = /^(?:drex|nacedm)-[A-Za-z0-9.-]+$/;

// Context sizes published for the Drex models, in tokens; others fall back to the caller's default.
const CONTEXT = {
  "drex-v2.0": 131_072,
  "drex-latest": 131_072,
  "drex-max-v1.1": 262_144,
  "drex-max-finance": 262_144,
};

/** Nace model id for `id`: drex-* / nacedm-* as is, OpenRouter's nace-ai/drex-* without the prefix. */
export function toNaceModel(id) {
  const raw = String(id || "").trim();
  const m = /^nace-ai\//i.test(raw) ? raw.slice("nace-ai/".length).toLowerCase() : raw;
  if (!MODEL_ID.test(m)) {
    throw new Error(
      `Model "${raw}" is not served by the Nace API (DECISIONS_PROVIDER=nace takes drex-* models, e.g. drex-max-v1.1 or drex-v2.0; see list_models)`,
    );
  }
  return m;
}

/** Context window in tokens of a Drex model, or undefined if unknown or not a Drex id. */
export function naceContextOf(id) {
  try {
    return CONTEXT[toNaceModel(id)];
  } catch {
    return undefined;
  }
}

function headers(cfg) {
  return {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    "X-Nace-Client": `decisions-mcp/${VERSION}`,
  };
}

// Error text that reaches tool output is built only from what Nace itself writes: the error type,
// issue paths, short messages and the request id. Quoted values (which can echo request content)
// are dropped unless they are Drex model ids, the key is redacted, and every piece is capped.
const MAX_PIECE = 200;
const redact = (s, key) => (key ? String(s).split(key).join("[redacted]") : String(s));
function clean(s, key) {
  let text = redact(s, key).replace(/\s+/g, " ").trim();
  // Quoted values are kept only when every one is a Drex model id (as in "unknown model" errors);
  // otherwise everything from the first quote to the last goes, so nested quotes can't leak.
  const quoted = text.match(/"[^"]*"/g) || [];
  if (text.includes('"') && !(quoted.length && quoted.every((q) => MODEL_ID.test(q.slice(1, -1))) && text.split('"').length % 2 === 1)) {
    text = `${text.slice(0, text.indexOf('"'))}"…"${text.slice(text.lastIndexOf('"') + 1)}`;
  }
  return text.length > MAX_PIECE ? `${text.slice(0, MAX_PIECE)}…` : text;
}
const token = (v, re) => (typeof v === "string" && re.test(v) ? v : undefined);

// Issues about the request text never repeat Drex's message, which could quote that text; only Drex's
// fixed wording for media and for length is passed through
// (https://console.nace.ai/docs/drex/reference/errors).
const STATE_ISSUE = [
  /^is media \([\w/.+ -]{1,60}\); (?:place supported images in the top-level images array|[\w.-]{1,40} reads text only)$/,
  /^exceeds the [\d,]{1,12}-token (?:state |whole-request )?limit$/,
];
// A top-level message without issues is shown only when it is one of Drex's own fixed sentences
// (authentication, funds, rate limits, capacity, length); anything else gets a generic line.
const KNOWN_MESSAGE = [
  /^Invalid API key\. Pass a nace_sk_ key as `Authorization: Bearer <key>`\.$/,
  /^This account (?:has insufficient available funds|has an unpaid invoice|has reached the credit limit)[\w ,.]{0,160}$/,
  /^(?:Requests per minute exceeded|Too many concurrent requests) for this account\.$/,
  /^(?:The free tier|Drex|Drex Max image inference) is (?:at capacity|temporarily unavailable|temporarily overloaded|not configured)[\w ,.]{0,80}$/,
  /^The model service (?:is busy|failed to process this request)[\w ,.]{0,160}$/,
  /^Something went wrong on our side\.$/,
  /^Request too long: [\w ,.()-]{1,300}$/,
  /^request body must be at most \d{1,12} bytes$/,
  /^Invalid request\.$/,
];
const GENERIC_MESSAGE = "request failed (message not shown; see the request_id)";

const HINTS = {
  401: " (NACE_API_KEY needs a valid nace_sk_ key from console.nace.ai → API Keys)",
  402: " (add funds or pay the open invoice on the console Billing page)",
};

function naceError(cfg, model, status, raw, res) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {}
  const e = body?.error;
  let detail;
  if (e && typeof e === "object") {
    const type = token(e.type, /^[a-z_]{1,40}$/) || "error";
    const issues = Array.isArray(e.issues) ? e.issues.filter((i) => i && typeof i === "object").slice(0, 5) : [];
    if (issues.length) {
      const path = (i) => token(i.path, /^[\w.[\]-]{0,100}$/);
      const known = (i) => STATE_ISSUE.some((re) => re.test(i.message ?? ""));
      const message = (i) => (/^state\b/.test(path(i) ?? "") && !known(i) ? "rejected" : clean(i.message ?? "", cfg.apiKey));
      detail = `${type}: ${issues.map((i) => [path(i), message(i)].filter(Boolean).join(": ")).join("; ")}`;
    } else {
      const m = typeof e.message === "string" ? e.message.trim() : "";
      detail = `${type}: ${KNOWN_MESSAGE.some((re) => re.test(m)) ? clean(m, cfg.apiKey) : GENERIC_MESSAGE}`;
    }
  } else {
    // A body that isn't Drex's JSON (a proxy or gateway page) is not shown, only its content type.
    const ct = token((res.headers.get("content-type") || "").split(";")[0].trim(), /^[\w.+-]{1,40}\/[\w.+-]{1,60}$/);
    detail = `response is not JSON${ct ? ` (${ct})` : ""}`;
  }
  const requestId = token(body?.request_id, /^[\w-]{1,80}$/) || token(res.headers.get("x-request-id"), /^[\w-]{1,80}$/);
  const msg = `Nace ${status} (${model}): ${detail}${HINTS[status] || ""}${requestId ? ` [request_id: ${requestId}]` : ""}`;
  const err = new Error(redact(msg, cfg.apiKey));
  err.status = status;
  err.retry = status === 429 || status >= 500;
  const after = Number(res.headers.get("retry-after-ms"));
  if (after > 0) err.retryAfterMs = after;
  else if (Number(res.headers.get("retry-after")) > 0) err.retryAfterMs = Number(res.headers.get("retry-after")) * 1000;
  return err;
}

// Per-request limits Drex enforces (https://console.nace.ai/docs/drex/reference/limits): 512 questions
// for every model, and 255 options or levels per question for Drex Max models and the retired ids Drex
// Max now serves.
const MAX_QUESTIONS = 512;
const MAX_OPTIONS = 255;
const MAX_OPTION_MODELS = new Set(["drex-max-v1.1", "drex-max-finance", "drex-max", "drex-v1.0", "drex-v1.1", "drex-v1.5"]);

/** Throws a clear local error, before anything is sent, when a request is over Drex's limits. */
export function checkNaceLimits(model, questions) {
  const ids = Object.keys(questions);
  if (ids.length > MAX_QUESTIONS) {
    throw new Error(
      `${model} takes at most ${MAX_QUESTIONS} questions per request; this request has ${ids.length} (multi-label classify asks one question per label: use fewer labels)`,
    );
  }
  if (!MAX_OPTION_MODELS.has(model)) return;
  for (const [id, q] of Object.entries(questions)) {
    const n = Array.isArray(q.criteria) ? q.criteria.length : q.type === "choice" && q.criteria ? Object.keys(q.criteria).length : 0;
    if (n > MAX_OPTIONS) {
      throw new Error(
        `${model} takes at most ${MAX_OPTIONS} options or levels per question; question "${id}" has ${n} (use fewer labels, or drex-v2.0)`,
      );
    }
  }
}

/**
 * One POST /v1/systemone attempt (retries are the caller's job).
 * Returns { answers, model, usage: {prompt, completion, cost: null}, requestId, evaluationMs }.
 * Nace reports token counts but no cost, so cost stays null rather than a made-up $0.
 */
export async function naceDecide(cfg, model, questions, state, signal) {
  const naceModel = toNaceModel(model);
  checkNaceLimits(naceModel, questions);
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ model: naceModel, questions, state }),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) throw naceError(cfg, naceModel, res.status, raw, res);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const err = new Error(`Nace returned a response that is not JSON (${naceModel})`);
    err.retry = true;
    throw err;
  }
  return {
    answers: data.answers || {},
    model: data.model || naceModel,
    usage: {
      prompt: data.usage?.input_tokens ?? 0,
      completion: data.usage?.output_tokens ?? 0,
      cost: typeof data.usage?.cost === "number" ? data.usage.cost : null,
    },
    requestId: data.request_id || res.headers.get("x-request-id") || undefined,
    evaluationMs: typeof data.evaluation_time_ms === "number" ? data.evaluation_time_ms : undefined,
  };
}

/** GET /v1/models: [{id, name, context, pricePerM: null, aliasFor, retired}]. Throws on HTTP errors. */
export async function listNaceModels(cfg) {
  const res = await fetch(cfg.modelsUrl, { headers: headers(cfg), signal: AbortSignal.timeout(10_000) });
  const raw = await res.text();
  if (!res.ok) throw naceError(cfg, "models", res.status, raw, res);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Nace returned a model list that is not JSON (HTTP ${res.status})`);
  }
  return (data.models || []).map((m) => ({
    id: m.name,
    name: m.description,
    context: CONTEXT[m.name] || CONTEXT[m.alias_for] || 0,
    // The models endpoint carries no prices; see the Pricing page on console.nace.ai.
    pricePerM: null,
    aliasFor: m.alias_for || null,
    retired: /^retired/i.test(m.description || ""),
  }));
}
