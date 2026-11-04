import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToZalo } from "../markdownToZalo.js";

const cases = [
  ["bold", "Hello **world**!", "Hello world!", [{ start: 6, len: 5, st: "b" }]],
  ["italic", "Hello *world*!", "Hello world!", [{ start: 6, len: 5, st: "i" }]],
  ["mixed", "**Bold** and *italic*", "Bold and italic", [
    { start: 0, len: 4, st: "b" },
    { start: 9, len: 6, st: "i" },
  ]],
  ["heading + bold", "# Top 5 AI\n**Claude** and **Cursor**", "Top 5 AI\nClaude and Cursor", [
    { start: 0, len: 8, st: "f_18" },
    { start: 9, len: 6, st: "b" },
    { start: 20, len: 6, st: "b" },
  ]],
  ["strike + underline", "~~strike~~ and __underline__", "strike and underline", [
    { start: 0, len: 6, st: "s" },
    { start: 11, len: 9, st: "u" },
  ]],
  ["no markdown", "plain text", "plain text", []],
  // Positions are UTF-16 indices: 🔥 is two code units, so "bold" starts at 3.
  ["emoji", "🔥 **bold** 🦞", "🔥 bold 🦞", [{ start: 3, len: 4, st: "b" }]],
  ["vietnamese", "**Lưu ý:** xong", "Lưu ý: xong", [{ start: 0, len: 6, st: "b" }]],
  ["bold+italic run", "***both***", "both", [
    { start: 0, len: 4, st: "b" },
    { start: 0, len: 4, st: "i" },
  ]],
  ["color with bold inside", "{red:**x**} y", "x y", [
    { start: 0, len: 1, st: "c_db342e" },
    { start: 0, len: 1, st: "b" },
  ]],
  ["list with emphasis", "- **A**: x\n- *B*", "- A: x\n- B", [
    { start: 2, len: 1, st: "b" },
    { start: 9, len: 1, st: "i" },
  ]],
];

for (const [name, input, text, styles] of cases) {
  test(`converts: ${name}`, () => {
    assert.deepEqual(markdownToZalo(input), { text, styles });
  });
}

// Text that must come through unchanged (regressions from the old parser).
const untouched = [
  ["bullets are not italics", "* item one\n* item two"],
  ["arithmetic is not italics", "2 * 3 * 4 = 24"],
  ["spaced markers", "a ** b ** c"],
  ["intraword underscores", "my__var__x and snake_case_name"],
  ["inline code", "Run `__init__.py` and `a**b**c`"],
  ["lone hash keeps its newline", "#\nline"],
  ["emphasis never crosses lines", "*start\nend*"],
];

for (const [name, input] of untouched) {
  test(`leaves alone: ${name}`, () => {
    assert.deepEqual(markdownToZalo(input), { text: input, styles: [] });
  });
}

test("fenced code blocks are not formatted", () => {
  const r = markdownToZalo("```\n**no**\n```\n**yes**");
  assert.equal(r.text, "```\n**no**\n```\nyes");
  assert.deepEqual(r.styles, [{ start: 15, len: 3, st: "b" }]);
});

test("empty input", () => {
  assert.deepEqual(markdownToZalo(""), { text: "", styles: [] });
  assert.deepEqual(markdownToZalo(null), { text: "", styles: [] });
});
