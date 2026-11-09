# Changelog

## Unreleased

- Call Drex directly through the Nace API, alongside OpenRouter: set `NACE_API_KEY` (and optionally `DECISIONS_PROVIDER=nace`, `DECISIONS_NACE_URL`). The default Nace model is `drex-max-v1.1`; other `drex-*` ids and OpenRouter's `nace-ai/drex-*` ids work too. Without `DECISIONS_PROVIDER`, Nace is used only when `NACE_API_KEY` is the only key set, so existing setups keep OpenRouter.
- Each provider's key is sent only to that provider's URLs.
- Nace errors show the HTTP status, Drex's error type, issue paths with short messages, and `request_id`. Messages about the state are shown only in Drex's fixed media and length wording, a message without issues only when it is one of Drex's own sentences, and quoted values are dropped, so request content is never echoed. Rate-limit and overload responses are retried after `retry-after-ms`. Key, credit and validation errors (401, 402, 422) are not retried and, on Nace, don't fall back to `DECISIONS_FALLBACK_MODELS`; OpenRouter's fallback rules are unchanged.
- Requests over Drex's limits (512 questions; 255 options per question on Drex Max) fail with a clear error before anything is sent.
- `DECISIONS_STRIP_INLINE_MEDIA` replaces inline base64 media (`data:` URLs and base64 images, audio, video and PDFs, also when wrapped over lines) with a short marker in file text and question text, keeping line numbers. On by default for Nace, which rejects `data:` URLs and values that are entirely base64 media; off by default for OpenRouter, `nace-ai/` models included.
- A cancelled tool call stops at once, also while waiting to retry, and sends no further retries. Waits from a server's `retry-after-ms` are capped at 60 s.
- On Nace, which reports billed input tokens but no cost, the cost stays unreported instead of $0. OpenRouter still counts a missing cost as $0.
- `list_models` works with Nace and marks aliases and retired ids.
- Benchmark: runs on Nace (`DECISIONS_PROVIDER=nace`), records input tokens, reported cost and p50 / p95 latency, and adds `--price-per-m` (calculated estimate), `--tag` and `--bugs`.

## 0.4.0 — 2026-10-14

- Renamed from `jev-offload-mcp` to `decisions-mcp`: the server works with any OpenRouter decision model, not only Jev.
- Settings are now `DECISIONS_*`; the old `JEV_*` names still work.

## 0.3.0 — 2026-10-14

- Works with any OpenRouter decision model, not just Jev: Cloudflare Clef, Mercury Decide, Liquid D1, Microsoft Decision, Perplexity Decider, Drex, Solar Decide, GPT-6 Luna Decisions, ScaleDown, Respan and others.
- Chunk and clip sizes follow each model's context window (read from OpenRouter's catalog).
- Per-model request quirks are learned from the first 400 and remembered: string `state`, plain-string yes/no criteria, clear error for yes/no-only models.
- `JEV_FALLBACK_MODELS`: backups tried in order when the primary model fails.
- New `list_models` tool.
- `score` answers report the most probable level.
- Quality benchmark (`npm run bench`) on the MCP TypeScript SDK: bug localization, per-file facts and classification with checkable ground truth.

## 0.2.0 — 2026-10-14

- Jev-only: every tool runs on the Jev decision model via OpenRouter's Decisions API. The calling agent is already an LLM, so no chat model is bundled.
- `locate_in_files`: two-pass search — Jev scores every chunk of every file, then re-scores ~40-line windows inside the best chunks. Returns ranked `file:lines`, a per-file ranking and the code of the top hits.
- `classify_files` and `decide_files` (typed `yes_no` / `choice` / `score` questions per file).
- Workspace root detection via MCP roots; secrets, `.gitignore`d, binary and vendored files are never sent.
- Replaced `fast-glob` with `tinyglobby` (no `braces` / `micromatch` advisories).

## 0.1.0

- First prototype with chat-model based `analyze_files` / `map_files`.
