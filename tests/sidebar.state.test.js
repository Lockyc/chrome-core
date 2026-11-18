// Random operation sequences over a mounted Sidebar: after every step the DOM must still be the
// projection of the tab records (`sb.tabs`, `sb.active`, `controls.armed`). A partial repaint (a
// folder toggle, a mirror-section repaint, a targeted setter) that drops state the full paint would
// have kept fails here, whatever sequence reached it.
//
// The "app" these commands play answers the component the way every consumer does: selecting a tab
// loads it (`onSelect` → `setLive(id, true)`), and its snapshots report the active tab live.
// `FC_RUNS` raises the run count (`just soak`).
const { test } = require("node:test");
const assert = require("node:assert");
const fc = require("fast-check");
const { Sidebar, presenceClass } = require("../assets/sidebar.js");
const { installDom, installStorage, fire } = require("./dom.js");

const NUM_RUNS = Number(process.env.FC_RUNS) || 400;

// The universe: loose tabs, a headed group, and a project tree whose depth-1 folders start collapsed.
const SHAPE = [
  { id: "a", title: "alpha" },
  { id: "b", title: "bravo" },
  { id: "p", title: "popper" }, // the one tab a snapshot may report popped out
  { id: "h", title: "Fleet", group: "G", head: true },
  { id: "m1", title: "mike", group: "G" },
  { id: "m2", title: "november", group: "G" },
  { id: "t1", title: "root-proj", group: "Dev", tree: true, treePath: [] },
  { id: "t2", title: "lockyc-proj", group: "Dev", tree: true, treePath: ["gh", "lockyc"] },
  { id: "t3", title: "acme-proj", group: "Dev", tree: true, treePath: ["gh", "acme"] },
  { id: "t4", title: "gl-proj", group: "Dev", tree: true, treePath: ["gl"] },
];
const IDS = SHAPE.map((t) => t.id);
const DOCKED = IDS.filter((id) => id !== "p");

const presenceArb = fc.constantFrom(null, "on", "ghost", "off");
const attentionArb = fc.constantFrom(null, true, 3, "lock");
const tabArb = (shape) =>
  fc
    .record({
      live: fc.boolean(),
      presence: presenceArb,
      attention: attentionArb,
      killable: fc.constantFrom(true, true, false), // most rows arm, so arm-then-repaint is reached
      suspendable: fc.boolean(),
      startable: fc.boolean(),
      busy: fc.boolean(),
      detached: shape.id === "p" ? fc.boolean() : fc.constant(false),
    })
    .map((r) => ({ ...shape, ...r }));
const dtoArb = fc.record({
  tabs: fc.tuple(...SHAPE.map(tabArb)),
  openSection: fc.boolean(),
  backgroundSection: fc.boolean(),
  collapseG: fc.boolean(),
  // undefined → the component owns the selection; else the app names it.
  active: fc.option(fc.constantFrom(...DOCKED), { nil: undefined }),
});

/** The state the test drives: the mounted sidebar, plus what the app has seen. */
function mount() {
  const root = installDom();
  installStorage(); // folder, section and group collapse states persist here
  const world = { sb: null, selected: [], collapsedG: false };
  world.sb = new Sidebar(
    root,
    {
      // Selecting a docked tab loads it, as every consumer's onSelect does.
      onSelect: (id) => {
        world.selected.push(id);
        if (world.sb.active === id) world.cleared = false; // a selection, by any route
        const t = world.sb.tabs.find((x) => x.id === id);
        if (t && !t.detached && !t.live) world.sb.setLive(id, true);
      },
      onToggleGroup: (g, c) => {
        world.collapsedG = c;
        world.sb.update({ ...world.lastDto, collapsed: c ? ["G"] : [] });
      },
      onDestroy() {},
      onSuspend() {},
      onStart() {},
    },
    {},
  );
  return world;
}

const rec = (sb, id) => sb.tabs.find((t) => t.id === id);

/** Every invariant the full paint establishes, checked against the records. */
function checkInvariants(world, note) {
  const { sb } = world;
  const at = (msg) => `${msg} (after ${note})`;
  for (const row of sb.list.querySelectorAll(".cc-tab")) {
    const id = row.dataset.id;
    const t = rec(sb, id);
    assert.ok(t, at(`row ${id} has a record`));
    const dot = row.querySelector(".cc-dot");
    const wantLive = !!(t.live || t.detached || id === sb.active);
    assert.equal(dot.classList.contains("live"), wantLive, at(`row ${id} live dot`));
    const pres = row.querySelector(".cc-presence");
    if (t.presence == null) assert.equal(pres, null, at(`row ${id} has no presence dot`));
    else {
      assert.ok(pres, at(`row ${id} has a presence dot`));
      assert.equal(pres.className, presenceClass(t.presence, t, wantLive), at(`row ${id} presence classes`));
    }
    const att = row.querySelector(".cc-attention");
    if (t.attention == null) assert.equal(att, null, at(`row ${id} has no attention`));
    else {
      assert.ok(att, at(`row ${id} has attention`));
      assert.equal(att.classList.contains("cc-count"), typeof t.attention === "number", at(`row ${id} count pill`));
      assert.equal(att.classList.contains("cc-lock"), t.attention === "lock", at(`row ${id} padlock`));
    }
    // Dot slots in their documented order (docs/contract.md): attention, presence, unload-group, remove, dot.
    const slots = [".cc-attention", ".cc-presence", ".cc-unload-group", ".cc-remove", ".cc-dot"];
    const pos = slots.map((s) => row.children.indexOf(row.querySelector(s))).filter((i) => i >= 0);
    assert.deepEqual(pos, [...pos].sort((x, y) => x - y), at(`row ${id} dot-slot order`));
    assert.equal(row.classList.contains("active"), id === sb.active, at(`row ${id} .active`));
    if (row.classList.contains("confirming")) assert.equal(sb.controls.armed, id, at(`confirming row ${id} is the armed one`));
  }
  const armed = sb.controls.armed;
  if (armed) {
    const rows = sb._rowsById(armed);
    assert.ok(rows.some((r) => r.classList.contains("confirming")), at(`armed ${armed} has a confirming row`));
  }
  if (world.cleared) assert.equal(sb.active, null, at("a cleared selection stays clear"));
}

/** A fresh snapshot from the app: it reports the active tab live and keeps the group's collapse. */
function pushDto(world, d) {
  const { sb } = world;
  const active = d.active !== undefined ? d.active : sb.active;
  const tabs = d.tabs.map((t) => (t.id === active ? { ...t, live: true, detached: false } : { ...t }));
  world.collapsedG = d.collapseG;
  const dto = {
    title: "w",
    tabs,
    openSection: d.openSection,
    backgroundSection: d.backgroundSection,
    collapsed: d.collapseG ? ["G"] : [],
  };
  if (d.active !== undefined) dto.active = d.active;
  world.lastDto = dto;
  if (d.active !== undefined) world.cleared = false;
  sb.update(dto);
}

// ── commands ──

const cmd = (name, args, run) => ({
  check: () => true,
  run: (_m, world) => {
    run(world);
    checkInvariants(world, `${name}(${JSON.stringify(args)})`);
  },
  toString: () => `${name}(${JSON.stringify(args)})`,
});

const idArb = fc.constantFrom(...IDS);
const commands = {
  update: dtoArb.map((d) => cmd("update", d, (w) => pushDto(w, d))),
  setLive: fc.tuple(idArb, fc.boolean()).map(([id, live]) =>
    cmd("setLive", [id, live], (w) => {
      // The app moves the highlight off a tab before unloading it.
      if (!live && w.sb.active === id) return;
      w.sb.setLive(id, live);
    }),
  ),
  setPresence: fc.tuple(idArb, presenceArb).map(([id, s]) => cmd("setPresence", [id, s], (w) => w.sb.setPresence(id, s))),
  setAttention: fc.tuple(idArb, attentionArb).map(([id, v]) => cmd("setAttention", [id, v], (w) => w.sb.setAttention(id, v))),
  clickFolder: fc.nat(5).map((i) =>
    cmd("clickFolder", i, (w) => {
      const folders = w.sb.list.querySelectorAll(".cc-folder");
      if (folders.length) fire(folders[i % folders.length], "click");
    }),
  ),
  clickSectionHead: fc.nat(3).map((i) =>
    cmd("clickSectionHead", i, (w) => {
      const heads = w.sb.list.querySelectorAll(".cc-section-head");
      if (heads.length) fire(heads[i % heads.length], "click");
    }),
  ),
  toggleGroup: fc.constant(null).map(() =>
    cmd("toggleGroup", null, (w) => {
      const arrow = w.sb.list.querySelector(".cc-head .cc-disclosure");
      if (arrow && w.lastDto) fire(arrow, "click");
    }),
  ),
  search: fc.constantFrom("", "proj", "lock", "m", "zzz").map((q) =>
    cmd("search", q, (w) => {
      w.sb.searchInput.value = q;
      fire(w.sb.searchInput, "input");
    }),
  ),
  select: idArb.map((id) =>
    cmd("select", id, (w) => {
      if (!rec(w.sb, id)) return;
      w.sb.select(id);
      if (!rec(w.sb, id).detached) w.cleared = false;
    }),
  ),
  setActive: fc.option(fc.constantFrom(...DOCKED), { nil: null }).map((id) =>
    cmd("setActive", id, (w) => {
      const t = id == null ? null : rec(w.sb, id);
      if (id != null && (!t || t.detached)) return;
      w.sb.setActive(id);
      w.cleared = id == null;
      if (t && !t.live) w.sb.setLive(id, true); // the app activated it
    }),
  ),
  selectByOffset: fc.tuple(fc.constantFrom(-1, 1), fc.boolean()).map(([dir, liveOnly]) =>
    cmd("selectByOffset", [dir, liveOnly], (w) => {
      const before = w.selected.length;
      const live = new Set(w.sb.tabs.filter((t) => t.live || t.detached).map((t) => t.id));
      w.sb.selectByOffset(dir, { liveOnly });
      const landed = w.selected.slice(before);
      if (liveOnly) for (const id of landed) assert.ok(live.has(id), `liveOnly cycle landed on cold ${id}`);
      if (landed.length && !rec(w.sb, landed[0]).detached) w.cleared = false;
    }),
  ),
  requestEnd: fc.tuple(idArb, fc.constantFrom("destroy", "suspend")).map(([id, how]) =>
    cmd("requestEnd", [id, how], (w) => w.sb.requestEnd(id, how)),
  ),
  clickPresence: fc.nat(9).map((i) =>
    cmd("clickPresence", i, (w) => {
      const dots = w.sb.list.querySelectorAll(".cc-presence");
      if (dots.length) fire(dots[i % dots.length], "click");
    }),
  ),
};
// Arming and the partial repaints that follow it are where the bugs sit, so they come up more often.
const weighted = [
  ...Object.values(commands),
  ...[commands.setLive, commands.clickFolder, commands.clickFolder, commands.requestEnd, commands.requestEnd, commands.clickPresence],
];

test("state: the DOM stays the projection of the tab records under any operation sequence", (t) => {
  // requestEnd's arm lapse is a real timer; mocked, so a run leaves nothing pending.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fc.assert(
    fc.property(dtoArb, fc.commands(weighted, { maxCommands: 40 }), (first, cmds) => {
      const world = mount();
      pushDto(world, first);
      checkInvariants(world, "first update");
      fc.modelRun(() => ({ model: {}, real: world }), cmds);
    }),
    { numRuns: NUM_RUNS },
  );
});
