#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { collectFiles } from "./files.js";
import { classify, decideFiles, locate, estTokens, formatStats } from "./decisions.js";
import { config, listDecisionModels } from "./openrouter.js";

const INSTRUCTIONS = `Scans large amounts of text with a tiny, very cheap decision model on OpenRouter (Jev by default; Clef, Mercury Decide and others work too) so you don't have to read it yourself.
Decision models don't write text — they score and pick. Use them to narrow down WHERE to look, then read only the lines they point to:
- locate_in_files: find where something is in many/huge files — the cause of a bug from its symptoms, the code behind a feature, where a setting lives. Returns file:line ranges with probabilities and the top snippets.
- classify_files: sort many files into your categories.
- decide_files: typed per-file facts — yes/no flags, one-of choices, ordered scores — e.g. to filter "files that write to the DB".
- list_models: available decision models; pass one as \`model\` to switch.
Prefer absolute paths; relative paths resolve against the project root. Describe the target specifically (symptoms, error text, names).
Worth it when the material is bigger than ~5 files or a few thousand lines; for a small file just read it.`;

const commonShape = {
  paths: z
    .array(z.string())
    .min(1)
    .describe("Files and/or directories to read (absolute or relative to the project root)"),
  include: z
    .array(z.string())
    .optional()
    .describe('Glob patterns inside directories, e.g. ["**/*.ts", "docs/**/*.md"]. Default: all text files'),
  exclude: z.array(z.string()).optional().describe('Extra globs to skip, e.g. ["**/*.test.ts"]'),
  respect_gitignore: z.boolean().optional().describe("Skip files ignored by the directory's .gitignore (default true)"),
  model: z
    .string()
    .optional()
    .describe("Override the OpenRouter decision model for this call, e.g. cloudflare/clef (see list_models)"),
  dry_run: z.boolean().optional().describe("Only list which files would be scanned and the estimated tokens; no API call"),
};

function progressReporter(extra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return undefined;
  return (progress, total) =>
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total } }).catch(() => {});
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });

function skippedSummary(skipped, limit = 15) {
  if (!skipped.length) return "";
  const lines = skipped.slice(0, limit).map((s) => `  - ${s.path}: ${s.reason}`);
  if (skipped.length > limit) lines.push(`  … and ${skipped.length - limit} more`);
  return `\nSkipped ${skipped.length} file(s):\n${lines.join("\n")}`;
}

// Relative paths resolve against JEV_BASE_DIR, else the client's first workspace root, else cwd.
let rootsBaseDir;
async function baseDir() {
  if (process.env.JEV_BASE_DIR) return process.env.JEV_BASE_DIR;
  if (rootsBaseDir === undefined) {
    rootsBaseDir = null;
    if (server.server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
        const uri = roots.find((r) => r.uri.startsWith("file://"))?.uri;
        if (uri) rootsBaseDir = fileURLToPath(uri);
      } catch {}
    }
  }
  return rootsBaseDir || process.cwd();
}

async function gather(args) {
  const { files, skipped } = await collectFiles({
    paths: args.paths,
    baseDir: await baseDir(),
    include: args.include?.length ? args.include : undefined,
    exclude: args.exclude || [],
    respectGitignore: args.respect_gitignore ?? true,
  });
  const tokens = files.reduce((n, f) => n + estTokens(f.content), 0);
  return { files, skipped, tokens };
}

function dryRunReport({ files, skipped, tokens }, model) {
  const top = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 20);
  return text(
    `Dry run: ${files.length} file(s), ~${tokens} tokens of source; model: ${model}.\n` +
      `Largest files:\n${top.map((f) => `  - ${f.rel} (~${estTokens(f.content)} tok)`).join("\n")}` +
      skippedSummary(skipped),
  );
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    return fail(`jev-offload-mcp error: ${e.message}`);
  }
}

const server = new McpServer({ name: "jev", version: "0.3.0" }, { instructions: INSTRUCTIONS });

server.registerTool(
  "locate_in_files",
  {
    title: "Find where something is in many/huge files",
    description:
      "Find which files and lines most likely contain what you describe — the cause of a bug from its symptoms, the code implementing a feature, where a setting is defined. " +
      "Pass 1: every file is split into chunks and ALL chunks are scored by the decision model (nothing is truncated; very cheap even for megabytes). " +
      "Pass 2: the best chunks are re-scored in small line windows to pinpoint the lines. " +
      "Returns ranked file:line ranges with probabilities, a per-file ranking and the code of the top locations, so you can go straight to the fix.",
    inputSchema: {
      ...commonShape,
      query: z
        .string()
        .describe("What to find, as specific as possible: symptoms, error text, expected vs actual behaviour, names involved"),
      top: z.number().int().positive().optional().describe("How many locations and files to list (default 5)"),
      snippets: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Include the code of this many top locations, with line numbers (default 3, 0 = only file:line ranges)"),
      window_lines: z.number().int().min(5).optional().describe("Size of the pinpointed line windows (default 40)"),
      chunk_chars: z.number().int().positive().optional().describe("Chunk size in chars for pass 1 (default 20000; capped to what the model's context fits)"),
    },
  },
  (args, extra) =>
    guarded(async () => {
      const g = await gather(args);
      if (!g.files.length) return fail(`No readable text files found.${skippedSummary(g.skipped)}`);
      if (args.dry_run) return dryRunReport(g, args.model || config().model);
      const top = args.top ?? 5;
      const r = await locate({
        files: g.files,
        query: args.query,
        refineTop: top,
        windowLines: args.window_lines,
        chunkChars: args.chunk_chars,
        model: args.model,
        signal: extra?.signal,
        onProgress: progressReporter(extra),
      });
      const locs = r.locations.slice(0, top);
      const out = [
        `Most likely locations (probability · file:lines):`,
        ...locs.map((l, i) => `${i + 1}. ${l.p.toFixed(2)}  ${l.rel}:${l.start}-${l.end}`),
        ``,
        `Files ranking:`,
        ...r.files.slice(0, top).map((f, i) => `${i + 1}. ${f.p.toFixed(2)}  ${f.rel}`),
      ];
      for (const l of locs.slice(0, args.snippets ?? 3)) {
        out.push(``, `--- ${l.rel}:${l.start}-${l.end} (${l.p.toFixed(2)})`, ...l.lines.map((line, i) => `${l.start + i}| ${line}`));
      }
      const meta = formatStats(r.stats, {
        files: g.files.length,
        "~source tokens": g.tokens,
        chunks: r.chunks,
        windows: r.windows,
        ...(r.failed ? { "failed requests": r.failed } : {}),
      });
      out.push(``, `---`, `Probabilities are Jev's estimate, not proof: read the code before acting.`, meta + skippedSummary(g.skipped, 5));
      return text(out.join("\n"));
    }),
);

server.registerTool(
  "classify_files",
  {
    title: "Classify files",
    description:
      "Classify every file in the given paths into your labels with a decision model (one very cheap request per file, calibrated confidence). " +
      "Returns files grouped by label. Good for triage: tests/configs/dead code, sorting documents by topic, flagging files about X. " +
      "Label descriptions after a colon noticeably improve accuracy.",
    inputSchema: {
      ...commonShape,
      labels: z
        .array(z.string())
        .min(2)
        .describe('Label names, optionally with a description after a colon, e.g. ["bug: describes a defect", "feature", "question"]'),
      multi_label: z.boolean().optional().describe("Allow several labels per file (default false)"),
      instructions: z.string().optional().describe("Extra classification criteria"),
      max_chars_per_file: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Truncate each file to this many chars, keeping head and tail (default 12000; capped to the model's context)"),
      format: z.enum(["grouped", "table", "json"]).optional().describe("Output format (default grouped)"),
    },
  },
  (args, extra) =>
    guarded(async () => {
      const g = await gather(args);
      if (!g.files.length) return fail(`No readable text files found.${skippedSummary(g.skipped)}`);
      if (args.dry_run) return dryRunReport(g, args.model || config().model);
      const r = await classify({
        files: g.files,
        labels: args.labels,
        multiLabel: args.multi_label,
        instructions: args.instructions,
        maxCharsPerFile: args.max_chars_per_file,
        model: args.model,
        signal: extra?.signal,
        onProgress: progressReporter(extra),
      });
      const meta = formatStats(r.stats, { files: g.files.length });
      const errNote = (x) => (x.error ? ` ${x.error}` : "");
      let body;
      if (args.format === "json") {
        body = JSON.stringify(r.rows);
      } else if (args.format === "table") {
        body = "file\tlabels\tconfidence\n" + r.rows.map((x) => `${x.file}\t${x.labels.join(",")}\t${x.confidence}${errNote(x)}`).join("\n");
      } else {
        const groups = new Map();
        for (const row of r.rows) for (const l of row.labels) groups.set(l, [...(groups.get(l) || []), row]);
        body = [...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([l, rows]) => `## ${l} (${rows.length})\n` + rows.map((x) => `- ${x.file} [${x.confidence}]${errNote(x)}`).join("\n"))
          .join("\n\n");
      }
      return text(`${body}\n\n---\n${meta}${skippedSummary(g.skipped, 5)}`);
    }),
);

const questionSpec = z.object({
  id: z.string().describe("Short key for the answer column, e.g. 'uses_db'"),
  type: z.enum(["yes_no", "choice", "score"]),
  question: z.string().describe("What to decide about each file"),
  options: z
    .array(z.string())
    .optional()
    .describe('choice: options, optionally "name: description". score: ordered levels from lowest to highest, e.g. ["trivial", "moderate", "complex"]'),
  yes: z.string().optional().describe("yes_no: what 'yes' means"),
  no: z.string().optional().describe("yes_no: what 'no' means"),
});

const fmtAnswer = (a) => {
  if (a.value === null || a.value === undefined) return "?";
  if (a.p !== undefined) return `${a.value}(${a.p})`;
  if (a.level !== undefined) return `${a.value}/${a.level}`;
  return `${a.value}(${a.confidence})`;
};

server.registerTool(
  "decide_files",
  {
    title: "Typed per-file decisions",
    description:
      "Ask several typed questions about EACH file with a decision model: yes_no flags, one-of choices and ordered scores, with calibrated probabilities. " +
      "Example: for every file decide uses_db (yes_no), layer (choice: api/domain/ui/infra), complexity (score: low/medium/high). " +
      "Use only_matching to return just the files where a yes_no question is yes.",
    inputSchema: {
      ...commonShape,
      questions: z.array(questionSpec).min(1).max(20),
      instructions: z.string().optional().describe("Shared context added to every question"),
      only_matching: z.string().optional().describe("Return only files where this yes_no question id is 'yes'"),
      max_chars_per_file: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Truncate each file to this many chars, keeping head and tail (default 12000; capped to the model's context)"),
      format: z.enum(["table", "json"]).optional().describe("Output format (default table)"),
    },
  },
  (args, extra) =>
    guarded(async () => {
      const g = await gather(args);
      if (!g.files.length) return fail(`No readable text files found.${skippedSummary(g.skipped)}`);
      if (args.dry_run) return dryRunReport(g, args.model || config().model);
      const r = await decideFiles({
        files: g.files,
        questions: args.questions,
        instructions: args.instructions,
        maxCharsPerFile: args.max_chars_per_file,
        model: args.model,
        signal: extra?.signal,
        onProgress: progressReporter(extra),
      });
      let rows = r.rows;
      if (args.only_matching) rows = rows.filter((x) => x.answers?.[args.only_matching]?.value === "yes");
      const ids = args.questions.map((q) => q.id);
      const meta = formatStats(r.stats, { files: g.files.length, shown: rows.length });
      const body =
        args.format === "json"
          ? JSON.stringify(rows)
          : `file\t${ids.join("\t")}\n` +
            rows.map((x) => (x.error ? `${x.file}\tERROR: ${x.error}` : `${x.file}\t${ids.map((id) => fmtAnswer(x.answers[id])).join("\t")}`)).join("\n");
      const legend = "yes_no: yes|no(probability of yes); choice: value(confidence); score: value/nearest level";
      return text(`${body}\n\n---\n${legend}\n${meta}${skippedSummary(g.skipped, 5)}`);
    }),
);

server.registerTool(
  "list_models",
  {
    title: "List decision models",
    description:
      "List the decision models available on OpenRouter (id, context window, input price) and which one is the default. " +
      "Pass an id as `model` to any other tool. Bigger context = bigger chunks per request.",
    inputSchema: {},
  },
  () =>
    guarded(async () => {
      const models = await listDecisionModels();
      if (!models.length) return fail("Could not load the model list from OpenRouter.");
      const cfg = config();
      const rows = [...models]
        .sort((a, b) => a.pricePerM - b.pricePerM || b.context - a.context)
        .map((m) => {
          const tags = [m.id === cfg.model && "default", cfg.fallbacks.includes(m.id) && "fallback"].filter(Boolean);
          return `${m.id}\t${m.context || "?"}\t$${m.pricePerM.toFixed(3)}${tags.length ? `\t(${tags.join(", ")})` : ""}`;
        });
      return text(`model\tcontext\t$/1M input\n${rows.join("\n")}`);
    }),
);

await server.connect(new StdioServerTransport());
if (!config().apiKey) console.error("[jev-offload-mcp] warning: OPENROUTER_API_KEY is not set — tool calls will fail");
