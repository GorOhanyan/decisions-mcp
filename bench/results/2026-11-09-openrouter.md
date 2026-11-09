# Benchmark 2026-11-09 (openrouter)

Corpus: @modelcontextprotocol/sdk@1.32.1 dist/esm, 87 files, ~230k tokens.

| Model | Bug: file #1 | Bug: file top-3 | Bug: line window #1 | Bug: line top-3 | Facts acc | Facts F1 | Classify acc | Input tokens | Cost (reported) | Latency p50 / p95 | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `nace-ai/drex-v2.0` | 6/6 | 6/6 | 5/6 | 6/6 | 99% | 0.94 | — | 1407346 | $0.0844 | 1057 / 3249 ms | 182s |
| `typesafe/jev-1.13` | 6/6 | 6/6 | 5/6 | 6/6 | 98% | 0.91 | — | 1724709 | $0.0724 | 660 / 791 ms | 84s |

Provider: OpenRouter. Cost (reported) is what the provider returned per request.
Latency is the per-request round trip (retries included); the row shows the slowest task's p50 / p95.
