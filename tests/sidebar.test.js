const { test } = require("node:test");
const assert = require("node:assert");
const {
  tileInitial,
  tileColour,
  tintOverBase,
  clampWidth,
  resolveOffset,
} = require("../assets/sidebar.js");

test("tileInitial: first alphanumeric, uppercased; bullet fallback", () => {
  assert.equal(tileInitial("grafana"), "G");
  assert.equal(tileInitial("  9to5"), "9");
  assert.equal(tileInitial("—"), "•");
  assert.equal(tileInitial(""), "•");
  assert.equal(tileInitial(null), "•");
});

test("tileColour: deterministic hsl(_, 45%, 45%) from the seed", () => {
  assert.equal(tileColour("api"), tileColour("api"));
  assert.match(tileColour("api"), /^hsl\(\d+, 45%, 45%\)$/);
  // distinct seeds usually differ (not a hard guarantee, but these do)
  assert.notEqual(tileColour("api"), tileColour("web"));
});

test("tintOverBase: opaque rgb; ratio 0 = base, ratio 1 = colour", () => {
  assert.equal(tintOverBase("#ffffff", 0, [21, 25, 30]), "rgb(21,25,30)");
  assert.equal(tintOverBase("#ffffff", 1, [21, 25, 30]), "rgb(255,255,255)");
  // halfway between base #15191e and #ffffff
  assert.equal(tintOverBase("#ffffff", 0.5, [21, 25, 30]), "rgb(138,140,143)");
});

test("clampWidth: [min, min(max, fraction*window)]", () => {
  const cfg = { min: 120, max: 400, fraction: 0.4, windowWidth: 1500 };
  assert.equal(clampWidth(50, cfg), 120); // below min snaps up
  assert.equal(clampWidth(9999, cfg), 400); // above hard max snaps down
  assert.equal(clampWidth(300, { min: 120, max: 400, fraction: 0.4, windowWidth: 500 }), 200); // 40% of a narrow window
});

test("resolveOffset: cycles among ids with wraparound; null when empty", () => {
  const ids = ["a", "b", "c"];
  assert.equal(resolveOffset(ids, "a", 1), "b");
  assert.equal(resolveOffset(ids, "c", 1), "a");
  assert.equal(resolveOffset(ids, "b", -1), "a");
  assert.equal(resolveOffset(ids, "a", -1), "c");
  assert.equal(resolveOffset([], null, 1), null);
  // unknown active steps in from the end opposite the direction of travel
  assert.equal(resolveOffset(ids, "zzz", 1), "a");
  assert.equal(resolveOffset(ids, "zzz", -1), "c");
});
