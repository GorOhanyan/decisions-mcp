// Inline media: base64 images, audio, video and PDFs embedded in text (data: URLs in SVG/HTML/CSS/
// Markdown, image outputs in Jupyter notebooks, base64 constants in source files). A text-only decision
// model can't read them, they cost thousands of tokens, and Drex rejects requests that contain them.

const MEDIA_TYPE = String.raw`(?:image|audio|video)\/[\w.+-]+|application\/pdf`;
// Whole base64 quanta plus optional padding: the match stops exactly where the base64 ends.
const QUANTA = (min) => String.raw`(?:[A-Za-z0-9+/]{4}){${min},}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|={1,2})?`;

// A data: URL with a real payload (at least 32 base64 characters).
const DATA_URL = new RegExp(String.raw`(data:)(${MEDIA_TYPE})((?:;[\w.+=-]+)*);base64,${QUANTA(8)}`, "gi");
// A media data: URL prefix with no payload or a short one, e.g. code that builds data URLs.
const DATA_PREFIX = new RegExp(String.raw`data:(?=(?:${MEDIA_TYPE})(?:;[\w.+=-]+)*;base64,)`, "gi");

// Base64 of the first bytes of PNG, JPEG, GIF, RIFF (WebP/WAV/AVI), PDF, MP3 and MP4 files: candidates only,
// confirmed by decoding (mediaKind) so identifiers that merely start the same way are left alone.
const SIGNATURE = String.raw`iVBORw0KGg|\/9j\/|R0lGOD|UklGR|JVBERi0|SUQz|AAAA[A-Za-z0-9+/]{2}ZnR5cA`;
const MIN_BASE64_CHARS = 512;
const RAW_BASE64 = new RegExp(String.raw`(?<![A-Za-z0-9+/])(?=${SIGNATURE})${QUANTA(MIN_BASE64_CHARS / 4)}`, "g");
const STARTS_WITH_SIGNATURE = new RegExp(String.raw`^(?:${SIGNATURE})`);
const ANY_LINE_STARTS_WITH_SIGNATURE = new RegExp(String.raw`^[ \t]*(?:${SIGNATURE})`, "m");
const BASE64_LINE = /^([ \t]*)([A-Za-z0-9+/]+={0,2})([ \t]*\r?)$/;

/** "image" | "audio" | "video" | "pdf" when `b64` decodes to a known media file header, else undefined. */
export function mediaKind(b64) {
  const b = Buffer.from(b64.replace(/\s+/g, "").slice(0, 24), "base64");
  const ascii = (i, n) => b.toString("latin1", i, i + n);
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image";
  if (ascii(0, 4) === "RIFF") return { WEBP: "image", WAVE: "audio", "AVI ": "video" }[ascii(8, 4)];
  if (ascii(0, 5) === "%PDF-") return "pdf";
  if (ascii(0, 3) === "ID3" && b[3] >= 2 && b[3] <= 4) return "audio";
  if (ascii(4, 4) === "ftyp" && /^[\x20-\x7e]{4}$/.test(ascii(8, 4))) return "video";
  return undefined;
}

const kindOfType = (mime) => (/^application\/pdf$/i.test(mime) ? "pdf" : mime.split("/")[0].toLowerCase());

// Media base64 wrapped over several lines (a 76-column constant in a .py file, a .b64 file): the first
// line is kept as the marker, the others become empty, so line numbers don't change. Continuation lines
// must be as wide as the first one, except a shorter last line.
function stripWrapped(text) {
  if (!ANY_LINE_STARTS_WITH_SIGNATURE.test(text)) return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const first = BASE64_LINE.exec(lines[i]);
    if (!first || !STARTS_WITH_SIGNATURE.test(first[2])) continue;
    const width = first[2].length;
    let end = i + 1;
    let b64 = first[2];
    while (end < lines.length && !b64.endsWith("=")) {
      const next = BASE64_LINE.exec(lines[end]);
      if (!next || next[2].length > width) break;
      b64 += next[2];
      end++;
      if (next[2].length < width) break;
    }
    const kind = b64.length >= MIN_BASE64_CHARS && mediaKind(b64);
    if (!kind) continue;
    lines[i] = `${first[1]}[base64 ${kind} omitted]${first[3]}`;
    for (let k = i + 1; k < end; k++) lines[k] = lines[k].endsWith("\r") ? "\r" : "";
    i = end - 1;
  }
  return lines.join("\n");
}

/**
 * Replace inline base64 media with a short marker such as `[base64 image omitted]`: data: URLs with a
 * payload, long base64 runs that decode to a media file header, and such base64 wrapped over lines.
 * A media data: URL prefix without a payload (code that builds one) only gets a space after `data:`,
 * so Drex no longer reads it as a data URL; nothing is removed. Line breaks are kept.
 */
export function stripInlineMedia(text) {
  return stripWrapped(text)
    .replace(DATA_URL, (_, data, mime, params) => `${data}${mime}${params};[base64 ${kindOfType(mime)} omitted]`)
    .replace(DATA_PREFIX, "$& ")
    .replace(RAW_BASE64, (m) => {
      const kind = mediaKind(m);
      return kind ? `[base64 ${kind} omitted]` : m;
    });
}
