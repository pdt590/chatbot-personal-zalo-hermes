// markdownToZalo.js
// Convert Markdown inline formatting to Zalo MessageContent styles array.
//
// Supported syntax:
//   **bold**       → Bold (b)
//   *italic*       → Italic (i)
//   __underline__  → Underline (u)
//   ~~strikethru~~ → StrikeThrough (s)
//   # heading      → Big (f_18)
//   {red:text}     → Red (also orange / yellow / green)
//
// Rules follow CommonMark closely enough for chat text: a marker must touch
// the text it wraps ("* item" and "2 * 3" are not italics), spans never cross
// a line break, "__" does not apply inside a word, and anything inside `code`
// or ``` fences is left untouched.
//
// How it works:
// 1. scan() finds every span and the marker characters to strip, in one pass.
// 2. Strip the markers to produce clean text.
// 3. Map each span's content range from original positions → clean positions.
// 4. Output clean text + styles array.

const TextStyle = {
  Bold: "b",
  Italic: "i",
  Underline: "u",
  StrikeThrough: "s",
  Red: "c_db342e",
  Orange: "c_f27806",
  Yellow: "c_f7b503",
  Green: "c_15a85f",
  Big: "f_18",
  Small: "f_13",
};

// Emphasis rules, applied in this order. `intraword: false` means the marker
// may not touch a letter/digit on its outer side (so my__var__x stays as is).
const EMPHASIS_RULES = [
  { marker: "**", style: TextStyle.Bold, intraword: true },
  { marker: "__", style: TextStyle.Underline, intraword: false },
  { marker: "~~", style: TextStyle.StrikeThrough, intraword: true },
  { marker: "*", style: TextStyle.Italic, intraword: true },
];

// Color rules: {red:text} {orange:text} {yellow:text} {green:text}
const COLOR_RULES = [
  { open: "{red:", close: "}", style: TextStyle.Red },
  { open: "{orange:", close: "}", style: TextStyle.Orange },
  { open: "{yellow:", close: "}", style: TextStyle.Yellow },
  { open: "{green:", close: "}", style: TextStyle.Green },
];

const WS = /\s/;
const WORD = /[\p{L}\p{N}]/u;

/**
 * JS-style string length (surrogate pairs = 2).
 */
function jsStrLen(s) {
  let len = 0;
  for (const ch of s) {
    len += ch.charCodeAt(0) > 0xFFFF ? 2 : 1;
  }
  return len;
}

/**
 * Mark code that must be left untouched: fenced blocks (```...```) and inline
 * code spans (`...`). Returns a boolean array indexed by UTF-16 position.
 */
function protectedRanges(text) {
  const prot = new Array(text.length).fill(false);
  const mark = (s, e) => { for (let i = s; i < e; i++) prot[i] = true; };
  const fence = /```[\s\S]*?(?:```|$)/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    mark(m.index, m.index + m[0].length);
    if (m[0].length === 0) fence.lastIndex++;
  }
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text)) !== null) {
    if (!prot[m.index]) mark(m.index, m.index + m[0].length);
  }
  return prot;
}

/**
 * Single pass over the text that finds every formatting span and the marker
 * characters to strip. Markers already used by one rule cannot be reused by
 * another, so "**bold**" never also produces italics.
 *
 * Returns { spans: [{contentStart, contentEnd, style}], syntax: Set<index> }
 * with positions in the ORIGINAL text.
 */
function scan(text) {
  const prot = protectedRanges(text);
  const used = new Array(text.length).fill(false);
  const spans = [];
  const free = (s, len) => {
    for (let k = s; k < s + len; k++) if (k >= text.length || prot[k] || used[k]) return false;
    return true;
  };
  const take = (s, len) => { for (let k = s; k < s + len; k++) used[k] = true; };

  // Colors first so emphasis inside {red:**x**} still works.
  for (const rule of COLOR_RULES) {
    let i = 0;
    while ((i = text.indexOf(rule.open, i)) !== -1) {
      const cs = i + rule.open.length;
      let j = cs;
      while (j < text.length && text[j] !== "\n" && !(text.startsWith(rule.close, j) && free(j, rule.close.length))) j++;
      if (j < text.length && j > cs && text.startsWith(rule.close, j) && free(i, rule.open.length)) {
        take(i, rule.open.length);
        take(j, rule.close.length);
        spans.push({ contentStart: cs, contentEnd: j, style: rule.style });
        i = j + rule.close.length;
      } else {
        i++;
      }
    }
  }

  for (const rule of EMPHASIS_RULES) {
    const mk = rule.marker;
    const ml = mk.length;
    const canOpen = (i) => {
      if (!text.startsWith(mk, i) || !free(i, ml)) return false;
      const after = text[i + ml];
      if (after === undefined || WS.test(after)) return false;
      // A lone "*" next to an unused "*" is part of a longer run, not italics.
      if (ml === 1 && ((text[i - 1] === mk && !used[i - 1]) || (after === mk && !used[i + 1]))) return false;
      if (!rule.intraword && i > 0 && WORD.test(text[i - 1])) return false;
      return true;
    };
    const canClose = (j) => {
      if (!text.startsWith(mk, j) || !free(j, ml)) return false;
      const before = text[j - 1];
      if (before === undefined || WS.test(before)) return false;
      if (ml === 1 && text[j + 1] === mk && !used[j + 1]) return false;
      if (!rule.intraword && j + ml < text.length && WORD.test(text[j + ml])) return false;
      return true;
    };

    let i = 0;
    while (i < text.length) {
      if (!canOpen(i)) { i++; continue; }
      let j = i + ml + 1; // content must be non-empty
      let closeAt = -1;
      for (; j < text.length && text[j] !== "\n"; j++) {
        if (canClose(j)) { closeAt = j; break; }
      }
      if (closeAt === -1) { i++; continue; }
      take(i, ml);
      take(closeAt, ml);
      spans.push({ contentStart: i + ml, contentEnd: closeAt, style: rule.style });
      i = closeAt + ml;
    }
  }

  // Heading: one to six # followed by a space/tab at the start of a line.
  const hdRe = /(^|\n)(#{1,6}[ \t]+)/g;
  let m;
  while ((m = hdRe.exec(text)) !== null) {
    const ms = m.index + m[1].length;
    const cs = ms + m[2].length;
    if (!free(ms, m[2].length)) continue;
    const nl = text.indexOf("\n", cs);
    const ce = nl === -1 ? text.length : nl;
    take(ms, m[2].length);
    if (ce > cs) spans.push({ contentStart: cs, contentEnd: ce, style: TextStyle.Big });
  }

  const syntax = new Set();
  used.forEach((u, idx) => { if (u) syntax.add(idx); });
  spans.sort((a, b) => a.contentStart - b.contentStart);
  return { spans, syntax };
}

/**
 * Map a range from original text positions to clean text positions.
 * Range: [start, end) in original text (inclusive start, exclusive end).
 * Returns { start, len } in clean text, or null if nothing survives.
 */
function mapRangeToClean(start, end, originalToClean) {
  let cs = -1;
  let ce = -1;
  for (let i = start; i < end; i++) {
    if (originalToClean.has(i)) {
      const c = originalToClean.get(i);
      if (cs === -1) cs = c;
      ce = c + 1;
    }
  }
  if (cs === -1) return null;
  return { start: cs, len: ce - cs };
}

/**
 * Parse markdown text, return clean text + styles array for Zalo.
 * Positions are UTF-16 code-unit indices (JavaScript string indices).
 *
 * @param {string} md - Markdown text with inline formatting
 * @returns {{ text: string, styles: Array<{start:number, len:number, st:string}> }}
 */
function markdownToZalo(md) {
  if (!md) return { text: "", styles: [] };

  const { spans, syntax } = scan(md);

  // Build clean text and the original→clean position map.
  const cleanChars = [];
  const originalToClean = new Map();
  for (let i = 0; i < md.length; i++) {
    if (!syntax.has(i)) {
      originalToClean.set(i, cleanChars.length);
      cleanChars.push(md[i]);
    }
  }
  const cleanText = cleanChars.join("");

  const styleEntries = [];
  for (const sp of spans) {
    const mapped = mapRangeToClean(sp.contentStart, sp.contentEnd, originalToClean);
    if (mapped && mapped.len > 0) {
      styleEntries.push({ start: mapped.start, len: mapped.len, st: sp.style });
    }
  }

  // Merge adjacent same-style entries.
  styleEntries.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const e of styleEntries) {
    const last = merged[merged.length - 1];
    if (last && last.st === e.st && last.start + last.len === e.start) {
      last.len += e.len;
    } else {
      merged.push({ ...e });
    }
  }

  return { text: cleanText, styles: merged };
}

/**
 * Simple stripper (used as fallback).
 */
function stripMarkdown(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|\n)#\s/g, "$1");
}

export { markdownToZalo, TextStyle, jsStrLen, stripMarkdown };
