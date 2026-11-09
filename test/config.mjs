// Unit checks: provider selection, per-provider defaults, inline-media stripping and Nace model ids.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { config, provider, stripInlineMediaEnabled } from "../src/config.js";
import { collectFiles, stripInlineMedia } from "../src/files.js";
import { checkNaceLimits, toNaceModel } from "../src/nace.js";

const VARS = [
  "DECISIONS_PROVIDER", "JEV_PROVIDER", "NACE_API_KEY", "OPENROUTER_API_KEY", "DECISIONS_STRIP_INLINE_MEDIA",
  "JEV_STRIP_INLINE_MEDIA", "DECISIONS_MODEL", "JEV_MODEL", "DECISIONS_NACE_URL", "DECISIONS_DECISIONS_URL",
  "DECISIONS_FALLBACK_MODELS", "JEV_FALLBACK_MODELS",
];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
const clear = () => VARS.forEach((k) => delete process.env[k]);
function withEnv(vars, fn) {
  clear();
  Object.assign(process.env, vars);
  let r;
  try {
    r = fn();
  } catch (e) {
    clear();
    throw e;
  }
  if (r instanceof Promise) return r.finally(clear);
  clear();
  return r;
}

// ---- Provider auto-select: DECISIONS_PROVIDER wins; Nace only when NACE_API_KEY is the only key.
withEnv({}, () => assert.equal(provider(), "openrouter"));
withEnv({ OPENROUTER_API_KEY: "or" }, () => assert.equal(provider(), "openrouter"));
withEnv({ NACE_API_KEY: "nace_sk_x" }, () => assert.equal(provider(), "nace"));
withEnv({ NACE_API_KEY: "nace_sk_x", OPENROUTER_API_KEY: "or" }, () => assert.equal(provider(), "openrouter"));
withEnv({ NACE_API_KEY: "nace_sk_x", OPENROUTER_API_KEY: "or", DECISIONS_PROVIDER: "nace" }, () => assert.equal(provider(), "nace"));
withEnv({ NACE_API_KEY: "nace_sk_x", DECISIONS_PROVIDER: "openrouter" }, () => assert.equal(provider(), "openrouter"));
withEnv({ DECISIONS_PROVIDER: " Nace " }, () => assert.equal(provider(), "nace"));
withEnv({ DECISIONS_PROVIDER: "bogus" }, () => assert.throws(() => config(), /DECISIONS_PROVIDER must be one of openrouter, nace/));

// ---- Per-provider defaults; each provider gets only its own key and URLs.
withEnv({ NACE_API_KEY: "nace_sk_x", DECISIONS_DECISIONS_URL: "http://elsewhere/decisions" }, () => {
  const c = config();
  assert.equal(c.provider, "nace");
  assert.equal(c.model, "drex-max-v1.1");
  assert.equal(c.apiKey, "nace_sk_x");
  assert.equal(c.keyName, "NACE_API_KEY");
  assert.equal(c.url, "https://console.nace.ai/v1/systemone");
  assert.equal(c.modelsUrl, "https://console.nace.ai/v1/models");
});
withEnv({ NACE_API_KEY: "nace_sk_x", DECISIONS_NACE_URL: "http://127.0.0.1:1/", DECISIONS_MODEL: "drex-v2.0" }, () => {
  const c = config();
  assert.equal(c.url, "http://127.0.0.1:1/v1/systemone");
  assert.equal(c.model, "drex-v2.0");
});
withEnv({ OPENROUTER_API_KEY: "or", NACE_API_KEY: "nace_sk_x" }, () => {
  const c = config();
  assert.equal(c.model, "typesafe/jev-1.13");
  assert.equal(c.apiKey, "or");
  assert.equal(c.url, "https://openrouter.ai/api/alpha/decisions");
});
withEnv({ DECISIONS_PROVIDER: "nace", OPENROUTER_API_KEY: "or" }, () => {
  assert.equal(config().apiKey, undefined, "the OpenRouter key must never be used for Nace");
});

// ---- Inline-media stripping: on by default for Nace, off for OpenRouter, env wins both ways.
withEnv({ NACE_API_KEY: "nace_sk_x" }, () => assert.equal(stripInlineMediaEnabled(), true));
withEnv({ OPENROUTER_API_KEY: "or" }, () => assert.equal(stripInlineMediaEnabled(), false));
withEnv({ OPENROUTER_API_KEY: "or", DECISIONS_STRIP_INLINE_MEDIA: "true" }, () => assert.equal(stripInlineMediaEnabled(), true));
withEnv({ NACE_API_KEY: "nace_sk_x", DECISIONS_STRIP_INLINE_MEDIA: "false" }, () => assert.equal(stripInlineMediaEnabled(), false));
withEnv({ DECISIONS_STRIP_INLINE_MEDIA: "1" }, () => assert.equal(stripInlineMediaEnabled(), true));
withEnv({ DECISIONS_STRIP_INLINE_MEDIA: "maybe" }, () => assert.throws(() => stripInlineMediaEnabled(), /true or false/));

// OpenRouter's nace-ai/ models are served by Drex too: stripping defaults on for them only.
withEnv({ OPENROUTER_API_KEY: "or", DECISIONS_MODEL: "nace-ai/drex-v2.0" }, () => assert.equal(stripInlineMediaEnabled(), true));
withEnv({ OPENROUTER_API_KEY: "or", DECISIONS_FALLBACK_MODELS: "nace-ai/drex-v2.0" }, () => assert.equal(stripInlineMediaEnabled(), true));
withEnv({ OPENROUTER_API_KEY: "or" }, () => {
  assert.equal(stripInlineMediaEnabled(["nace-ai/drex-v2.0"]), true);
  assert.equal(stripInlineMediaEnabled(["cloudflare/clef"]), false);
});
withEnv({ OPENROUTER_API_KEY: "or", DECISIONS_MODEL: "nace-ai/drex-v2.0", DECISIONS_STRIP_INLINE_MEDIA: "false" }, () =>
  assert.equal(stripInlineMediaEnabled(), false),
);

// Drex's own detector (lib/ndm-media.ts), to check stripped text would be accepted.
const DREX_DATA_URL = /data:((?:image|audio|video)\/[\w.+-]+|application\/pdf)(?:;[\w.+=-]+)*;base64,/i;
const DREX_SIGNATURES = [/^\/9j\//, /^iVBORw0KGg/, /^R0lGOD/, /^UklGR/, /^JVBERi0/, /^SUQz/, /^AAAA[A-Za-z0-9+/]{2}ZnR5cA/];
const drexRejects = (s) => {
  if (DREX_DATA_URL.test(s)) return true;
  const t = s.trim();
  return t.length >= 512 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(t) && DREX_SIGNATURES.some((re) => re.test(t));
};
// Real base64 of media file headers followed by filler bytes.
const b64 = (header, n = 600) => {
  const b = Buffer.alloc(n, 7);
  Buffer.from(header, "latin1").copy(b);
  return b.toString("base64");
};
const png = b64("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", 601); // ends with "=="
const jpeg = b64("\xff\xd8\xff\xe0\0\x10JFIF");
const pdf = b64("%PDF-1.4\n");
const mp3 = b64("ID3\x04\0\0");
const mp4 = b64("\0\0\0\x18ftypmp42");
const filler = png.slice(40, 140);
const lines = (s) => s.split("\n").length;
const cases = [
  [`<svg>\n<image href="data:image/png;base64,${png}"/>\n</svg>`, /<image href="data:image\/png;\[base64 image omitted\]"\/>/],
  [`a { background: url(data:image/svg+xml;charset=utf-8;base64,${png}) }`, /url\(data:image\/svg\+xml;charset=utf-8;\[base64 image omitted\]\) }/],
  [`<audio src="data:audio/mpeg;base64,${mp3}">\n<video src="data:video/mp4;base64,${mp4}">`, /"data:audio\/mpeg;\[base64 audio omitted\]">\n<video src="data:video\/mp4;\[base64 video omitted\]">/],
  [`<embed src="DATA:Application/PDF;BASE64,${pdf}">`, /<embed src="DATA:Application\/PDF;\[base64 pdf omitted\]">/],
  [`{\n "outputs": [{"data": {"image/png": "${png}",\n "text/plain": ["<Figure>"]}}]\n}`, /"image\/png": "\[base64 image omitted\]",\n/],
  [`jpeg = '${jpeg}'\npdf = "${pdf}"\nmp3 = ${mp3};`, /^jpeg = '\[base64 image omitted\]'\npdf = "\[base64 pdf omitted\]"\nmp3 = \[base64 audio omitted\];$/],
  // the match stops exactly at the end of the base64 and its padding
  [`<img src=data:image/png;base64,${png}/>`, /^<img src=data:image\/png;\[base64 image omitted\]\/>$/],
  [`<img src=data:image/jpeg;base64,${jpeg}/>`, /^<img src=data:image\/jpeg;\[base64 image omitted\]\/>$/],
];
for (const [input, expected] of cases) {
  const out = stripInlineMedia(input);
  assert.match(out, expected, out);
  assert.equal(lines(out), lines(input), "line count must not change");
  assert.ok(!drexRejects(out), `Drex would still reject: ${out}`);
  assert.ok(!out.includes(filler) && !out.includes(jpeg.slice(40, 140)), out);
}

// A media data: URL prefix with no payload is not reported as omitted media; only "data:" gets a
// space so Drex doesn't read it as a data URL.
const builder = `const url = (b) => "data:image/png;base64," + b;\nconst pdfUrl = 'DATA:application/pdf;base64,' + x;`;
const built = stripInlineMedia(builder);
assert.equal(built, `const url = (b) => "data: image/png;base64," + b;\nconst pdfUrl = 'DATA: application/pdf;base64,' + x;`);
assert.ok(!drexRejects(built));
assert.equal(stripInlineMedia(`src="data:image/png;base64,iVBORw0KGgo="`), `src="data: image/png;base64,iVBORw0KGgo="`);

// Base64 media wrapped over many lines (a 76-column constant in a .py file) keeps its line count, and a
// window that starts on its first line is no longer rejected.
const bigPng = b64("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", 6000).match(/.{1,76}/g);
const py = [...Array.from({ length: 29 }, (_, i) => `x${i} = ${i}`), 'PNG = """', ...bigPng, '"""', "else", "def load(): return PNG"].join("\n");
const pyOut = stripInlineMedia(py);
const pyLines = pyOut.split("\n");
assert.equal(pyLines.length, py.split("\n").length);
assert.equal(pyLines[30], "[base64 image omitted]");
assert.ok(pyLines.slice(31, 30 + bigPng.length).every((l) => l === ""), "continuation lines must be emptied");
assert.deepEqual(pyLines.slice(30 + bigPng.length), ['"""', "else", "def load(): return PNG"]);
for (let start = 0; start < pyLines.length; start++) assert.ok(!drexRejects(pyLines.slice(start, start + 40).join("\n")));
assert.ok(drexRejects(py.split("\n").slice(30, 70).join("\n")), "the unstripped window is what Drex rejects");
// The same with indentation and CRLF line ends.
const indented = bigPng.map((l) => `    ${l}\r`).join("\n");
const indentedOut = stripInlineMedia(indented);
assert.equal(lines(indentedOut), bigPng.length);
assert.match(indentedOut, /^ {4}\[base64 image omitted\]\r\n\r\n/);

// Left alone: short base64, base64 that doesn't decode to a media header (identifiers, hashes), text data:
// URLs, ordinary code, runs that don't start at a run boundary, uneven "wrapped" text.
for (const keep of [
  `const tiny = "iVBORw0KGgo${"A".repeat(40)}";`,
  `hash: ${"Zm9v".repeat(200)}`,
  `const SUQz${"abcdefgh".repeat(64)} = 1;`,
  `let iVBORw0KGgx${"Abc1".repeat(130)} = 2;`,
  `R0lGODxx${"Q".repeat(600)}`,
  `href="data:text/plain;base64,aGVsbG8="`,
  `export const a = 1;\n// see data:image/png docs\n`,
  `token = "x${png}"`,
  ["SUQzdGVzdA", ...Array.from({ length: 80 }, (_, i) => "word".repeat(1 + (i % 5)))].join("\n"),
]) {
  assert.equal(stripInlineMedia(keep), keep);
}

// ---- collectFiles applies stripping by provider default and the env override.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-media-"));
const svg = `<svg xmlns="http://www.w3.org/2000/svg">\n  <image href="data:image/png;base64,${png}"/>\n</svg>\n`;
fs.writeFileSync(path.join(dir, "logo.svg"), svg);
const read = async () => (await collectFiles({ paths: ["logo.svg"], baseDir: dir })).files[0].content;
const forNace = await withEnv({ NACE_API_KEY: "nace_sk_x" }, read);
assert.ok(forNace.includes("[base64 image omitted]") && !forNace.includes(png), forNace);
assert.equal(lines(forNace), lines(svg));
assert.equal(await withEnv({ OPENROUTER_API_KEY: "or" }, read), svg, "OpenRouter text must stay byte-identical by default");
assert.notEqual(await withEnv({ OPENROUTER_API_KEY: "or", DECISIONS_STRIP_INLINE_MEDIA: "true" }, read), svg);
assert.equal(await withEnv({ NACE_API_KEY: "nace_sk_x", DECISIONS_STRIP_INLINE_MEDIA: "false" }, read), svg);
const readFor = (model) => async () => (await collectFiles({ paths: ["logo.svg"], baseDir: dir, model })).files[0].content;
assert.notEqual(await withEnv({ OPENROUTER_API_KEY: "or" }, readFor("nace-ai/drex-v2.0")), svg, "nace-ai/ models on OpenRouter get stripped text");
assert.equal(await withEnv({ OPENROUTER_API_KEY: "or" }, readFor("cloudflare/clef")), svg);
fs.rmSync(dir, { recursive: true, force: true });

// ---- Drex request limits are checked before anything is sent
const noul = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`l${i}`, { type: "noul", instructions: "x" }]));
const choice = (n) => ({ label: { type: "choice", instructions: "x", criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, "d"])) } });
assert.doesNotThrow(() => checkNaceLimits("drex-v2.0", noul(512)));
assert.throws(() => checkNaceLimits("drex-v2.0", noul(513)), /drex-v2\.0 takes at most 512 questions per request; this request has 513/);
assert.doesNotThrow(() => checkNaceLimits("drex-max-v1.1", choice(255)));
assert.throws(() => checkNaceLimits("drex-max-v1.1", choice(256)), /at most 255 options or levels per question; question "label" has 256/);
assert.throws(() => checkNaceLimits("drex-v1.5", { s: { type: "score", instructions: "x", criteria: Array(300).fill("lvl") } }), /255 options/);
assert.doesNotThrow(() => checkNaceLimits("drex-v2.0", choice(1000)), "drex-v2.0 has no option cap");

// ---- Nace model ids
assert.equal(toNaceModel("drex-v2.0"), "drex-v2.0");
assert.equal(toNaceModel("drex-max-v1.1"), "drex-max-v1.1");
assert.equal(toNaceModel("nace-ai/drex-v2.0"), "drex-v2.0");
assert.equal(toNaceModel("Nace-AI/Drex-Max-V1.1"), "drex-max-v1.1");
assert.equal(toNaceModel("nacedm-latest"), "nacedm-latest");
assert.throws(() => toNaceModel("typesafe/jev-1.13"), /not served by the Nace API/);
assert.throws(() => toNaceModel(""), /not served by the Nace API/);

for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
console.log("OK — config, provider and media checks passed");
