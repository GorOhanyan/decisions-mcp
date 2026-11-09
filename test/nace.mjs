// End-to-end: real MCP client <-> decisions-mcp over stdio, against a mock Nace API (Drex's request,
// answer and error shapes) and a mock OpenRouter host, to check routing, keys, answers and errors.
// The last sections call decide() in-process for cancellation, timeouts and the raw usage objects.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "../src/index.js");
const VERSION = JSON.parse(fs.readFileSync(path.join(here, "../package.json"), "utf8")).version;

const NACE_KEY = `nace_sk_${"test".repeat(10)}abc`; // fake, shaped like a real key
const REVOKED_KEY = `nace_sk_${"gone".repeat(10)}abc`;
const OR_KEY = "sk-or-v1-TESTKEY-openrouter";

// Drex rejects media data: URLs anywhere in `state` or `questions` with a 422.
const DATA_URL = /data:((?:image|audio|video)\/[\w.+-]+|application\/pdf)(?:;[\w.+=-]+)*;base64,/i;
const MODELS = [
  { name: "drex-v2.0", description: "Drex 2.0 decision model.", release_date: "2026-10-06", alias_for: null },
  { name: "drex-latest", description: "Points to drex-v2.0 (Drex 2.0).", release_date: "2026-10-06", alias_for: "drex-v2.0" },
  { name: "drex-max-v1.1", description: "Drex Max v1.1 multimodal decision model.", release_date: "2026-11-01", alias_for: null },
  { name: "drex-v1.5", description: "Retired on 2026-11-08. Drex 1.5 decision model.", release_date: "2026-09-01", alias_for: "drex-max-v1.1" },
];

const nace = []; // {method, url, headers, raw, body, at}
const openrouter = [];
const seen = new Map(); // model -> attempts, for retry scenarios
let rid = 0;

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "x-request-id": body.request_id || "", ...headers });
  res.end(JSON.stringify(body));
}
const naceError = (res, status, type, message, extra = {}, headers = {}) =>
  sendJson(res, status, { error: { type, message, ...extra }, request_id: `req_err${++rid}` }, headers);

const naceMock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const auth = req.headers.authorization || "";
    nace.push({ method: req.method, url: req.url, headers: req.headers, raw, body, at: Date.now() });
    // Echoes the key it got, so the client's redaction is what keeps it out of tool output.
    if (auth !== `Bearer ${NACE_KEY}`)
      return naceError(res, 401, "authentication_error", `Invalid API key ${auth}. Pass a nace_sk_ key as \`Authorization: Bearer <key>\`.`);
    if (req.method === "GET" && req.url === "/v1/models") return sendJson(res, 200, { models: MODELS, request_id: `req_${++rid}` });
    if (req.method !== "POST" || req.url !== "/v1/systemone") return naceError(res, 404, "invalid_request_error", "not found");
    const n = (seen.get(body.model) || 0) + 1;
    seen.set(body.model, n);
    const content = body.state?.content || "";
    if (body.model === "drex-test-402")
      return naceError(res, 402, "insufficient_credit", "This account has insufficient available funds. Add funds to keep going.");
    if (body.model === "drex-test-429" && n === 1)
      return naceError(res, 429, "rate_limit_error", "Too many requests in flight.", {}, { "retry-after-ms": "1500" });
    if (body.model === "drex-test-429-always")
      return naceError(res, 429, "rate_limit_error", "Too many requests in flight.", {}, { "retry-after-ms": "1500" });
    if (body.model === "drex-test-529" && n === 1)
      return naceError(res, 529, "overloaded", "The model service is busy. Retry shortly.", {}, { "retry-after-ms": "200" });
    if (body.model === "drex-test-slow" || (body.model === "drex-test-slow-once" && n === 1))
      return setTimeout(() => sendJson(res, 200, { model: body.model, answers: {}, usage: {} }), 1500);
    if (body.model === "drex-test-echo")
      // A 422 that reflects request content, quoted, in the message and in an issue.
      return naceError(res, 422, "invalid_request_error", `state.content: bad value "${content}"`, {
        issues: [
          { path: "state.content", message: `bad value "${content}"` },
          { path: "state.content", message: `bad value ${content}` },
          { path: "state", message: `bad value '${content}` },
        ],
      });
    if (body.model === "drex-test-html") {
      // Not JSON; the key sits near the cut-off point of the shown text.
      res.writeHead(418, { "Content-Type": "text/html" });
      return res.end(`<html><body>${"x".repeat(165)} ${auth} trailing</body></html>`);
    }
    if (!/^(?:drex|nacedm)-[A-Za-z0-9.-]+$/.test(body.model) || body.model === "drex-v9.9") {
      const message = `unknown model "${body.model}"; use "drex-v2.0" or "drex-latest"`;
      return naceError(res, 422, "invalid_request_error", `model: ${message}`, {
        issues: [{ path: "model", message }, { path: "questions", message: "second issue for the test" }],
      });
    }
    if (DATA_URL.test(JSON.stringify(body.state)) || DATA_URL.test(JSON.stringify(body.questions)))
      return naceError(res, 422, "invalid_request_error", `state.content is media (image/png data URL); ${body.model} reads text only`, {
        issues: [{ path: "state.content", message: `is media (image/png data URL); ${body.model} reads text only` }],
      });
    const answers = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === "choice") {
        const choice = body.state.path.endsWith(".md") ? "docs" : "code";
        const probabilities = Object.fromEntries(Object.keys(q.criteria).map((o) => [o, o === choice ? 0.97 : 0.01]));
        answers[k] = { type: "choice", choice, confidence: 0.97, probabilities };
      }
      if (q.type === "noul") {
        const p1 = content.includes("SECRET_MARKER") ? 0.97 : content.includes("export") ? 0.91 : 0.04;
        answers[k] = { type: "noul", noul: p1, confidence: Math.max(p1, 1 - p1) };
      }
      if (q.type === "score")
        answers[k] = { type: "score", score: 1.2, legend: q.criteria, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.6 };
    }
    const served = body.model === "drex-latest" || body.model === "nacedm-latest" ? "drex-v2.0" : body.model;
    sendJson(res, 200, { model: served, answers, usage: { input_tokens: 50, output_tokens: 5 }, evaluation_time_ms: 12.5, request_id: `req_${++rid}` });
  });
});

const orMock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    openrouter.push({ method: req.method, url: req.url, headers: req.headers, raw, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") return res.end(JSON.stringify({ data: [{ id: "typesafe/jev-1.13", context_length: 64000, pricing: { prompt: "0.000000042" } }] }));
    const body = JSON.parse(raw);
    const answers = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === "choice") answers[k] = { type: "choice", choice: "code", confidence: 0.97 };
      if (q.type === "noul") answers[k] = { type: "noul", noul: 0.91 };
    }
    const usage = { input_tokens: 50, output_tokens: 5, ...(body.model === "nocost/model" ? {} : { cost: 0.00001 }) };
    const n = (seen.get(`or:${body.model}`) || 0) + 1;
    seen.set(`or:${body.model}`, n);
    setTimeout(() => res.end(JSON.stringify({ model: body.model, answers, usage })), body.model === "slow-once/model" && n === 1 ? 1500 : 0);
  });
});

await new Promise((r) => naceMock.listen(0, "127.0.0.1", r));
await new Promise((r) => orMock.listen(0, "127.0.0.1", r));
const naceUrl = `http://127.0.0.1:${naceMock.address().port}`;
const orBase = `http://127.0.0.1:${orMock.address().port}`;

// Real base64 of a PNG header followed by filler bytes.
const pngBytes = Buffer.alloc(601, 7);
Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1").copy(pngBytes);
const png = pngBytes.toString("base64");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-nace-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir, "src/a.js"), "export const a = 1;\n");
fs.writeFileSync(path.join(dir, "src/b.js"), "export const b = 2;\n");
fs.writeFileSync(path.join(dir, "README.md"), "# Project\nHello\n");
fs.writeFileSync(path.join(dir, ".env"), "API_KEY=should-never-be-sent\n");
const svg = `<svg xmlns="http://www.w3.org/2000/svg">\n  <title>logo export</title>\n  <image href="data:image/png;base64,${png}"/>\n</svg>\n`;
fs.writeFileSync(path.join(dir, "logo.svg"), svg);

// Only the variables each scenario sets; nothing from the outer environment can pick the provider.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(DECISIONS_|JEV_|NACE_|OPENROUTER_)/.test(k)),
);
const naceEnv = { ...baseEnv, NACE_API_KEY: NACE_KEY, DECISIONS_NACE_URL: naceUrl, DECISIONS_BASE_DIR: dir };
const orUrls = { DECISIONS_DECISIONS_URL: `${orBase}/api/alpha/decisions`, DECISIONS_MODELS_URL: `${orBase}/api/v1/models` };
const both = { ...baseEnv, NACE_API_KEY: NACE_KEY, OPENROUTER_API_KEY: OR_KEY, DECISIONS_NACE_URL: naceUrl, DECISIONS_BASE_DIR: dir, ...orUrls };

let stderr = "";
async function start(env) {
  const client = new Client({ name: "nace-test", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "pipe" });
  transport.stderr?.on("data", (d) => (stderr += d));
  await client.connect(transport);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content[0].text, isError: r.isError };
  };
  return { call, close: () => client.close() };
}
const reset = () => {
  nace.length = 0;
  openrouter.length = 0;
};
const posts = () => nace.filter((r) => r.method === "POST");
const yesNo = [{ id: "x", type: "yes_no", question: "Exports?" }];

// ---- 1. Auto-selected Nace (only NACE_API_KEY set): request shape, headers, default model
let s = await start(naceEnv);
let r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code: source code", "docs"] });
assert.match(r.text, /## code \(1\)/, r.text);
assert.equal(posts().length, 1);
let q = posts()[0];
assert.equal(q.url, "/v1/systemone");
assert.equal(q.headers.authorization, `Bearer ${NACE_KEY}`);
assert.equal(q.headers["x-nace-client"], `decisions-mcp/${VERSION}`);
assert.equal(q.headers["content-type"], "application/json");
assert.equal(q.headers["http-referer"], undefined, "OpenRouter headers must not be sent to Nace");
assert.equal(q.headers["x-title"], undefined, "OpenRouter headers must not be sent to Nace");
assert.deepEqual(Object.keys(q.body).sort(), ["model", "questions", "state"]);
assert.equal(q.body.model, "drex-max-v1.1", "default Nace model");
assert.deepEqual(q.body.state, { path: "src/a.js", content: "export const a = 1;\n" });
assert.equal(openrouter.length, 0);

// ---- 2. Typed answers in Drex's shapes (array legend, string-keyed probabilities, no cost)
reset();
r = await s.call("decide_files", {
  paths: ["."],
  include: ["src/**", "*.md"],
  questions: [
    { id: "exports", type: "yes_no", question: "Does it export anything?" },
    { id: "kind", type: "choice", question: "Kind?", options: ["code", "docs"] },
    { id: "size", type: "score", question: "Size?", options: ["low", "mid", "high"] },
  ],
});
assert.match(r.text, /src\/a\.js\tyes\(0\.91\)\tcode\(0\.97\)\t1\.2\/mid/, r.text);
assert.match(r.text, /README\.md\tno\(0\.04\)\tdocs\(0\.97\)\t1\.2\/mid/, r.text);
assert.match(r.text, /tokens in: 150/, r.text);
assert.match(r.text, /model: drex-max-v1\.1/, r.text);
assert.ok(!/cost:/.test(r.text), `no cost should be shown when Nace reports none: ${r.text}`);
assert.ok(!JSON.stringify(posts()).includes("should-never-be-sent"), ".env leaked");

// ---- 3. Question ids with dashes and spaces come back under the original ids
reset();
r = await s.call("decide_files", {
  paths: ["src/a.js"],
  questions: [
    { id: "has-exports", type: "yes_no", question: "Exports?" },
    { id: "file kind", type: "choice", question: "Kind?", options: ["code", "docs"] },
  ],
  format: "json",
});
assert.deepEqual(Object.keys(posts()[0].body.questions), ["has_exports", "file_kind"]);
assert.deepEqual(JSON.parse(r.text.split("\n\n---")[0]), [
  { file: "src/a.js", answers: { "has-exports": { value: "yes", p: 0.91 }, "file kind": { value: "code", confidence: 0.97 } } },
]);
r = await s.call("decide_files", { paths: ["src/a.js"], questions: [{ id: "has-exports", type: "yes_no", question: "Exports?" }], only_matching: "has-exports" });
assert.match(r.text, /file\thas-exports\nsrc\/a\.js\tyes\(0\.91\)/, r.text);

// locate works end to end (two passes) on Nace
r = await s.call("locate_in_files", { paths: ["src"], query: "exports", snippets: 0 });
assert.match(r.text, /1\. 0\.91  src\/[ab]\.js:1-\d/, r.text);

// ---- 4. OpenRouter's nace-ai/ ids map to Drex ids; non-Drex models fail before any request
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "nace-ai/drex-v2.0" });
assert.match(r.text, /model: drex-v2\.0/, r.text);
assert.equal(posts()[0].body.model, "drex-v2.0");
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "typesafe/jev-1.13" });
assert.equal(r.isError, true);
assert.match(r.text, /not served by the Nace API/, r.text);
assert.equal(nace.length, 0, "no request for a non-Drex model");

// ---- 5. list_models from GET /v1/models
reset();
r = await s.call("list_models", {});
assert.match(r.text, /^model\tcontext\t\$\/1M input\n/, r.text);
assert.match(r.text, /drex-max-v1\.1\t262144\t\?\t\(default\)/, r.text);
assert.match(r.text, /drex-latest\t131072\t\?\t\(alias for drex-v2\.0\)/, r.text);
assert.match(r.text, /drex-v1\.5\t262144\t\?\t\(retired, served by drex-max-v1\.1\)/, r.text);
assert.equal(nace[0].method, "GET");
assert.equal(nace[0].headers.authorization, `Bearer ${NACE_KEY}`);
assert.equal(nace[0].headers["x-nace-client"], `decisions-mcp/${VERSION}`);

// ---- 6. Errors: 402 / 422 are not retried; 429 honours retry-after-ms (the only header sent); 529 is retried
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "drex-test-402" });
assert.equal(r.isError, true);
assert.match(r.text, /Nace 402 \(drex-test-402\): insufficient_credit: .*Billing page.*\[request_id: req_err\d+\]/, r.text);
assert.equal(posts().length, 1, "402 must not be retried");

reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "drex-v9.9" });
assert.equal(r.isError, true);
assert.match(r.text, /Nace 422 \(drex-v9\.9\): invalid_request_error: model: unknown model "drex-v9\.9"; use "drex-v2\.0" or "drex-latest"; questions: second issue for the test/, r.text);
assert.match(r.text, /request_id: req_err\d+/, r.text);
assert.equal(posts().length, 1, "422 must not be retried");

reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "drex-test-429" });
assert.equal(r.isError, undefined, r.text);
assert.match(r.text, /## code \(1\)/, r.text);
assert.equal(posts().length, 2, "429 is retried once, then succeeds");
assert.ok(posts()[1].at - posts()[0].at >= 1400, `retry-after-ms 1500 should be honoured (waited ${posts()[1].at - posts()[0].at} ms)`);

reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "drex-test-529" });
assert.match(r.text, /## code \(1\)/, r.text);
assert.equal(posts().length, 2, "529 is retried, then succeeds");

// ---- 7. Error text never echoes request values: issues about the file text say only "rejected", quoted values are dropped, non-JSON bodies are redacted, then cut
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "drex-test-echo" });
assert.equal(r.isError, true);
assert.match(r.text, /Nace 422 \(drex-test-echo\): invalid_request_error: state\.content: rejected; state\.content: rejected; state: rejected/, r.text);
assert.ok(!r.text.includes("export const a"), `file text leaked into the error: ${r.text}`);
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"], model: "drex-test-html" });
assert.equal(r.isError, true);
assert.match(r.text, /Nace 418 \(drex-test-html\): response is not JSON: <html><body>x+ Bearer \[redacted\]/, r.text);
assert.ok(!r.text.includes(NACE_KEY.slice(0, 12)), `a key prefix leaked: ${r.text}`);

// ---- 8. Inline media is stripped from files and from question text (default for Nace); line count is unchanged
reset();
r = await s.call("decide_files", { paths: ["logo.svg"], questions: yesNo });
assert.match(r.text, /logo\.svg\tyes\(0\.91\)/, r.text);
let content = posts()[0].body.state.content;
assert.ok(content.includes("data:image/png;[base64 image omitted]"), content);
assert.ok(!content.includes(png), "media payload was sent");
assert.equal(content.split("\n").length, svg.split("\n").length);
reset();
r = await s.call("locate_in_files", { paths: ["src/a.js"], query: `where is data:image/png;base64,${png} built, or the bare data:image/png;base64, prefix`, snippets: 0 });
assert.equal(r.isError, undefined, r.text);
const instructions = posts()[0].body.questions.hit.instructions;
assert.ok(instructions.includes("data:image/png;[base64 image omitted] built") && instructions.includes("bare data: image/png;base64, prefix"), instructions);

// ---- 9. Drex's request limits are checked before sending
reset();
const many = Array.from({ length: 513 }, (_, i) => `label${i}`);
r = await s.call("classify_files", { paths: ["src/a.js"], labels: many, multi_label: true, model: "drex-v2.0" });
assert.equal(r.isError, true);
assert.match(r.text, /at most 512 questions per request; this request has 513/, r.text);
r = await s.call("classify_files", { paths: ["src/a.js"], labels: many.slice(0, 300) });
assert.equal(r.isError, true);
assert.match(r.text, /drex-max-v1\.1 takes at most 255 options or levels per question; question "label" has 301/, r.text);
assert.equal(nace.length, 0, "nothing is sent over the limits");
r = await s.call("classify_files", { paths: ["src/a.js"], labels: many.slice(0, 300), model: "drex-v2.0" });
assert.match(r.text, /## code \(1\)/, r.text);
await s.close();

// ---- 10. The opt-out sends media as is (Drex answers 422)
s = await start({ ...naceEnv, DECISIONS_STRIP_INLINE_MEDIA: "false" });
reset();
r = await s.call("decide_files", { paths: ["logo.svg"], questions: yesNo });
assert.equal(r.isError, true);
assert.match(r.text, /Nace 422 .*data URL/, r.text);
assert.ok(posts()[0].body.state.content.includes(png));
await s.close();

// ---- 11. 401: hint + request_id, the echoed key never shows up, no retry and no fallback
s = await start({ ...naceEnv, NACE_API_KEY: REVOKED_KEY, DECISIONS_FALLBACK_MODELS: "drex-v2.0" });
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"] });
assert.equal(r.isError, true);
assert.match(r.text, /Nace 401 \(drex-max-v1\.1\): authentication_error: Invalid API key Bearer \[redacted\]\..*nace_sk_ key from console\.nace\.ai.*\[request_id: req_err\d+\]/, r.text);
assert.ok(!r.text.includes(REVOKED_KEY), "key leaked into tool output");
assert.equal(posts().length, 1, "401 is neither retried nor sent to a fallback model");
r = await s.call("list_models", {});
assert.equal(r.isError, true);
assert.match(r.text, /Nace 401/, r.text);
assert.ok(!r.text.includes(REVOKED_KEY), "key leaked into tool output");
await s.close();

// ---- 12. 402 and 422 on the configured model don't fall back on Nace either
for (const [model, status] of [["drex-test-402", 402], ["drex-v9.9", 422]]) {
  s = await start({ ...naceEnv, DECISIONS_MODEL: model, DECISIONS_FALLBACK_MODELS: "drex-v2.0" });
  reset();
  r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"] });
  assert.equal(r.isError, true);
  assert.match(r.text, new RegExp(`Nace ${status} \\(${model.replace(/\./g, "\\.")}\\)`), r.text);
  assert.deepEqual(posts().map((x) => x.body.model), [model], `${status} must not fall back`);
  await s.close();
}

// ---- 13. DECISIONS_PROVIDER=nace without NACE_API_KEY: clear error, no request
s = await start({ ...baseEnv, DECISIONS_PROVIDER: "nace", OPENROUTER_API_KEY: OR_KEY, DECISIONS_NACE_URL: naceUrl, DECISIONS_BASE_DIR: dir, ...orUrls });
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"] });
assert.equal(r.isError, true);
assert.match(r.text, /NACE_API_KEY is not set/, r.text);
r = await s.call("list_models", {});
assert.equal(r.isError, true);
assert.match(r.text, /NACE_API_KEY is not set/, r.text);
assert.equal(nace.length + openrouter.length, 0, "no request without the provider's key");
await s.close();
assert.match(stderr, /warning: NACE_API_KEY is not set/);

// ---- 14. Both keys set: each host only ever sees its own key and headers
s = await start({ ...both, DECISIONS_PROVIDER: "nace" });
reset();
r = await s.call("classify_files", { paths: ["src"], labels: ["code", "docs"] });
assert.match(r.text, /## code \(2\)/, r.text);
await s.call("list_models", {});
assert.ok(nace.length >= 3);
assert.equal(openrouter.length, 0, "OpenRouter host contacted while provider is nace");
assert.ok(!JSON.stringify(nace.map((x) => [x.headers, x.raw])).includes(OR_KEY), "OpenRouter key sent to Nace");
await s.close();

s = await start(both); // provider unset + both keys = OpenRouter (unchanged default)
reset();
r = await s.call("classify_files", { paths: ["src"], labels: ["code", "docs"] });
assert.match(r.text, /## code \(2\)[\s\S]*cost: \$0\.00002[\s\S]*model: typesafe\/jev-1\.13/, r.text);
assert.equal(nace.length, 0, "Nace host contacted while provider is openrouter");
const orPosts = openrouter.filter((x) => x.method === "POST");
assert.equal(orPosts.length, 2);
for (const x of orPosts) {
  assert.equal(x.headers.authorization, `Bearer ${OR_KEY}`);
  assert.equal(x.headers["http-referer"], "https://github.com/GorOhanyan/decisions-mcp");
  assert.equal(x.headers["x-title"], "decisions-mcp");
  assert.equal(x.headers["x-nace-client"], undefined, "Nace headers must not be sent to OpenRouter");
}
assert.ok(!JSON.stringify(openrouter.map((x) => [x.headers, x.raw])).includes(NACE_KEY), "Nace key sent to OpenRouter");

// ---- 15. OpenRouter sends text byte-for-byte by default, questions included ...
reset();
const query = `where is data:image/png;base64,${png} built`;
r = await s.call("decide_files", { paths: ["logo.svg"], questions: yesNo });
assert.equal(openrouter.find((x) => x.method === "POST").body.state.content, svg);
reset();
r = await s.call("locate_in_files", { paths: ["src/a.js"], query, snippets: 0 });
assert.ok(openrouter.find((x) => x.method === "POST").body.questions.hit.instructions.includes(png));
await s.close();

// ... but strips for nace-ai/ models, which Drex serves behind OpenRouter
s = await start(both);
reset();
r = await s.call("decide_files", { paths: ["logo.svg"], questions: yesNo, model: "nace-ai/drex-v2.0" });
content = openrouter.find((x) => x.method === "POST").body.state.content;
assert.ok(content.includes("[base64 image omitted]") && !content.includes(png), content);
reset();
r = await s.call("locate_in_files", { paths: ["src/a.js"], query, snippets: 0, model: "nace-ai/drex-v2.0" });
assert.ok(!openrouter.find((x) => x.method === "POST").body.questions.hit.instructions.includes(png));
await s.close();

// ... and for any model with DECISIONS_STRIP_INLINE_MEDIA=true
s = await start({ ...both, DECISIONS_STRIP_INLINE_MEDIA: "true" });
reset();
r = await s.call("decide_files", { paths: ["logo.svg"], questions: yesNo });
content = openrouter.find((x) => x.method === "POST").body.state.content;
assert.ok(content.includes("[base64 image omitted]") && !content.includes(png), content);
assert.equal(content.split("\n").length, svg.split("\n").length);
await s.close();

// ---- 16. Explicit DECISIONS_MODEL picks another Drex model
s = await start({ ...naceEnv, DECISIONS_MODEL: "drex-v2.0" });
reset();
r = await s.call("classify_files", { paths: ["src/a.js"], labels: ["code", "docs"] });
assert.equal(posts()[0].body.model, "drex-v2.0");
await s.close();

// ---- 17. Keys never reach the server's logs
for (const k of [NACE_KEY, REVOKED_KEY, OR_KEY]) assert.ok(!stderr.includes(k), "a key was written to stderr");

// ---- 18. In-process: usage objects, cancellation and timeouts
for (const k of Object.keys(process.env)) if (/^(DECISIONS_|JEV_|NACE_|OPENROUTER_)/.test(k)) delete process.env[k];
Object.assign(process.env, { NACE_API_KEY: NACE_KEY, DECISIONS_NACE_URL: naceUrl });
const { decide } = await import("../src/openrouter.js");
const { decideFiles } = await import("../src/decisions.js");
const hit = { hit: { type: "noul", instructions: "x" } };
const state = { path: "a.js", content: "export const a = 1;" };

// Nace reports no cost: it stays null, never 0
let d = await decide({ questions: hit, state, model: "drex-v2.0" });
assert.equal(d.usage.cost, null);
assert.equal(d.usage.prompt, 50);
const df = await decideFiles({ files: [{ rel: "a.js", content: state.content }], questions: yesNo, model: "drex-v2.0" });
assert.equal(df.stats.costReported, false);
assert.equal(df.stats.cost, 0);

// a call cancelled while waiting to retry sends nothing more
reset();
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 300);
const tCancel = Date.now();
await assert.rejects(decide({ questions: hit, state, model: "drex-test-429-always", signal: ctrl.signal }), (e) => e.name === "AbortError");
assert.ok(Date.now() - tCancel < 1000, "a cancelled call returns at once, not after the retry wait");
await new Promise((res) => setTimeout(res, 1800));
assert.equal(posts().length, 1, "no request after cancellation");

// an already-cancelled call sends nothing at all
reset();
const done = new AbortController();
done.abort();
await assert.rejects(decide({ questions: hit, state, model: "drex-v2.0", signal: done.signal }));
assert.equal(nace.length, 0);

// DECISIONS_TIMEOUT_MS is per attempt, as before: a timed-out attempt is retried ...
reset();
process.env.DECISIONS_TIMEOUT_MS = "300";
d = await decide({ questions: hit, state, model: "drex-test-slow-once" });
assert.equal(d.model, "drex-test-slow-once");
assert.equal(posts().length, 2, "the timed-out attempt is sent again");
// ... and after 4 timed-out attempts the error says so
reset();
await assert.rejects(decide({ questions: hit, state, model: "drex-test-slow" }), /Nace request timed out after 0\.3s \(drex-test-slow\)/);
assert.equal(posts().length, 4);

// OpenRouter: a timed-out attempt is retried the same way
Object.assign(process.env, { DECISIONS_PROVIDER: "openrouter", OPENROUTER_API_KEY: OR_KEY, ...orUrls });
reset();
d = await decide({ questions: hit, state, model: "slow-once/model" });
assert.equal(d.model, "slow-once/model");
assert.equal(openrouter.filter((x) => x.method === "POST").length, 2, "the timed-out OpenRouter attempt is sent again");
delete process.env.DECISIONS_TIMEOUT_MS;

// OpenRouter still counts a missing cost as 0, as before
d = await decide({ questions: hit, state, model: "nocost/model" });
assert.equal(d.usage.cost, 0);
d = await decide({ questions: hit, state, model: "typesafe/jev-1.13" });
assert.equal(d.usage.cost, 0.00001);

naceMock.close();
naceMock.closeAllConnections?.();
orMock.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("OK — all Nace checks passed");
