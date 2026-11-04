import { test } from "node:test";
import assert from "node:assert/strict";
import { formatZaloMarkdown, formatAndChunkZaloMarkdown } from "../markdownToZalo.js";

const b = (start, len) => ({ start, len, st: "b" });
const big = (start, len) => ({ start, len, st: "f_18" });
const i = (start, len) => ({ start, len, st: "i" });
const s = (start, len) => ({ start, len, st: "s" });

// ── formatZaloMarkdown: markup → { msg, styles } ─────────────────────────────

const cases = [
  ["bold **", "Hello **world**!", "Hello world!", [b(6, 5)]],
  ["bold __", "Hello __world__!", "Hello world!", [b(6, 5)]],
  ["italic *", "Hello *world*!", "Hello world!", [i(6, 5)]],
  ["italic _", "Hello _world_!", "Hello world!", [i(6, 5)]],
  ["strike", "~~cũ~~ mới", "cũ mới", [s(0, 2)]],
  ["inline code is bold", "Chạy `npm test`", "Chạy npm test", [b(5, 8)]],
  ["link keeps url, bolds label", "[Docs](https://x.vn)", "Docs (https://x.vn)", [b(0, 4)]],
  ["heading is bold + big", "# Top 5 AI\n**Claude**", "Top 5 AI\nClaude", [
    b(0, 8), big(0, 8), b(9, 6),
  ]],
  ["deep heading", "#### Phụ", "Phụ", [b(0, 3), big(0, 3)]],
  ["quote is italic", "> trích dẫn", "trích dẫn", [i(0, 9)]],
  ["numbered item: number is bold + big", "1. Một\n2) Hai", "1. Một\n2) Hai", [
    b(0, 3), big(0, 3), b(7, 3), big(7, 3),
  ]],
  ["top-level bullets become '- '", "* a\n• b\n- c", "- a\n- b\n- c", []],
  ["nested bullets become '•'", "- a\n  - b\n    * c", "- a\n  • b\n    • c", []],
  ["bold inside italic *", "*a **b** c*", "a b c", [b(2, 1), i(0, 5)]],
  ["bold inside italic _", "_a **b** c_", "a b c", [b(2, 1), i(0, 5)]],
  ["italic inside bold", "**a *b* c**", "a b c", [i(2, 1), b(0, 5)]],
  ["bold+italic run", "***both***", "both", [b(0, 4), i(0, 4)]],
  ["intraword ** still bolds", "**x**y", "xy", [b(0, 1)]],
  ["list with emphasis", "- **A**: x\n- *B*", "- A: x\n- B", [b(2, 1), i(9, 1)]],
  ["color tag", "[red]x[/red] y", "x y", [{ start: 0, len: 1, st: "c_db342e" }]],
  ["vietnamese color alias", "[xanh]ok[/xanh]", "ok", [{ start: 0, len: 2, st: "c_15a85f" }]],
  ["color tags are case-insensitive", "[ORANGE]x[/Orange]", "x", [{ start: 0, len: 1, st: "c_f27806" }]],
  ["markup inside a color tag", "[yellow]**x**[/yellow]", "x", [
    b(0, 1), { start: 0, len: 1, st: "c_f7b503" },
  ]],
  // Positions are UTF-16 indices: 🔥 is two code units, so "bold" starts at 3.
  ["emoji offsets", "🔥 **bold** 🦞", "🔥 bold 🦞", [b(3, 4)]],
  ["vietnamese", "**Lưu ý:** xong", "Lưu ý: xong", [b(0, 6)]],
  ["horizontal rule is dropped", "a\n---\nb", "a\nb", []],
  ["blank lines around a rule collapse to one", "a\n\n---\n\nb", "a\n\nb", []],
  ["consecutive blank lines collapse", "a\n\n\n\nb", "a\n\nb", []],
  ["CRLF line endings", "**a**\r\nb", "a\nb", [b(0, 1)]],
  ["no markdown", "plain text", "plain text", []],
];

for (const [name, input, msg, styles] of cases) {
  test(`converts: ${name}`, () => {
    assert.deepEqual(formatZaloMarkdown(input), { msg, styles });
  });
}

// Text that must come through unchanged.
const untouched = [
  ["arithmetic is not italics", "2 * 3 * 4 = 24"],
  ["snake_case is not italics", "snake_case_name"],
  ["spaced markers", "a ** b ** c"],
  ["intraword double underscores", "my__var__x"],
  ["lone hash is not a heading", "#\nline"],
  ["italic never crosses lines", "*start\nend*"],
];

for (const [name, input] of untouched) {
  test(`leaves alone: ${name}`, () => {
    assert.deepEqual(formatZaloMarkdown(input), { msg: input, styles: [] });
  });
}

test("fenced code: fences dropped, content kept verbatim", () => {
  const r = formatZaloMarkdown("```js\n**no**\n# no\n```\n**yes**");
  assert.equal(r.msg, "**no**\n# no\nyes");
  assert.deepEqual(r.styles, [b(12, 3)]);
});

test("empty input", () => {
  assert.deepEqual(formatZaloMarkdown(""), { msg: "", styles: [] });
  assert.deepEqual(formatZaloMarkdown(null), { msg: "", styles: [] });
});

test("every style range stays inside msg", () => {
  const r = formatZaloMarkdown("# T\n1. **a** [red]b[/red]\n> *c* `d`\n- [L](http://u) ~~e~~");
  for (const st of r.styles) {
    assert.ok(st.len > 0 && st.start >= 0 && st.start + st.len <= r.msg.length, JSON.stringify(st));
  }
});

// ── formatAndChunkZaloMarkdown: split into sendable messages ─────────────────

const MAX_STYLES = 40;
const MAX_CHARS = 2000;
const MAX_PAYLOAD_BYTES = 3000;

function assertWithinBudget(chunk) {
  assert.ok(chunk.msg.length <= MAX_CHARS, `chars ${chunk.msg.length}`);
  assert.ok(chunk.styles.length <= MAX_STYLES, `styles ${chunk.styles.length}`);
  const bytes = Buffer.byteLength(chunk.msg, "utf8") + JSON.stringify(chunk.styles).length;
  assert.ok(bytes <= MAX_PAYLOAD_BYTES, `bytes ${bytes}`);
  for (const st of chunk.styles) {
    assert.ok(st.len > 0 && st.start >= 0 && st.start + st.len <= chunk.msg.length, JSON.stringify(st));
  }
}

test("chunk: empty and whitespace-only input give no messages", () => {
  assert.deepEqual(formatAndChunkZaloMarkdown(""), []);
  assert.deepEqual(formatAndChunkZaloMarkdown(null), []);
  assert.deepEqual(formatAndChunkZaloMarkdown("  \n\n "), []);
});

test("chunk: short input is a single message equal to formatZaloMarkdown", () => {
  const md = "  # Chào\n**bạn**  ";
  assert.deepEqual(formatAndChunkZaloMarkdown(md), [formatZaloMarkdown(md.trim())]);
});

test("chunk: long plain text splits under the char limit without losing text", () => {
  const para = "Đây là một câu tiếng Việt khá dài để thử. ".repeat(20);
  const md = Array.from({ length: 12 }, () => para.trim()).join("\n\n");
  const chunks = formatAndChunkZaloMarkdown(md);
  assert.ok(chunks.length > 1);
  chunks.forEach(assertWithinBudget);
  assert.equal(chunks.map((c) => c.msg).join(""), formatZaloMarkdown(md).msg);
});

test("chunk: many styles split at 40 styles per message, none dropped", () => {
  const md = Array.from({ length: 100 }, (_, n) => `**k${n}** v`).join("\n");
  const full = formatZaloMarkdown(md);
  const chunks = formatAndChunkZaloMarkdown(md);
  assert.ok(chunks.length >= 3);
  chunks.forEach(assertWithinBudget);
  assert.equal(chunks.reduce((n, c) => n + c.styles.length, 0), full.styles.length);
});

test("chunk: emoji-heavy text stays under the byte budget and never splits a surrogate pair", () => {
  const md = "🔥🦞 nội dung có dấu ".repeat(200);
  const chunks = formatAndChunkZaloMarkdown(md);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assertWithinBudget(c);
    const last = c.msg.charCodeAt(c.msg.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "chunk ends in a high surrogate");
  }
});

test("chunk: a style crossing a cut is clipped onto both sides", () => {
  const md = `**${"x".repeat(2500)}**`;
  const chunks = formatAndChunkZaloMarkdown(md);
  assert.equal(chunks.length, 2);
  chunks.forEach(assertWithinBudget);
  for (const c of chunks) assert.deepEqual(c.styles, [b(0, c.msg.length)]);
});
