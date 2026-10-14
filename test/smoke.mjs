// End-to-end smoke test: real MCP client <-> decisions-mcp over stdio, with a mock OpenRouter Decisions API.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "../src/index.js");
const requests = [];

const CATALOG = [
  { id: "typesafe/jev-1.13", context_length: 64000, pricing: { prompt: "0.000000042" } },
  { id: "tiny/ctx", context_length: 4000, pricing: { prompt: "0.00000002" } },
  { id: "quirky/string-state", context_length: 64000, pricing: { prompt: "0.00000004" } },
  { id: "yesno/only", context_length: 64000, pricing: { prompt: "0.00000002" } },
];

const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const fail400 = (message) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message, code: 400 } }));
    };
    if (req.method === "GET") return res.end(JSON.stringify({ data: CATALOG }));
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.model === "broken/model") return fail400("model unavailable");
    if (body.model === "quirky/string-state" && typeof body.state !== "string") return fail400("Quirky state must be a string");
    if (
      body.model === "yesno/only" &&
      Object.values(body.questions).some((q) => q.type !== "noul" || typeof q.criteria !== "string")
    )
      return fail400("YesNo only accepts noul questions whose instructions and criteria are plain strings");
    const { path: p, content: c } =
      typeof body.state === "string" ? { path: body.state.split("\n")[0].replace("path: ", ""), content: body.state } : body.state;
    const answers = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === "choice") answers[k] = { type: "choice", choice: p.endsWith(".md") ? "docs" : "code", confidence: 0.97 };
      if (q.type === "noul") answers[k] = { type: "noul", noul: c.includes("SECRET_MARKER") ? 0.97 : c.includes("export") ? 0.91 : 0.04 };
      if (q.type === "score") answers[k] = { type: "score", score: 1.2, legend: { 0: "low", 1: "mid", 2: "high" }, confidence: 0.6 };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 50, output_tokens: 5, cost: 0.00001 } }));
  });
});
await new Promise((r) => mock.listen(0, r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir, "src/a.js"), "export const a = 1;\n");
fs.writeFileSync(path.join(dir, "src/b.js"), "export const b = 2;\n");
fs.writeFileSync(path.join(dir, "README.md"), "# Project\nHello\n");
fs.writeFileSync(path.join(dir, ".env"), "API_KEY=should-never-be-sent\n");
fs.writeFileSync(path.join(dir, "ignored.log"), "ignored-content\n");
fs.writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
fs.writeFileSync(path.join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));

const env = {
  ...process.env,
  OPENROUTER_API_KEY: "test",
  DECISIONS_DECISIONS_URL: `http://127.0.0.1:${mock.address().port}/api/alpha/decisions`,
  DECISIONS_MODELS_URL: `http://127.0.0.1:${mock.address().port}/api/v1/models`,
  DECISIONS_BASE_DIR: dir,
};
const start = async (client, e = env) => {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: e }));
  return async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content[0].text, isError: r.isError };
  };
};

const client = new Client({ name: "smoke", version: "0" });
const call = await start(client);

const { tools } = await client.listTools();
assert.deepEqual(tools.map((t) => t.name).sort(), ["classify_files", "decide_files", "list_models", "locate_in_files"]);

// list_models: catalog sorted by price, default marked
let lm = await call("list_models", {});
assert.match(lm.text, /typesafe\/jev-1\.13\t64000\t\$0\.042\t\(default\)/, lm.text);

// dry run makes no API calls
let r = await call("classify_files", { paths: ["."], labels: ["code", "docs"], dry_run: true });
assert.match(r.text, /Dry run: 4 file\(s\)/, r.text);
assert.equal(requests.length, 0);

// classify: one request per file; secrets, gitignored and binary files are never sent
r = await call("classify_files", { paths: ["."], labels: ["code: source code", "docs"] });
assert.match(r.text, /## code \(3\)/, r.text);
assert.match(r.text, /## docs \(1\)/, r.text);
assert.equal(requests.length, 4);
assert.equal(requests[0].model, "typesafe/jev-1.13");
assert.deepEqual(Object.keys(requests[0].questions.label.criteria), ["code", "docs", "other"]);
const sent = JSON.stringify(requests);
assert.ok(!sent.includes("should-never-be-sent"), ".env leaked");
assert.ok(!sent.includes("ignored-content"), "gitignored file sent");

// include filter + multi-label
r = await call("classify_files", { paths: ["."], include: ["src/**"], labels: ["code", "docs"], multi_label: true });
assert.match(r.text, /## code \(2\)/, r.text);

// decide_files: typed questions + only_matching filter
r = await call("decide_files", {
  paths: ["."],
  questions: [
    { id: "exports", type: "yes_no", question: "Does it export anything?" },
    { id: "kind", type: "choice", question: "Kind?", options: ["code", "docs"] },
    { id: "size", type: "score", question: "Size?", options: ["low", "mid", "high"] },
  ],
  only_matching: "exports",
});
assert.match(r.text, /src\/a.js\tyes\(0.91\)\tcode\(0.97\)\t1.2\/mid/, r.text);
assert.ok(!r.text.includes("README.md\t"), r.text);
assert.match(r.text, /shown: 2/, r.text);

// errors are reported, not thrown
r = await call("locate_in_files", { paths: ["nope"], query: "q" });
assert.equal(r.isError, true);

// locate: a 4000-line file is scanned in full (pass 1), then pinpointed to a small window (pass 2)
fs.writeFileSync(
  path.join(dir, "big.txt"),
  Array.from({ length: 4000 }, (_, i) => `line ${i} ${i === 3500 ? "SECRET_MARKER" : "filler text here"}`).join("\n"),
);
requests.length = 0;
r = await call("locate_in_files", { paths: ["big.txt"], query: "where is the marker?", chunk_chars: 5000, top: 3, snippets: 1 });
const m = r.text.match(/1\. 0\.97  big\.txt:(\d+)-(\d+)/);
assert.ok(m && +m[1] <= 3501 && +m[2] >= 3501 && +m[2] - +m[1] < 40, r.text);
assert.match(r.text, /3501\| line 3500 SECRET_MARKER/, r.text);
assert.ok(requests.length > 20, `expected full scan + refinement, got ${requests.length} requests`);
assert.ok(requests.every((q) => q.state.content.length <= 5100), "chunk exceeded chunk_chars");

// chunks are capped to what a small-context model can take (4000 tok * 0.6 * 2.5 = 6000 chars)
requests.length = 0;
r = await call("locate_in_files", { paths: ["big.txt"], query: "marker", model: "tiny/ctx", explain: false, snippets: 0 });
assert.ok(requests.length > 0 && requests.every((q) => q.state.content.length <= 6000), "chunk exceeded model context budget");
assert.match(r.text, /1\. 0\.97  big\.txt:/, r.text);

// a model that wants a string state is adapted to automatically, and the quirk is remembered
requests.length = 0;
r = await call("classify_files", { paths: ["src"], labels: ["code", "docs"], model: "quirky/string-state" });
assert.match(r.text, /## code \(2\)/, r.text);
assert.equal(requests.filter((q) => typeof q.state === "string").length, 2, "each file should succeed once with a string state");
requests.length = 0;
r = await call("classify_files", { paths: ["src"], labels: ["code", "docs"], model: "quirky/string-state" });
assert.match(r.text, /## code \(2\)/, r.text);
assert.ok(requests.every((q) => typeof q.state === "string"), "learned quirk should be reused without a failed attempt");

// a yes/no-only model works for locate (criteria become plain strings) and fails clearly for choice questions
r = await call("locate_in_files", { paths: ["src"], query: "exports", model: "yesno/only", snippets: 0 });
assert.match(r.text, /1\. 0\.91  src\/[ab]\.js/, r.text);
r = await call("classify_files", { paths: ["src"], labels: ["code", "docs"], model: "yesno/only" });
assert.equal(r.isError, true);
assert.match(r.text, /supports only yes\/no questions/, r.text);
await client.close();

// fallback model takes over when the primary fails (legacy JEV_* variable names still work)
const client3 = new Client({ name: "smoke3", version: "0" });
const call3 = await start(client3, { ...env, JEV_MODEL: "broken/model", JEV_FALLBACK_MODELS: "typesafe/jev-1.13" });
r = await call3("classify_files", { paths: ["README.md"], labels: ["code", "docs"] });
assert.match(r.text, /## docs \(1\)[\s\S]*model: typesafe\/jev-1\.13/, r.text);
await client3.close();

// workspace root from MCP roots when DECISIONS_BASE_DIR is unset
const client2 = new Client({ name: "smoke2", version: "0" }, { capabilities: { roots: {} } });
client2.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: `file://${path.join(dir, "src")}` }] }));
const { DECISIONS_BASE_DIR, ...envNoBase } = env;
const call2 = await start(client2, envNoBase);
r = await call2("classify_files", { paths: ["a.js"], labels: ["code", "docs"] });
assert.match(r.text, /- a\.js \[0\.97\]/, r.text);
await client2.close();

mock.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("OK — all smoke checks passed");
