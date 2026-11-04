import { TextStyle } from "zca-js";

/**
 * Markdown → Zalo native text styles.
 *
 * Zalo does not render Markdown. It does support a few text styles (bold,
 * italic, strikethrough, a larger font size and four colors), sent next to the
 * message as a list of { start, len, st } ranges. This module translates the
 * Markdown the agent writes into that form, so the agent can write Markdown as
 * it would anywhere else.
 *
 *   # Heading (any level)      → bold + large, whole line
 *   **bold**, __bold__         → bold
 *   *italic*, _italic_         → italic
 *   ***both***, ___both___     → bold + italic
 *   ~~strike~~                 → strikethrough
 *   `code`                     → bold (Zalo has no monospace font)
 *   ```fenced block```         → fences removed, content kept verbatim
 *   > quote                    → italic, whole line
 *   1. item, 1) item           → the number in bold + large
 *   - item, * item, • item     → "- item"; indented sub-items → "• item"
 *   [label](url)               → bold label followed by " (url)"
 *   [red]…[/red]               → red; also [orange] [yellow] [green] and the
 *                                Vietnamese aliases [do] [cam] [vang] [xanh]
 *   ---                        → removed
 *
 * Styles nest, never cross a line break, and positions are UTF-16 indices into
 * the output text (what zca-js expects).
 */

const BOLD = TextStyle.Bold || "b";
const ITALIC = TextStyle.Italic || "i";
const STRIKE = TextStyle.StrikeThrough || "s";
// Larger font. Stacked with bold on headings and list numbers so the structure
// of a long reply is easy to scan.
const BIG = TextStyle.Big || "f_18";

const COLORS = {
  red: TextStyle.Red || "c_db342e",
  green: TextStyle.Green || "c_15a85f",
  orange: TextStyle.Orange || "c_f27806",
  yellow: TextStyle.Yellow || "c_f7b503",
};

// Vietnamese color names, rewritten to the English tags before parsing.
const COLOR_ALIASES = { do: "red", xanh: "green", cam: "orange", vang: "yellow" };
const COLOR_ALIAS_RE = new RegExp(`\\[(\\/?)(${Object.keys(COLOR_ALIASES).join("|")})\\]`, "gi");

// ── Zalo per-message limits ──────────────────────────────────────────────────

const MAX_CHARS = 2000;
// Zalo accepts many styles per message, but stays reliable up to about 40.
const MAX_STYLES = 40;
// Zalo also rejects messages by payload size, not just by length or style
// count. Across 223 real sends, every message refused with "unknown error" had
// UTF-8 text bytes + style JSON length of 3448 or more, and every accepted one
// was at most 3437. Vietnamese letters take 2–3 bytes and emoji 4, so a message
// well under 2000 characters can still cross it. 3000 leaves a safety margin.
const MAX_PAYLOAD_BYTES = 3000;
// Each "@Name" mention travels in the same payload as one {pos, len, uid}
// entry, about 50 bytes of JSON. Reserve room for every "@" so a message near
// the limit still fits once mentions are attached.
const MENTION_RESERVE_BYTES = 60;

// Preferred places to cut a long message, best first. A cut is only taken if
// it keeps at least 60% of the window, so chunks don't end up tiny.
const CUT_MARKERS = ["\n\n", "\n", ". ", "; ", ", ", " "];
const MIN_CUT_RATIO = 0.6;

// ── Block-level patterns (whole line) ────────────────────────────────────────

const FENCE_RE = /^\s*```/;
const RULE_RE = /^\s*([-*_])\1{2,}\s*$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const BULLET_RE = /^(\s*)[-*•]\s+/;
const NUMBER_RE = /^(\s*)(\d+[.)]\s+)/;
// Indent (in spaces) from which a bullet counts as a sub-item.
const SUB_ITEM_INDENT = 2;

// ── Inline patterns (matched at the current position) ────────────────────────

const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const STRIKE_RE = /^~~([\s\S]+?)~~/;
// The text inside emphasis may not start or end with a space, so "a ** b **"
// and "2 * 3 * 4" stay as typed.
const BOLD_ITALIC_RE = /^(\*\*\*|___)(?!\s)([^\n]+?)(?<!\s)\1(?![*_])/;
const BOLD_RE = /^(\*\*|__)(?!\s)([\s\S]+?)(?<!\s)\1/;
const CODE_RE = /^`([^`\n]+)`/;
// Italic may contain nested **bold** / __bold__, and its closing marker must
// not be the start of a "**", so "*a **b** c*" is not cut at the bold's "*".
const ITALIC_RE = /^([*_])(?!\s)((?:\*\*[^*\n]+?\*\*|__[^_\n]+?__|[^*_\n])+?)\1(?!\1)/;
// Characters that may precede an opening marker (start of a word).
const WORD_START_RE = /[\s(["'—–-]/;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/**
 * Convert Markdown to a single Zalo message.
 *
 * @param {string} input Markdown text
 * @returns {{ msg: string, styles: Array<{ start: number, len: number, st: string }> }}
 */
export function formatZaloMarkdown(input) {
  if (!input) return { msg: "", styles: [] };

  const source = String(input).replace(
    COLOR_ALIAS_RE,
    (_, slash, name) => `[${slash}${COLOR_ALIASES[name.toLowerCase()]}]`,
  );

  const outLines = [];
  const styles = [];
  let offset = 0; // position of the current line in the output text
  let inCodeBlock = false;
  let prevBlank = false;

  for (const rawLine of source.split(/\r?\n/)) {
    // Fences are dropped; lines between them are kept exactly as written.
    if (FENCE_RE.test(rawLine)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      outLines.push(rawLine);
      offset += rawLine.length + 1;
      prevBlank = false;
      continue;
    }

    // Zalo has no horizontal rule, so drop it. prevBlank is left alone: the
    // rule disappears, so blank lines around it should merge into one.
    if (RULE_RE.test(rawLine)) continue;

    // Collapse runs of blank lines; on Zalo they show as a large empty gap.
    const isBlank = rawLine.trim() === "";
    if (isBlank && prevBlank) continue;
    prevBlank = isBlank;

    const block = parseBlock(rawLine);
    const { text, styles: inline } = renderInline(block.line, offset);

    styles.push(...inline);
    if (text.length) {
      for (const st of block.lineStyles) styles.push({ start: offset, len: text.length, st });
    }
    if (block.number) {
      const start = offset + block.number.start;
      styles.push({ start, len: block.number.len, st: BOLD }, { start, len: block.number.len, st: BIG });
    }

    outLines.push(text);
    offset += text.length + 1; // + the newline
  }

  return { msg: outLines.join("\n"), styles };
}

/**
 * Convert Markdown and split the result into messages that each fit Zalo's
 * limits (characters, style count and payload size). Styles are never dropped:
 * a style that crosses a cut is clipped onto both sides.
 *
 * @param {string} input Markdown text
 * @returns {Array<{ msg: string, styles: Array<{ start: number, len: number, st: string }> }>}
 *   Empty when the input has no visible text.
 */
export function formatAndChunkZaloMarkdown(input) {
  if (!input) return [];

  const formatted = formatZaloMarkdown(String(input).trim());
  if (!formatted.msg.trim()) return [];
  if (fitsZaloLimits(formatted)) return [formatted];

  const chunks = [];
  for (let start = 0; start < formatted.msg.length; ) {
    const end = findChunkEnd(formatted, start);
    chunks.push(sliceMessage(formatted, start, end));
    start = end;
  }
  return chunks.filter((chunk) => chunk.msg.trim());
}

// ── Block parsing ────────────────────────────────────────────────────────────

/**
 * Strip a line's block markup and report the styles it implies.
 * `number` is the position of a leading "1. " in the returned line, if any.
 */
function parseBlock(line) {
  let lineStyles = [];
  const heading = line.match(HEADING_RE);
  const quote = heading ? null : line.match(QUOTE_RE);
  if (heading) {
    line = heading[1];
    lineStyles = [BOLD, BIG];
  } else if (quote) {
    line = quote[1];
    lineStyles = [ITALIC];
  }

  line = line.replace(BULLET_RE, (_, indent) =>
    indent.length >= SUB_ITEM_INDENT ? `${indent}• ` : `${indent}- `,
  );

  // A heading is already bold + large as a whole; don't style its number twice.
  const num = heading ? null : line.match(NUMBER_RE);
  const number = num ? { start: num[1].length, len: num[2].length } : null;
  return { line, lineStyles, number };
}

// ── Inline rendering ─────────────────────────────────────────────────────────

/**
 * Render the inline markup of one line. `base` is the line's position in the
 * output text, so the returned style ranges are absolute.
 */
function renderInline(line, base) {
  const styles = [];
  let out = "";
  let i = 0;

  // Render `inner` (which may hold more markup) and apply `stList` over it.
  const wrap = (inner, consumed, ...stList) => {
    const rendered = renderInline(inner, base + out.length);
    const start = base + out.length;
    out += rendered.text;
    styles.push(...rendered.styles);
    if (rendered.text.length) {
      for (const st of stList) styles.push({ start, len: rendered.text.length, st });
    }
    i += consumed;
  };

  while (i < line.length) {
    const rest = line.slice(i);
    let m;

    // Color alone, without bold: stacking two styles on the same text doubles
    // its share of the payload budget, and the color already stands out.
    if ((m = matchColorTag(rest))) {
      wrap(m.inner, m.consumed, COLORS[m.name]);
      continue;
    }

    if ((m = rest.match(LINK_RE))) {
      const [whole, label, url] = m;
      if (label.length) styles.push({ start: base + out.length, len: label.length, st: BOLD });
      out += `${label} (${url})`;
      i += whole.length;
      continue;
    }

    if ((m = rest.match(STRIKE_RE))) {
      wrap(m[1], m[0].length, STRIKE);
      continue;
    }

    // "__" only counts at word boundaries, so names like my__var__x stay intact.
    if ((m = rest.match(BOLD_ITALIC_RE)) && (m[1] === "***" || isUnderscoreRun(line, i, m[0].length))) {
      wrap(m[2], m[0].length, BOLD, ITALIC);
      continue;
    }

    if ((m = rest.match(BOLD_RE)) && (m[1] === "**" || isUnderscoreRun(line, i, m[0].length))) {
      wrap(m[2], m[0].length, BOLD);
      continue;
    }

    // Code content is literal: no markup inside it is rendered.
    if ((m = rest.match(CODE_RE))) {
      styles.push({ start: base + out.length, len: m[1].length, st: BOLD });
      out += m[1];
      i += m[0].length;
      continue;
    }

    // Only at the start of a word, so snake_case and a*b stay as typed.
    if ((m = rest.match(ITALIC_RE)) && isWordStart(line, i)) {
      wrap(m[2], m[0].length, ITALIC);
      continue;
    }

    out += line[i];
    i += 1;
  }

  return { text: out, styles };
}

/** Match "[color]…[/color]" (any case) at the start of `rest`. */
function matchColorTag(rest) {
  if (rest[0] !== "[") return null;
  const lower = rest.toLowerCase();
  for (const name of Object.keys(COLORS)) {
    const open = `[${name}]`;
    if (!lower.startsWith(open)) continue;
    const close = lower.indexOf(`[/${name}]`, open.length);
    if (close === -1) continue;
    return { name, inner: rest.slice(open.length, close), consumed: close + name.length + 3 };
  }
  return null;
}

/** An underscore marker spanning [i, i+len) with no letter or digit glued to either end. */
function isUnderscoreRun(line, i, len) {
  const after = line[i + len];
  return isWordStart(line, i) && (after === undefined || !WORD_CHAR_RE.test(after));
}

function isWordStart(line, i) {
  return i === 0 || WORD_START_RE.test(line[i - 1]);
}

// ── Chunking ─────────────────────────────────────────────────────────────────

function payloadBytes({ msg, styles }) {
  const mentions = (msg.match(/@/g) || []).length;
  return Buffer.byteLength(msg, "utf8") + JSON.stringify(styles).length + mentions * MENTION_RESERVE_BYTES;
}

function fitsZaloLimits(formatted) {
  return formatted.msg.length <= MAX_CHARS
    && formatted.styles.length <= MAX_STYLES
    && payloadBytes(formatted) <= MAX_PAYLOAD_BYTES;
}

/** Find where the chunk starting at `start` should end, honouring every limit. */
function findChunkEnd(formatted, start) {
  const { msg, styles } = formatted;
  let end = preferReadableCut(msg, start, Math.min(start + MAX_CHARS, msg.length));

  // Too many styles: pull the cut back to a style boundary that fits.
  while (countStylesIn(styles, start, end) > MAX_STYLES && end > start + 1) {
    end = lastFittingStyleBoundary(styles, start, end) || Math.floor((start + end) / 2);
    end = Math.max(start + 1, Math.min(end, start + MAX_CHARS));
  }

  // Too many bytes: shrink in proportion to the overshoot, still preferring a
  // readable cut. `end` strictly decreases each round, so the loop ends.
  let bytes = payloadBytes(sliceMessage(formatted, start, end));
  while (bytes > MAX_PAYLOAD_BYTES && end > start + 1) {
    const target = start + Math.floor(((end - start) * MAX_PAYLOAD_BYTES) / bytes);
    end = preferReadableCut(msg, start, Math.max(start + 1, Math.min(target, end - 1)));
    // Never split an emoji (a UTF-16 surrogate pair) in half.
    if (end > start + 1 && isHighSurrogate(msg.charCodeAt(end - 1))) end -= 1;
    bytes = payloadBytes(sliceMessage(formatted, start, end));
  }

  return end;
}

/** Move `end` back to the best cut marker in [start, end), if one is close enough. */
function preferReadableCut(msg, start, end) {
  if (end >= msg.length) return msg.length;

  const window = msg.slice(start, end);
  for (const marker of CUT_MARKERS) {
    const idx = window.lastIndexOf(marker);
    if (idx > 0 && idx >= window.length * MIN_CUT_RATIO) return start + idx + marker.length;
  }
  return end;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function countStylesIn(styles, start, end) {
  return styles.filter((s) => s.start < end && s.start + s.len > start).length;
}

/** The latest style start/end in (start, end) whose chunk holds at most MAX_STYLES styles. */
function lastFittingStyleBoundary(styles, start, end) {
  const boundaries = styles
    .flatMap((s) => [s.start, s.start + s.len])
    .filter((pos) => pos > start && pos < end)
    .sort((a, b) => b - a);
  return boundaries.find((pos) => countStylesIn(styles, start, pos) <= MAX_STYLES) || null;
}

/** Cut [start, end) out of a formatted message, clipping and re-basing its styles. */
function sliceMessage({ msg, styles }, start, end) {
  const clipped = [];
  for (const s of styles) {
    const from = Math.max(s.start, start);
    const to = Math.min(s.start + s.len, end);
    if (from < to) clipped.push({ start: from - start, len: to - from, st: s.st });
  }
  return { msg: msg.slice(start, end), styles: clipped };
}
