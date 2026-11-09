// Error text from the Nace provider never repeats what the server or the transport sends back: a
// sentinel string is pushed through every error path, and neither it, the request's file text nor the
// key may reach the message. Drex's real state-limit and media 422s stay readable.
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "../src/index.js");

const S = "SENTINEL9f3a";
const KEY = `nace_sk_${"test".repeat(10)}abc`; // fake, shaped like a real key
const FILE_TEXT = "export const secretValue = 42;";
const STATUSES = [400, 401, 402, 403, 404, 408, 409, 413, 415, 422, 429, 500, 502, 503, 504, 529];

// Error bodies that reflect the sentinel, the request and the Authorization header in every field.
const bodies = (content, auth) => [
  { error: { type: `${S.toLowerCase()}_type`, message: `${S} ${content} ${auth}` }, request_id: `req_${S}` },
  { error: { type: "invalid_request_error", message: `Request too long: ${S}` }, request_id: `req_${S.toLowerCase()}` },
  { error: { type: "insufficient_credit", message: `This account has insufficient available funds. ${S}` } },
  { error: { type: "overloaded", message: `Drex is at capacity. ${S}` } },
  { error: { type: "internal_error", message: `The model service failed to process this request. ${S} ${content}` } },
  { error: { type: "rate_limit_error", message: `Request too long: the state exceeds the 1,000-token state limit of drex-${S.toLowerCase()} ${content}. Shorten the state.` } },
  {
    error: {
      type: "invalid_request_error",
      message: S,
      issues: [
        { path: "questions.hit.instructions", message: `bad value ${S} ${content}` },
        { message: `${S} ${content}` },
        { path: 'state["content"]', message: `${S} ${content}` },
        { path: S, message: "is required" },
        { path: `questions.${S}.type`, message: "must be an object" },
      ],
    },
  },
  {
    error: {
      type: "invalid_request_error",
      message: S,
      issues: [
        { path: `state.content.${S}`, message: "must be a string" },
        { path: 42, message: `${S}` },
        null,
        `${S} ${content}`,
        { path: `questions.hit.criteria.${S}`, message: "must be a string" },
      ],
    },
  },
  {
    error: {
      type: "invalid_request_error",
      message: S,
      issues: [
        { path: "", message: `${S} ${auth}` },
        { path: "model", message: `unknown model "drex-${S.toLowerCase()}"; use "drex-v2.0"` },
        { path: "state", message: `is media (${S}); drex-v2.0 reads text only` },
        { path: "state", message: `is media (image/png data URL); ${S} reads text only` },
        { path: "state", message: `exceeds the ${S}-token state limit` },
      ],
    },
  },
  {
    error: {
      type: "invalid_request_error",
      message: S,
      issues: [
        { path: "state.content", message: `is media (image/${S.toLowerCase()} data URL); drex-v2.0 reads text only` },
        { path: "state", message: `exceeds the 131,072-token state limit ${S}` },
        { path: "questions", message: `at most ${S} questions allowed` },
        { path: { toString: () => S }, message: { toString: () => S } },
        { path: "questions.hit.type", message: `must be "noul", "choice", or "score" ${S}` },
      ],
    },
  },
];
const N_BODIES = bodies("", "").length;

const seen = [];
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const auth = req.headers.authorization || "";
    const content = raw ? JSON.parse(raw).state?.content || "" : "";
    seen.push({ method: req.method, url: req.url });
    // /v1/systemone: the scenario is in the model id; /v1/models: in the query.
    const m = /(?:drex-sentinel-|[?&]s=)(\d{3}|html)-(\d+)/.exec(raw ? JSON.parse(raw).model : req.url);
    if (!m) {
      res.writeHead(200, { "Content-Type": "application/json", "x-request-id": `req_${"0".repeat(32)}` });
      const ok = raw
        ? { model: "drex-v2.0", answers: { hit: { type: "noul", noul: 0.9, confidence: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } }
        : { models: [{ name: "drex-v2.0", description: "Drex 2.0" }] };
      return res.end(JSON.stringify(ok));
    }
    const [, status, k] = m;
    if (status === "html") {
      res.writeHead(Number(k), { "Content-Type": `text/${S.toLowerCase()}`, "x-request-id": S });
      return res.end(`<html>${S} ${content} ${auth}</html>`);
    }
    res.writeHead(Number(status), { "Content-Type": "application/json", "x-request-id": `${S} ${auth}` });
    res.end(JSON.stringify(bodies(content, auth)[Number(k)]));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${mock.address().port}`;

for (const k of Object.keys(process.env)) if (/^(DECISIONS_|JEV_|NACE_|OPENROUTER_)/.test(k)) delete process.env[k];
const { naceDecide, listNaceModels } = await import("../src/nace.js");
const { decide } = await import("../src/openrouter.js");

const cfg = (over = {}) => ({ provider: "nace", label: "Nace", keyName: "NACE_API_KEY", apiKey: KEY, url: `${base}/v1/systemone`, modelsUrl: `${base}/v1/models`, timeoutMs: 5000, ...over });
const questions = { hit: { type: "noul", instructions: "Is this exported?" } };
const state = { path: "a.js", content: FILE_TEXT };

// Every leak is collected, so a run against older code lists all of them at once.
const leaks = [];
let checked = 0;
function check(label, text, key = KEY) {
  checked++;
  const found = [
    text.toLowerCase().includes(S.toLowerCase()) && "sentinel",
    text.includes(FILE_TEXT) && "file text",
    key && text.includes(key) && "key",
    key && text.includes(key.slice(0, 16)) && "key prefix",
  ].filter(Boolean);
  if (found.length) leaks.push(`${label}: ${found.join(", ")} in ${JSON.stringify(text.slice(0, 300))}`);
}
const messageOf = async (p) => {
  try {
    await p;
    return "(no error)";
  } catch (e) {
    return String(e?.message);
  }
};

// ---- 1. Every status code with every reflecting body, on both endpoints, plus non-JSON bodies
for (const status of STATUSES) {
  for (let k = 0; k < N_BODIES; k++) {
    check(`POST ${status} body ${k}`, await messageOf(naceDecide(cfg(), `drex-sentinel-${status}-${k}`, questions, state)));
    check(`GET ${status} body ${k}`, await messageOf(listNaceModels(cfg({ modelsUrl: `${base}/v1/models?s=${status}-${k}` }))));
  }
  check(`POST ${status} non-JSON`, await messageOf(naceDecide(cfg(), `drex-sentinel-html-${status}`, questions, state)));
  check(`GET ${status} non-JSON`, await messageOf(listNaceModels(cfg({ modelsUrl: `${base}/v1/models?s=html-${status}` }))));
}
// a 200 that isn't JSON
check("POST 200 non-JSON", await messageOf(naceDecide(cfg(), "drex-sentinel-html-200", questions, state)));
check("GET 200 non-JSON", await messageOf(listNaceModels(cfg({ modelsUrl: `${base}/v1/models?s=html-200` }))));

// ---- 2. Transport failures: a key fetch refuses as a header value, an unreachable host, a bad URL
for (const bad of [`nace_sk_${S}\nX`, `nace_sk_${S} X`, `nace_sk_${S}\r`, `nace_sk_${S}é`]) {
  const n = seen.length;
  check(`key ${JSON.stringify(bad.slice(-2))} POST`, await messageOf(naceDecide(cfg({ apiKey: bad }), "drex-v2.0", questions, state)), bad);
  check(`key ${JSON.stringify(bad.slice(-2))} GET`, await messageOf(listNaceModels(cfg({ apiKey: bad }))), bad);
  if (seen.length !== n) leaks.push(`key ${JSON.stringify(bad.slice(-2))}: sent before being refused`);
}
check("unreachable host", await messageOf(naceDecide(cfg({ url: `http://127.0.0.1:9/${S}` }), "drex-v2.0", questions, state)));
check("unreachable models host", await messageOf(listNaceModels(cfg({ modelsUrl: `http://127.0.0.1:9/${S}` }))));
check("invalid URL", await messageOf(naceDecide(cfg({ url: `http://[${S}]/${KEY}` }), "drex-v2.0", questions, state)));
check("invalid models URL", await messageOf(listNaceModels(cfg({ modelsUrl: `http://[${S}]/${KEY}` }))));

// ---- 3. Through decide(), with retries: a malformed key on either provider fails at once, sends nothing
const n0 = seen.length;
Object.assign(process.env, { DECISIONS_PROVIDER: "nace", NACE_API_KEY: `nace_sk_${S}\nX`, DECISIONS_NACE_URL: base });
check("decide nace bad key", await messageOf(decide({ questions, state, model: "drex-v2.0" })), process.env.NACE_API_KEY);
Object.assign(process.env, { DECISIONS_PROVIDER: "openrouter", OPENROUTER_API_KEY: `sk-or-v1-${S}\nX`, DECISIONS_DECISIONS_URL: `${base}/or` });
check("decide openrouter bad key", await messageOf(decide({ questions, state, model: "typesafe/jev-1.13" })), process.env.OPENROUTER_API_KEY);
if (seen.length !== n0) leaks.push("decide: requests sent with a malformed key");
for (const k of Object.keys(process.env)) if (/^(DECISIONS_|NACE_|OPENROUTER_)/.test(k)) delete process.env[k];

// ---- 4. Through the MCP server: list_models and a tool call with a key holding a line break
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DECISIONS_|JEV_|NACE_|OPENROUTER_)/.test(k)));
const badKey = `nace_sk_${S}\nX`;
const client = new Client({ name: "errors-test", version: "0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [server], env: { ...env, NACE_API_KEY: badKey, DECISIONS_NACE_URL: base, DECISIONS_BASE_DIR: here }, stderr: "pipe" }),
);
for (const [name, args] of [
  ["list_models", {}],
  ["classify_files", { paths: ["errors.mjs"], labels: ["code", "docs"] }],
]) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError !== true) leaks.push(`MCP ${name}: did not fail with a malformed key`);
  check(`MCP ${name} bad key`, r.content.map((c) => c.text).join("\n"), badKey);
}
await client.close();

// ---- 5. Drex's real wording stays readable
const real = (body, status = 422) => {
  const srv = http.createServer((req, res) => {
    res.writeHead(status, { "Content-Type": "application/json", "x-request-id": `req_${"a".repeat(32)}` });
    res.end(JSON.stringify(body));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
};
const realCase = async (body, expected, status = 422) => {
  const srv = await real(body, status);
  const msg = await messageOf(naceDecide(cfg({ url: `http://127.0.0.1:${srv.address().port}/v1/systemone` }), "drex-v2.0", questions, state));
  srv.close();
  assert.match(msg, expected, msg);
};
const tooLong = "Request too long: the state exceeds the 131,072-token state limit of drex-v2.0. Shorten the state.";
await realCase(
  { error: { type: "invalid_request_error", message: tooLong, issues: [{ path: "state", message: "exceeds the 131,072-token state limit" }] }, request_id: `req_${"b".repeat(32)}` },
  new RegExp(`^Nace 422 \\(drex-v2\\.0\\): invalid_request_error: state: exceeds the 131,072-token state limit \\[request_id: req_${"b".repeat(32)}\\]$`),
);
await realCase({ error: { type: "invalid_request_error", message: tooLong } }, /^Nace 422 \(drex-v2\.0\): invalid_request_error: Request too long: the state exceeds the 131,072-token state limit of drex-v2\.0\. Shorten the state\. \[request_id: req_a{32}\]$/);
await realCase(
  { error: { type: "invalid_request_error", message: "x", issues: [{ path: "state.content", message: "is media (image/png data URL); drex-v2.0 reads text only" }, { path: "questions.hit.instructions", message: 'is media (base64 PNG image); drex-v2.0 reads text only' }] } },
  /invalid_request_error: state\.content: is media \(image\/png data URL\); drex-v2\.0 reads text only; questions\.hit\.instructions: is media \(base64 PNG image\); drex-v2\.0 reads text only/,
);
await realCase(
  { error: { type: "invalid_request_error", message: "x", issues: [{ path: "model", message: 'unknown model "drex-v2.0"; use "drex-max-v1.1" or "drex-latest"' }, { path: "", message: "exceeds the 262,144-token whole-request limit" }] } },
  /invalid_request_error: model: unknown model "drex-v2\.0"; use "drex-max-v1\.1" or "drex-latest"; exceeds the 262,144-token whole-request limit/,
);
await realCase({ error: { type: "insufficient_credit", message: "This account has insufficient available funds. Add funds to keep going." } }, /insufficient_credit: This account has insufficient available funds\. Add funds to keep going\./, 402);

mock.close();
assert.ok(checked > 300, `only ${checked} cases ran`);
assert.deepEqual(leaks, [], `${leaks.length} of ${checked} error paths leaked:\n${leaks.join("\n")}`);
console.log(`OK — ${checked} error paths checked, none echoes the sentinel, file text or key`);
