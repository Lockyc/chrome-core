// Invariants over assets/sidebar.css that no fake DOM can see. `:hover` sticks when a view the host
// composites above the chrome takes the pointer, so every hover rule is gated on `.cc-away` being
// absent (see `pointerAway()` in sidebar.js); and RowControls draws its rows outside `.cc-root` too,
// so its hovers must also answer under `.cc-ctl-host`.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CSS = fs.readFileSync(path.join(__dirname, "..", "assets", "sidebar.css"), "utf8");

/** Split on `sep` at paren depth 0. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Every style rule's selectors in `css`, with the line each prelude starts on. At-rule preludes
 *  (`@media …`) are skipped; the rules nested in them are walked like any other. */
function selectors(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const out = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = src.slice(start, i);
      const text = prelude.trim();
      if (text && !text.startsWith("@")) {
        const line = src.slice(0, start + prelude.search(/\S/)).split("\n").length;
        for (const sel of splitTop(text, ",")) out.push({ sel: sel.replace(/\s+/g, " ").trim(), line });
      }
      start = i + 1;
    } else if (ch === "}" || ch === ";") {
      start = i + 1;
    }
  }
  return out;
}

const GATES = [".cc-root:not(.cc-away) ", ":is(.cc-root:not(.cc-away), .cc-ctl-host) ", ".cc-root.cc-collapsed:not(.cc-away) "];
const ROW_CONTROLS = /\.cc-(presence|confirm-[\w-]+|ctl-row)\b/;

const hovers = () => selectors(CSS).filter((s) => s.sel.includes(":hover"));

test("css: the selector walk finds the stylesheet's hover rules", () => {
  // A walk that found none would pass every check below vacuously.
  assert.ok(hovers().length >= 20, `found ${hovers().length}`);
  assert.ok(hovers().some((s) => ROW_CONTROLS.test(s.sel)));
});

test("css: every :hover rule is gated on .cc-root:not(.cc-away) (or its RowControls form)", () => {
  const bad = hovers().filter((s) => !GATES.some((g) => s.sel.startsWith(g)));
  assert.deepEqual(bad.map((s) => `${s.line}: ${s.sel}`), []);
});

test("css: every RowControls hover also answers under .cc-ctl-host", () => {
  const bad = hovers().filter((s) => ROW_CONTROLS.test(s.sel) && !s.sel.includes(".cc-ctl-host"));
  assert.deepEqual(bad.map((s) => `${s.line}: ${s.sel}`), []);
});

test("css: the selector walk splits preludes and skips at-rules and comments", () => {
  const got = selectors("/* a { } */\n@media (x) {\n  .a:hover, :is(.b, .c) .d { x: 1; }\n}\n.e { y: 2; }").map((s) => [s.line, s.sel]);
  assert.deepEqual(got, [
    [3, ".a:hover"],
    [3, ":is(.b, .c) .d"],
    [5, ".e"],
  ]);
});
