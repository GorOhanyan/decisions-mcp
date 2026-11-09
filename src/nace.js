import { VERSION, checkKey } from "./config.js";

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
  checkKey(cfg);
  return {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    "X-Nace-Client": `decisions-mcp/${VERSION}`,
  };
}

// Error text that reaches tool output is built only from fixed wording: Drex's documented error types,
// its documented messages (https://console.nace.ai/docs/drex/reference/errors) with substitutions
// checked against strict patterns, issue paths rebuilt from known segments, and the request id.
// Nothing Drex echoes from the request, and nothing from a transport error, is passed through.
const ERROR_TYPES = new Set([
  "authentication_error",
  "insufficient_credit",
  "payment_required",
  "invalid_request_error",
  "rate_limit_error",
  "internal_error",
  "overloaded",
]);
const REQUEST_ID = /^req_[0-9a-f]{32}$/;
const token = (v, re) => (typeof v === "string" && re.test(v) ? v : undefined);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oneOf = (xs) => `(?:${xs.map(escape).join("|")})`;

// Substitutions: token counts are digits with thousands commas, models are Drex ids, media kinds
// come from a closed list.
const N = String.raw`\d{1,3}(?:,\d{3}){0,3}`;
const MODEL = String.raw`(?:drex|nacedm)-[A-Za-z0-9.-]{1,40}`;
const MIME = oneOf([
  ...["png", "jpeg", "jpg", "gif", "webp", "svg+xml", "bmp", "tiff", "avif", "heic", "heif", "x-icon", "vnd.microsoft.icon"].map((s) => `image/${s}`),
  ...["mpeg", "mp3", "wav", "x-wav", "wave", "ogg", "webm", "aac", "flac", "mp4", "x-m4a"].map((s) => `audio/${s}`),
  ...["mp4", "webm", "ogg", "quicktime", "x-msvideo", "mpeg"].map((s) => `video/${s}`),
  "application/pdf",
]);
const KIND = `(?:${MIME} data URL|base64 ${oneOf(["JPEG image", "PNG image", "GIF image", "RIFF (WebP or WAV) data", "PDF", "MP3 audio", "MP4 video"])}|"${oneOf(["image_url", "input_image", "input_audio", "input_file", "file", "image", "document"])}" content part|Gemini (?:inline_data|file_data) part)`;
const exact = (src) => new RegExp(`^${src}$`);

// Issue messages Drex itself writes, for any path.
const ISSUE_MESSAGES = [
  exact(String.raw`is media \(${KIND}\); (?:place supported images in the top-level images array|${MODEL} reads text only)`),
  exact(String.raw`exceeds the ${N}-token (?:state |whole-request )?limit`),
  exact(String.raw`request body must be at most \d{1,12} bytes`),
  exact(String.raw`at most \d{1,4} questions allowed`),
  exact(String.raw`must be "noul", "choice", or "score"`),
  exact(String.raw`"box" questions are not supported; use "noul", "choice", or "score"`),
  exact(String.raw`must be a string, or JSON nested at most \d{1,2} levels that renders to at most \d{1,9} characters`),
  exact(String.raw`JSON instructions across all questions must render to at most \d{1,9} characters`),
  exact(
    oneOf([
      "body must be JSON",
      "body must be a JSON object",
      "is required",
      "must be an object",
      "must contain at least one question",
      "question ids must be non-empty",
      "noul needs instructions or criteria",
      "must be a string",
      "must be an object with options",
      "choice needs at least 1 option",
      "must be a string or null",
      "must be an array of level labels",
      "score needs at least 1 level",
      "invalid request",
    ]),
  ),
];

// Messages without issues: Drex's fixed sentences.
const TOP_MESSAGES = [
  exact(
    oneOf([
      "Invalid API key. Pass a nace_sk_ key as `Authorization: Bearer <key>`.",
      "This account has insufficient available funds. Add funds to keep going.",
      "This account has an unpaid invoice. Pay it on the Billing page to keep going.",
      "This account has reached the credit limit in its Nace agreement, or the agreement has ended. Contact your Nace account team.",
      "Requests per minute exceeded for this account.",
      "Too many concurrent requests for this account.",
      "The free tier is at capacity. Retry shortly.",
      "Drex is at capacity. Retry shortly.",
      "Drex is temporarily unavailable. Retry shortly.",
      "Drex is temporarily unavailable. Retry after 30 seconds.",
      "Drex is temporarily overloaded. Retry after a few seconds.",
      "Drex Max image inference is not configured on this deployment.",
      "The model service failed to process this request. Retry with backoff, and contact support with the request_id if it keeps failing.",
      "Something went wrong on our side.",
      "Invalid request.",
    ]),
  ),
  exact(String.raw`Request too long: the state exceeds the ${N}-token state limit of ${MODEL}\. Shorten the state\.`),
  exact(String.raw`Request too long: the state plus its longest question exceed the ${N}-token limit of ${MODEL}\. Shorten the state or that question\.`),
  exact(
    String.raw`Request too long: the whole request \(state, images, all questions and model formatting\) exceeds the ${N}-token limit of ${MODEL}\. Shorten the state, use fewer or smaller images, or remove or shorten questions\.`,
  ),
];
const GENERIC_MESSAGE = "request failed (message not shown; see the request_id)";
const GENERIC_ISSUE = "rejected";
// "unknown model" quotes the model id sent; it is shown only when that is the id this request used.
const UNKNOWN_MODEL = exact(String.raw`unknown model "(${MODEL})"; use "${MODEL}"(?:, "${MODEL}"){0,10}(?:,? or "${MODEL}")?`);
const known = (list, m) => typeof m === "string" && m.length <= 400 && list.some((re) => re.test(m));

/**
 * The issue path rebuilt from known segments: model, images.<n>, state, state.path / state.content,
 * questions, questions.<id> for an id this request sent, then type / instructions / criteria and a
 * numeric index or true / false. Anything else is cut back to the last known segment.
 */
function issuePath(p, ids) {
  if (typeof p !== "string") return "request";
  if (p === "") return "request";
  if (p === "model") return "model";
  if (/^images(?:\.\d{1,4})?$/.test(p)) return p;
  if (p === "state.path" || p === "state.content") return p;
  if (/^state\b/.test(p)) return "state";
  if (!/^questions\b/.test(p)) return "request";
  const id = [...ids].sort((a, b) => b.length - a.length).find((q) => p === `questions.${q}` || p.startsWith(`questions.${q}.`));
  if (id === undefined) return "questions";
  let out = `questions.${id}`;
  const rest = p.slice(out.length + 1).split(".");
  if (!["type", "instructions", "criteria"].includes(rest[0])) return out;
  out += `.${rest[0]}`;
  if (rest[0] === "criteria" && rest.length === 2 && /^(?:\d{1,4}|true|false)$/.test(rest[1])) out += `.${rest[1]}`;
  return out;
}

const HINTS = {
  401: " (NACE_API_KEY needs a valid nace_sk_ key from console.nace.ai → API Keys)",
  402: " (add funds or pay the open invoice on the console Billing page)",
};

function naceError(model, status, raw, res, ids = new Set()) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {}
  const e = body?.error;
  let detail;
  if (e && typeof e === "object") {
    const type = ERROR_TYPES.has(e.type) ? e.type : "error";
    const issues = Array.isArray(e.issues) ? e.issues.slice(0, 5) : [];
    if (issues.length) {
      const one = (i) => {
        const path = issuePath(i?.path, ids);
        const sent = typeof i?.message === "string" && UNKNOWN_MODEL.exec(i.message)?.[1] === model;
        const message = sent || known(ISSUE_MESSAGES, i?.message) ? i.message : GENERIC_ISSUE;
        return path === "request" && message !== GENERIC_ISSUE ? message : `${path}: ${message}`;
      };
      detail = `${type}: ${issues.map(one).join("; ")}`;
    } else {
      detail = `${type}: ${known(TOP_MESSAGES, e.message) ? e.message : GENERIC_MESSAGE}`;
    }
  } else {
    // A body that isn't Drex's JSON (a proxy or gateway page) is not shown, only its content type.
    const ct = token((res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), /^(?:text\/(?:html|plain|xml)|application\/(?:json|xml|problem\+json))$/);
    detail = `response is not JSON${ct ? ` (${ct})` : ""}`;
  }
  const requestId = token(body?.request_id, REQUEST_ID) || token(res.headers.get("x-request-id"), REQUEST_ID);
  const err = new Error(`Nace ${status} (${model}): ${detail}${HINTS[status] || ""}${requestId ? ` [request_id: ${requestId}]` : ""}`);
  err.status = status;
  err.retry = status === 429 || status >= 500;
  const after = Number(res.headers.get("retry-after-ms"));
  if (after > 0) err.retryAfterMs = after;
  else if (Number(res.headers.get("retry-after")) > 0) err.retryAfterMs = Number(res.headers.get("retry-after")) * 1000;
  return err;
}

/**
 * fetch + body read with transport failures mapped to fixed messages: their own text can carry the
 * request's header values, the key among them, so it is never shown. An AbortError keeps its name, so
 * timeouts and cancellations are still told apart by the caller.
 */
async function send(url, init, what) {
  try {
    const res = await fetch(url, init);
    return { res, raw: await res.text() };
  } catch (e) {
    const aborted = e?.name === "AbortError" || e?.name === "TimeoutError";
    const err = new Error(aborted ? `Nace request (${what}) was cancelled or timed out` : `Could not reach Nace (${what}): connection failed`);
    if (aborted) err.name = e.name;
    err.retry = !aborted;
    throw err;
  }
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
  const { res, raw } = await send(
    cfg.url,
    { method: "POST", headers: headers(cfg), body: JSON.stringify({ model: naceModel, questions, state }), signal },
    naceModel,
  );
  if (!res.ok) throw naceError(naceModel, res.status, raw, res, new Set(Object.keys(questions)));
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
    requestId: token(data.request_id, REQUEST_ID) || token(res.headers.get("x-request-id"), REQUEST_ID),
    evaluationMs: typeof data.evaluation_time_ms === "number" ? data.evaluation_time_ms : undefined,
  };
}

/** GET /v1/models: [{id, name, context, pricePerM: null, aliasFor, retired}]. Throws on HTTP errors. */
export async function listNaceModels(cfg) {
  const { res, raw } = await send(cfg.modelsUrl, { headers: headers(cfg), signal: AbortSignal.timeout(10_000) }, "models");
  if (!res.ok) throw naceError("models", res.status, raw, res);
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
