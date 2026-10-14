import { charBudget, config, decide, pool } from "./openrouter.js";

// Rough token estimate, only used for dry-run reports.
export const estTokens = (s) => Math.ceil(s.length / 3);


function newStats() {
  return { calls: 0, prompt: 0, cost: 0, models: new Set() };
}

export function formatStats(stats, extra = {}) {
  const parts = Object.entries(extra).map(([k, v]) => `${k}: ${v}`);
  parts.push(`model calls: ${stats.calls}`, `tokens in: ${stats.prompt}`);
  if (stats.cost) parts.push(`cost: $${stats.cost.toFixed(5)}`);
  if (stats.models.size) parts.push(`model: ${[...stats.models].join(", ")}`);
  return parts.join(" | ");
}

/** decide() + usage accounting; returns null instead of throwing (except on cancel) and remembers the error. */
async function tracked(stats, args, errors) {
  try {
    const r = await decide(args);
    stats.calls++;
    stats.prompt += r.usage.prompt;
    stats.cost += r.usage.cost;
    stats.models.add(r.model);
    return r;
  } catch (e) {
    if (args.signal?.aborted) throw e;
    errors.push(e);
    return null;
  }
}

function clip(content, maxChars) {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.8);
  const tail = maxChars - head;
  return `${content.slice(0, head)}\n…[${content.length - maxChars} chars omitted]…\n${content.slice(-tail)}`;
}

const keyOf = (id) => String(id).trim().replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 64) || "q";

function splitLabel(l) {
  const i = l.indexOf(":");
  return i < 0 ? [l.trim(), l.trim()] : [l.slice(0, i).trim(), l.slice(i + 1).trim() || l.slice(0, i).trim()];
}

/** Convert agent-facing question specs into Decisions API questions. */
function toDecisionQuestions(specs, instructions) {
  const out = {};
  const suffix = instructions ? `\nContext: ${instructions}` : "";
  for (const q of specs) {
    const key = keyOf(q.id);
    if (q.type === "choice") {
      if (!q.options?.length) throw new Error(`question "${q.id}": choice needs options`);
      out[key] = { type: "choice", instructions: q.question + suffix, criteria: Object.fromEntries(q.options.map(splitLabel)) };
    } else if (q.type === "score") {
      if (!q.options || q.options.length < 2) throw new Error(`question "${q.id}": score needs at least 2 ordered levels`);
      out[key] = { type: "score", instructions: q.question + suffix, criteria: q.options };
    } else {
      out[key] = { type: "noul", instructions: q.question + suffix, criteria: { true: q.yes || "Yes", false: q.no || "No" } };
    }
  }
  return out;
}

function normalizeAnswer(a) {
  if (!a) return { value: null };
  if (a.type === "noul" || typeof a.noul === "number") {
    const p = Number(a.noul) || 0;
    return { value: p >= 0.5 ? "yes" : "no", p: +p.toFixed(2) };
  }
  if (a.type === "score" || typeof a.score === "number") {
    // Level = most probable rung; `score` itself is the expected rung index (0..n-1).
    const probs = Object.entries(a.probabilities || {});
    const top = probs.length ? probs.reduce((x, y) => (y[1] > x[1] ? y : x))[0] : String(Math.round(a.score));
    const level = a.legend?.[top];
    return { value: +Number(a.score).toFixed(2), level, confidence: +(Number(a.confidence) || 0).toFixed(2) };
  }
  return { value: a.choice ?? null, confidence: +(Number(a.confidence) || 0).toFixed(2) };
}

/** Ask typed questions about each file (one Jev request per file). Returns rows [{file, answers} | {file, error}]. */
export async function decideFiles({ files, questions, instructions, maxCharsPerFile = 12000, model, signal, onProgress }) {
  const cfg = config();
  const stats = newStats();
  const errors = [];
  const dq = toDecisionQuestions(questions, instructions);
  const keys = questions.map((q) => [q.id, keyOf(q.id)]);
  // Never exceed what the model's context can take.
  const limit = Math.min(maxCharsPerFile, await charBudget(model));
  let done = 0;
  const rows = await pool(files, cfg.concurrency, async (f) => {
    const r = await tracked(stats, { questions: dq, state: { path: f.rel, content: clip(f.content, limit) }, model, signal }, errors);
    onProgress?.(++done, files.length);
    if (!r) return { file: f.rel, error: errors.at(-1).message };
    return { file: f.rel, answers: Object.fromEntries(keys.map(([id, k]) => [id, normalizeAnswer(r.answers[k])])) };
  });
  if (errors.length && rows.every((r) => r.error)) throw errors.at(-1);
  return { rows, stats };
}

/** Classification on top of decideFiles: one choice question (single-label) or one yes/no per label (multi-label). */
export async function classify({ files, labels, multiLabel = false, instructions, maxCharsPerFile = 12000, model, signal, onProgress }) {
  const parsed = labels.map(splitLabel);
  let questions;
  if (multiLabel) {
    questions = parsed.map(([name, desc], i) => ({
      id: `l${i}`,
      type: "yes_no",
      question: `Does this file belong to the category "${name}"?`,
      yes: desc,
      no: `The file does not match "${name}"`,
    }));
  } else {
    const opts = parsed.map(([n, d]) => `${n}: ${d}`);
    if (!parsed.some(([n]) => n.toLowerCase() === "other")) opts.push("other: None of the listed categories fits");
    questions = [{ id: "label", type: "choice", question: "Which category does this file belong to?", options: opts }];
  }
  const r = await decideFiles({ files, questions, instructions, maxCharsPerFile, model, signal, onProgress });
  const rows = r.rows.map((row) => {
    if (row.error) return { file: row.file, labels: ["ERROR"], confidence: 0, error: row.error };
    if (!multiLabel) {
      const a = row.answers.label;
      return { file: row.file, labels: [a.value ?? "other"], confidence: a.confidence ?? 0 };
    }
    const hits = parsed.map(([name], i) => [name, row.answers[`l${i}`]?.p ?? 0]).filter(([, p]) => p >= 0.5);
    hits.sort((a, b) => b[1] - a[1]);
    return hits.length
      ? { file: row.file, labels: hits.map(([n]) => n), confidence: hits[0][1] }
      : { file: row.file, labels: ["other"], confidence: 0 };
  });
  return { rows, stats: r.stats };
}

// ---- Locate: pass 1 scores every chunk of every file (nothing is clipped),
// pass 2 re-scores small line windows inside the best chunks to pinpoint the lines.

function windows(lines, firstLine, size, overlap) {
  const out = [];
  const step = Math.max(1, size - overlap);
  for (let s = 0; s < lines.length; s += step) {
    out.push({ start: firstLine + s, end: firstLine + Math.min(s + size, lines.length) - 1, lines: lines.slice(s, s + size) });
    if (s + size >= lines.length) break;
  }
  return out;
}

function chunkByChars(content, maxChars, overlapLines = 20) {
  const lines = content.split("\n");
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end].length + 1 <= maxChars)) {
      size += lines[end].length + 1;
      end++;
    }
    // A single huge line (minified code, one-line JSON) is cut to fit the context.
    const slice = lines.slice(start, end).map((l) => (l.length > maxChars ? l.slice(0, maxChars) + " …[line truncated]" : l));
    chunks.push({ start: start + 1, end, lines: slice });
    if (end >= lines.length) break;
    start = Math.max(end - overlapLines, start + 1);
  }
  return chunks;
}

/**
 * Find where in a large corpus something is (a bug, the code behind a feature, a setting...).
 * Returns { locations: [{rel, start, end, p, lines}], files: [{rel, p}], stats, chunks, windows, failed }.
 */
export async function locate({ files, query, chunkChars = 20000, refineTop = 5, windowLines = 40, model, signal, onProgress }) {
  const cfg = config();
  const stats = newStats();
  const errors = [];
  const question = {
    hit: {
      type: "noul",
      instructions: `Target: ${query}\nIs the target located in this fragment (or is this fragment very likely where it is)?`,
      criteria: {
        true: "This fragment contains the target or its most likely cause/location",
        false: "This fragment is unrelated to the target",
      },
    },
  };
  const score = async (c) => {
    const r = await tracked(stats, { questions: question, state: { path: c.rel, lines: `${c.start}-${c.end}`, content: c.lines.join("\n") }, model, signal }, errors);
    return { ...c, p: r ? Number(r.answers.hit?.noul) || 0 : -1 };
  };

  const size = Math.min(chunkChars, await charBudget(model));
  const chunks = files.flatMap((f) => chunkByChars(f.content, size).map((c) => ({ ...c, rel: f.rel })));
  let done = 0;
  const progress = (total) => onProgress?.(++done, total);
  const pass1 = await pool(chunks, cfg.concurrency, async (c) => {
    const r = await score(c);
    progress(chunks.length);
    return r;
  });
  if (errors.length && pass1.every((c) => c.p < 0)) throw errors.at(-1);

  const fileBest = new Map();
  for (const c of pass1) if (c.p > (fileBest.get(c.rel) ?? -1)) fileBest.set(c.rel, c.p);
  const fileRanking = [...fileBest.entries()].map(([rel, p]) => ({ rel, p })).sort((a, b) => b.p - a.p);

  // Pass 2: pinpoint lines inside the best chunks. Chunks that are already window-sized are kept as is.
  const top = pass1.filter((c) => c.p >= 0).sort((a, b) => b.p - a.p).slice(0, refineTop);
  const toRefine = top.flatMap((c) =>
    c.lines.length <= windowLines ? [] : windows(c.lines, c.start, windowLines, Math.floor(windowLines / 4)).map((w) => ({ ...w, rel: c.rel })),
  );
  done = 0;
  const pass2 = await pool(toRefine, cfg.concurrency, async (w) => {
    const r = await score(w);
    progress(toRefine.length);
    return r;
  });

  // Rank windows; a window inherits nothing from its chunk score, but small chunks compete directly.
  const candidates = [...pass2.filter((w) => w.p >= 0), ...top.filter((c) => c.lines.length <= windowLines)];
  candidates.sort((a, b) => b.p - a.p);
  // Drop windows that overlap an already-picked, higher-scoring one.
  const locations = [];
  for (const w of candidates) {
    if (locations.some((l) => l.rel === w.rel && w.start <= l.end && w.end >= l.start)) continue;
    locations.push(w);
  }
  return {
    chunkChars: size,
    locations,
    files: fileRanking,
    stats,
    chunks: chunks.length,
    windows: toRefine.length,
    failed: [...pass1, ...pass2].filter((c) => c.p < 0).length,
  };
}
