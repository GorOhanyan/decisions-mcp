import fs from "node:fs";
import { env } from "./env.js";

/** decisions-mcp's own version, sent to Nace as `X-Nace-Client: decisions-mcp/<version>`. */
export const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const PROVIDERS = ["openrouter", "nace"];

// Decision models (Jev, Clef, Mercury Decide, ...) return typed choices with probabilities, not text.
// OpenRouter serves many of them through its Decisions API; Nace serves Drex directly.
const DEFAULTS = {
  openrouter: { model: "typesafe/jev-1.13", keyName: "OPENROUTER_API_KEY", label: "OpenRouter" },
  nace: { model: "drex-max-v1.1", keyName: "NACE_API_KEY", label: "Nace" },
};

/**
 * Which API the server talks to. DECISIONS_PROVIDER wins; otherwise Nace only when NACE_API_KEY is
 * the only key set, so existing OpenRouter setups keep working unchanged.
 */
export function provider() {
  const set = (env("PROVIDER") || "").trim().toLowerCase();
  if (set) {
    if (!PROVIDERS.includes(set)) throw new Error(`DECISIONS_PROVIDER must be one of ${PROVIDERS.join(", ")} (got "${set}")`);
    return set;
  }
  return process.env.NACE_API_KEY && !process.env.OPENROUTER_API_KEY ? "nace" : "openrouter";
}

const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Whether inline base64 media (data: URLs, base64 images and PDFs) is replaced by a short marker before
 * text is sent. DECISIONS_STRIP_INLINE_MEDIA=true|false wins. Otherwise it is on wherever Drex reads
 * the request, since Drex rejects such requests: on Nace, and on OpenRouter when one of `models`
 * (default: DECISIONS_MODEL and its fallbacks) is a nace-ai/ model. Other OpenRouter models: off.
 */
export function stripInlineMediaEnabled(models) {
  const v = (env("STRIP_INLINE_MEDIA") || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  if (v) throw new Error(`DECISIONS_STRIP_INLINE_MEDIA must be true or false (got "${v}")`);
  if (provider() === "nace") return true;
  const ms = models ?? [env("MODEL") || DEFAULTS.openrouter.model, ...list(env("FALLBACK_MODELS"))];
  return ms.some((m) => /^nace-ai\//i.test(String(m)));
}

/** Server settings. Each provider's key is only ever sent to that provider's URLs. */
export function config() {
  const p = provider();
  const d = DEFAULTS[p];
  const common = {
    provider: p,
    label: d.label,
    keyName: d.keyName,
    apiKey: process.env[d.keyName],
    model: env("MODEL") || d.model,
    fallbacks: list(env("FALLBACK_MODELS")),
    concurrency: Number(env("CONCURRENCY")) || 8,
    timeoutMs: Number(env("TIMEOUT_MS")) || 120_000,
  };
  if (p === "nace") {
    const base = (env("NACE_URL") || "https://console.nace.ai").replace(/\/+$/, "");
    return { ...common, url: `${base}/v1/systemone`, modelsUrl: `${base}/v1/models` };
  }
  return {
    ...common,
    url: env("DECISIONS_URL") || "https://openrouter.ai/api/alpha/decisions",
    modelsUrl: env("MODELS_URL") || "https://openrouter.ai/api/v1/models?output_modalities=decisions",
  };
}
