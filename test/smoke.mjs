// End-to-end smoke test: real MCP client <-> jev-offload-mcp over stdio, with a mock OpenRouter Decisions API.
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

const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    requests.push(body);
    const { path: p, content: c } = body.state;
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
  JEV_DECISIONS_URL: `http://127.0.0.1:${mock.address().port}/api/alpha/decisions`,
  JEV_BASE_DIR: dir,
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
assert.deepEqual(tools.map((t) => t.name).sort(), ["classify_files", "decide_files", "locate_in_files"]);

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
await client.close();

// workspace root from MCP roots when JEV_BASE_DIR is unset
const client2 = new Client({ name: "smoke2", version: "0" }, { capabilities: { roots: {} } });
client2.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: `file://${path.join(dir, "src")}` }] }));
const { JEV_BASE_DIR, ...envNoBase } = env;
const call2 = await start(client2, envNoBase);
r = await call2("classify_files", { paths: ["a.js"], labels: ["code", "docs"] });
assert.match(r.text, /- a\.js \[0\.97\]/, r.text);
await client2.close();

mock.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("OK — all smoke checks passed");
