const { test } = require("node:test");
const assert = require("node:assert");
const {
  Sidebar,
  tileInitial,
  tileColour,
  tintOverBase,
  liftColour,
  clampWidth,
  resolveOffset,
  presenceClass,
  canSuspend,
  canEnd,
  armable,
  endIntent,
  derivePresenceState,
  buildTree,
  patchTab,
  openTabs,
  backgroundTabs,
  mirrorContext,
  folderChain,
  listSections,
  navOrder,
  navAnchor,
  filterTabs,
  treeRows,
  rescanSummary,
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

test("liftColour: floors lightness, preserves hue, leaves bright colours alone", () => {
  const hsl = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    let h = 0;
    if (mx !== mn) {
      const d = mx - mn;
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h / 6) * 360;
    }
    return { h, l: (mx + mn) / 2 };
  };
  // A near-black navy is the case the whole helper exists for: it must come back at the floor,
  // still the same hue. Untouched, it is far too dark to tint a visible highlight out of.
  const navy = liftColour("#002b49", 0.42);
  assert.ok(Math.abs(hsl(navy).l - 0.42) < 0.01, `lightness floored, got ${hsl(navy).l}`);
  assert.ok(Math.abs(hsl(navy).h - hsl("#002b49").h) < 1, "hue preserved");
  // Already at or above the floor → returned verbatim (no round-trip drift through HSL).
  assert.equal(liftColour("#6b7280", 0.42), "#6b7280");
  assert.equal(liftColour("#ffffff", 0.42), "#ffffff");
  // Achromatic input stays achromatic — saturation is never raised (keeps the neutral fallback grey).
  const grey = liftColour("#000000", 0.5);
  assert.equal(grey.slice(1, 3), grey.slice(3, 5));
  assert.equal(grey.slice(3, 5), grey.slice(5, 7));
});

test("clampWidth: [min, min(max, fraction*window)]", () => {
  const cfg = { min: 120, max: 400, fraction: 0.4, windowWidth: 1500 };
  assert.equal(clampWidth(50, cfg), 120); // below min snaps up
  assert.equal(clampWidth(9999, cfg), 400); // above hard max snaps down
  assert.equal(clampWidth(300, { min: 120, max: 400, fraction: 0.4, windowWidth: 500 }), 200); // 40% of a narrow window
  // Falsy fraction skips the window-share cap (isolated-sidebar-webview consumers clamp backend-side):
  // windowWidth is ignored, so a drag isn't pinned to the floor by a tiny sidebar-view innerWidth.
  const isolated = { min: 160, max: 520, fraction: 0, windowWidth: 240 };
  assert.equal(clampWidth(300, isolated), 300); // honoured, not collapsed to min
  assert.equal(clampWidth(9999, isolated), 520); // still bounded by hard max
  assert.equal(clampWidth(50, isolated), 160); // still bounded by min
});

test("presenceClass: kill affordance when on + an ending action, start when off+startable+live", () => {
  const P = (state, caps, live) => presenceClass(state, caps, live);
  // session present → base on; kill when either ending action can run
  assert.equal(P("on", {}, true), "cc-presence on");
  assert.equal(P("on", { killable: true }, true), "cc-presence on kill");
  assert.equal(P("on", { suspendable: true }, true), "cc-presence on kill");
  // startable is irrelevant while on
  assert.equal(P("on", { startable: true }, true), "cc-presence on");
  // session absent → base off; start only when startable AND live (a shell to re-run cmd in)
  assert.equal(P("off", {}, true), "cc-presence off");
  assert.equal(P("off", { startable: true }, true), "cc-presence off start");
  assert.equal(P("off", { startable: true }, false), "cc-presence off"); // cold: no start
  assert.equal(P("off", { killable: true }, true), "cc-presence off"); // nothing to end while off
  assert.equal(P("off", { killable: true, startable: true }, true), "cc-presence off start");
});

test("armable: either ending action gives the row its confirm controls", () => {
  assert.equal(armable({ killable: true }), true);
  assert.equal(armable({ suspendable: true }), true);
  assert.equal(armable({ killable: true, suspendable: true }), true);
  assert.equal(armable({ killable: false, suspendable: false }), false);
  assert.equal(armable({}), false); // curator/lector send neither
});

test("canSuspend / canEnd: a ghost has nothing running to suspend, but ☠ discards it", () => {
  assert.equal(canSuspend({ suspendable: true, presence: "on" }), true);
  assert.equal(canSuspend({ suspendable: true, presence: "ghost" }), false);
  assert.equal(canEnd({ suspendable: true, presence: "ghost" }), false);
  assert.equal(canEnd({ killable: true, presence: "ghost" }), true);
  assert.equal(canEnd({ suspendable: true, presence: "on" }), true);
});

test("endIntent: suspend fires at once; destroy arms, then fires only on the armed row", () => {
  const both = { id: "a", killable: true, suspendable: true };
  assert.equal(endIntent(both, "suspend", null), "suspend");
  assert.equal(endIntent(both, "suspend", "a"), "suspend");
  assert.equal(endIntent(both, "destroy", null), "arm");
  assert.equal(endIntent(both, "destroy", "b"), "arm"); // another row armed → arm this one instead
  assert.equal(endIntent(both, "destroy", "a"), "destroy");
});

test("endIntent: an action the tab lacks arms the row to show why; neither → nothing", () => {
  assert.equal(endIntent({ id: "a", killable: true }, "suspend", null), "arm");
  assert.equal(endIntent({ id: "a", suspendable: true }, "destroy", null), "arm");
  assert.equal(endIntent({ id: "a", suspendable: true }, "destroy", "a"), null); // ☠ disabled
  assert.equal(endIntent({ id: "a" }, "suspend", null), null);
  assert.equal(endIntent({ id: "a" }, "destroy", null), null);
  assert.equal(endIntent(undefined, "destroy", null), null); // unknown id
});

test("endIntent: a ghost — ⏻ arms to show why it can't, ☠ discards on the second request", () => {
  const ghost = { id: "a", killable: true, suspendable: true, presence: "ghost" };
  assert.equal(endIntent(ghost, "suspend", null), "arm");
  assert.equal(endIntent(ghost, "destroy", null), "arm");
  assert.equal(endIntent(ghost, "destroy", "a"), "destroy");
  assert.equal(endIntent({ id: "a", suspendable: true, presence: "ghost" }, "destroy", null), null);
});

test("presenceClass: ghost is the third state — start when live, else ☠ to discard", () => {
  const P = (caps, live) => presenceClass("ghost", caps, live);
  // Cold: no live shell to type into, so a killable ghost's click arms ☠ (discard the offer).
  assert.equal(P({ killable: true }, false), "cc-presence ghost kill");
  assert.equal(P({ killable: true, startable: true }, false), "cc-presence ghost kill");
  // Live + startable: the click starts — typing `cmd` lets amux's picker offer the restore.
  assert.equal(P({ startable: true }, true), "cc-presence ghost start");
  assert.equal(P({ killable: true, startable: true }, true), "cc-presence ghost start");
  // Suspend alone can't end a ghost — nothing running.
  assert.equal(P({ suspendable: true }, false), "cc-presence ghost");
  assert.equal(P({ startable: true }, false), "cc-presence ghost");
});

test("derivePresenceState: reads state back from a dot's class list — regression guard for the " +
  "ghost-preservation repaint fix (a `contains(\"on\") ? \"on\" : \"off\"` derivation would " +
  "collapse a ghost dot to `off` on every load/unload repaint)", () => {
  assert.equal(derivePresenceState(["cc-presence", "on", "kill"]), "on");
  assert.equal(derivePresenceState(["cc-presence", "ghost", "start"]), "ghost");
  assert.equal(derivePresenceState(["cc-presence", "off"]), "off");
  assert.equal(derivePresenceState(["cc-presence", "off", "start"]), "off");
  // on and ghost never co-occur in practice, but on must win if they did (matches presenceClass's
  // own precedence — `on` is checked before `ghost`).
  assert.equal(derivePresenceState(["cc-presence", "on", "ghost"]), "on");
});

test("buildTree compresses single-child chains", () => {
  const rows = [
    { id: "/d/gh/lockyc/warden", treePath: ["gh", "lockyc"] },
    { id: "/d/gh/lockyc/curator", treePath: ["gh", "lockyc"] },
    { id: "/d/solo", treePath: [] },
  ];
  const tree = buildTree(rows);
  // top level: one compressed folder "gh/lockyc" (single-child chain) + one loose leaf
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].label, "gh/lockyc");
  assert.equal(tree.folders[0].rows.length, 2);
  assert.equal(tree.rows.length, 1);
  assert.equal(tree.rows[0].id, "/d/solo");
});

test("buildTree keeps sibling branches uncompressed", () => {
  const rows = [
    { id: "/d/gh/lockyc/warden", treePath: ["gh", "lockyc"] },
    { id: "/d/gh/other/thing", treePath: ["gh", "other"] },
    { id: "/d/loose", treePath: [] }, // a root-level row stops "gh" itself from being absorbed
  ];
  const tree = buildTree(rows);
  // "gh" has two children (lockyc, other) → not compressed away, stays its own folder
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].label, "gh");
  assert.equal(tree.folders[0].folders.length, 2);
  const labels = tree.folders[0].folders.map((f) => f.label).sort();
  assert.deepEqual(labels, ["lockyc", "other"]);
  assert.equal(tree.folders[0].rows.length, 0);
  assert.equal(tree.rows.length, 1);
  assert.equal(tree.rows[0].id, "/d/loose");
});

test("buildTree: a loose row with an empty treePath sits at the top level", () => {
  const rows = [{ id: "/d/solo-a", treePath: [] }, { id: "/d/solo-b", treePath: [] }];
  const tree = buildTree(rows);
  assert.equal(tree.folders.length, 0);
  assert.equal(tree.rows.length, 2);
  assert.deepEqual(tree.rows.map((r) => r.id), ["/d/solo-a", "/d/solo-b"]);
});

test("buildTree: no rows → empty folders and rows", () => {
  const tree = buildTree([]);
  assert.equal(tree.folders.length, 0);
  assert.equal(tree.rows.length, 0);
});

test("buildTree: a single branch from the root is not absorbed away", () => {
  // Every row shares the same treePath and there are no loose root rows — the
  // root itself must not be compressed, or the top-level folder's label is lost.
  const rows = [
    { id: "warden", treePath: ["github.com", "lockyc"] },
    { id: "curator", treePath: ["github.com", "lockyc"] },
  ];
  const tree = buildTree(rows);
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].label, "github.com/lockyc");
  assert.equal(tree.folders[0].rows.length, 2);
  assert.equal(tree.rows.length, 0);
});

test("buildTree: a single top-level folder with one segment is kept as a folder", () => {
  const rows = [{ id: "only", treePath: ["a"] }];
  const tree = buildTree(rows);
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].label, "a");
  assert.equal(tree.folders[0].rows.length, 1);
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

test("patchTab: a targeted setter's signal lands on the stored tab, so a re-render keeps it", () => {
  const tabs = [
    { id: "/d/a", presence: "off", attention: null, live: false },
    { id: "/d/b", presence: "off", attention: null, live: false },
  ];
  assert.equal(patchTab(tabs, "/d/a", { presence: "on" }), true);
  assert.equal(tabs[0].presence, "on");
  assert.equal(tabs[1].presence, "off", "siblings are untouched");
  // A tree section repaints itself from these records on every folder toggle, so the record —
  // not the painted DOM — is what survives. Clearing writes null rather than deleting the key.
  assert.equal(patchTab(tabs, "/d/a", { presence: null }), true);
  assert.equal(tabs[0].presence, null);
  assert.equal(patchTab(tabs, "/d/b", { attention: 3, live: true }), true);
  assert.equal(tabs[1].attention, 3);
  assert.equal(tabs[1].live, true);
});

test("patchTab: unknown id or missing list is a no-op, not a throw", () => {
  const tabs = [{ id: "/d/a", presence: "off" }];
  assert.equal(patchTab(tabs, "/d/nope", { presence: "on" }), false);
  assert.equal(tabs[0].presence, "off");
  assert.equal(patchTab(undefined, "/d/a", { presence: "on" }), false);
});

test("openTabs: membership is `live || detached`, in the DTO's own order", () => {
  const tabs = [
    { id: "/a", live: false },
    { id: "/b", live: true },
    // Detached counts: the tab IS open, just in its own popped-out window. `live` reports only a
    // LOCAL surface, so a detached tab is routinely `live: false`.
    { id: "/c", live: false, detached: true },
    { id: "/d", live: true, detached: true },
    // `presence` is a session probe, not openness — a cold tab with a live amux session is NOT open.
    { id: "/e", live: false, presence: "on" },
  ];
  assert.deepEqual(openTabs(tabs).map((t) => t.id), ["/b", "/c", "/d"]);
});

test("openTabs: empty or missing list is an empty section, not a throw", () => {
  assert.deepEqual(openTabs([]), []);
  assert.deepEqual(openTabs(undefined), []);
  assert.deepEqual(openTabs([{ id: "/a" }, { id: "/b", live: false }]), []);
});

test("mirrorContext: tree row → parent folder; grouped → group; loose → null", () => {
  // treePath excludes the project's own dir, so its last segment is the parent folder.
  assert.equal(mirrorContext({ tree: true, group: "Developer", treePath: ["github.com", "acme"] }), "acme");
  // A project directly under a root has no folders — the root's name is where it lives.
  assert.equal(mirrorContext({ tree: true, group: "Developer", treePath: [] }), "Developer");
  // A curated group: same-titled tabs in different groups come apart.
  assert.equal(mirrorContext({ tree: false, group: "backend", treePath: [] }), "backend");
  // treePath is only meaningful on a tree row.
  assert.equal(mirrorContext({ tree: false, group: "tools", treePath: ["x"] }), "tools");
  assert.equal(mirrorContext({ tree: false, group: null }), null);
  assert.equal(mirrorContext({ group: "" }), null);
});

test("folderChain: compressed folder labels down to a tab's folder", () => {
  const rows = [
    { id: "top", treePath: [] },
    { id: "deep", treePath: ["gh", "lockyc"] },
    { id: "a", treePath: ["gl", "x"] },
    { id: "b", treePath: ["gl", "y"] },
  ];
  assert.deepEqual(folderChain(rows, "top"), []);
  assert.deepEqual(folderChain(rows, "deep"), ["gh/lockyc"]); // single-child chain compressed
  assert.deepEqual(folderChain(rows, "b"), ["gl", "y"]);
  assert.equal(folderChain(rows, "missing"), null);
});

test("listSections: flat runs split on group change or a tree row; a tree run takes its whole group", () => {
  const tabs = [
    { id: "loose" },
    { id: "loose-tree", tree: true }, // ungrouped: never a tree section
    { id: "a1", group: "A" },
    { id: "a2", group: "A" },
    { id: "d1", group: "Dev", tree: true, treePath: [] },
    { id: "d2", group: "Dev" }, // non-tree row inside a tree run stays in it
    { id: "b1", group: "B" },
    { id: "b2", group: "B", tree: true },
    { id: "a3", group: "A" },
  ];
  const shape = listSections(tabs).map((s) => [s.group, s.tree, s.rows.map((r) => r.id)]);
  assert.deepEqual(shape, [
    [null, false, ["loose", "loose-tree"]],
    ["A", false, ["a1", "a2"]],
    ["Dev", true, ["d1", "d2"]],
    ["B", false, ["b1"]],
    ["B", true, ["b2"]],
    ["A", false, ["a3"]],
  ]);
  assert.deepEqual(listSections([]), []);
});

test("listSections: a declared tree with no rows still gets its empty section, after the rest", () => {
  const tabs = [{ id: "d1", group: "Dev", tree: true }];
  const shape = listSections(tabs, ["Dev", "Empty"]).map((s) => [s.group, s.tree, s.rows.length]);
  assert.deepEqual(shape, [["Dev", true, 1], ["Empty", true, 0]]);
});

test("navOrder walks the main list's paint order with every tree folder expanded", () => {
  const tabs = [
    { id: "loose" },
    { id: "a1", group: "A" },
    { id: "deep", group: "Dev", tree: true, treePath: ["gh", "lockyc"] },
    { id: "top", group: "Dev", tree: true, treePath: [] },
    { id: "other", group: "Dev", tree: true, treePath: ["gl"] },
    { id: "b1", group: "B" },
  ];
  // a tree section paints a node's rows before its folders, folders in first-seen order
  assert.deepEqual(navOrder(tabs), ["loose", "a1", "top", "deep", "other", "b1"]);
  assert.deepEqual(navOrder([]), []);
});

test("filterTabs: empty query keeps every tab, same array", () => {
  const tabs = [{ id: "a", title: "api" }];
  assert.equal(filterTabs(tabs, ""), tabs);
  assert.equal(filterTabs(tabs, "   "), tabs);
  assert.equal(filterTabs(tabs, null), tabs);
});

test("filterTabs: case-insensitive over title, tree path and group; every term must match", () => {
  const tabs = [
    { id: "web", title: "website", group: "Dev", tree: true, treePath: ["rotary"] },
    { id: "api", title: "API", group: "Backend" },
    { id: "loose", title: "notes" },
    // treePath is only meaningful on a tree row
    { id: "flat", title: "flat", group: "tools", treePath: ["rotary"] },
  ];
  const ids = (q) => filterTabs(tabs, q).map((t) => t.id);
  assert.deepEqual(ids("api"), ["api"]);
  assert.deepEqual(ids("ROTARY"), ["web"]);
  assert.deepEqual(ids("backend"), ["api"]);
  assert.deepEqual(ids("rot web"), ["web"]);
  assert.deepEqual(ids("rot api"), []);
  assert.deepEqual(ids("zzz"), []);
});

// `update()` against a stub instance: no DOM, just the fields `update` touches, with `_paintList`
// recording which tab it painted as active.
function stubSidebar(active) {
  globalThis.document = { documentElement: { setAttribute() {} } };
  const style = { setProperty() {} };
  const sb = Object.create(Sidebar.prototype);
  Object.assign(sb, {
    active,
    cb: {},
    nameEl: {},
    banner: { style: {} },
    root: { style },
    titlebarEl: null,
    painted: [],
    _rescans: new Map(),
    _disarmKill() {},
    _setDrag() {},
    _paintList() {
      this.painted.push(this.active);
    },
    _paint() {},
  });
  return sb;
}

test("update: the list paints with the DTO's active, not the outgoing one", () => {
  // The app unloaded the active tab `a` and promoted `b`. Painting with `a` still active would
  // re-light `a`'s dot (the active row is always painted live) though the DTO says it's cold.
  const sb = stubSidebar("a");
  sb.update({ active: "b", tabs: [{ id: "a", live: false }, { id: "b", live: true }] });
  assert.deepEqual(sb.painted, ["b"]);
});

test("update: component-owned selection falls back before painting, then fires onSelect", () => {
  const sb = stubSidebar("gone");
  const selected = [];
  sb.cb.onSelect = (id) => selected.push(id);
  sb.update({ tabs: [{ id: "x", live: false }] });
  assert.deepEqual(sb.painted, ["x"]);
  assert.deepEqual(selected, ["x"]);
});

test("treeRows: one group's tree rows, id → title", () => {
  const tabs = [
    { id: "a", title: "A", group: "dev", tree: true },
    { id: "b", title: "B", group: "dev" },
    { id: "c", title: "C", group: "other", tree: true },
  ];
  assert.deepEqual([...treeRows(tabs, "dev")], [["a", "A"]]);
});

test("rescanSummary: counts and names what a rescan added and removed", () => {
  const before = new Map([["a", "A"], ["b", "B"]]);
  assert.deepEqual(rescanSummary(before, new Map(before)), { text: "No changes", tip: "" });
  assert.deepEqual(rescanSummary(before, new Map([["a", "A"], ["c", "C"], ["d", "D"]])), {
    text: "+2 −1",
    tip: "Added: C, D\nRemoved: B",
  });
  assert.deepEqual(rescanSummary(before, new Map([["a", "A"], ["b", "B"], ["c", "C"]])), {
    text: "+1",
    tip: "Added: C",
  });
});

test("update: keeps the main list's scroll position across a repaint", () => {
  const sb = stubSidebar("a");
  sb.mainEl = { scrollTop: 420 };
  sb.openEl = { scrollTop: 30 };
  sb._paintList = function () {
    this.mainEl = { scrollTop: 0 };
    this.openEl = { scrollTop: 0 };
  };
  sb.update({ tabs: [{ id: "a", live: true }] });
  assert.equal(sb.mainEl.scrollTop, 420);
  assert.equal(sb.openEl.scrollTop, 30);
});

// ── headed, collapsible groups + row context menu (opt-in: `head`/`collapsed`/`groupName`,
// `onToggleGroup`/`onContextMenu`). These mount the real component on the fake DOM in ./dom.js.

const { installDom, installStorage, fire, serialize } = require("./dom.js");

const row = (id, title, group, extra = {}) => ({
  id, title, group, live: false, attention: null, presence: null,
  killable: false, suspendable: false, startable: false, warn: false, ...extra,
});

// flotilla's shape: the group's id is its head tab's id, and `groupName` carries the head's title.
const fleet = () => [
  row("loose", "scratch", null),
  row("h1", "Fleet", "h1", { head: true, groupName: "Fleet" }),
  row("m1", "alpha", "h1", { groupName: "Fleet" }),
  row("m2", "beta", "h1", { groupName: "Fleet" }),
  row("other", "solo", null),
];

function mountFleet(cb = {}, dto = {}) {
  const root = installDom();
  const sb = new Sidebar(root, cb, {});
  sb.update({ title: "w", colour: null, density: "comfortable", active: "loose", tabs: fleet(), ...dto });
  return sb;
}
const mainIds = (sb) => sb.mainEl.querySelectorAll(".cc-tab").map((r) => r.dataset.id);
const rowOf = (sb, id) => sb.mainEl.querySelector('.cc-tab[data-id="' + id + '"]');

test("head_row_replaces_group_header", () => {
  const selected = [];
  const sb = mountFleet({ onSelect: (id) => selected.push(id), onToggleGroup() {} });
  installStorage(); // the Open section reads its persisted collapse state
  sb.update({ title: "w", active: "loose", openSection: true, tabs: fleet().map((t) => (t.id === "h1" ? { ...t, live: true } : t)) });
  // No text header for the headed group — the head row stands in its place, a full tab row.
  assert.equal(sb.mainEl.querySelectorAll(".cc-group").length, 0);
  assert.deepEqual(mainIds(sb), ["loose", "h1", "m1", "m2", "other"]);
  const head = rowOf(sb, "h1");
  assert.ok(head.classList.contains("cc-head"));
  assert.ok(head.querySelector(".cc-disclosure"), "a head with members leads with its disclosure arrow");
  assert.ok(head.querySelector(".cc-icon") && head.querySelector(".cc-dot"), "tile and dots like any row");
  assert.ok(rowOf(sb, "m1").classList.contains("cc-member"));
  // Clicking the row (not the arrow) selects the head tab, like any other row.
  fire(head.querySelector(".cc-title"), "click");
  assert.deepEqual(selected, ["h1"]);
  // Its mirror in the pinned "Open" section is a plain row: no arrow, and no context naming itself.
  const mirror = sb.openEl.querySelector('.cc-tab[data-id="h1"]');
  assert.ok(mirror && !mirror.querySelector(".cc-disclosure") && !mirror.querySelector(".cc-context"));
});

test("open_section_nests_open_members_under_their_head", () => {
  const toggled = [];
  const sb = mountFleet({ onToggleGroup: (g, c) => toggled.push([g, c]) });
  installStorage();
  // m2 is open but its head is not: the head still leads, so only heads and loose rows sit at the root.
  const live = (ids) => fleet().map((t) => (ids.includes(t.id) ? { ...t, live: true } : t));
  sb.update({ title: "w", active: "loose", openSection: true, tabs: live(["m2", "other"]) });
  const mirrors = () => sb.openEl.querySelectorAll(".cc-tab[data-mirror]");
  assert.deepEqual(mirrors().map((r) => r.dataset.id), ["h1", "m2", "other"]);
  const [head, member] = mirrors();
  assert.ok(head.classList.contains("cc-head") && head.querySelector(".cc-disclosure"));
  assert.ok(member.classList.contains("cc-member"));
  assert.ok(!member.querySelector(".cc-context"), "nested under its head, it needs no group label");
  fire(head.querySelector(".cc-disclosure"), "click");
  assert.deepEqual(toggled, [["h1", true]], "the mirror head toggles the same group state");
  // The app's `collapsed` hides the members in the section as it does in the main list.
  sb.update({ title: "w", active: "loose", openSection: true, collapsed: ["h1"], tabs: live(["m2", "other"]) });
  assert.deepEqual(mirrors().map((r) => r.dataset.id), ["h1", "other"]);
});

test("icon_replaces_the_letter_tile", () => {
  const sb = mountFleet({ onPopOut() {} }, { tabs: [row("a", "Budget", null, { icon: "icons/sheet.svg" }), row("b", "Notes", null)] });
  const tile = rowOf(sb, "a").querySelector(".cc-icon");
  assert.ok(tile.classList.contains("cc-icon-image"));
  assert.equal(tile.querySelector("img").getAttribute("src"), "icons/sheet.svg");
  assert.equal(tile.textContent, "", "no initial behind the image");
  assert.ok(tile.querySelector(".cc-icon-pop"), "the pop-out overlay still sits on the tile");
  // A row without `icon` keeps the initial-and-colour tile.
  const plain = rowOf(sb, "b").querySelector(".cc-icon");
  assert.ok(!plain.classList.contains("cc-icon-image") && !plain.querySelector("img"));
  assert.equal(plain.textContent, "N");
});

test("remove_button_only_with_onRemove_and_fires_without_selecting", () => {
  assert.equal(rowOf(mountFleet(), "m1").querySelector(".cc-remove"), null, "absent without onRemove");
  const removed = [], selected = [];
  const sb = mountFleet({ onRemove: (id) => removed.push(id), onSelect: (id) => selected.push(id) });
  const rm = rowOf(sb, "m1").querySelector(".cc-remove");
  assert.ok(rm, "every row carries the button, cold ones included");
  const kids = rowOf(sb, "m1").children;
  assert.ok(kids[kids.length - 1].classList.contains("cc-dot"), "unload stays rightmost");
  assert.ok(kids[kids.length - 2] === rm, "the bin sits just left of it");
  fire(rm, "click");
  assert.deepEqual(removed, ["m1"]);
  assert.deepEqual(selected, [], "the click stays off the row");
});

test("setAttention / setPresence keep the slot order on a row with a bin", () => {
  const sb = mountFleet({ onRemove() {} });
  sb.setPresence("m1", "on");
  sb.setAttention("m1", true);
  const slots = ["cc-attention", "cc-presence", "cc-remove", "cc-dot"];
  const order = [...rowOf(sb, "m1").children]
    .map((c) => slots.find((k) => c.classList.contains(k)))
    .filter(Boolean);
  assert.deepEqual(order, slots);
});

test("unload_group_button_on_heads_only_enabled_while_the_group_has_a_loaded_tab", () => {
  assert.equal(rowOf(mountFleet(), "h1").querySelector(".cc-unload-group"), null, "absent without onUnloadGroup");
  const unloaded = [], selected = [];
  const cb = { onUnloadGroup: (g) => unloaded.push(g), onSelect: (id) => selected.push(id), onRemove() {} };
  const sb = mountFleet(cb);
  assert.equal(rowOf(sb, "m1").querySelector(".cc-unload-group"), null, "members carry none");
  const btn = () => rowOf(sb, "h1").querySelector(".cc-unload-group");
  const kids = rowOf(sb, "h1").children;
  assert.ok(kids[kids.length - 3] === btn(), "left of the bin, which stays beside the dot");
  assert.ok(btn().hasAttribute("disabled"), "nothing in the group is loaded");
  assert.equal(btn().title, "Unload group — nothing loaded");
  // A loaded member enables it on the head.
  const live = (ids, extra = {}) => fleet().map((t) => (ids.includes(t.id) ? { ...t, live: true, ...extra } : t));
  sb.update({ title: "w", active: "loose", tabs: live(["m2"]) });
  assert.ok(!btn().hasAttribute("disabled"));
  fire(btn(), "click");
  assert.deepEqual(unloaded, ["h1"]);
  assert.deepEqual(selected, [], "the click stays off the row");
  // The active tab always has a surface; a popped-out one does not count.
  sb.update({ title: "w", active: "m1", tabs: fleet() });
  assert.ok(!btn().hasAttribute("disabled"), "the active member counts as loaded");
  sb.update({ title: "w", active: "loose", tabs: live(["m1"], { detached: true }) });
  assert.ok(btn().hasAttribute("disabled"), "a popped-out member's window keeps it");
  // A targeted setLive repaints it.
  sb.setLive("m2", true);
  assert.ok(!btn().hasAttribute("disabled"));
});

test("confirm_remove_opens_in_place_and_only_its_remove_fires", () => {
  const removed = [];
  const selected = [];
  const why = "Closes this group and its 2 documents.";
  const tabs = fleet().map((t) => (t.id === "h1" ? { ...t, confirmRemove: why } : t));
  const sb = mountFleet({ onRemove: (id) => removed.push(id), onSelect: (id) => selected.push(id) }, { tabs });
  const rm = () => rowOf(sb, "h1").querySelector(".cc-remove");
  const box = () => rowOf(sb, "h1").querySelector(".cc-remove-confirm");
  fire(rm(), "click");
  assert.deepEqual(removed, [], "the bin only opens the confirm");
  assert.equal(box().querySelector(".cc-remove-why").textContent, why);
  sb.update({ title: "w", active: "loose", tabs });
  assert.ok(box(), "a repaint keeps it open");
  // The bin again, and Keep, close it without removing.
  fire(rm(), "click");
  assert.equal(box(), null);
  fire(rm(), "click");
  fire(box().querySelector(".cc-remove-keep"), "click");
  assert.equal(box(), null);
  assert.deepEqual(removed, []);
  // Remove fires and closes it, and the click stays off the row.
  fire(rm(), "click");
  fire(box().querySelector(".cc-remove-go"), "click");
  assert.deepEqual(removed, ["h1"]);
  assert.equal(box(), null);
  assert.deepEqual(selected, []);
  // Opening one, then removing another, closes the first.
  fire(rm(), "click");
  fire(rowOf(sb, "m1").querySelector(".cc-remove"), "click");
  assert.deepEqual(removed, ["h1", "m1"], "an unconfirmed row still fires at once");
  assert.equal(box(), null);
});

test("collapsed_group_hides_members_not_head", () => {
  const sb = mountFleet({ onToggleGroup() {} }, { collapsed: ["h1"] });
  assert.deepEqual(mainIds(sb), ["loose", "h1", "other"]);
  const head = rowOf(sb, "h1");
  assert.ok(head.hasAttribute("data-collapsed"));
  assert.equal(head.querySelector(".cc-disclosure").getAttribute("aria-expanded"), "false");
  // `collapsed` naming a group with no head hides nothing — there is no arrow to bring it back.
  const flat = mountFleet({}, { tabs: [row("a", "a", "G"), row("b", "b", "G")], collapsed: ["G"] });
  assert.deepEqual(mainIds(flat), ["a", "b"]);
});

test("toggle_fires_onToggleGroup_without_repainting_state_itself", () => {
  const toggles = [];
  const selected = [];
  const cb = { onSelect: (id) => selected.push(id), onToggleGroup: (g, c) => toggles.push([g, c]) };
  const sb = mountFleet(cb);
  // `localStorage` is undefined under the fake DOM, so a toggle that persisted anything would throw.
  fire(rowOf(sb, "h1").querySelector(".cc-disclosure"), "click");
  assert.deepEqual(toggles, [["h1", true]]);
  assert.deepEqual(selected, [], "the arrow toggles; it does not select the head");
  assert.deepEqual(mainIds(sb), ["loose", "h1", "m1", "m2", "other"], "no optimistic repaint");
  // The app answers with a DTO update, and that is authoritative.
  sb.update({ title: "w", active: "loose", tabs: fleet(), collapsed: ["h1"] });
  assert.deepEqual(mainIds(sb), ["loose", "h1", "other"]);
  fire(rowOf(sb, "h1").querySelector(".cc-disclosure"), "click");
  assert.deepEqual(toggles, [["h1", true], ["h1", false]]);
  // Without the callback the arrow still shows the state, disabled.
  const bare = mountFleet({}, { collapsed: ["h1"] });
  assert.ok(rowOf(bare, "h1").querySelector(".cc-disclosure").hasAttribute("disabled"));
});

test("search_reveals_collapsed_members", () => {
  const dto = { collapsed: ["h1"] };
  const sb = mountFleet({ onToggleGroup() {} }, dto);
  const search = (q) => {
    sb.searchInput.value = q;
    fire(sb.searchInput, "input");
    return mainIds(sb);
  };
  assert.deepEqual(search("beta"), ["m2"]);
  // The member's text header names the group by `groupName`, never by the head id in `group`.
  assert.equal(sb.mainEl.querySelector(".cc-group").textContent, "Fleet");
  // `groupName` is what a group matches; the head id carried in `group` is not searchable.
  assert.deepEqual(search("fleet"), ["h1", "m1", "m2"]);
  assert.ok(rowOf(sb, "h1").querySelector(".cc-disclosure").hasAttribute("disabled"), "no toggling under a search");
  assert.deepEqual(search("h1"), []);
  assert.deepEqual(dto.collapsed, ["h1"]);
  assert.deepEqual(search(""), ["loose", "h1", "other"], "clearing the search restores the collapse");
  // Absent `groupName` → `group` matches, as before.
  assert.deepEqual(filterTabs([row("x", "x", "Backend")], "backend").map((t) => t.id), ["x"]);
});

test("navOrder_skips_collapsed_members", () => {
  assert.deepEqual(navOrder(fleet()), ["loose", "h1", "m1", "m2", "other"]);
  assert.deepEqual(navOrder(fleet(), ["h1"]), ["loose", "h1", "other"]);
  const selected = [];
  const sb = mountFleet({ onSelect: (id) => selected.push(id) }, { collapsed: ["h1"], active: "h1" });
  sb.selectByOffset(1);
  assert.deepEqual(selected, ["other"]);
});

test("contextmenu_fires_with_id", () => {
  const menus = [];
  const sb = mountFleet({ onContextMenu: (id, at) => menus.push([id, at]) });
  const ev = fire(rowOf(sb, "m1").querySelector(".cc-title"), "contextmenu", { clientX: 12, clientY: 34 });
  assert.deepEqual(menus, [["m1", { x: 12, y: 34 }]]);
  assert.ok(ev.defaultPrevented, "the app's menu replaces the webview's");
  fire(rowOf(sb, "h1"), "contextmenu", { clientX: 1, clientY: 2 });
  assert.deepEqual(menus[1], ["h1", { x: 1, y: 2 }]);
  // Without the callback, a right-click is left alone.
  const bare = mountFleet();
  assert.equal(fire(rowOf(bare, "m1"), "contextmenu").defaultPrevented, false);
});

test("dto_without_head_renders_unchanged", () => {
  // A curator-shaped DTO: app-owned `active`, loose + grouped rows, attention counts, no presence,
  // no head/collapsed/groupName, no new callbacks. The markup is pinned verbatim from before the
  // headed-group change.
  const root = installDom();
  const sb = new Sidebar(root, { onSelect() {} }, {});
  sb.update({
    title: "work", colour: "#1a9e8f", density: "compact", active: "b",
    tabs: [
      row("a", "Inbox", null, { live: true, attention: 3 }),
      row("b", "Calendar", "Google", { live: true }),
      row("c", "Drive", "Google", { attention: true, warn: true }),
      row("d", "Grafana", "Ops"),
    ],
  });
  const expected =
    '<div data-tauri-drag-region="" id="cc-tab-list"><div class="cc-open" data-tauri-drag-region=""></div><div class="cc-main" data-tauri-drag-region="">' +
    '<div class="cc-tab" data-id="a"><span class="cc-icon" style="background:hsl(302, 45%, 45%)">I</span><span class="cc-title">Inbox</span><span class="cc-attention cc-count">3</span><span class="cc-dot live"></span></div>' +
    '<div class="cc-group" data-tauri-drag-region="" style="background:rgb(22,41,44)">Google</div>' +
    '<div class="cc-tab active" data-id="b"><span class="cc-icon" style="background:hsl(150, 45%, 45%)">C</span><span class="cc-title">Calendar</span><span class="cc-dot live"></span></div>' +
    '<div class="cc-tab" data-id="c"><span class="cc-icon" style="background:hsl(146, 45%, 45%)">D</span><span class="cc-title">Drive  ⚠</span><span class="cc-attention"></span><span class="cc-dot cold"></span></div>' +
    '<div class="cc-group" data-tauri-drag-region="" style="background:rgb(22,41,44)">Ops</div>' +
    '<div class="cc-tab" data-id="d"><span class="cc-icon" style="background:hsl(148, 45%, 45%)">G</span><span class="cc-title">Grafana</span><span class="cc-dot cold"></span></div>' +
    "</div></div>";
  assert.equal(serialize(sb.list), expected);
  assert.equal(sb.list.querySelectorAll(".cc-contains-active").length, 0);
  assert.ok(sb.list.querySelectorAll(".cc-tab").every((r) => !(r.listeners.contextmenu || []).length));
});

test("collapsing the active tab's group: its head stands in, and ⌃Tab steps from the head", () => {
  assert.equal(navAnchor(fleet(), ["h1"], "m2"), "h1");
  assert.equal(navAnchor(fleet(), [], "m2"), "m2");
  assert.equal(navAnchor(fleet(), ["h1"], "nope"), "nope");
  const selected = [];
  const sb = mountFleet({ onSelect: (id) => selected.push(id), onToggleGroup() {} }, { collapsed: ["h1"], active: "m2" });
  assert.ok(rowOf(sb, "h1").classList.contains("cc-contains-active"));
  assert.ok(!rowOf(sb, "h1").classList.contains("active"));
  sb.selectByOffset(1);
  assert.deepEqual(selected, ["other"], "the step after the head, not a jump to the list's start");
  sb.update({ title: "w", active: "m2", tabs: fleet(), collapsed: ["h1"] });
  sb.selectByOffset(-1);
  assert.deepEqual(selected, ["other", "loose"]);
  // Expanded, the member itself is highlighted and the head carries no stand-in mark.
  const open = mountFleet({}, { active: "m2" });
  assert.ok(!rowOf(open, "h1").classList.contains("cc-contains-active"));
  assert.ok(rowOf(open, "m2").classList.contains("active"));
});

test("a disabled disclosure arrow fires nothing", () => {
  const toggles = [];
  const selected = [];
  const cb = { onSelect: (id) => selected.push(id), onToggleGroup: (g, c) => toggles.push([g, c]) };
  // Disabled by a search …
  const sb = mountFleet(cb);
  sb.searchInput.value = "fleet";
  fire(sb.searchInput, "input");
  const arrow = rowOf(sb, "h1").querySelector(".cc-disclosure");
  assert.ok(arrow.hasAttribute("disabled"));
  fire(arrow, "click");
  assert.deepEqual(toggles, []);
  assert.deepEqual(selected, [], "nor does the click fall through to select the head");
});

test("a head with no members has a blank where the arrow would be", () => {
  const lone = mountFleet({ onToggleGroup() {} }, { tabs: [row("h", "Solo", "h", { head: true, groupName: "Solo" })] });
  const head = rowOf(lone, "h");
  assert.ok(!head.querySelector(".cc-disclosure"));
  assert.equal(head.firstChild.getAttribute("class"), "cc-disclosure-blank");
});

test("banner_contextmenu_fires_with_coords", () => {
  const menus = [];
  const sb = mountFleet({ onBannerMenu: (at) => menus.push(at) });
  const ev = fire(sb.banner, "contextmenu", { clientX: 7, clientY: 9 });
  assert.deepEqual(menus, [{ x: 7, y: 9 }]);
  assert.ok(ev.defaultPrevented, "the app's menu replaces the webview's");
});

test("no_banner_listener_without_callback", () => {
  const bare = mountFleet();
  assert.equal(fire(bare.banner, "contextmenu").defaultPrevented, false);
  assert.ok(!(bare.banner.listeners.contextmenu || []).length);
});

test("revealRow_clears_a_search_hiding_the_row", () => {
  const sb = mountFleet();
  sb.searchInput.value = "solo";
  fire(sb.searchInput, "input");
  assert.equal(rowOf(sb, "loose"), null, "the search hides it");
  const r = sb.revealRow("loose");
  assert.ok(r && r.dataset.id === "loose");
  assert.equal(sb.query, "");
  assert.equal(sb.revealRow("nope"), null);
});

// ── mirror sections: the pinned Open + Background sections, each with a collapsible header ──


test("backgroundTabs: running or ghost session, unloaded, DTO order; missing list → []", () => {
  const tabs = [
    { id: "a", presence: "ghost" },
    { id: "b", presence: "on" },
    { id: "c", presence: "ghost" },
    { id: "d", presence: "ghost", live: true },
    { id: "e", presence: "ghost", detached: true },
    { id: "f", presence: "off" },
    { id: "g", presence: "on", live: true },
    { id: "h" },
  ];
  assert.deepEqual(backgroundTabs(tabs).map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(backgroundTabs(undefined), []);
});

const ghosts = () => [
  row("g1", "crashed", "work", { presence: "ghost" }),
  row("ok", "fine", "work", { presence: "off" }),
  row("lv", "open", "work", { presence: "ghost", live: true }),
];
function mountSections(dto = {}, storage = installStorage()) {
  const root = installDom();
  globalThis.localStorage = storage;
  const sb = new Sidebar(root, {}, { storageKey: "w" });
  sb.update({ title: "w", colour: null, density: "comfortable", tabs: ghosts(), backgroundSection: true, ...dto });
  return sb;
}
const heads = (sb) => sb.openEl.querySelectorAll(".cc-group").map((h) => h.querySelector(".cc-section-label").textContent);
const mirrorIds = (sb) => sb.openEl.querySelectorAll(".cc-tab[data-mirror]").map((r) => r.dataset.id);
const headOf = (sb, title) => sb.openEl.querySelectorAll(".cc-group").find((h) => h.querySelector(".cc-section-label").textContent === title);

test("Background section: collapsed by default — header only, no mirrors", () => {
  const sb = mountSections();
  assert.deepEqual(heads(sb), ["Background"]);
  const head = headOf(sb, "Background");
  assert.equal(head.querySelector(".cc-disclosure").getAttribute("aria-expanded"), "false");
  assert.ok(head.hasAttribute("data-collapsed"));
  assert.deepEqual(mirrorIds(sb), []);
});

test("Background section: arrow click expands, persists \"0\", mirrors appear", () => {
  const storage = installStorage();
  const sb = mountSections({}, storage);
  fire(headOf(sb, "Background").querySelector(".cc-disclosure"), "click");
  assert.equal(storage.getItem("cc-section:w:background"), "0");
  assert.deepEqual(mirrorIds(sb), ["g1"], "a live ghost is open, not recoverable");
  const again = mountSections({}, storage);
  assert.deepEqual(mirrorIds(again), ["g1"], "the expanded state is remembered");
});

test("section header: a click on its body toggles like the arrow, and it is no drag region", () => {
  const storage = installStorage();
  const sb = mountSections({ windowDrag: true }, storage);
  const head = headOf(sb, "Background");
  assert.ok(!head.hasAttribute("data-tauri-drag-region"));
  fire(head.querySelector(".cc-section-label"), "click");
  assert.equal(storage.getItem("cc-section:w:background"), "0");
  assert.deepEqual(mirrorIds(sb), ["g1"]);
  fire(headOf(sb, "Background"), "click");
  assert.equal(storage.getItem("cc-section:w:background"), "1");
  assert.deepEqual(mirrorIds(sb), []);
});

test("Background section: no recoverable tabs or flag off → no header", () => {
  assert.deepEqual(heads(mountSections({ tabs: [row("ok", "fine", null, { presence: "off" }), row("lv", "open", null, { presence: "on", live: true })] })), []);
  assert.deepEqual(heads(mountSections({ backgroundSection: undefined })), []);
});

test("Open section: expanded by default and collapsible", () => {
  const storage = installStorage();
  const sb = mountSections({ openSection: true, backgroundSection: false }, storage);
  assert.deepEqual(heads(sb), ["Open"]);
  assert.deepEqual(mirrorIds(sb), ["lv"]);
  fire(headOf(sb, "Open").querySelector(".cc-disclosure"), "click");
  assert.equal(storage.getItem("cc-section:w:open"), "1");
  assert.deepEqual(mirrorIds(sb), []);
  assert.deepEqual(heads(sb), ["Open"], "a collapsed section keeps its header");
});

test("setPresence: ghost or on adds a Background mirror, off removes it", () => {
  const storage = installStorage();
  storage.setItem("cc-section:w:background", "0");
  const sb = mountSections({}, storage);
  sb.setPresence("ok", "on");
  assert.deepEqual(mirrorIds(sb), ["g1", "ok"], "a running session behind an unloaded tab");
  sb.setPresence("g1", "off");
  assert.deepEqual(mirrorIds(sb), ["ok"]);
  sb.setPresence("ok", "ghost");
  assert.deepEqual(mirrorIds(sb), ["ok"], "on → ghost stays in the section");
  sb.setPresence("ok", "off");
  assert.deepEqual(heads(sb), [], "the last one leaving takes the header with it");
});

test("a live ghost tab mirrors in Open only; setLive on a Background tab moves its mirror to Open", () => {
  const storage = installStorage();
  storage.setItem("cc-section:w:background", "0");
  const sb = mountSections({ openSection: true }, storage);
  assert.deepEqual(heads(sb), ["Open", "Background"]);
  assert.deepEqual(mirrorIds(sb), ["lv", "g1"]);
  sb.setLive("g1", true);
  assert.deepEqual(heads(sb), ["Open"]);
  assert.deepEqual(mirrorIds(sb), ["g1", "lv"]);
});

test("dimming marker: data-rows only while an expanded section has rows", () => {
  const storage = installStorage();
  const sb = mountSections({}, storage);
  assert.ok(!sb.openEl.hasAttribute("data-rows"), "a lone collapsed header does not dim the list");
  fire(headOf(sb, "Background").querySelector(".cc-disclosure"), "click");
  assert.ok(sb.openEl.hasAttribute("data-rows"));
});

test("nav skips Background mirrors", () => {
  const storage = installStorage();
  storage.setItem("cc-section:w:background", "0");
  const sb = mountSections({}, storage);
  assert.deepEqual(mirrorIds(sb), ["g1"]);
  assert.equal(sb._navRows().length, ghosts().length);
});

test("an armed Open mirror survives probe sweeps that move no tab between sections", () => {
  const storage = installStorage();
  storage.setItem("cc-section:w:background", "0");
  // A fresh pair per mount: `setPresence` patches the records it was handed.
  const tabs = () => [
    row("x", "armed", "work", { live: true, presence: "on", killable: true }),
    row("y", "cold", "work", { presence: "off" }),
  ];
  const arm = (sb) => {
    fire(sb.openEl.querySelector('.cc-tab[data-id="x"]').querySelector(".cc-presence"), "click");
    assert.equal(sb.armedKill, "x");
  };
  const sb = mountSections({ openSection: true, tabs: tabs() }, storage);
  arm(sb);
  sb.setPresence("x", "on");
  sb.setPresence("y", "off");
  assert.equal(sb.armedKill, "x", "a sweep that changes no section keeps the confirm row");
  sb.setPresence("y", "ghost");
  assert.equal(sb.armedKill, null, "a section repaint wipes the armed mirror, so it disarms");

  // With Background off, a tab turning ghost changes nothing visible — no repaint, still armed.
  const off = mountSections({ openSection: true, backgroundSection: false, tabs: tabs() }, storage);
  arm(off);
  off.setPresence("y", "ghost");
  assert.equal(off.armedKill, "x");
});

test("search narrows mirrors; a collapsed section stays collapsed under it", () => {
  const storage = installStorage();
  const tabs = [
    row("a", "alpha", null, { presence: "ghost" }),
    row("z", "zeta", null, { presence: "ghost" }),
  ];
  const sb = mountSections({ tabs }, storage);
  const search = (q) => {
    sb.searchInput.value = q;
    fire(sb.searchInput, "input");
  };
  search("zeta");
  assert.deepEqual(heads(sb), ["Background"]);
  assert.deepEqual(mirrorIds(sb), [], "collapsed stays collapsed");
  assert.ok(!sb.openEl.hasAttribute("data-rows"));
  storage.setItem("cc-section:w:background", "0");
  search("zet");
  assert.deepEqual(mirrorIds(sb), ["z"]);
  search("nothing");
  assert.deepEqual(heads(sb), []);
});

// ── the pinned "Incoming" section (opt-in `incoming`: items waiting on an action) ──

const incomingItems = () => [
  {
    id: "in-1", title: "Quarterly budget", icon: "icons/sheet.svg",
    actions: [{ id: "add", label: "Add" }, { id: "add-active", label: "Add to active" }, { id: "open", label: "Open" }, { id: "dismiss", label: "Dismiss" }],
  },
  {
    id: "in-2", title: "https://example.com/private", problem: "Not a document",
    actions: [{ id: "add", label: "Add" }, { id: "add-active", label: "Add to active", disabled: "No active group" }],
  },
];
// The fake DOM takes compound selectors only, so descend one step at a time.
const incomingItem = (sb, item) => sb.list.querySelector(".cc-incoming").querySelector('[data-incoming="' + item + '"]');
const incomingBtn = (sb, item, action) => incomingItem(sb, item).querySelector('[data-action="' + action + '"]');

test("incoming_section_lists_every_item_above_open", () => {
  const sb = mountFleet({}, { incoming: incomingItems() });
  const section = sb.list.children[0];
  assert.ok(section.classList.contains("cc-incoming"), "above .cc-open and .cc-main");
  assert.ok(sb.list.children[1].classList.contains("cc-open"));
  assert.match(section.querySelector(".cc-group").textContent, /Incoming\D*2/);
  assert.deepEqual(section.querySelectorAll(".cc-inbox-item").map((r) => r.dataset.incoming), ["in-1", "in-2"]);
  assert.equal(incomingItem(sb, "in-1").querySelector("img").getAttribute("src"), "icons/sheet.svg");
  assert.equal(incomingItem(sb, "in-1").querySelector(".cc-inbox-problem"), null);
  assert.equal(incomingItem(sb, "in-2").querySelector(".cc-inbox-problem").textContent, "Not a document");
  assert.equal(incomingItem(sb, "in-2").querySelector(".cc-inbox-title").getAttribute("title"), "https://example.com/private");
  assert.equal(incomingItem(sb, "in-1").querySelectorAll("[data-action]").length, 4);
});

test("incoming_action_fires_with_ids_and_a_disabled_one_does_not", () => {
  const fired = [];
  const sb = mountFleet({ onIncomingAction: (item, action, at) => fired.push([item, action, typeof at.x]) }, { incoming: incomingItems() });
  fire(incomingBtn(sb, "in-1", "add"), "click");
  assert.deepEqual(fired, [["in-1", "add", "number"]]);
  const off = incomingBtn(sb, "in-2", "add-active");
  assert.ok(off.hasAttribute("disabled"));
  assert.equal(off.getAttribute("title"), "No active group");
  fire(off, "click");
  assert.equal(fired.length, 1);
  // The row is not a tab: a click on a button neither selects nor reaches a row handler.
  assert.equal(sb.active, "loose");
});

test("incoming_absent_or_empty_renders_nothing_and_ignores_search", () => {
  const none = mountFleet();
  assert.equal(none.list.querySelector(".cc-incoming"), null);
  assert.ok(none.list.children[0].classList.contains("cc-open"));
  assert.equal(mountFleet({}, { incoming: [] }).list.querySelector(".cc-incoming"), null);
  const sb = mountFleet({}, { incoming: incomingItems() });
  sb.searchInput.value = "zzz-no-match";
  fire(sb.searchInput, "input");
  assert.equal(sb.list.querySelectorAll(".cc-inbox-item").length, 2, "a search does not filter it");
  // Dropping `incoming` on the next update removes the section.
  sb.update({ title: "w", active: "loose", tabs: fleet() });
  assert.equal(sb.list.querySelector(".cc-incoming"), null);
});

test("incoming_rows_are_outside_keyboard_nav", () => {
  const selected = [];
  const sb = mountFleet({ onSelect: (id) => selected.push(id) }, { incoming: incomingItems() });
  sb.selectByIndex(1);
  assert.deepEqual(selected, ["loose"]);
});

test("incoming_action_without_a_callback_fires_nothing_and_does_not_throw", () => {
  const sb = mountFleet({}, { incoming: incomingItems() });
  assert.doesNotThrow(() => fire(incomingBtn(sb, "in-1", "add"), "click"));
  assert.equal(sb.active, "loose");
});

test("a cold killable ghost: its dot arms the confirm row — ☠ discards, ⏻ disabled with why", () => {
  const root = installDom();
  globalThis.localStorage = installStorage();
  const fired = [];
  const sb = new Sidebar(
    root,
    { onDestroy: (id) => fired.push(["destroy", id]), onSuspend: (id) => fired.push(["suspend", id]) },
    { storageKey: "w" },
  );
  const tab = row("g", "crashed", null, { presence: "on", killable: true, suspendable: true });
  sb.update({ title: "w", colour: null, density: "comfortable", tabs: [tab] });
  sb.setPresence("g", "ghost");
  const r = rowOf(sb, "g");
  const dot = r.querySelector(".cc-presence");
  assert.ok(dot.classList.contains("kill"), "a ghost that went cold keeps a kill affordance");
  fire(dot, "click");
  assert.equal(sb.armedKill, "g");
  const suspend = r.querySelector(".cc-confirm-suspend");
  const destroy = r.querySelector(".cc-confirm-destroy");
  assert.ok(suspend.classList.contains("cc-disabled"));
  assert.match(suspend.title, /nothing running/);
  assert.equal(destroy.title, "Discard the restorable session");
  fire(suspend, "click");
  assert.deepEqual(fired, []);
  fire(destroy, "click");
  assert.deepEqual(fired, [["destroy", "g"]]);
});

test("an armed row disarms when its session changes state, not on a repeat report", () => {
  const root = installDom();
  globalThis.localStorage = installStorage();
  const sb = new Sidebar(root, {}, { storageKey: "w" });
  const tab = row("g", "crashed", null, { presence: "ghost", killable: true });
  sb.update({ title: "w", colour: null, density: "comfortable", tabs: [tab] });
  fire(rowOf(sb, "g").querySelector(".cc-presence"), "click");
  sb.setPresence("g", "ghost");
  assert.equal(sb.armedKill, "g", "a probe re-reporting the same state leaves it armed");
  sb.setPresence("g", "off");
  assert.equal(sb.armedKill, null);
});

// ── the standard header: title-row nav, the URL toolbar, the downloads button ──

function mountHeader(cfg = {}, cb = {}) {
  const root = installDom();
  const sb = new Sidebar(root, cb, cfg);
  sb.update({ title: "Work", colour: null, density: "comfortable", tabs: [] });
  return sb;
}
const titleRow = (sb) => sb.banner.querySelector(".cc-title-row");
const toolbar = (sb) => sb.banner.querySelector('[id="cc-toolbar"]');
const tick = () => new Promise((r) => setImmediate(r));

test("nav_renders_requested_buttons_in_fixed_order", () => {
  const sb = mountHeader({ nav: ["home", "back"] });
  const nav = titleRow(sb).querySelector(".cc-nav");
  assert.ok(nav, "the pill sits on the title row");
  assert.deepEqual(nav.querySelectorAll("button").map((b) => b.dataset.nav), ["back", "home"]);
  const kids = titleRow(sb).children;
  assert.ok(kids.indexOf(titleRow(sb).querySelector(".cc-name")) < kids.indexOf(nav.parentNode), "name left, nav right");
  assert.equal(mountHeader({}).banner.querySelector(".cc-nav"), null, "no nav requested → no pill");
});

test("nav_click_fires_onNav", () => {
  const fired = [];
  const sb = mountHeader({ nav: ["back", "forward", "reload", "home"] }, { onNav: (a) => fired.push(a) });
  sb.setNavEnabled(true);
  for (const b of sb.banner.querySelectorAll(".cc-nav-btn")) fire(b, "click");
  assert.deepEqual(fired, ["back", "forward", "reload", "home"]);
});

test("setNavEnabled_false_turns_off_with_reason_and_keeps_the_tooltip", () => {
  const fired = [];
  const sb = mountHeader({ nav: ["back", "reload"] }, { onNav: (a) => fired.push(a) });
  const [back, reload] = sb.banner.querySelectorAll(".cc-nav-btn");
  sb.setNavEnabled(true);
  assert.ok(!back.classList.contains("off"));
  assert.equal(back.getAttribute("aria-disabled"), "false");
  assert.equal(back.title, "Back");
  sb.setNavEnabled(false);
  assert.ok(back.classList.contains("off"));
  assert.equal(back.getAttribute("aria-disabled"), "true");
  assert.ok(!back.hasAttribute("disabled"), "never `disabled`: WebKit would drop the tooltip");
  assert.equal(back.title, "Back — no tab open");
  assert.equal(reload.title, "Reload — no tab open");
  fire(back, "click");
  assert.deepEqual(fired, [], "an off button ignores clicks");
});

test("title_row_controls_are_one_wrapping_group", () => {
  const sb = mountHeader({ nav: ["back", "home"], downloads: true });
  const row = titleRow(sb);
  const group = row.querySelector(".cc-title-controls");
  assert.ok(group, "the controls share one element");
  assert.deepEqual(row.children, [row.querySelector(".cc-name"), group], "name, then the controls");
  assert.deepEqual(group.children, [group.querySelector(".cc-downloads"), group.querySelector(".cc-nav")]);
  assert.equal(titleRow(mountHeader({})).querySelector(".cc-title-controls"), null, "no controls → no group");
  assert.equal(
    titleRow(mountHeader({ urlField: { placeholder: "x" }, downloads: true })).querySelector(".cc-title-controls"),
    null,
    "downloads in the toolbar leaves the title row bare",
  );
});

test("urlField_renders_toolbar_and_submits_on_enter", async () => {
  const submitted = [];
  const sb = mountHeader(
    { urlField: { placeholder: "Open a page" } },
    { onUrlSubmit: (v) => (submitted.push(v), Promise.resolve()) },
  );
  const tb = toolbar(sb);
  assert.ok(tb, "the toolbar row exists");
  const input = tb.querySelector(".cc-url");
  assert.equal(input.tagName, "INPUT");
  assert.equal(input.getAttribute("placeholder"), "Open a page");
  input.value = "https://example.com";
  fire(input, "keydown", { key: "a" });
  assert.deepEqual(submitted, [], "only Enter submits");
  fire(input, "keydown", { key: "Enter" });
  assert.deepEqual(submitted, ["https://example.com"]);
  await tick();
  assert.equal(input.value, "", "a resolved submit clears the field");
});

test("url_submit_rejection_sets_error", async () => {
  const sb = mountHeader({ urlField: { placeholder: "x" } }, { onUrlSubmit: () => Promise.reject(new Error("bad link")) });
  const input = toolbar(sb).querySelector(".cc-url");
  input.value = "nope";
  fire(input, "keydown", { key: "Enter" });
  await tick();
  assert.equal(sb._errorText.textContent, "Error: bad link");
  assert.equal(input.value, "nope", "a rejected submit keeps what was typed");
});

test("downloads_in_toolbar_when_urlField", () => {
  const rects = [];
  const sb = mountHeader({ urlField: { placeholder: "x" }, downloads: true }, { onDownloads: (r) => rects.push(r) });
  const tb = toolbar(sb);
  const btn = tb.querySelector(".cc-downloads");
  assert.ok(btn, "the button is in the toolbar");
  assert.equal(tb.children.indexOf(btn), tb.children.indexOf(tb.querySelector(".cc-url")) + 1, "after the field");
  assert.equal(titleRow(sb).querySelector(".cc-downloads"), null);
  assert.equal(btn.title, "Downloads");
  fire(btn, "click");
  assert.deepEqual(rects, [{ x: 0, y: 0, width: 0, height: 0 }]);
});

test("downloads_on_title_row_before_nav_without_urlField", () => {
  const sb = mountHeader({ nav: ["back"], downloads: true });
  assert.equal(toolbar(sb), null);
  const kids = titleRow(sb).children;
  const btn = titleRow(sb).querySelector(".cc-downloads");
  assert.ok(btn);
  const group = titleRow(sb).querySelector(".cc-title-controls").children;
  assert.equal(group.indexOf(btn) + 1, group.indexOf(titleRow(sb).querySelector(".cc-nav")), "immediately before the nav");
  assert.equal(kids.indexOf(btn), -1, "inside the controls group");
});

test("setDownloads_sets_state_classes", () => {
  const sb = mountHeader({ downloads: true });
  const btn = sb.banner.querySelector(".cc-downloads");
  const cls = () => ["cc-dl-active", "cc-dl-unseen", "cc-dl-failed"].filter((c) => btn.classList.contains(c));
  assert.deepEqual(cls(), []);
  sb.setDownloads({ active: true, unseen: true, unseenFailed: false });
  assert.deepEqual(cls(), ["cc-dl-active", "cc-dl-unseen"]);
  sb.setDownloads({ active: false, unseen: true, unseenFailed: true });
  assert.deepEqual(cls(), ["cc-dl-failed"], "a failure among the unseen shows red, not blue");
  sb.setDownloads({ active: false, unseen: false, unseenFailed: false });
  assert.deepEqual(cls(), []);
});

test("no_toolbar_without_urlField_or_downloads", () => {
  const sb = mountHeader({ nav: ["back"] });
  assert.equal(toolbar(sb), null);
  assert.equal(sb.banner.querySelector(".cc-downloads"), null);
  assert.equal(sb.banner.querySelector(".cc-url"), null);
});

test("header_option_is_gone", () => {
  const header = document.createElement("div");
  header.className = "app-header";
  const sb = mountHeader({ header });
  assert.equal(sb.banner.querySelector(".app-header"), null);
  assert.equal(sb.root.querySelector(".app-header"), null);
});

test("the title row and toolbar are drag surfaces; their controls are not", () => {
  const sb = mountHeader({ nav: ["back"], urlField: { placeholder: "x" }, downloads: true });
  assert.ok(titleRow(sb).hasAttribute("data-tauri-drag-region"));
  assert.ok(toolbar(sb).hasAttribute("data-tauri-drag-region"));
  assert.ok(titleRow(sb).querySelector(".cc-title-controls").hasAttribute("data-tauri-drag-region"), "the gaps between controls");
  for (const n of sb.banner.querySelectorAll("button").concat(sb.banner.querySelectorAll("input"))) {
    assert.ok(!n.hasAttribute("data-tauri-drag-region"));
  }
  sb.update({ title: "Work", windowDrag: false, tabs: [] });
  assert.ok(!titleRow(sb).hasAttribute("data-tauri-drag-region"));
  assert.ok(!toolbar(sb).hasAttribute("data-tauri-drag-region"));
});
