import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import ignore from "ignore";

// Skipped in directory scans (never sent to the remote model) unless JEV_ALLOW_SECRETS=1.
const SECRET_PATTERNS = [
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.keystore",
  "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*", "**/.npmrc", "**/.pypirc", "**/.netrc",
  "**/credentials*", "**/secrets*", "**/*.secret", "**/.aws/**", "**/.ssh/**",
];

const DEFAULT_EXCLUDE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/.nuxt/**",
  "**/out/**", "**/coverage/**", "**/.venv/**", "**/venv/**", "**/__pycache__/**", "**/.cache/**",
  "**/target/**", "**/vendor/**", "**/.idea/**", "**/.vscode/**", "**/*.min.js", "**/*.min.css",
  "**/*.map", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lockb",
  "**/Cargo.lock", "**/poetry.lock", "**/composer.lock", "**/go.sum",
];

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "psd", "pdf", "zip", "gz", "tgz", "bz2",
  "xz", "7z", "rar", "jar", "war", "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "wasm",
  "mp3", "mp4", "wav", "ogg", "flac", "mov", "avi", "mkv", "webm", "woff", "woff2", "ttf", "otf",
  "eot", "sqlite", "db", "pyc", "DS_Store", "heic", "avif", "glb", "fbx", "blend",
]);

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function loadGitignore(root) {
  const ig = ignore();
  try {
    ig.add(await fs.readFile(path.join(root, ".gitignore"), "utf8"));
  } catch {}
  return ig;
}

// Relative to the project root when inside it, absolute otherwise (no "../../.." chains).
function displayPath(baseDir, abs) {
  const rel = path.relative(baseDir, abs);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
}

function checkAllowed(absPath) {
  const roots = (process.env.JEV_ALLOWED_ROOTS || "")
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  if (!roots.length) return;
  const ok = roots.some((r) => absPath === r || absPath.startsWith(r + path.sep));
  if (!ok) throw new Error(`Path ${absPath} is outside JEV_ALLOWED_ROOTS`);
}

/**
 * Collect text files from a list of paths (files or directories).
 * Returns { files: [{path, rel, content, bytes}], skipped: [{path, reason}], root }.
 */
export async function collectFiles({
  paths,
  baseDir = process.cwd(),
  include = ["**/*"],
  exclude = [],
  respectGitignore = true,
  maxFileBytes = Number(process.env.JEV_MAX_FILE_BYTES) || 1_000_000,
  maxFiles = Number(process.env.JEV_MAX_FILES) || 2000,
}) {
  const files = [];
  const skipped = [];
  const seen = new Set();
  const allowSecrets = process.env.JEV_ALLOW_SECRETS === "1";

  const candidates = [];
  for (const p of paths) {
    const abs = path.resolve(baseDir, p);
    checkAllowed(abs);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      skipped.push({ path: p, reason: "not found" });
      continue;
    }
    if (stat.isFile()) {
      candidates.push({ abs, rel: displayPath(baseDir, abs) });
      continue;
    }
    const ig = respectGitignore ? await loadGitignore(abs) : ignore();
    const entries = await glob(include, {
      cwd: abs,
      ignore: [...DEFAULT_EXCLUDE, ...(allowSecrets ? [] : SECRET_PATTERNS), ...exclude],
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      expandDirectories: false,
    });
    entries.sort();
    for (const e of entries) {
      if (respectGitignore && ig.ignores(e)) continue;
      candidates.push({ abs: path.join(abs, e), rel: displayPath(baseDir, path.join(abs, e)) });
    }
  }

  for (const c of candidates) {
    if (seen.has(c.abs)) continue;
    seen.add(c.abs);
    if (files.length >= maxFiles) {
      skipped.push({ path: c.rel, reason: `maxFiles (${maxFiles}) reached` });
      continue;
    }
    const ext = path.extname(c.abs).slice(1).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      skipped.push({ path: c.rel, reason: "binary extension" });
      continue;
    }
    let buf;
    try {
      const st = await fs.stat(c.abs);
      if (st.size > maxFileBytes) {
        skipped.push({ path: c.rel, reason: `too large (${st.size} bytes > ${maxFileBytes})` });
        continue;
      }
      buf = await fs.readFile(c.abs);
    } catch (e) {
      skipped.push({ path: c.rel, reason: `read error: ${e.code || e.message}` });
      continue;
    }
    if (looksBinary(buf)) {
      skipped.push({ path: c.rel, reason: "binary content" });
      continue;
    }
    files.push({ path: c.abs, rel: c.rel, content: buf.toString("utf8"), bytes: buf.length });
  }
  return { files, skipped };
}
