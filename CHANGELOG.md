# Changelog

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
