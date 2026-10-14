#!/usr/bin/env node
// Quality benchmark for decision models on a real codebase with checkable ground truth.
//
// Corpus: the compiled MCP TypeScript SDK in node_modules (version pinned by package-lock.json).
// Tasks:
//   locate   — 6 planted one-line bugs, only the symptom is given; is the right file / line window on top?
//   facts    — 6 yes/no questions per file whose answer is checkable with a regex (calls fetch, defines a class…)
//   classify — client / server / shared / examples, with file paths anonymized so the model must read the code
//
// Usage: OPENROUTER_API_KEY=... node bench/run.mjs [--models a,b] [--tasks locate,facts,classify] [--parallel 4]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "../src/files.js";
import { classify, decideFiles, locate } from "../src/decisions.js";
import { charBudget, pool } from "../src/openrouter.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const sdkDir = path.join(root, "../node_modules/@modelcontextprotocol/sdk");
const corpusDir = path.join(sdkDir, "dist/esm");
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkDir, "package.json"), "utf8")).version;

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

// Distinct models only (":free" and "~…-latest" aliases left out).
const DEFAULT_MODELS = [
  "typesafe/jev-1.13",
  "cloudflare/clef",
  "cloudflare/clef-flash",
  "cloudflare/clef-omni",
  "inception/mercury-decide",
  "liquid/d1",
  "microsoft/microsoft-decision-1",
  "perplexity/pplx-decider-v1.1-27b",
  "nace-ai/drex-v2.0",
  "nace-ai/drex-v1.5",
  "upstage/solar-decide-flash",
  "upstage/solar-decide",
  "openai/gpt-6-luna-decisions",
  "togethercomputer/tev1-4b-experimental",
  "jaredpalmer/kev-4b",
  "scaledown/classify-1",
  "respan/span-01-lite",
];
const models = arg("models", DEFAULT_MODELS.join(",")).split(",").map((s) => s.trim());
const tasks = new Set(arg("tasks", "locate,facts,classify").split(","));
const parallel = Number(arg("parallel", 4));

// ---- Task data

const BUGS = [
  {
    file: "server/auth/middleware/bearerAuth.js",
    find: "authInfo.expiresAt < Date.now() / 1000",
    replace: "authInfo.expiresAt > Date.now() / 1000",
    symptom: "Свежие валидные access token получают 401 'Token has expired', а давно просроченные токены проходят авторизацию.",
  },
  {
    file: "shared/stdio.js",
    find: "this._buffer = this._buffer.subarray(index + 1);",
    replace: "this._buffer = this._buffer.subarray(index);",
    symptom: "Over stdio only the first JSON-RPC message gets through; every following message fails to parse and the client hangs right after the initialize response.",
  },
  {
    file: "shared/protocol.js",
    find: "DEFAULT_REQUEST_TIMEOUT_MSEC = 60000",
    replace: "DEFAULT_REQUEST_TIMEOUT_MSEC = 600",
    symptom: "Все запросы падают с 'Request timed out' (McpError -32001) меньше чем через секунду, хотя сервер отвечает примерно за 1 секунду.",
  },
  {
    file: "server/mcp.js",
    find: "if (this._registeredTools[name]) {",
    replace: "if (!this._registeredTools[name]) {",
    symptom: "Calling server.registerTool('search', ...) on a brand-new McpServer immediately throws 'Tool search is already registered'.",
  },
  {
    file: "client/sse.js",
    find: "if (this._endpoint.origin !== this._url.origin) {",
    replace: "if (this._endpoint.origin === this._url.origin) {",
    symptom: "SSE-клиент падает с ошибкой 'Endpoint origin does not match connection origin' при подключении к серверу на том же домене, а к серверу на чужом домене подключается без ошибок.",
  },
  {
    file: "shared/auth-utils.js",
    find: "if (requested.origin !== configured.origin) {",
    replace: "if (requested.origin === configured.origin) {",
    symptom: "OAuth: a token whose resource is exactly the configured server URL is rejected as not allowed for this resource, while resources on completely different hosts are accepted.",
  },
];

const FACTS = [
  {
    id: "calls_fetch",
    question: "Does this code make HTTP requests with fetch — directly or through an injected/wrapped fetch function?",
    // Counts `fetch(…)`, `(this._fetch ?? fetch)(…)` and calls of injected fetch functions.
    re: /(?<![\w.])fetch\s*\(|\?\?\s*fetch\s*\)\s*\(|\b(?:_fetch|fetchFn|fetchWithInit)\s*\(|this\._fetch\b/,
  },
  { id: "defines_class", question: "Does this file define a class?", re: /\bclass\s+[A-Za-z_$][\w$]*/ },
  { id: "throws", question: "Does this code contain a throw statement?", re: /\bthrow\b/ },
  { id: "uses_timers", question: "Does this code use setTimeout or setInterval?", re: /\bset(?:Timeout|Interval)\s*\(/ },
  { id: "uses_zod", question: "Does this file itself call zod schema builders such as z.object(...) or z.string(...)?", re: /\bz\.(?:object|string|number|boolean|union|array|enum|literal|optional)\s*\(/ },
  { id: "async_code", question: "Does this code use async functions or await?", re: /\basync\b|\bawait\b/ },
];

const CLASS_LABELS = [
  "client: MCP client library code — connects to MCP servers, client transports, client-side OAuth",
  "server: MCP server library code — server runtime, server transports, server-side auth handlers and middleware",
  "shared: protocol plumbing shared by client and server — JSON-RPC protocol, base transport, utilities",
  "examples: example or demo application showing how to use the SDK",
];

// Same head+tail clipping the server applies, so ground truth matches what the model actually sees.
function clip(content, maxChars) {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.8);
  const tail = maxChars - head;
  return `${content.slice(0, head)}\n…[${content.length - maxChars} chars omitted]…\n${content.slice(-tail)}`;
}

// ---- Runners

async function runLocate(model, files) {
  const out = { file1: 0, file3: 0, line1: 0, line3: 0, cost: 0, ms: 0, errors: 0, cases: [] };
  for (const bug of BUGS) {
    const mutated = files.map((f) => {
      if (f.rel !== bug.file) return f;
      if (!f.content.includes(bug.find)) throw new Error(`bug site not found in ${bug.file}`);
      return { ...f, content: f.content.replace(bug.find, bug.replace) };
    });
    const target = mutated.find((f) => f.rel === bug.file);
    const bugLine = target.content.slice(0, target.content.indexOf(bug.replace)).split("\n").length;
    const t = Date.now();
    try {
      const r = await locate({ files: mutated, query: bug.symptom, model });
      out.ms += Date.now() - t;
      out.cost += r.stats.cost;
      out.errors += r.failed;
      const fileRank = r.files.findIndex((f) => f.rel === bug.file) + 1;
      const hit = (l) => l.rel === bug.file && l.start <= bugLine && l.end >= bugLine;
      const lineRank = r.locations.findIndex(hit) + 1;
      if (fileRank === 1) out.file1++;
      if (fileRank >= 1 && fileRank <= 3) out.file3++;
      if (lineRank === 1) out.line1++;
      if (lineRank >= 1 && lineRank <= 3) out.line3++;
      out.cases.push({ file: bug.file, bugLine, fileRank: fileRank || null, lineRank: lineRank || null, top: r.locations.slice(0, 3).map((l) => `${l.rel}:${l.start}-${l.end} ${l.p.toFixed(2)}`) });
    } catch (e) {
      out.ms += Date.now() - t;
      out.errors++;
      out.cases.push({ file: bug.file, error: e.message.slice(0, 200) });
    }
  }
  return out;
}

async function runFacts(model, files) {
  const limit = Math.min(12000, await charBudget(model));
  const clipped = files.map((f) => ({ ...f, content: clip(f.content, limit) }));
  const t = Date.now();
  const r = await decideFiles({
    files: clipped,
    questions: FACTS.map(({ id, question }) => ({ id, type: "yes_no", question })),
    maxCharsPerFile: limit,
    model,
  });
  const per = Object.fromEntries(FACTS.map((q) => [q.id, { tp: 0, fp: 0, fn: 0, tn: 0 }]));
  let errors = 0;
  r.rows.forEach((row, i) => {
    if (row.error) return errors++;
    for (const q of FACTS) {
      const truth = q.re.test(clipped[i].content);
      const said = row.answers[q.id]?.value === "yes";
      const c = per[q.id];
      if (truth && said) c.tp++;
      else if (!truth && said) c.fp++;
      else if (truth && !said) c.fn++;
      else c.tn++;
    }
  });
  const f1 = (c) => (c.tp ? (2 * c.tp) / (2 * c.tp + c.fp + c.fn) : c.fp + c.fn ? 0 : 1);
  const tot = Object.values(per).reduce((a, c) => ({ ok: a.ok + c.tp + c.tn, n: a.n + c.tp + c.tn + c.fp + c.fn }), { ok: 0, n: 0 });
  return {
    accuracy: tot.n ? tot.ok / tot.n : 0,
    macroF1: FACTS.reduce((s, q) => s + f1(per[q.id]), 0) / FACTS.length,
    perQuestion: Object.fromEntries(FACTS.map((q) => [q.id, +f1(per[q.id]).toFixed(3)])),
    cost: r.stats.cost,
    ms: Date.now() - t,
    errors,
  };
}

async function runClassify(model, files) {
  const labelled = files
    .map((f) => ({ f, label: f.rel.split("/")[0] }))
    .filter((x) => ["client", "server", "shared", "examples"].includes(x.label));
  // Anonymize paths: the label must come from the code, not from the directory name.
  const anon = labelled.map((x, i) => ({ ...x.f, rel: `file_${String(i).padStart(3, "0")}.js` }));
  const t = Date.now();
  const r = await classify({ files: anon, labels: CLASS_LABELS, model });
  let ok = 0;
  let errors = 0;
  r.rows.forEach((row, i) => {
    if (row.labels[0] === "ERROR") errors++;
    else if (row.labels[0] === labelled[i].label) ok++;
  });
  if (errors === r.rows.length) throw new Error(r.rows[0]?.error || "all requests failed");
  return { accuracy: ok / labelled.length, n: labelled.length, cost: r.stats.cost, ms: Date.now() - t, errors };
}

async function benchModel(model, files) {
  const res = { model };
  const guard = async (name, fn) => {
    if (!tasks.has(name)) return;
    try {
      res[name] = await fn();
    } catch (e) {
      res[name] = { error: e.message.slice(0, 200) };
    }
    process.stderr.write(`  ${model} · ${name} done\n`);
  };
  await guard("locate", () => runLocate(model, files));
  await guard("facts", () => runFacts(model, files));
  await guard("classify", () => runClassify(model, files));
  return res;
}

// ---- Report

const pct = (x) => (x === undefined ? "—" : `${Math.round(x * 100)}%`);
const usd = (x) => (x === undefined ? "—" : `$${x.toFixed(4)}`);

function report(results) {
  const n = BUGS.length;
  const lines = [
    `| Model | Bug: file #1 | Bug: file top-3 | Bug: line window #1 | Bug: line top-3 | Facts acc | Facts F1 | Classify acc | Cost | Time |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
  ];
  const score = (r) => (r.locate?.line1 ?? 0) * 10 + (r.locate?.file1 ?? 0) * 5 + (r.facts?.macroF1 ?? 0) * 10 + (r.classify?.accuracy ?? 0) * 10;
  for (const r of [...results].sort((a, b) => score(b) - score(a))) {
    const L = r.locate || {};
    const loc = (k) => (L.error ? "err" : L[k] === undefined ? "—" : `${L[k]}/${n}`);
    const F = r.facts || {};
    const C = r.classify || {};
    const cost = (L.cost || 0) + (F.cost || 0) + (C.cost || 0);
    const ms = (L.ms || 0) + (F.ms || 0) + (C.ms || 0);
    lines.push(
      `| \`${r.model}\` | ${loc("file1")} | ${loc("file3")} | ${loc("line1")} | ${loc("line3")} | ${F.error ? "err" : pct(F.accuracy)} | ${F.error ? "err" : F.macroF1 === undefined ? "—" : F.macroF1.toFixed(2)} | ${C.error ? "n/a" : pct(C.accuracy)} | ${usd(cost)} | ${Math.round(ms / 1000)}s |`,
    );
  }
  return lines.join("\n");
}

// ---- Main

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Set OPENROUTER_API_KEY");
  process.exit(1);
}
const { files } = await collectFiles({ paths: [corpusDir], include: ["**/*.js"], baseDir: corpusDir });
const tokens = Math.round(files.reduce((s, f) => s + f.content.length, 0) / 3.5);
process.stderr.write(`Corpus: @modelcontextprotocol/sdk@${sdkVersion} dist/esm — ${files.length} files, ~${Math.round(tokens / 1000)}k tokens\n`);
process.stderr.write(`Models: ${models.length} · tasks: ${[...tasks].join(", ")}\n`);

const results = await pool(models, parallel, (m) => benchModel(m, files));

const outDir = path.join(root, "results");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const meta = { date: stamp, corpus: `@modelcontextprotocol/sdk@${sdkVersion} dist/esm`, files: files.length, approxTokens: tokens, bugs: BUGS.length, facts: FACTS.map((f) => f.id) };
fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify({ meta, results }, null, 2));
const md = report(results);
fs.writeFileSync(path.join(outDir, `${stamp}.md`), `# Benchmark ${stamp}\n\nCorpus: ${meta.corpus}, ${meta.files} files, ~${Math.round(tokens / 1000)}k tokens.\n\n${md}\n`);
console.log(md);
