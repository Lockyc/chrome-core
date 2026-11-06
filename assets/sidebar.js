// chrome-core — the shared sidebar chrome for curator, warden, lector, and flotilla.
//
// Framework-free: exposes a global `ChromeSidebar` factory (browser) and CommonJS exports (the
// factory + the pure helpers, for node:test). The component renders a window DTO into a mount
// container and reports user intent via callbacks — and it also owns app-agnostic capabilities
// shared by every consuming app (self-update: check/install/relaunch + the re-check cadence),
// feature-detecting the Tauri runtime so the isolated preview.html no-ops. Only app-*type*-specific
// divergence lives in the thin per-app controllers (callback → Tauri command, event → setter),
// never here. See CLAUDE.md's dividing-line decision.
//
// See CLAUDE.md for the interface contract (DTO, callbacks, methods, the fixed dot-slot order).

// ─────────────────────────── pure helpers (unit-tested) ───────────────────────────

/** First alphanumeric of a string, uppercased — the letter on a tab's tile. `•` fallback. */
function tileInitial(s) {
  const m = (s || "").match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "•";
}

/** Deterministic tile colour hashed from the title (stable per project). */
function tileColour(seed) {
  let h = 0;
  const str = seed || "";
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return "hsl(" + (h % 360) + ", 45%, 45%)";
}

/** Parse a #rgb / #rrggbb hex into [r,g,b]. */
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
}

/** Blend a hex colour over an opaque base at `ratio`, returning an OPAQUE rgb(...) — the sidebar
 *  must never carry alpha (a transparent window would leak the wallpaper through the chrome). */
function tintOverBase(hex, ratio, base) {
  const b = base || SIDEBAR_BASE;
  const c = hexToRgb(hex);
  const ch = (i) => Math.round(b[i] * (1 - ratio) + c[i] * ratio);
  return "rgb(" + ch(0) + "," + ch(1) + "," + ch(2) + ")";
}

/** Raise a hex colour's HSL lightness to a floor, preserving hue and saturation. Returns hex.
 *
 *  This is what makes the active-row highlight readable for ANY window colour. The sidebar and the
 *  active row are both tints of the window colour, so a highlight tinted from the *raw* colour has
 *  contrast proportional to that colour's own luminance — near zero for a dark accent. Lifting the
 *  accent to a lightness floor first decouples the highlight's contrast from the accent's
 *  luminance while keeping its hue, so a window still highlights in *its own* colour.
 *
 *  Saturation is deliberately left alone (no floor): a floor would push the neutral no-colour
 *  fallback (`NEUTRAL_COLOUR`, a near-grey slate) into a tinted blue, and every accent saturated
 *  enough to be worth calling a window colour already clears any floor worth setting. */
function liftColour(hex, minL) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  let s = 0;
  let l = (mx + mn) / 2;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  if (l >= minL) return hex;
  l = minL;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const chan = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + to(chan(h + 1 / 3)) + to(chan(h)) + to(chan(h - 1 / 3));
}

/** Clamp a desired sidebar width into [min, min(max, fraction*windowWidth)]. `fraction` caps the
 *  sidebar at a share of the window, but is only meaningful when `windowWidth` (the sidebar view's
 *  own `window.innerWidth`) IS the host window's width — i.e. the sidebar is the window's full-size
 *  main webview. All current consumers (curator, warden, lector, flotilla) are hole-punch main webviews, so
 *  each passes a real `fraction`. A consumer whose sidebar were instead an isolated child webview —
 *  `innerWidth` being just the sidebar's own width — would see this cap collapse below `min` and pin
 *  every drag to the floor; it passes a falsy `fraction` to skip the cap here and enforce its
 *  share-of-window limit backend-side. */
function clampWidth(w, { min, max, fraction, windowWidth }) {
  const upper = fraction ? Math.min(max, windowWidth * fraction) : max;
  return Math.max(min, Math.min(w, upper));
}

/** Resolve a cycle step among `ids` from `active` in direction `dir` (±1), with wraparound. An
 *  unknown active steps in from the end opposite the direction of travel. Null when `ids` is empty. */
function resolveOffset(ids, active, dir) {
  if (!ids.length) return null;
  const cur = ids.indexOf(active);
  const base = cur === -1 ? (dir > 0 ? -1 : 0) : cur;
  return ids[(base + dir + ids.length) % ids.length];
}

/** The tabs the pinned "Open" section mirrors, in the DTO's own order. Open = has a terminal/view
 *  standing: a live local surface, or a detached one (running in its own popped-out window, where
 *  `live` reports only the LOCAL surface and is routinely false). A session probe (`presence`) is
 *  deliberately NOT openness — a cold tab with a live amux session behind it is not open. */
function openTabs(tabs) {
  return (tabs || []).filter((t) => t.live || t.detached);
}

/** The tabs the pinned "Background" section mirrors, in the DTO's own order: the host reports a
 *  session behind the tab — running (`presence: "on"`) or restorable (`"ghost"`) — and nothing is
 *  open. The complement of `openTabs`, so the two sections never mirror the same tab. Opening one
 *  reattaches or restores it and moves it to "Open". */
function backgroundTabs(tabs) {
  return (tabs || []).filter((t) => (t.presence === "on" || t.presence === "ghost") && !t.live && !t.detached);
}

/** The pinned mirror sections, top to bottom. `flag` is the window-DTO field that opts a sidebar
 *  in; `key` names the section's persisted collapse state (`_sectionKey`). */
const MIRROR_SECTIONS = [
  { key: "open", title: "Open", flag: "openSection", members: openTabs, defaultCollapsed: false },
  { key: "background", title: "Background", flag: "backgroundSection", members: backgroundTabs, defaultCollapsed: true },
];

/** A mirror section's `members` arranged for painting, in the order of each entry's first member:
 *  a member of a headed group (`listSections` over the whole list, `tabs`) joins its group's entry,
 *  led by the head whether or not the head is a member itself, so the section's root holds only
 *  heads and ungrouped-by-head rows. → `[{ group, head: TabDTO|null, rows }]`. */
function mirrorEntries(members, tabs) {
  const headOf = new Map();
  for (const sec of listSections(tabs || [])) if (sec.head) headOf.set(sec.group, sec.head);
  const out = [];
  const byGroup = new Map();
  for (const t of members) {
    const head = t.group == null ? null : headOf.get(t.group);
    if (!head) {
      out.push({ group: t.group == null ? null : t.group, head: null, rows: [t] });
      continue;
    }
    let e = byGroup.get(t.group);
    if (!e) {
      e = { group: t.group, head, rows: [] };
      byGroup.set(t.group, e);
      out.push(e);
    }
    if (t.id !== head.id) e.rows.push(t);
  }
  return out;
}

/** Where a tab lives, for its row in the pinned "Open" section: the parent folder of a tree row
 *  (the last `treePath` segment — `treePath` already excludes the project's own dir), else its
 *  group name (a curated group, or the root itself for a project directly under it); null for a
 *  loose tab. A mirror row is lifted out of its section, so without this a title alone is all it
 *  shows — `website` from `rotary/website` is indistinguishable from any other `website`, and two
 *  tabs sharing a title render as two identical rows. */
function mirrorContext(t) {
  const path = t.tree ? t.treePath || [] : [];
  if (path.length) return path[path.length - 1];
  if (t.head) return null; // a group's head IS the group — naming it again says nothing
  const g = groupLabel(t);
  return g == null || g === "" ? null : g;
}

/** A tab's group as shown and searched: `groupName` when the app sends one (flotilla, whose `group`
 *  is the head tab's id), else `group` itself. */
function groupLabel(t) {
  return t.groupName != null ? t.groupName : t.group;
}

/** Write a targeted setter's signal onto the stored tab record, so any later re-render paints from
 *  it. Returns whether a record matched (an unknown id is a no-op, not a throw).
 *
 *  **Load-bearing: `this.tabs` is the state, the DOM is only its projection.** The targeted setters
 *  (`setLive`/`setAttention`/`setPresence`) patch one hot signal without a full re-render, so each
 *  must write it back here as well as to the row. Rows are re-rendered from these records outside
 *  `update()` — a tree section's `repaint` on every folder expand/collapse, a search keystroke — and
 *  a host that emits a signal only *on change* (warden's probe scheduler) never re-sends it, so a
 *  DOM-only patch is lost on the next such repaint. */
function patchTab(tabs, id, patch) {
  const t = (tabs || []).find((x) => x.id === id);
  if (!t) return false;
  Object.assign(t, patch);
  return true;
}

/** A row's dot slots, in their fixed order (CLAUDE.md). */
const DOT_SLOTS = [".cc-attention", ".cc-presence", ".cc-unload-group", ".cc-remove", ".cc-dot"];

/** Insert `node` (the slot `slot`, one of DOT_SLOTS) into `row` before the first later slot the
 *  row has, so a slot added after render keeps the fixed order. */
function insertSlot(row, node, slot) {
  const later = DOT_SLOTS.slice(DOT_SLOTS.indexOf(slot) + 1);
  const before = later.map((sel) => row.querySelector(sel)).find(Boolean) || null;
  row.insertBefore(node, before);
}

/** Does this row carry the end-session confirm controls? Either ending action — ⏻ suspend
 *  (`suspendable`) or ☠ destroy (`killable`) — is enough; the armed row shows both, disabling
 *  whichever can't run. A capability, fixed for the row's life; what can run NOW is `canEnd`. */
function armable(t) {
  return !!(t.killable || t.suspendable);
}

/** Can ⏻ suspend run on `t` right now? Not on a ghost: it is already restorable, with nothing
 *  running to suspend. */
function canSuspend(t) {
  return !!t.suspendable && t.presence !== "ghost";
}

/** Can either ending action run on `t` right now — i.e. may its confirm row arm? ☠ on a ghost
 *  discards the restorable session (warden: the tab's `kill`, which retires amux's restore offer). */
function canEnd(t) {
  return !!t.killable || canSuspend(t);
}

/** What a keyboard request to end `t`'s session does (`requestEnd`), given which row is armed.
 *  ⏻ suspend is restorable, so it fires at once; ☠ destroy is not, so the first request arms the
 *  confirm row and only a second one while that row is armed fires. A request the tab can't honour
 *  arms the row instead, whose disabled control says why; a tab with neither action gets nothing.
 *  → "suspend" | "destroy" | "arm" | null. */
function endIntent(t, how, armedId) {
  if (!t || !canEnd(t)) return null;
  if (how === "suspend") return canSuspend(t) ? "suspend" : "arm";
  if (armedId !== t.id) return "arm";
  return t.killable ? "destroy" : null;
}

/** Class list for a presence dot given session state, the tab's capabilities (`killable`,
 *  `suspendable`, `startable`) and whether it is live. Three states:
 *  `on` = a probe reported a live session → a kill affordance (arms the confirm) when `canEnd`;
 *  `ghost` = no live session, but the host reports a *recoverable* one (warden: a crashed or
 *  suspended amux session a plain launch would offer to restore);
 *  `off` = configured-but-absent.
 *  `on` and `ghost` are mutually exclusive. The *start* affordance (re-run the tab's command) is
 *  offered for BOTH non-`on` states, and only when `startable` AND the tab is `live` — a cold tab
 *  has no shell to type into, and is started by activating the row instead. A ghost without start
 *  takes the kill affordance when `killable` (☠ discards it); a live ghost keeps the click for
 *  start, and reaches ☠ through `requestEnd`. */
function presenceClass(state, caps, live) {
  const on = state === "on";
  const ghost = state === "ghost";
  const t = { ...caps, presence: state };
  let cls = "cc-presence " + (on ? "on" : ghost ? "ghost" : "off");
  const start = !on && !!t.startable && live;
  if (start) cls += " start";
  else if ((on || ghost) && canEnd(t)) cls += " kill";
  return cls;
}

/** Re-derive a dot's presence state ("on" | "ghost" | "off") from its painted class list — the
 *  inverse of `presenceClass`'s state→class mapping, used to repaint a dot (e.g. on a live-state
 *  change) without re-fetching the session state that produced it. Pure — takes a plain array of
 *  class names, not a live classList, so it's testable with no DOM (a caller with a DOMTokenList
 *  passes `Array.from(el.classList)`). Must check BOTH `on` and `ghost`: reading only `on` would
 *  collapse a ghost back to `off` on every repaint, silently losing the recoverable signal. */
function derivePresenceState(classNames) {
  return classNames.includes("on") ? "on" : classNames.includes("ghost") ? "ghost" : "off";
}

/** Opaque dark base the sidebar tint composites over (matches the CSS `.cc-root` fallback). */
const SIDEBAR_BASE = [21, 25, 30]; // #15191e
const NEUTRAL_COLOUR = "#6b7280";

/** Active-row highlight, all three derived from the window colour via `liftColour` (read its
 *  comment first — it carries the why). The fill is the lifted accent mixed over the sidebar base;
 *  the bar is lifted harder because it is only 3px wide and has to carry the highlight on its own
 *  when the fill is subtle. */
const ACTIVE_FILL_MIN_L = 0.42;
const ACTIVE_FILL_MIX = 0.42;
const ACTIVE_BAR_MIN_L = 0.62;

// Pop-out / pop-in icon (svgrepo "pop-in": a window frame + an arrow). The frame is shared; the
// arrow points INTO the frame for pop-in and is reversed (180° about its own centre) to point OUT
// for pop-out. `fill: currentColor` so it inherits `.cc-icon-pop`'s white.
const POP_FRAME =
  "M37,35.3h-4c-0.6,0-1,0.4-1,1v5.5c0,0.1,0,0.1,0,0.2v0.5c0,0.8-0.7,1.5-1.5,1.5h-21C8.7,44,8,43.3,8,42.5v-21C8,20.7,8.7,20,9.4,20h6.3c0.6,0,1-0.4,1-1v-4c0-0.6-0.4-1-1-1H6.2C6.1,14,6,14,6,14c-2.2,0-4,1.8-4,4v28c0,2.2,1.8,4,4,4h28c2.2,0,4-1.8,4-4v-4.2v-2.9v-2.6C38,35.7,37.6,35.3,37,35.3z";
const POP_ARROW =
  "M22,31.3h19.1c0.8,0,1.6-0.5,1.6-1.3v-3c0-0.8-0.7-1.7-1.6-1.7h-7.9c-0.9,0-1.4-1-0.7-1.6l17-17c0.6-0.6,0.6-1.5,0-2.1l-2.1-2.1c-0.6-0.6-1.5-0.6-2.1,0l-17,17c-0.6,0.6-1.6,0.2-1.6-0.7v-7.9c0-0.8-0.8-1.7-1.6-1.7h-2.9c-0.8,0-1.5,0.9-1.5,1.7v19C20.8,30.8,21.2,31.2,22,31.3z";
const POP_IN_SVG = `<svg viewBox="0 0 52 52" fill="currentColor" aria-hidden="true"><path d="${POP_ARROW}"/><path d="${POP_FRAME}"/></svg>`;
const POP_OUT_SVG = `<svg viewBox="0 0 52 52" fill="currentColor" aria-hidden="true"><path transform="rotate(180 31.5 17.65)" d="${POP_ARROW}"/><path d="${POP_FRAME}"/></svg>`;
// The row's remove button: a bin, so it never reads as the live dot's unload ✕ beside it.
const REMOVE_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5"/></svg>`;

// A head row's unload-group button: two stacked dots, the live dot's shape for "every tab here".
const UNLOAD_GROUP_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6" cy="6" r="3.25"/><circle cx="10" cy="10" r="3.25"/></svg>`;

/** Whether group `group` has a tab an unload-group would close: one with a local surface (`live`,
 *  or `active`, which always has one), a popped-out tab excepted since its own window shows it. */
function groupLoaded(tabs, group, active) {
  return (tabs || []).some((t) => t.group === group && !t.detached && (t.live || t.id === active));
}

/** Build a nested folder tree from flat rows carrying `treePath` segment arrays.
 *  Single-child folder chains are compressed (label joined with "/"). Pure — tested. */
function buildTree(rows) {
  const root = { label: "", folders: new Map(), rows: [] };
  for (const r of rows) {
    let node = root;
    for (const seg of r.treePath || []) {
      if (!node.folders.has(seg)) node.folders.set(seg, { label: seg, folders: new Map(), rows: [] });
      node = node.folders.get(seg);
    }
    node.rows.push(r);
  }
  const compress = (node) => {
    let folders = [...node.folders.values()].map(compress);
    // compress a chain: exactly one child folder, no rows here → merge labels
    let self = { label: node.label, folders, rows: node.rows };
    while (self.rows.length === 0 && self.folders.length === 1) {
      const only = self.folders[0];
      self = {
        label: self.label ? `${self.label}/${only.label}` : only.label,
        folders: only.folders,
        rows: only.rows,
      };
    }
    return self;
  };
  // Compress each top-level folder's internal single-child chains, but never
  // merge the anonymous root itself — otherwise a root with one top-level folder
  // would drop that folder's label and surface its projects unnested.
  const folders = [...root.folders.values()].map(compress);
  return { folders, rows: root.rows };
}

/** The folder labels from a tree section's root down to the folder holding tab `id`, as `buildTree`
 *  compresses them (the segments a folder's collapse key is built from); `[]` for a row at the
 *  section's top level, null when `id` is not among `rows`. */
function folderChain(rows, id) {
  const find = (node) => {
    if (node.rows.some((r) => r.id === id)) return [];
    for (const f of node.folders) {
      const c = find(f);
      if (c) return [f.label, ...c];
    }
    return null;
  };
  return find(buildTree(rows));
}

/** Split the tabs into the main list's sections, in paint order — the one sectioning rule both
 *  `_paintList` and `navOrder` walk. A run of consecutive same-`group` tabs whose first row is
 *  `tree: true` (and grouped) is a project-tree section and takes every following row of that group;
 *  any other run of same-`group` rows is a flat section, ended by a group change or a tree row.
 *  `trees` names the window's declared project trees (the DTO's `trees`): one with no rows still
 *  gets its (empty) section, after the rest, so its head and ⟳ stay on screen.
 *  A grouped flat section holding a `head: true` row lifts it out of `rows` into `head`: it paints
 *  in place of the text header, and `rows` are its members.
 *  → `[{ group: string|null, tree: bool, head: TabDTO|null, rows }]`. */
function listSections(tabs, trees = []) {
  const out = [];
  const grp = (t) => (t.group == null ? null : t.group);
  let i = 0;
  while (i < tabs.length) {
    const g = grp(tabs[i]);
    const tree = g !== null && !!tabs[i].tree;
    const start = i++;
    while (i < tabs.length && grp(tabs[i]) === g && (tree || g === null || !tabs[i].tree)) i++;
    let rows = tabs.slice(start, i);
    const head = !tree && g !== null ? rows.find((t) => t.head) || null : null;
    if (head) rows = rows.filter((t) => t !== head);
    out.push({ group: g, tree, head, rows });
  }
  for (const g of trees) {
    if (!out.some((s) => s.tree && s.group === g)) out.push({ group: g, tree: true, head: null, rows: [] });
  }
  return out;
}

/** Every tab id in the main list's paint order, as if every tree folder were expanded: a tree
 *  section paints a node's own rows before its child folders (`_paintTreeNode`), so a tab inside a
 *  collapsed folder still has a place in the order without having a row in the DOM. A headed group
 *  named in `collapsed` contributes only its head — its members are hidden by the user's choice,
 *  not by a default, so cycling passes over them. */
function navOrder(tabs, collapsed = []) {
  return navSections(tabs, collapsed).order;
}

/** The id `navOrder` places for tab `id`: its group's head when `id` is a member hidden by
 *  `collapsed`, else `id` itself (unknown ids included). */
function navAnchor(tabs, collapsed, id) {
  return navSections(tabs, collapsed).anchor.get(id) || id;
}

/** `navOrder`'s walk, plus the hidden-member → head map `navAnchor` reads. */
function navSections(tabs, collapsed = []) {
  const out = [];
  const anchor = new Map();
  const walk = (node) => {
    for (const r of node.rows) out.push(r.id);
    for (const f of node.folders) walk(f);
  };
  for (const sec of listSections(tabs)) {
    if (sec.tree) walk(buildTree(sec.rows));
    else {
      if (sec.head) out.push(sec.head.id);
      const hidden = sec.head && collapsed.includes(sec.group);
      for (const r of sec.rows) {
        if (hidden) anchor.set(r.id, sec.head.id);
        else out.push(r.id);
      }
    }
  }
  return { order: out, anchor };
}

/** The tabs the search field keeps for `query`: every whitespace-separated term must appear,
 *  case-insensitively, in the tab's title, its tree path (tree rows only), or its group's label
 *  (`groupLabel`). An empty query returns `tabs` itself — the unfiltered list, not a copy. */
function filterTabs(tabs, query) {
  const terms = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return tabs;
  return (tabs || []).filter((t) => {
    const hay = [t.title, t.tree ? (t.treePath || []).join("/") : "", groupLabel(t)].join(" ").toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/** One tree section's rows as `id → title` — the snapshot a rescan's outcome is diffed against. */
function treeRows(tabs, group) {
  return new Map((tabs || []).filter((t) => t.tree && t.group === group).map((t) => [t.id, t.title]));
}

/** What a rescan changed, `before` → `after` (both `treeRows` maps): `text` is the tree-head's
 *  status ("+2 −1" / "No changes"), `tip` names the projects behind the counts. */
function rescanSummary(before, after) {
  const added = [...after].filter(([id]) => !before.has(id)).map(([, title]) => title);
  const removed = [...before].filter(([id]) => !after.has(id)).map(([, title]) => title);
  const counts = [];
  const tip = [];
  if (added.length) {
    counts.push("+" + added.length);
    tip.push("Added: " + added.join(", "));
  }
  if (removed.length) {
    counts.push("−" + removed.length);
    tip.push("Removed: " + removed.join(", "));
  }
  return { text: counts.length ? counts.join(" ") : "No changes", tip: tip.join("\n") };
}

// ─────────────────────────── the component ───────────────────────────

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (text != null) node.textContent = text;
  return node;
}

// Self-update re-check cadence: a long-running window re-checks this often so a release surfaces
// without a restart (the single home for the interval, shared by every consuming app).
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// How long a keyboard-armed confirm row (`requestEnd`) stays armed before it lapses on its own.
const KEY_ARM_TIMEOUT_MS = 4000;

// How long a tree-head shows a finished rescan's outcome ("+2 −1" / "No changes").
const RESCAN_STATUS_MS = 4000;

// A collapsed sidebar peeks once the pointer has rested this long on the rail, so brushing the
// window's left edge on the way to the content doesn't fling it open.
const PEEK_DELAY_MS = 150;
// A peek survives the pointer leaving the sidebar for this long, so a wobble past its edge onto
// the chrome page doesn't close it. (Onto the content is `pointerAway`, which closes at once.)
const PEEK_LEAVE_MS = 200;
// The collapsed rail's looks (DTO `rail`), the first the default: the titlebar strip's colour
// carried down the edge, with a chevron; the bare edge; a column of marks, one per tab.
const RAIL_STYLES = ["handle", "edge", "map"];
// A pressed row lifts into a drag once the pointer has moved this far, so a click stays a click.
const DRAG_START_PX = 5;
// While dragging, the list scrolls this far per move with the pointer this close to its top or bottom.
const DRAG_SCROLL_EDGE = 28;
const DRAG_SCROLL_STEP = 12;

/** The localStorage key holding whether window `title`'s sidebar is collapsed ("1"; absent =
 *  expanded). Per window, so each restores its own. */
function collapseKey(storageKey, title) {
  return `${storageKey}:collapsed:${title}`;
}

// The header's icons: 18px, 2px round stroke in `currentColor`.
const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

// The title row's nav buttons, in the order they render whichever subset `nav` asks for.
const NAV_BUTTONS = [
  { action: "back", name: "Back", icon: svgIcon('<path d="M15 18l-6-6 6-6"/>') },
  { action: "forward", name: "Forward", icon: svgIcon('<path d="M9 6l6 6-6 6"/>') },
  { action: "reload", name: "Reload", icon: svgIcon('<path d="M21 12a9 9 0 1 1-2.6-6.36"/><path d="M21 3v6h-6"/>') },
  { action: "home", name: "Home", icon: svgIcon('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>') },
];
const DOWNLOADS_ICON = svgIcon('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>');
const SIDEBAR_ICON = svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>');

class Sidebar {
  constructor(container, callbacks, config) {
    this.root = container;
    this.cb = callbacks || {};
    this.cfg = Object.assign(
      {
        nav: [], urlField: null, downloads: false, appName: null, emptyState: null, hole: null,
        minWidth: 120, maxWidth: 400, maxFraction: 0.4, defaultWidth: 240, autoUpdate: false,
        // Timer seam for the peek's delays; tests pass one they drive by hand.
        clock: { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
      },
      config || {}
    );
    // Collapse (see "collapse"): opt-in by handing over the content hole the sidebar gives way to.
    this.holeEl = this.cfg.hole;
    this.sidebarCollapsed = false;
    this._peeking = false;
    this._pointerInside = false;
    this._railTimer = null;
    this._leaveTimer = null;
    this._collapseTitle = null;
    this.active = null;
    this.armedKill = null;
    this.armedRemove = null;
    this.windowColour = NEUTRAL_COLOUR;
    this.tabs = [];
    this.collapsed = [];
    this.dropSections = [];
    // Moving a row by dragging it (see "drag to move"): the row pressed but not yet dragged, and the
    // drag under way. Listened for on `window`, so a drag carries on past the row it began on.
    this._dragPress = null;
    this._drag = null;
    this._swallowClick = false;
    this._onDragMove = (e) => this._dragMove(e);
    this._onDragEnd = () => this._dragEnd(true);
    this._onDragKey = (e) => {
      if (e.key === "Escape" && this._drag) this._dragEnd(false);
    };
    window.addEventListener("mousemove", this._onDragMove);
    window.addEventListener("mouseup", this._onDragEnd);
    window.addEventListener("keydown", this._onDragKey);
    // The search field's text (see "search"); `this.tabs` stays whole, the list paints the filtered
    // view. `_cursor` is the id Enter would open — the highlighted match.
    this.query = "";
    this._cursor = null;
    this._lastWidth = 0;
    // Per tree section (`group`): the rescan in flight or just finished — `{ before, busy, failed,
    // timer }` — so its spinner/outcome survive the repaint the rescan itself triggers. `_rescanEls`
    // is the current paint's head controls for each group, rebuilt by `_paintList`.
    this._rescans = new Map();
    this._rescanEls = new Map();
    // Self-update state (see the "self-update" section): the pending Update from a successful check,
    // a per-session dismissal flag, an install-in-progress flag, and the recurring-check timer handle.
    this._pendingUpdate = null;
    this._installing = false;
    this._updateDismissed = false;
    this._updateTimer = null;
    // When the host last reported the pointer leaving (`pointerAway`); 0 = never.
    this._awayAt = 0;
    this.emptyEl = this.cfg.emptyState;
    if (this.emptyEl) this.emptyEl.classList.add("cc-empty-state");
    this._buildShell();
    this._initResize();
    this._restoreWidth();
    this._startUpdater();
  }

  _buildShell() {
    this.root.classList.add("cc-root");
    this.root.innerHTML = "";
    // Any pointer activity inside the chrome cancels `cc-away` (see `pointerAway`) — the page can
    // see the pointer again, so `:hover` is authoritative from here. STALE moves must not cancel
    // it: the host's signal and the page's own pointer events arrive by different routes (an IPC
    // hop vs. the webview's event queue), so a move the page queued while the pointer was still
    // inside can be dispatched *after* the away signal. An event older than the away signal
    // describes where the pointer was, so it decides nothing; `timeStamp` shares
    // `performance.now()`'s time origin.
    this.root.addEventListener("pointermove", (e) => {
      if (e.timeStamp < this._awayAt) return;
      this.root.classList.remove("cc-away");
      this._pointerInside = true;
    });
    // The traffic-light strip. Only exists when the consumer names itself or can collapse (the strip
    // is what stays on screen collapsed) — any other host renders exactly as before.
    this.titlebarEl = this.cfg.appName || this.holeEl ? el("div", { id: "cc-titlebar" }) : null;
    this.titlebarName = null;
    this.sidebarToggle = null;
    if (this.titlebarEl) {
      this.titlebarName = el("span", { class: "cc-titlebar-name" }, this.cfg.appName || "");
      if (this.holeEl) {
        this.sidebarToggle = el("button", { class: "cc-sidebar-toggle" });
        this.sidebarToggle.innerHTML = SIDEBAR_ICON;
        this.sidebarToggle.addEventListener("click", () => this.toggleSidebar());
        this.titlebarEl.appendChild(this.sidebarToggle);
      }
      this.titlebarEl.appendChild(this.titlebarName);
    }
    this.banner = el("div", { id: "cc-banner" });
    // Right-click on the window title row → the app's own menu (opt-in, like `onContextMenu`).
    // `data-tauri-drag-region` only claims left-button mousedown, so the event still arrives.
    if (this.cb.onBannerMenu) {
      this.banner.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.cb.onBannerMenu({ x: e.clientX, y: e.clientY });
      });
    }
    this._buildHeader();
    this.errorBar = el("div", { id: "cc-error" });
    // Error text + a dismiss (×) button, so any surfaced error (config, update-check, …) can be
    // cleared by the user rather than lingering until something else clears it.
    this._errorText = el("span", { id: "cc-error-text" });
    this._errorClose = el("button", { id: "cc-error-close", "aria-label": "Dismiss" });
    this._errorClose.textContent = "×";
    this._errorClose.addEventListener("click", () => this.clearError());
    this.errorBar.append(this._errorText, this._errorClose);
    // Update bar: shown by setUpdate() when the component's own updater finds a newer release
    // (self-update is a core-owned capability — see the "self-update" section). Clicking the button
    // downloads/installs/relaunches; the × dismisses for the session.
    this.updateBar = el("div", { id: "cc-update" });
    this._updateText = el("span", { id: "cc-update-text" });
    this._updateBtn = el("button", { id: "cc-update-btn" });
    this._updateBtn.textContent = "Update & Relaunch";
    this._updateBtn.addEventListener("click", () => {
      // Immediate feedback: the download/install/relaunch takes a beat, so reflect the working state.
      this._updateBtn.disabled = true;
      this._updateBtn.textContent = "Updating…";
      this._installUpdate();
    });
    // Dismiss (×): hide the update bar and suppress auto re-surfacing for the session (in-memory, so
    // it resets next launch; the menu check clears it and re-surfaces).
    this._updateClose = el("button", { id: "cc-update-close", "aria-label": "Dismiss" });
    this._updateClose.textContent = "×";
    this._updateClose.addEventListener("click", () => {
      this.clearUpdate();
      this._updateDismissed = true;
    });
    this.updateBar.append(this._updateText, this._updateBtn, this._updateClose);
    this.searchEl = el("div", { id: "cc-search" });
    this.searchInput = el("input", { type: "text", placeholder: "Search", spellcheck: "false", autocomplete: "off", "aria-label": "Search tabs" });
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput.value;
      this.searchClear.disabled = !this.query;
      this._cursor = null;
      this._paintList();
    });
    this.searchInput.addEventListener("keydown", (e) => this._onSearchKey(e));
    // Always rendered; disabled while the field is empty (`_clearSearch` / the input handler sync it).
    this.searchClear = el("button", { id: "cc-search-clear", "aria-label": "Clear search", disabled: "" });
    this.searchClear.textContent = "×";
    this.searchClear.addEventListener("click", () => {
      this._clearSearch();
      this.searchInput.focus();
    });
    this.searchEl.append(this.searchInput, this.searchClear);
    this.list = el("div", { id: "cc-tab-list" });
    this.resizeEl = el("div", { id: "cc-resize" });
    if (this.titlebarEl) this.root.append(this.titlebarEl);
    this.root.append(this.banner, this.errorBar, this.updateBar, this.searchEl, this.list, this.resizeEl);
    if (this.holeEl) this._initCollapse();
  }

  /** The banner's contents: the title row (name, then `.cc-title-controls` right-aligned: the
   *  downloads button when there is no URL field, then the `nav` pill) and, with `urlField`, the
   *  toolbar row under it (the field at full width, then the downloads button). The controls are one
   *  element so they wrap together onto their own line when the name would be crushed. Every part is
   *  opt-in through mount config. */
  _buildHeader() {
    this.titleRow = el("div", { class: "cc-title-row" });
    this.nameEl = el("span", { class: "cc-name" });
    this.titleRow.appendChild(this.nameEl);
    this.banner.appendChild(this.titleRow);

    this.navBtns = [];
    const wanted = this.cfg.nav || [];
    for (const b of NAV_BUTTONS.filter((n) => wanted.includes(n.action))) {
      const btn = el("button", { class: "cc-nav-btn", "data-nav": b.action, "aria-label": b.name });
      btn.innerHTML = b.icon;
      btn.dataset.name = b.name;
      btn.addEventListener("click", () => {
        if (!btn.classList.contains("off") && this.cb.onNav) this.cb.onNav(b.action);
      });
      this.navBtns.push(btn);
    }
    this.setNavEnabled(false);

    this.downloadsBtn = null;
    if (this.cfg.downloads) {
      this.downloadsBtn = el("button", { class: "cc-downloads", "aria-label": "Downloads" });
      this.downloadsBtn.title = "Downloads";
      this.downloadsBtn.innerHTML = DOWNLOADS_ICON;
      this.downloadsBtn.addEventListener("click", () => {
        const r = this.downloadsBtn.getBoundingClientRect();
        if (this.cb.onDownloads) this.cb.onDownloads({ x: r.left, y: r.top, width: r.width, height: r.height });
      });
    }

    this.toolbarEl = null;
    this.urlInput = null;
    if (this.cfg.urlField) {
      const placeholder = this.cfg.urlField.placeholder || "";
      this.toolbarEl = el("div", { id: "cc-toolbar" });
      this.urlInput = el("input", {
        class: "cc-url", type: "text", placeholder, "aria-label": placeholder, spellcheck: "false", autocomplete: "off",
      });
      this.urlInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || !this.cb.onUrlSubmit) return;
        Promise.resolve(this.cb.onUrlSubmit(this.urlInput.value))
          .then(() => {
            this.urlInput.value = "";
            this.clearError();
          })
          .catch((err) => this.setError(String(err)));
      });
      this.toolbarEl.appendChild(this.urlInput);
      if (this.downloadsBtn) this.toolbarEl.appendChild(this.downloadsBtn);
      this.banner.appendChild(this.toolbarEl);
    }

    this.titleControls = null;
    const onTitle = [];
    if (this.downloadsBtn && !this.toolbarEl) onTitle.push(this.downloadsBtn);
    if (this.navBtns.length) {
      const pill = el("div", { class: "cc-nav" });
      pill.append(...this.navBtns);
      onTitle.push(pill);
    }
    if (onTitle.length) {
      this.titleControls = el("div", { class: "cc-title-controls" });
      this.titleControls.append(...onTitle);
      this.titleRow.appendChild(this.titleControls);
    }
  }

  /** Enable the nav buttons while there is a tab for them to act on. Off, a button is `aria-disabled`
   *  (`.off`) rather than `disabled`, which in WebKit would also drop its tooltip, the reason. */
  setNavEnabled(enabled) {
    for (const b of this.navBtns) {
      b.classList.toggle("off", !enabled);
      b.setAttribute("aria-disabled", String(!enabled));
      b.title = enabled ? b.dataset.name : `${b.dataset.name} — no tab open`;
    }
  }

  /** Focus the URL field with its text selected (no-op without `urlField`). */
  focusUrlField() {
    if (!this.urlInput) return;
    if (this.sidebarCollapsed) this._setPeek(true);
    this.urlInput.focus();
    this.urlInput.select();
  }

  /** The downloads button's state: a spinner ring while any download runs, and a dot when finished
   *  ones are unseen — red when a failure is among them, else blue. */
  setDownloads({ active, unseen, unseenFailed } = {}) {
    if (!this.downloadsBtn) return;
    const c = this.downloadsBtn.classList;
    c.toggle("cc-dl-active", !!active);
    c.toggle("cc-dl-failed", !!unseenFailed);
    c.toggle("cc-dl-unseen", !!unseen && !unseenFailed);
  }

  /** The pointer has left the sidebar, as reported by the HOST rather than observed by the page.
   *
   * Hover state here is CSS (every `:hover` rule in sidebar.css), and CSS only recomputes it when
   * the page receives a pointer event. Any view a host composites above the chrome webview —
   * warden's terminal `NSView`, curator's content webviews — takes the pointer the moment it
   * crosses out of the chrome, so a fast exit delivers no further event to the page and `:hover`
   * stays set; `cc-away` on the root suppresses every hover rule until the pointer is back.
   *
   * The host calls this from the signal it *can* see (its own native mouse-entered), and the next
   * pointer event inside the chrome clears it again. A host with nothing above the chrome
   * (preview.html) never calls it and loses nothing. */
  pointerAway() {
    // Timestamped so a pointer event the page queued *before* this — see the pointermove listener
    // in `_buildShell` — can't cancel it on arrival.
    this._awayAt = performance.now();
    this.root.classList.add("cc-away");
    this._pointerInside = false;
    this._endPeekUnlessTyping();
  }

  // ── rendering ──

  /** Toggle the Tauri window-drag attribute on a non-interactive chrome node (see `update`). */
  _setDrag(node, on) {
    if (on) node.setAttribute("data-tauri-drag-region", "");
    else node.removeAttribute("data-tauri-drag-region");
  }

  /** Full render from a window DTO. The one render path (init + hot-reload). */
  update(dto) {
    this._disarmKill();
    const prevActive = this.active;
    this.windowColour = dto.colour || NEUTRAL_COLOUR;
    this.tabs = dto.tabs || [];
    document.documentElement.setAttribute("data-density", dto.density || "comfortable");
    // On the root element, like density: the hole beside the sidebar reads the rail's width too.
    this.railStyle = RAIL_STYLES.includes(dto.rail) ? dto.rail : RAIL_STYLES[0];
    if (this.holeEl) document.documentElement.setAttribute("data-rail", this.railStyle);
    this.toggleCount = dto.toggleCount === true;
    if (this.emptyEl) this.emptyEl.classList.toggle("cc-shown", !dto.active);

    this.nameEl.textContent = dto.title || "";
    if (this.holeEl && dto.title !== this._collapseTitle) this._restoreCollapse(dto.title);
    this.banner.style.background = this.windowColour;
    if (this.titlebarEl) this.titlebarEl.style.background = this.windowColour;
    this.root.style.setProperty("--cc-window", this.windowColour); // a `handle` rail continues the strip
    const tint = tintOverBase(this.windowColour, 0.12);
    this.root.style.background = tint;
    // Active-row highlight — the ONE place it is computed. `_paint` only toggles the `.active`
    // class; the CSS reads these two vars, so the ratios live here and nowhere else.
    this.root.style.setProperty(
      "--cc-active-bg",
      tintOverBase(liftColour(this.windowColour, ACTIVE_FILL_MIN_L), ACTIVE_FILL_MIX),
    );
    this.root.style.setProperty("--cc-active-bar", liftColour(this.windowColour, ACTIVE_BAR_MIN_L));

    // Window-move drag surface. Unless `windowDrag` is explicitly false, the NON-interactive chrome
    // (banner, its title row + toolbar, name, the list's empty area, group headers) carries `data-tauri-drag-region`
    // so a drag on it moves the host window (macOS: double-click zooms) — Tauri drags only when the
    // mousedown TARGET itself has the attribute, so interactive descendants (rows, dots, buttons, the
    // resize handle) stay attribute-free and clickable. Defaults ON when the field is absent (standard
    // macOS sidebar behaviour); a consumer opts out with `windowDrag: false`. warden drives it from
    // its `sidebar_drag` config. Applied every render so a hot-reload toggle takes effect; group
    // headers get it in the loop below, and the two SECTIONS get it where they are built — the
    // list's own box is fully covered by them, so the empty area a user actually grabs belongs to
    // a section, not to `this.list`.
    const drag = dto.windowDrag !== false;
    if (this.titlebarEl) this._setDrag(this.titlebarEl, drag);
    if (this.titlebarName) this._setDrag(this.titlebarName, drag);
    this._setDrag(this.banner, drag);
    this._setDrag(this.titleRow, drag);
    this._setDrag(this.nameEl, drag);
    if (this.titleControls) this._setDrag(this.titleControls, drag);
    if (this.toolbarEl) this._setDrag(this.toolbarEl, drag);
    this._setDrag(this.list, drag);

    this.openSection = dto.openSection === true;
    this.backgroundSection = dto.backgroundSection === true;
    this.trees = dto.trees || [];
    this.incoming = dto.incoming || [];
    this.dropSections = dto.dropSections || [];
    // Headed groups whose members are hidden. The app owns this (it persists it and answers each
    // `onToggleGroup` with a fresh DTO); the component only reads it, so every `update` is authoritative.
    this.collapsed = dto.collapsed || [];
    this.tint = tint;
    this.drag = drag;

    // Active selection has two ownership models. When the DTO carries `active`, the APP owns it
    // (curator: its Rust side is authoritative via get_tabs) — honour it and do NOT fire onSelect.
    // When `active` is absent, the COMPONENT owns it (warden): preserve the current selection, fall
    // back to the first tab if it vanished, and fire onSelect so the app activates the fallback.
    // Resolved BEFORE the list paints: `_paint` lights the active row's dot, so painting with the
    // outgoing active would re-light a tab the app just unloaded.
    if (dto.active !== undefined) {
      this.active = dto.active;
    } else if (!this.tabs.find((t) => t.id === this.active)) {
      // Never a detached tab: the highlight stays off popped-out rows, as in select().
      const first = this.tabs.find((t) => !t.detached);
      this.active = first ? first.id : null;
    }
    // `_paintList` replaces both scroll containers, so carry their offsets across — a hot-reload or
    // rescan must not jump a scrolled list back to the top. (A search repaint starts at the top.)
    const mainTop = this.mainEl ? this.mainEl.scrollTop : 0;
    const openTop = this.openEl ? this.openEl.scrollTop : 0;
    const incomingTop = this.incomingEl ? this.incomingEl.scrollTop : 0;
    this._paintList();
    if (this.incomingEl) this.incomingEl.scrollTop = incomingTop;
    if (this.mainEl) this.mainEl.scrollTop = mainTop;
    if (this.openEl) this.openEl.scrollTop = openTop;
    this._paintTitlebarName();
    this._paintNotice();
    if (dto.active === undefined && this.active && this.active !== prevActive && this.cb.onSelect) {
      this.cb.onSelect(this.active, { wasActive: false });
    }
  }

  /** The tabs the list shows: `this.tabs` narrowed by the search field. */
  _shown() {
    return filterTabs(this.tabs, this.query);
  }

  /** Rebuild both sections from `_shown()` — `update()`'s list half, and the search field's repaint.
   *  Selection is untouched: a filtered-out active tab stays active, it just has no row. */
  _paintList() {
    this._disarmKill();
    const tint = this.tint;
    const drag = this.drag;
    const tabs = this._shown();
    this.list.innerHTML = "";
    this._rescanEls = new Map();
    this._paintIncoming();
    // The pinned mirror sections ("Open", "Background"), each opt-in per window DTO. They live in
    // one container at the top of the list so `setLive`/`setPresence` can rebuild JUST them when a
    // tab's membership changes, without a full re-render.
    this.openEl = el("div", { class: "cc-open" });
    this._setDrag(this.openEl, drag);
    this.list.appendChild(this.openEl);
    this._paintMirrorSections();
    // Everything that is not the pinned section lives in one container, so the CSS can address
    // "the main list" as a unit — it is the hover target that lifts the de-emphasis the pinned
    // section puts on it, and it restores `.cc-group:first-child` to meaning the first header of
    // the main list (the pinned section would otherwise always be the list's first child).
    // It is also its own scroll container: the two sections scroll INDEPENDENTLY, so paging through
    // a long project list never pushes the open tabs off the top (see the CSS).
    this.mainEl = el("div", { class: "cc-main" });
    this._setDrag(this.mainEl, drag);
    this.list.appendChild(this.mainEl);

    // A search shows only what matches, so an empty declared tree is not painted under one.
    const searching = !!this.query.trim();
    // Drag to move (opt-in by `onMoveTab`): off under a search, which shows only part of each group.
    const moving = !!this.cb.onMoveTab && !searching;
    for (const sec of listSections(tabs, searching ? [] : this.trees)) {
      if (sec.tree) {
        this._renderTreeSection(sec.group, sec.rows, tint, drag);
        continue;
      }
      const target = (node) => {
        if (moving && sec.group !== null) node.setAttribute("data-drop-group", sec.group);
        return node;
      };
      if (sec.head) {
        // A search shows every match, so it opens a collapsed group without touching `collapsed`.
        const collapsed = !searching && this.collapsed.includes(sec.group);
        this.mainEl.appendChild(target(this._renderHead(sec, collapsed, searching)));
        if (collapsed) continue;
      } else if (sec.group !== null) {
        const h = el("div", { class: "cc-group" }, groupLabel(sec.rows[0]));
        h.style.background = tint; // sticky header matches the tinted sidebar
        this._setDrag(h, drag);
        this.mainEl.appendChild(target(h));
      }
      for (const t of sec.rows) {
        const r = target(this._renderRow(t));
        if (sec.head) r.classList.add("cc-member");
        if (moving && t.movable && !t.head) this._armMove(r, t, sec.group);
        this.mainEl.appendChild(r);
      }
    }
    if (!tabs.length && this.query.trim()) {
      this.mainEl.appendChild(el("div", { class: "cc-search-empty" }, "No tabs match \u201c" + this.query.trim() + "\u201d"));
    }
    this._paint();
    this._paintDrag();
  }

  // \u2500\u2500 drag to move (opt-in: `onMoveTab`, rows marked `movable`) \u2500\u2500
  //
  // Pressing a `movable` row and dragging it past `DRAG_START_PX` lifts it: a ghost of the row
  // follows the pointer, and every row and header of the section under it (`data-drop-group`) lights
  // as the drop target. Releasing there reports `onMoveTab(id, group)`; the component moves nothing
  // itself, the app answers with `update(dto)`. The section the row is in is never a target, and
  // Escape, a release anywhere else, or a release outside the page (seen as a move with no button
  // down) cancels. `dropSections` (`{ group, label }`) are targets that have no rows to show yet,
  // painted as drop zones at the top of the list only while a row is lifted. Mouse events rather
  // than HTML5 drag and drop: WebKit hands those to the host's file-drop handling, and a click
  // must still select.

  /** Make `row` (tab `t`, in section `group`) pressable to drag. */
  _armMove(row, t, group) {
    row.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest("button, .cc-icon-pop, input")) return;
      this._dragPress = { id: t.id, group, title: t.title, x: e.clientX, y: e.clientY };
    });
  }

  _dragMove(e) {
    const press = this._dragPress;
    if (!press) return;
    if (e.buttons === 0) return this._dragEnd(false);
    if (!this._drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_START_PX) return;
      this._drag = { ...press, over: null, ghost: el("div", { class: "cc-drag-ghost" }, press.title || "") };
      this.root.appendChild(this._drag.ghost);
      this._paintDrag();
    }
    const d = this._drag;
    d.ghost.style.left = e.clientX + 12 + "px";
    d.ghost.style.top = e.clientY + 4 + "px";
    const hit = e.target && e.target.closest ? e.target.closest("[data-drop-group]") : null;
    const group = hit ? hit.getAttribute("data-drop-group") : null;
    const over = group !== null && group !== d.group ? group : null;
    if (over !== d.over) {
      d.over = over;
      this._paintDrag();
    }
    // Near the list's top or bottom edge, scroll it, so a drag reaches a group off screen.
    if (this.mainEl && this.mainEl.getBoundingClientRect) {
      const r = this.mainEl.getBoundingClientRect();
      if (r.height && e.clientY < r.top + DRAG_SCROLL_EDGE) this.mainEl.scrollTop -= DRAG_SCROLL_STEP;
      else if (r.height && e.clientY > r.bottom - DRAG_SCROLL_EDGE) this.mainEl.scrollTop += DRAG_SCROLL_STEP;
    }
  }

  /** End the press or drag; `drop` reports the move when the pointer is over a target. */
  _dragEnd(drop) {
    const d = this._drag;
    this._dragPress = null;
    if (!d) return;
    this._drag = null;
    d.ghost.remove();
    this._paintDrag();
    // The release that ends a drag must not also select the row it lands on.
    this._swallowClick = true;
    setTimeout(() => (this._swallowClick = false), 0);
    if (drop && d.over !== null) this.cb.onMoveTab(d.id, d.over);
  }

  /** Bring the list's drag decoration in line with `_drag`: the lifted row, the lit target, and the
   *  `dropSections` zones. Run after every paint, so a repaint mid-drag keeps it. */
  _paintDrag() {
    if (!this.mainEl) return;
    const d = this._drag;
    for (const z of this.mainEl.querySelectorAll(".cc-drop-zone")) z.remove();
    for (const n of this.mainEl.querySelectorAll(".cc-drop-over")) n.classList.remove("cc-drop-over");
    for (const n of this.mainEl.querySelectorAll(".cc-drag-source")) n.classList.remove("cc-drag-source");
    if (!d) {
      if (this.list.classList.contains("cc-dragging")) this.list.classList.remove("cc-dragging");
      return;
    }
    this.list.classList.add("cc-dragging");
    const painted = new Set([...this.mainEl.querySelectorAll("[data-drop-group]")].map((n) => n.getAttribute("data-drop-group")));
    const zones = this.dropSections.filter((s) => !painted.has(s.group));
    for (const s of zones.reverse()) {
      const zone = el("div", { class: "cc-drop-zone", "data-drop-group": s.group }, s.label);
      this.mainEl.insertBefore(zone, this.mainEl.firstChild);
    }
    for (const n of this.mainEl.querySelectorAll(".cc-tab")) {
      if (n.dataset.id === d.id) n.classList.add("cc-drag-source");
    }
    if (d.over === null) return;
    for (const n of this.mainEl.querySelectorAll("[data-drop-group]")) {
      if (n.getAttribute("data-drop-group") === d.over) n.classList.add("cc-drop-over");
    }
  }

  // ── the pinned mirror sections (opt-in per section: `openSection` / `backgroundSection`) ──

  /** Rebuild every pinned section (`MIRROR_SECTIONS`) from `_shown()` — per section, a header plus a
   *  MIRROR row for each member unless the section is collapsed, headed groups' members nested under
   *  their head (`mirrorEntries`).
   *
   *  The rows are duplicates: a mirrored tab keeps its row in its own group/tree as well, so the main
   *  list never shuffles as membership comes and goes. **The DTO is not duplicated** — `this.tabs`
   *  stays one record per tab, so `patchTab` and every id → record lookup are unaffected. What IS
   *  newly true is that one id can own TWO rows, which is why row lookup is `_rowsById` (plural, every
   *  match) and why the mirrors carry `data-mirror` so keyboard nav can skip them (they would
   *  otherwise shift every ⌘1–9 index and make live-only cycling visit each mirrored tab twice).
   *
   *  Membership is a function of `live`/`detached`/`presence`, so it changes on a targeted `setLive`
   *  or `setPresence` as well as a full `update()` — each repaints every section rather than patching
   *  a row in or out, which is cheap (mirrored tabs are few) and keeps the order derived from one
   *  place. `data-rows` on the container marks an expanded section with rows: the CSS dims the main
   *  list only then, never under a lone collapsed header. */
  _paintMirrorSections() {
    if (!this.openEl) return;
    // Wiping an armed mirror row would leave armedKill set with no confirm UI, so the next dot
    // click does nothing and requestEnd destroys unconfirmed. An armed main-list row is untouched.
    if (this.openEl.querySelector(".cc-tab.confirming")) this._disarmKill();
    this.openEl.innerHTML = "";
    let anyRows = false;
    const searching = !!this.query.trim();
    const add = (row) => {
      row.dataset.mirror = "1";
      this.openEl.appendChild(row);
    };
    for (const spec of MIRROR_SECTIONS) {
      if (!this[spec.flag]) continue;
      const rows = spec.members(this._shown());
      if (!rows.length) continue; // no header over an empty section
      const collapsed = this._sectionCollapsed(spec);
      this.openEl.appendChild(this._renderSectionHead(spec, collapsed));
      if (collapsed) continue;
      anyRows = true;
      for (const e of mirrorEntries(rows, this.tabs)) {
        if (!e.head) {
          add(this._renderRow(e.rows[0], mirrorContext(e.rows[0])));
          continue;
        }
        // The group's collapse state is the app's one `collapsed`, shared with the main list.
        const hidden = !searching && this.collapsed.includes(e.group);
        add(this._renderHead(e, hidden, searching));
        if (hidden) continue;
        for (const t of e.rows) {
          const r = this._renderRow(t);
          r.classList.add("cc-member");
          add(r);
        }
      }
    }
    this.openEl.toggleAttribute("data-rows", anyRows);
  }

  /** A mirror section's sticky header: a disclosure arrow followed by its title. A click anywhere on
   *  it flips and persists the section's collapse state, then repaints the sections — like a tree
   *  folder row, so it carries no drag region (a drag region turns the mousedown into a window drag). */
  _renderSectionHead(spec, collapsed) {
    const head = el("div", { class: "cc-group cc-section-head" });
    head.style.background = this.tint; // sticky header matches the tinted sidebar
    if (collapsed) head.setAttribute("data-collapsed", "");
    const arrow = el("button", {
      class: "cc-disclosure",
      type: "button",
      "aria-expanded": String(!collapsed),
      title: collapsed ? "Expand section" : "Collapse section",
    });
    arrow.appendChild(el("span", { class: "cc-chevron" }));
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      localStorage.setItem(this._sectionKey(spec.key), collapsed ? "0" : "1");
      this._paintMirrorSections();
      this._paint(); // the rebuilt mirrors carry none of `_paint`'s decoration (.active, live upgrade)
    });
    head.append(arrow, el("span", { class: "cc-section-label" }, spec.title));
    return head;
  }

  /** The localStorage key holding a mirror section's collapse state, per mounted sidebar. */
  _sectionKey(key) {
    return "cc-section:" + (this.cfg.storageKey || "") + ":" + key;
  }

  /** Persisted collapse state for a mirror section (`"1"` collapsed, `"0"` expanded, same encoding
   *  as `_treeCollapsed`); the section's `defaultCollapsed` until the user has toggled it. */
  _sectionCollapsed(spec) {
    const v = localStorage.getItem(this._sectionKey(spec.key));
    if (v === "1") return true;
    if (v === "0") return false;
    return spec.defaultCollapsed;
  }

  // ── project-tree sections (a group whose rows are `tree: true`) ──

  /** Render a tree-head (group label + rescan control) followed by the nested folder body for one
   *  contiguous run of `tree: true` rows sharing `group` — or for a declared tree with no rows,
   *  whose body is the "No projects found" line. */
  _renderTreeSection(group, rows, tint, drag) {
    const head = el("div", { class: "cc-group cc-tree-head" });
    head.style.background = tint;
    this._setDrag(head, drag);
    head.appendChild(el("span", { class: "cc-tree-label" }, group));
    const status = el("span", { class: "cc-rescan-status" });
    const rescan = el("button", { class: "cc-rescan", type: "button", title: "Rescan" }, "⟳");
    rescan.addEventListener("click", (e) => {
      e.stopPropagation();
      this._rescan(group);
    });
    head.append(status, rescan);
    this.mainEl.appendChild(head);
    this._rescanEls.set(group, { btn: rescan, status });
    this._paintRescan(group);

    const body = el("div", { class: "cc-tree-body" });
    this.mainEl.appendChild(body);

    const tree = buildTree(rows);
    const repaint = () => {
      body.innerHTML = "";
      if (!tree.folders.length && !tree.rows.length) {
        body.appendChild(el("div", { class: "cc-tree-empty" }, "No projects found"));
        return;
      }
      this._paintTreeNode(body, tree, group, [], 0, repaint);
    };
    repaint();
  }

  /** Run `onRescan(group)`, spinning the head's ⟳ until the promise it returns settles, then show
   *  what changed for `RESCAN_STATUS_MS`. A host returning nothing settles at once. */
  _rescan(group) {
    const prev = this._rescans.get(group);
    if (prev && prev.busy) return;
    if (prev) clearTimeout(prev.timer);
    const st = { before: treeRows(this.tabs, group), busy: true, failed: false, timer: null };
    this._rescans.set(group, st);
    this._paintRescan(group);
    const settle = (failed) => {
      st.busy = false;
      st.failed = failed;
      st.timer = setTimeout(() => {
        if (this._rescans.get(group) !== st) return;
        this._rescans.delete(group);
        this._paintRescan(group);
      }, RESCAN_STATUS_MS);
      this._paintRescan(group);
    };
    Promise.resolve(this.cb.onRescan ? this.cb.onRescan(group) : undefined).then(
      () => settle(false),
      () => settle(true),
    );
  }

  /** Sync a tree-head's ⟳ and status to its rescan state. The outcome is diffed against the current
   *  `this.tabs` on every paint, so a snapshot that lands after the promise settled still counts. */
  _paintRescan(group) {
    const els = this._rescanEls.get(group);
    if (!els) return;
    const st = this._rescans.get(group);
    const busy = !!(st && st.busy);
    els.btn.disabled = busy;
    els.btn.toggleAttribute("data-busy", busy);
    if (!st || busy) {
      els.status.textContent = "";
      els.status.title = "";
      return;
    }
    const sum = st.failed ? { text: "Failed", tip: "" } : rescanSummary(st.before, treeRows(this.tabs, group));
    els.status.textContent = sum.text;
    els.status.title = sum.tip;
  }

  /** Recursively paint one tree node's rows + child folders into `container`. `pathSegs` is the
   *  folder-label chain down to (not including) this node, used to build each folder's persisted
   *  collapse-state key. `repaint` re-runs the whole section's paint from scratch on toggle — trees
   *  are small (config-scale), so a full repaint is simpler and cheap versus DOM-patching visibility. */
  _paintTreeNode(container, node, group, pathSegs, depth, repaint) {
    for (const t of node.rows) {
      const row = this._renderRow(t);
      row.classList.add("cc-tree-row");
      row.style.setProperty("--cc-depth", String(depth));
      container.appendChild(row);
    }
    for (const folder of node.folders) {
      const segs = [...pathSegs, folder.label];
      const key = this._treeKey(group, segs);
      // A search shows every match, so it opens every folder without touching the stored state.
      const searching = !!this.query.trim();
      const collapsed = !searching && this._treeCollapsed(key, depth);
      const row = el("div", { class: "cc-folder" });
      if (collapsed) row.setAttribute("data-collapsed", "");
      row.style.setProperty("--cc-depth", String(depth));
      row.appendChild(el("span", { class: "cc-chevron" }));
      row.appendChild(el("span", { class: "cc-folder-label" }, folder.label));
      if (searching) row.setAttribute("data-searching", "");
      row.addEventListener("click", () => {
        if (searching) return;
        localStorage.setItem(key, collapsed ? "0" : "1");
        repaint();
        this._paint(); // the rebuilt rows carry none of `_paint`'s decoration (.active, live upgrade, cursor)
      });
      container.appendChild(row);
      if (!collapsed) this._paintTreeNode(container, folder, group, segs, depth + 1, repaint);
    }
  }

  /** The localStorage key holding a folder's collapse state: per mounted sidebar (`storageKey`),
   *  per tree section (`group`), per folder-label chain (`segs`). */
  _treeKey(group, segs) {
    return "cc-tree:" + (this.cfg.storageKey || "") + ":" + group + "/" + segs.join("/");
  }

  /** Persisted collapse state for a folder key. Default policy (no stored value yet): top level
   *  (depth 0) expanded, deeper folders (depth ≥ 1) collapsed. */
  _treeCollapsed(key, depth) {
    const v = localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
    return depth >= 1;
  }

  /** A headed group's head: its own tab row (selectable like any other), led by a disclosure arrow
   *  that reports `onToggleGroup(group, collapsed)` and changes nothing itself — the row repaints when
   *  the app's answering `update(dto)` lands. A head with no members has nothing to disclose, so it
   *  gets an arrow-wide blank instead, keeping its tile in line with its neighbours'. The arrow is
   *  disabled, still showing the state, without the callback and under a search (which shows every
   *  match regardless). */
  _renderHead(sec, collapsed, searching) {
    const row = this._renderRow(sec.head);
    row.classList.add("cc-head");
    if (this.cb.onUnloadGroup) {
      const btn = el("button", { class: "cc-unload-group", type: "button", "data-group": sec.group });
      btn.innerHTML = UNLOAD_GROUP_SVG;
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // the button unloads; the rest of the row selects
        if (!btn.hasAttribute("disabled")) this.cb.onUnloadGroup(sec.group);
      });
      // Left of the bin, so every row's bin and dot stay in their columns.
      row.insertBefore(btn, row.querySelector(".cc-remove") || row.querySelector(".cc-dot"));
    }
    if (!sec.rows.length) {
      row.insertBefore(el("span", { class: "cc-disclosure-blank", "aria-hidden": "true" }), row.firstChild);
      return row;
    }
    if (collapsed) row.setAttribute("data-collapsed", "");
    const why = !this.cb.onToggleGroup
      ? "Collapsing isn't available here"
      : searching
        ? "Clear the search to collapse or expand"
        : null;
    const arrow = el("button", {
      class: "cc-disclosure",
      type: "button",
      "aria-expanded": String(!collapsed),
      title: why || (collapsed ? "Expand group" : "Collapse group"),
    });
    if (why) arrow.setAttribute("disabled", "");
    arrow.appendChild(el("span", { class: "cc-chevron" }));
    arrow.addEventListener("click", (e) => {
      e.stopPropagation(); // the arrow toggles; the rest of the row selects
      if (!why) this.cb.onToggleGroup(sec.group, !collapsed);
    });
    row.insertBefore(arrow, row.firstChild);
    return row;
  }

  /** The row's leading tile: the DTO `icon` image, else the title's initial on its colour. Shared by
   *  tab rows and Incoming items so an `icon` means the same on both. */
  _makeTile(t) {
    if (t.icon) {
      const icon = el("span", { class: "cc-icon cc-icon-image" });
      icon.appendChild(el("img", { src: t.icon, alt: "", draggable: "false" }));
      return icon;
    }
    const icon = el("span", { class: "cc-icon" }, tileInitial(t.title));
    icon.style.background = tileColour(t.title);
    return icon;
  }

  // ── the pinned Incoming section (opt-in: `incoming` in the DTO) ──

  /** Rebuild the "Incoming" section: items waiting on an action, pinned above `.cc-open`. Absent or
   *  empty `incoming` → nothing is added, so the list is exactly as it was. The section is not
   *  searched and its items are not tabs (no `.cc-tab`, no `data-id`), so keyboard nav, `_rowsById`
   *  and `_paint` never see them. Rebuilt whole by every `_paintList`. */
  _paintIncoming() {
    const items = this.incoming || [];
    this.incomingEl = null;
    if (!items.length) return;
    const section = el("div", { class: "cc-incoming" });
    this._setDrag(section, this.drag);
    const head = el("div", { class: "cc-group cc-section-head cc-incoming-head" });
    head.style.background = this.tint;
    this._setDrag(head, this.drag);
    head.append(el("span", { class: "cc-section-label" }, "Incoming"), el("span", { class: "cc-count" }, String(items.length)));
    section.appendChild(head);
    for (const item of items) section.appendChild(this._renderIncomingItem(item));
    this.list.appendChild(section);
    this.incomingEl = section;
  }

  _renderIncomingItem(item) {
    const node = el("div", { class: "cc-inbox-item", "data-incoming": item.id });
    const line = el("div", { class: "cc-inbox-line" });
    line.append(this._makeTile(item), el("span", { class: "cc-inbox-title", title: item.title || "" }, item.title || ""));
    node.appendChild(line);
    if (item.problem) node.appendChild(el("div", { class: "cc-inbox-problem" }, item.problem));
    const actions = el("div", { class: "cc-inbox-actions" });
    for (const a of item.actions || []) {
      const btn = el("button", { class: "cc-inbox-action", type: "button", "data-action": a.id }, a.label);
      if (a.disabled) {
        btn.setAttribute("disabled", "");
        btn.setAttribute("title", a.disabled);
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.hasAttribute("disabled") || !this.cb.onIncomingAction) return;
        const r = btn.getBoundingClientRect();
        this.cb.onIncomingAction(item.id, a.id, { x: r.left, y: r.bottom });
      });
      actions.appendChild(btn);
    }
    node.appendChild(actions);
    return node;
  }

  /** `context` (optional) is a dimmed where-it-lives label after the title — passed only for
   *  a mirror row in the pinned "Open" section (see `mirrorContext`); a home row's own section and
   *  tree already say it. */
  _renderRow(t, context = null) {
    const row = el("div", { class: "cc-tab", "data-id": t.id });
    if (t.detached) row.classList.add("detached");
    // Row click keeps its normal onSelect wiring even when detached — the app interprets
    // onSelect-on-a-detached-tab as "raise the popped-out window" (see CLAUDE.md). No new
    // callback: this IS the raise affordance.
    // A click is the search's other exit (Enter being the first), so it clears the field too.
    row.addEventListener("click", () => {
      if (this._swallowClick) return; // the release that ended a drag
      if (this.query) this._clearSearch();
      this.select(t.id);
    });
    // Right-click → the app's own menu (opt-in: without the callback the webview's is left alone).
    if (this.cb.onContextMenu) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.cb.onContextMenu(t.id, { x: e.clientX, y: e.clientY });
      });
    }

    // An `icon` image (opt-in: any image URL the page can load) stands in for the initial and
    // colour; the tile keeps its box, so the overlay and accent sit on it either way.
    const icon = this._makeTile(t);
    // Pop-out / pop-in as a hover overlay ON the initial tile (opt-in: capability-by-callback-
    // presence — rendered only when the app supplied onPopOut). A docked tab shows the pop-OUT icon (window + arrow leaving)
    // and fires onPopOut; a detached tab shows the pop-IN icon (arrow entering) and fires onPopIn.
    // Revealed on hover of the whole ROW (`.cc-tab:hover`) and sized to fill the tile — large and
    // deliberate, and out of the right-hand indicator cluster entirely.
    if (this.cb.onPopOut) {
      const detached = !!t.detached;
      if (!detached || this.cb.onPopIn) {
        const act = el("span", {
          class: "cc-icon-pop",
          title: detached ? "Pop back into a tab" : "Pop out into its own window",
        });
        act.innerHTML = detached ? POP_IN_SVG : POP_OUT_SVG;
        act.addEventListener("click", (e) => {
          e.stopPropagation();
          if (detached) this.cb.onPopIn(t.id);
          else this.cb.onPopOut(t.id);
        });
        icon.appendChild(act);
      }
    }
    // Accent mark (opt-in: absent `accent` renders nothing). Any CSS colour — a per-row identity cue,
    // a corner dot on the tile so it never shifts the row's layout.
    if (t.accent) {
      const mark = el("span", { class: "cc-accent" });
      mark.style.background = t.accent;
      icon.appendChild(mark);
    }
    row.appendChild(icon);

    const title = el("span", { class: "cc-title" }, (t.title || "") + (t.warn ? "  ⚠" : ""));
    if (context) title.appendChild(el("span", { class: "cc-context" }, context));
    row.appendChild(title);

    // Attention slot (amber; count pill when a number). Absent when null.
    if (t.attention != null) row.appendChild(this._makeAttention(t.attention));

    // Presence slot (cyan; warden probe). Absent when null. Clickable when armable + on.
    if (t.presence != null) row.appendChild(this._makePresence(t, t.presence));

    // Remove slot — opt-in per app (rendered only when the consumer supplies `onRemove`): take the
    // tab out of the sidebar. Always on screen, muted until hovered; fires at once, unless the row
    // carries `confirmRemove` (the sentence saying what goes): then the bin opens the row's confirm
    // in place, under it, and only its Remove fires.
    if (this.cb.onRemove) {
      const rm = el("span", { class: "cc-remove", title: "Remove" });
      rm.innerHTML = REMOVE_SVG;
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.armedRemove === t.id) return this._disarmRemove();
        if (t.confirmRemove) return this._armRemove(t.id);
        this._disarmRemove();
        this.cb.onRemove(t.id);
      });
      row.appendChild(rm);
    }

    // Live/unload slot — always rightmost (green live ↔ hover-✕ / hollow cold). Always present.
    // A detached tab is ALWAYS live — it's running in its own popped-out window — so its dot
    // shows live regardless of `t.live` (which reports only a LOCAL surface). It is NOT an
    // unload affordance there, though: you don't unload a tab that lives in another window, you
    // raise that window — so the click stays unwired and falls through to the row's onSelect
    // (which the app maps to "raise the popped-out window").
    const dot = this._makeDot(t.detached || t.live);
    if (!t.detached) {
      dot.addEventListener("click", (e) => {
        if (!dot.classList.contains("live")) return; // cold: nothing to unload
        e.stopPropagation();
        if (this.cb.onUnload) this.cb.onUnload(t.id);
      });
    }
    row.appendChild(dot);

    // Kill-confirm controls (only for armable rows; hidden until `.confirming`).
    if (armable(t)) this._appendConfirmControls(row, t);
    if (this.armedRemove === t.id) this._openRemoveConfirm(row, t);
    return row;
  }

  _makeAttention(val) {
    const a = el("span", { class: "cc-attention" });
    if (typeof val === "number") {
      a.classList.add("cc-count");
      a.textContent = String(val);
    }
    return a;
  }

  _makePresence(t, state) {
    const s = el("span");
    this._paintPresence(s, state, t, !!t.live);
    // The dot is a session toggle: click a present session to kill (2-step confirm), or click an
    // absent-but-startable one to restart (single click — non-destructive). Both are gated by the
    // painted classes (`.kill` / `.start`), so a click that matches neither is inert.
    if (armable(t) || t.startable) {
      s.addEventListener("click", (e) => {
        if (s.classList.contains("kill")) {
          e.stopPropagation();
          this._armKill(t.id, s.closest(".cc-tab"));
        } else if (s.classList.contains("start")) {
          e.stopPropagation();
          if (this.cb.onStart) this.cb.onStart(t.id);
        }
      });
    }
    return s;
  }

  /** Paint a dot from its state + the tab's capabilities, which ride on the span (`data-kill`,
   *  `data-suspend`, `data-start`) so a later repaint needs only the new state (`_capsOf`). */
  _paintPresence(span, state, caps, live) {
    span.className = presenceClass(state, caps, live);
    span.dataset.kill = caps.killable ? "1" : "";
    span.dataset.suspend = caps.suspendable ? "1" : "";
    span.dataset.start = caps.startable ? "1" : "";
    const ghost = span.classList.contains("ghost");
    span.title = span.classList.contains("kill")
      ? ghost
        ? "Restorable session — discard…"
        : "End session…"
      : ghost
        ? span.classList.contains("start")
          ? "Restorable session — start to restore it"
          : "Restorable session"
        : span.classList.contains("start")
          ? "Start session"
          : "";
  }

  _capsOf(span) {
    return {
      killable: span.dataset.kill === "1",
      suspendable: span.dataset.suspend === "1",
      startable: span.dataset.start === "1",
    };
  }

  /** Re-evaluate a row's presence dot after a live-state change — the `start` affordance is gated on
   *  the tab being live, so unloading/loading must repaint it (kill/start classes read from dataset). */
  _refreshPresenceLive(row, live) {
    const s = row.querySelector(".cc-presence");
    if (!s) return;
    const state = derivePresenceState(Array.from(s.classList));
    this._paintPresence(s, state, this._capsOf(s), live);
  }

  _makeDot(live) {
    const dot = el("span");
    this._paintDot(dot, live);
    return dot;
  }

  _paintDot(dot, live) {
    dot.className = "cc-dot " + (live ? "live" : "cold");
    dot.title = live ? "Unload" : "";
  }

  /** One armed-row confirm action (⏻ or ☠). They differ only in glyph + which callback fires, so
   *  the click contract lives here once: swallow the row click, ignore a re-click mid-animation,
   *  fire against the row that is actually armed, then press + pulse (~180ms) and disarm. A
   *  disabled control (`.cc-disabled`, painted by `_paintConfirmControls`) stays on screen, muted
   *  and titled with why, but swallows the click inertly. */
  _makeConfirmControl(row, { cls, glyph, fire }) {
    const ctl = el("span", { class: cls }, glyph);
    ctl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (ctl.classList.contains("cc-disabled") || row.classList.contains("killing")) return;
      const armed = this.armedKill;
      if (!armed) {
        this._disarmKill();
        return;
      }
      fire(armed);
      row.classList.add("killing");
      ctl.classList.add("cc-pressed");
      const finish = () => {
        row.removeEventListener("animationend", finish);
        row.classList.remove("killing");
        ctl.classList.remove("cc-pressed");
        if (this.armedKill === armed) this._disarmKill();
      };
      row.addEventListener("animationend", finish);
      setTimeout(finish, 250); // fallback if animationend doesn't fire
    });
    return ctl;
  }

  _appendConfirmControls(row, t) {
    // Two ways to end a session off the SAME armed row — one arming path, one state machine. Both
    // are always rendered; the one the tab can't do is disabled in place, never dropped. What each
    // means is the app's business (warden: run the tab's `kill`/`suspend` command, then unload).
    row.append(
      this._makeConfirmControl(row, {
        cls: "cc-confirm-destroy",
        glyph: "☠",
        fire: (armed) => {
          if (this.cb.onDestroy) this.cb.onDestroy(armed);
        },
      }),
      this._makeConfirmControl(row, {
        cls: "cc-confirm-suspend",
        glyph: "⏻",
        fire: (armed) => {
          if (this.cb.onSuspend) this.cb.onSuspend(armed);
        },
      }),
    );
    this._paintConfirmControls(row, t);
    const cancel = el("span", { class: "cc-confirm-cancel", title: "cancel" }, "↩︎");
    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      this._disarmKill();
    });
    row.append(cancel);
  }

  /** Enable/title the armed row's ☠ and ⏻ for `t` as it is NOW: suspend depends on presence (a
   *  ghost has nothing running to suspend), so `_armKill` repaints these before showing them. */
  _paintConfirmControls(row, t) {
    const ghost = t.presence === "ghost";
    const paint = (ctl, ok, title) => {
      if (!ctl) return;
      ctl.classList.toggle("cc-disabled", !ok);
      ctl.title = title;
    };
    paint(
      row.querySelector(".cc-confirm-destroy"),
      !!t.killable,
      !t.killable
        ? "Destroy — not configured for this tab"
        : ghost
          ? "Discard the restorable session"
          : "Destroy session + close",
    );
    paint(
      row.querySelector(".cc-confirm-suspend"),
      canSuspend(t),
      !t.suspendable
        ? "Suspend — not configured for this tab"
        : ghost
          ? "Suspend — nothing running; already restorable"
          : "Suspend session + close (restorable)",
    );
  }

  /** EVERY row for `id` — plural because a pinned mirror section mirrors a tab's row, so one
   *  id can own two; a caller patching a row patches them all. */
  _rowsById(id) {
    return [...this.list.querySelectorAll('.cc-tab[data-id="' + (window.CSS ? CSS.escape(id) : id) + '"]')];
  }

  _paint() {
    for (const row of this.list.querySelectorAll(".cc-tab")) {
      const isActive = row.dataset.id === this.active;
      row.classList.toggle("active", isActive);
      // The active tab always has a live surface (selecting it activates/creates it), so upgrade its
      // dot to live even if the last DTO snapshot caught it cold. Without this the loaded dot never
      // fills after a lazy select, and the unload ✕ (gated on .live) can never fire.
      if (isActive) {
        const dot = row.querySelector(".cc-dot");
        if (dot) this._paintDot(dot, true);
        this._refreshPresenceLive(row, true); // active ⇒ live ⇒ its presence dot can offer start
      }
    }
    const cursor = this._searchCursor();
    for (const row of this._navRows()) row.classList.toggle("cc-cursor", row.dataset.id === cursor);
    // The active tab hidden in a collapsed group has no row, so its head stands in for it.
    const anchor = navAnchor(this.tabs, this.collapsed, this.active);
    for (const row of this.list.querySelectorAll(".cc-head")) {
      row.classList.toggle("cc-contains-active", anchor !== this.active && row.dataset.id === anchor && row.hasAttribute("data-collapsed"));
    }
    for (const btn of this.list.querySelectorAll(".cc-unload-group")) {
      const loaded = groupLoaded(this.tabs, btn.dataset.group, this.active);
      btn.toggleAttribute("disabled", !loaded);
      btn.title = loaded ? "Unload group" : "Unload group — nothing loaded";
    }
    this._paintRail();
  }

  // ── search ──

  /** Put the cursor in the search field, selecting any text already there — the host's menu
   *  accelerator (shell-core's Find in Sidebar). A host whose content is a native view (warden) must
   *  first make the webview the key view; the page can't take focus from AppKit itself. */
  focusSearch() {
    // Collapsed, the field is off screen: peek first, and the focus inside then holds the peek.
    if (this.sidebarCollapsed) this._setPeek(true);
    this.searchInput.focus();
    this.searchInput.select();
  }

  /** The id Enter opens while a search is active: the arrow-moved cursor if its row is still shown,
   *  else the first match. Null with no search, or nothing shown. */
  _searchCursor() {
    if (!this.query.trim()) return null;
    const ids = this._navRows().map((r) => r.dataset.id);
    return ids.includes(this._cursor) ? this._cursor : ids[0] || null;
  }

  /** Clear the field and repaint the whole list. */
  _clearSearch() {
    this.searchInput.value = "";
    this.query = "";
    this.searchClear.disabled = true;
    this._cursor = null;
    this._paintList();
  }

  /** Esc clears and leaves (→ `onSearchExit`, so the host can hand focus back to its content);
   *  Enter opens the cursor's tab, then clears and leaves; ↑/↓ move the cursor among the matches. */
  _onSearchKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this._clearSearch();
      this.searchInput.blur();
      if (this.cb.onSearchExit) this.cb.onSearchExit();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const id = this._searchCursor();
      if (!id) return;
      this._clearSearch();
      this.searchInput.blur();
      this.select(id);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const ids = this._navRows().map((r) => r.dataset.id);
      if (!ids.length || !this.query.trim()) return;
      const cur = ids.indexOf(this._searchCursor());
      const next = Math.min(ids.length - 1, Math.max(0, cur + (e.key === "ArrowDown" ? 1 : -1)));
      this._cursor = ids[next];
      this._paint();
      const row = this._navRows().find((r) => r.dataset.id === this._cursor);
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  }

  // ── selection ──

  /** Select a tab by id: move the highlight optimistically and fire onSelect (the app activates).
   *  `wasActive` lets curator snap an already-active tab home. Used by clicks, keyboard nav, and the
   *  notification focus path. */
  select(id) {
    this._disarmKill();
    // A detached tab lives in its OWN window — selecting it means "raise that window" (the app's
    // onSelect), never "make it the shown tab in this window". So fire onSelect but do NOT move the
    // highlight: it stays on whatever this window is really showing.
    const t = this.tabs.find((x) => x.id === id);
    if (t && t.detached) {
      if (this.cb.onSelect) this.cb.onSelect(id, { wasActive: false });
      return;
    }
    const wasActive = this.active === id;
    this.active = id;
    this._paint();
    if (this.cb.onSelect) this.cb.onSelect(id, { wasActive });
  }

  /** Move the highlight to `id` WITHOUT firing onSelect — for reflecting app-side state the app
   *  already actioned (e.g. the neighbour it activated after an unload). */
  setActive(id) {
    this._disarmKill(); // a non-DOM path (⌘W) can land here with a background row still armed
    this.active = id;
    this._paint();
  }

  /** Cycle prev/next → onSelect. `liveOnly` restricts to tabs whose live dot is filled — live or
   *  detached (warden skips cold tabs; curator passes liveOnly:false). Walks the tab RECORDS in `navOrder`, not the DOM: a live tab inside a
   *  collapsed tree folder has no row, and must still be reachable. `from` steps from that tab
   *  instead of the highlight — a popped-out tab never takes the highlight, so a cycle driven from
   *  its own window anchors on it here, or it would land on the same popped-out tab again. */
  selectByOffset(dir, opts) {
    const liveOnly = opts && opts.liveOnly;
    // A hidden member has no place in `navOrder`; step from its group's head instead.
    const from = navAnchor(this.tabs, this.collapsed, (opts && opts.from) || this.active);
    const live = new Set(this.tabs.filter((t) => t.live || t.detached).map((t) => t.id));
    const ids = navOrder(this.tabs, this.collapsed).filter((id) => !liveOnly || live.has(id));
    if (ids.length < 2) return; // cycling needs ≥2 (eligible) tabs; 1 tab is a no-op, not a self-select
    const next = resolveOffset(ids, from, dir < 0 ? -1 : 1);
    if (next != null) this.select(next);
  }

  /** Jump to the 1-based position `n` → onSelect. No-op past the last tab. */
  selectByIndex(n) {
    const ids = this._navRows().map((r) => r.dataset.id);
    if (n >= 1 && n <= ids.length) this.select(ids[n - 1]);
  }

  /** The rows ⌘1–9 counts: the main list's visible rows, with the pinned section's MIRRORS
   *  excluded — including them would shift every index by however many tabs happened to be open. */
  _navRows() {
    return [...this.list.querySelectorAll(".cc-tab:not([data-mirror])")];
  }

  // ── targeted setters (patch a hot signal without a full re-render) ──

  setLive(id, live) {
    patchTab(this.tabs, id, { live });
    // Live-state IS the pinned sections' membership, so this repaints them (the record is already
    // patched above, so a mirror renders correct on birth) before patching the standing rows.
    this._paintMirrorSections();
    this._paint(); // a freshly-built mirror of the active tab needs its `.active` class
    for (const row of this._rowsById(id)) {
      const dot = row.querySelector(".cc-dot");
      if (dot) this._paintDot(dot, live);
      this._refreshPresenceLive(row, live); // live gates the presence `start` affordance
    }
  }

  setAttention(id, val) {
    patchTab(this.tabs, id, { attention: val == null ? null : val });
    for (const row of this._rowsById(id)) {
      let a = row.querySelector(".cc-attention");
      if (val == null) {
        if (a) a.remove();
        continue;
      }
      if (!a) {
        a = this._makeAttention(val);
        insertSlot(row, a, ".cc-attention");
      } else {
        const fresh = this._makeAttention(val);
        a.className = fresh.className;
        a.textContent = fresh.textContent;
      }
    }
    this._paintRail();
  }

  setPresence(id, state) {
    const inBackground = () => backgroundTabs(this.tabs).some((t) => t.id === id);
    const was = inBackground();
    const prev = (this.tabs.find((t) => t.id === id) || {}).presence ?? null;
    patchTab(this.tabs, id, { presence: state == null ? null : state });
    // Repaint the sections only when this tab entered or left "Background": probes report every
    // tab on each sweep, and an unconditional repaint would disarm an armed "Open" mirror each time.
    if (this.backgroundSection && inBackground() !== was) {
      this._paintMirrorSections();
      this._paint();
    }
    for (const row of this._rowsById(id)) {
      let s = row.querySelector(".cc-presence");
      if (state == null) {
        if (s) s.remove();
        continue;
      }
      const live = !!row.querySelector(".cc-dot.live");
      if (!s) {
        const t = this.tabs.find((x) => x.id === id) || {};
        s = this._makePresence(t, state);
        // Painted from the row's live dot, not the record: the active tab paints live while its
        // record can say cold, and a cold paint would drop the dot's `start` affordance.
        this._paintPresence(s, state, t, live);
        insertSlot(row, s, ".cc-presence");
      } else {
        this._paintPresence(s, state, this._capsOf(s), live);
      }
    }
    // The session the confirm row was armed against changed (ended, crashed, discarded) → the
    // armed actions no longer describe it, on either row.
    if (state !== prev && this.armedKill === id) this._disarmKill();
  }

  // ── kill-confirm state machine ──

  /** The keyboard route to the confirm row's two actions (`how` = "suspend" | "destroy"), for the
   *  app's menu accelerators — policy in `endIntent`. An armed row is disarmed by Escape and outside
   *  clicks only while the page holds key focus; a keyboard-armed one also lapses after
   *  `KEY_ARM_TIMEOUT_MS`, since a native host view (warden's terminal) keeps both from the page. */
  requestEnd(id, how) {
    const t = this.tabs.find((x) => x.id === id);
    const intent = endIntent(t, how, this.armedKill);
    if (intent === "suspend") {
      this._disarmKill();
      if (this.cb.onSuspend) this.cb.onSuspend(id);
    } else if (intent === "destroy") {
      this._disarmKill();
      if (this.cb.onDestroy) this.cb.onDestroy(id);
    } else if (intent === "arm") {
      this._armKill(id, this.revealRow(id));
      if (this.armedKill === id) {
        clearTimeout(this._armTimer); // a re-arm restarts the lapse; the old timer would cut it short
        this._armTimer = setTimeout(() => {
          if (this.armedKill === id) this._disarmKill();
        }, KEY_ARM_TIMEOUT_MS);
      }
    }
  }

  /** The row for `id`, preferring a visible one. A tab with no row is revealed first — a search
   *  hiding it is cleared, and every collapsed folder above it is stored expanded and repainted —
   *  because its callers must show the row: a destroy armed out of sight would fire blind on the
   *  second request, and an app's in-place rename edits the row itself. Null only when the tab has
   *  no row to reveal — including a hidden member of a collapsed headed group, whose `collapsed`
   *  state is the app's to change, not this component's. */
  revealRow(id) {
    // Collapsed, no row is on screen: peek, so a rename field or an armed confirm row can be seen.
    if (this.sidebarCollapsed) this._setPeek(true);
    const pick = () => {
      const rows = this._rowsById(id);
      return rows.find((r) => r.offsetParent !== null) || rows[0] || null;
    };
    let row = pick();
    if (!row && this.query.trim()) {
      this._clearSearch();
      row = pick();
    }
    if (row) return row;
    const sec = listSections(this.tabs).find((s) => s.tree && s.rows.some((r) => r.id === id));
    const chain = sec ? folderChain(sec.rows, id) : null;
    if (!chain || !chain.length) return null;
    for (let n = 1; n <= chain.length; n++) localStorage.setItem(this._treeKey(sec.group, chain.slice(0, n)), "0");
    this._paintList();
    return pick();
  }

  _armKill(id, rowEl) {
    if (!rowEl || this.armedKill === id) return;
    this._disarmKill();
    this.armedKill = id;
    const t = this.tabs.find((x) => x.id === id);
    if (t) this._paintConfirmControls(rowEl, t);
    rowEl.classList.add("confirming");
    this._onArmKey = (e) => {
      if (e.key === "Escape") this._disarmKill();
    };
    this._onArmOutside = (e) => {
      if (!this.armedKill) return;
      // Inside the armed row → its ⏻/↩ handle it. Only ONE of an id's rows is ever armed (the one
      // clicked), but checking them all is the same answer and needs no record of which.
      if (this._rowsById(this.armedKill).some((row) => row.contains(e.target))) return;
      this._disarmKill();
    };
    document.addEventListener("keydown", this._onArmKey);
    document.addEventListener("click", this._onArmOutside, true);
  }

  _disarmKill() {
    const prev = this.armedKill;
    this.armedKill = null;
    if (this._onArmKey) document.removeEventListener("keydown", this._onArmKey);
    if (this._onArmOutside) document.removeEventListener("click", this._onArmOutside, true);
    this._onArmKey = this._onArmOutside = null;
    clearTimeout(this._armTimer);
    this._armTimer = null;
    if (prev) {
      for (const row of this._rowsById(prev)) row.classList.remove("confirming");
    }
  }

  // ── remove-confirm ──

  /** Opens row `id`'s confirm (`confirmRemove`) under it: the row's sentence, then Remove, which
   *  fires `onRemove`, and Keep. Keep, the bin again, Escape or a click anywhere outside the
   *  confirm closes it. The state lives in `armedRemove`, so a repaint while open (a DTO push)
   *  keeps it. */
  _armRemove(id) {
    this._disarmRemove();
    this.armedRemove = id;
    this._paintRemoveArm(id, true);
    this._onRemoveKey = (e) => {
      if (e.key === "Escape") this._disarmRemove();
    };
    this._onRemoveOutside = (e) => {
      const inside = this._rowsById(id).some((row) =>
        [".cc-remove", ".cc-remove-confirm"].some((sel) => {
          const part = row.querySelector(sel);
          return part && part.contains(e.target);
        })
      );
      if (!inside) this._disarmRemove();
    };
    document.addEventListener("keydown", this._onRemoveKey);
    document.addEventListener("click", this._onRemoveOutside, true);
  }

  _disarmRemove() {
    const prev = this.armedRemove;
    this.armedRemove = null;
    if (this._onRemoveKey) document.removeEventListener("keydown", this._onRemoveKey);
    if (this._onRemoveOutside) document.removeEventListener("click", this._onRemoveOutside, true);
    this._onRemoveKey = this._onRemoveOutside = null;
    if (prev) this._paintRemoveArm(prev, false);
  }

  /** Adds row `t`'s open confirm to `row`, on its own line under the row's own contents. */
  _openRemoveConfirm(row, t) {
    row.classList.add("cc-remove-armed");
    const box = el("div", { class: "cc-remove-confirm" });
    box.addEventListener("click", (e) => e.stopPropagation());
    box.appendChild(el("span", { class: "cc-remove-why" }, String(t.confirmRemove)));
    const btns = el("div", { class: "cc-remove-btns" });
    const remove = el("button", { class: "cc-remove-go", type: "button" }, "Remove");
    remove.addEventListener("click", () => {
      this._disarmRemove();
      this.cb.onRemove(t.id);
    });
    const keep = el("button", { class: "cc-remove-keep", type: "button" }, "Keep");
    keep.addEventListener("click", () => this._disarmRemove());
    btns.appendChild(remove);
    btns.appendChild(keep);
    box.appendChild(btns);
    row.appendChild(box);
  }

  _paintRemoveArm(id, armed) {
    const t = this.tabs.find((x) => x.id === id);
    for (const row of this._rowsById(id)) {
      const open = row.querySelector(".cc-remove-confirm");
      if (open) open.remove();
      row.classList.remove("cc-remove-armed");
      if (armed && t) this._openRemoveConfirm(row, t);
    }
  }

  // ── error bar ──

  setError(msg) {
    // Any new message supersedes a pending auto-clear (see `checkForUpdate`'s "up to date" notice),
    // so a real error shown inside that window stays until dismissed.
    clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
    this._errorText.textContent = msg;
    this.errorBar.style.display = "flex";
    this._paintNotice();
  }
  clearError() {
    this.errorBar.style.display = "none";
    this._paintNotice();
  }

  // ── update bar (view) ──

  // Show the "update available" bar. `info.version` labels it. Public so a consumer *could* drive it
  // directly, but normally the component's own updater (below) calls it.
  setUpdate(info) {
    const v = info && info.version ? String(info.version) : "";
    this._updateText.textContent = v ? `Update available: v${v}` : "Update available";
    // Reset the button to the ready state (a re-shown bar after a failed attempt gets a fresh click).
    this._updateBtn.disabled = false;
    this._updateBtn.textContent = "Update & Relaunch";
    this.updateBar.style.display = "flex";
    this._paintNotice();
  }
  clearUpdate() {
    this.updateBar.style.display = "none";
    this._paintNotice();
  }

  // ── self-update (app-agnostic capability) ──
  //
  // A self-updater is the same for any app regardless of what it hosts, so it lives here once and
  // every consuming app inherits it (see CLAUDE.md's dividing-line decision). It feature-detects the
  // shared Tauri runtime: every real app exposes `window.__TAURI__.updater`/`.process`, while the
  // isolated preview.html has no Tauri, so every path below no-ops there. Per-app *identity* (release
  // endpoint, signing pubkey, the Rust plugin registration) stays in the app's own config; the only
  // knob passed in is `autoUpdate` (mount config), the app's config gate.

  _updater() {
    return typeof window !== "undefined" && window.__TAURI__ ? window.__TAURI__.updater : null;
  }
  _process() {
    return typeof window !== "undefined" && window.__TAURI__ ? window.__TAURI__.process : null;
  }

  // Arm at mount (gated on autoUpdate + a present Tauri runtime): one immediate silent check, then a
  // recurring one so a long-running window surfaces a release without a restart. Toggling autoUpdate
  // in config takes effect next launch (armed once here) — restart-only by design.
  _startUpdater() {
    // The process plugin relaunches into the update; without it nothing offered could install.
    if (!this.cfg.autoUpdate || !this._updater() || !this._process()) return;
    this.checkForUpdate(false);
    this._updateTimer = setInterval(() => this.checkForUpdate(false), UPDATE_CHECK_INTERVAL_MS);
  }

  // Check for a newer release. `announce` = surface "up to date" / errors (the menu path); the launch
  // + periodic paths pass false so they stay silent on miss/offline and never nag. A found update
  // shows unless dismissed this session — except the menu path, which re-surfaces it (clearing the
  // dismissal, since the user is re-engaging).
  async checkForUpdate(announce) {
    const updater = this._updater();
    if (!updater || !this._process()) return;
    try {
      const update = await updater.check();
      // A check landing mid-install must not re-enable the button or swap the Update object.
      if (this._installing) return;
      if (update) {
        this._pendingUpdate = update;
        if (announce) this._updateDismissed = false;
        if (announce || !this._updateDismissed) this.setUpdate({ version: update.version, notes: update.body });
      } else if (announce) {
        this.setError("You're up to date.");
        this._noticeTimer = setTimeout(() => this.clearError(), 4000);
      }
    } catch (e) {
      if (announce) this.setError("Couldn't check for updates: " + e);
    }
  }

  // The menu "Check for Updates…" path: check now and announce the result. The app forwards its own
  // menu event here — the event *name* is app-specific (warden:check-update / check-update), the
  // logic isn't.
  checkForUpdateNow() {
    this.checkForUpdate(true);
  }

  // Download + install the pending update, then relaunch into it. Fired by the update bar's button.
  async _installUpdate() {
    const proc = this._process();
    if (!this._pendingUpdate || !proc) {
      this.clearUpdate();
      this.setError(`Update failed: ${!proc ? "the process plugin is not available" : "no update is pending"}`);
      return;
    }
    this._installing = true;
    try {
      await this._pendingUpdate.downloadAndInstall();
      await proc.relaunch();
    } catch (e) {
      this._installing = false;
      this.clearUpdate();
      this.setError("Update failed: " + e);
    }
  }

  // Stop the recurring check — the interval is the only long-lived resource the component holds. A
  // consumer that unmounts the sidebar should call this; the current apps let the webview teardown
  // collect it, but destroy() keeps that explicit and lets tests tear down cleanly.
  destroy() {
    if (this._updateTimer) {
      clearInterval(this._updateTimer);
      this._updateTimer = null;
    }
    window.removeEventListener("mousemove", this._onDragMove);
    window.removeEventListener("mouseup", this._onDragEnd);
    window.removeEventListener("keydown", this._onDragKey);
  }

  // ── collapse ──
  //
  // Opt-in through mount config `hole`: the host's content-hole element, the box its Rust side
  // places the content views over. Collapsed, the sidebar shrinks to the titlebar strip across the
  // top plus a thin rail down the left edge, and the hole takes the rest (all sidebar.css, keyed on
  // the classes set here). Content views composite ABOVE this page, so a peek cannot draw over
  // them: it slides the hole right by the sidebar's width with a `transform` — same width, so the
  // page in it doesn't reflow — and `onLayout` tells the host to re-measure the hole, since a
  // `ResizeObserver` never sees a transform.

  /** Collapse or expand the sidebar (no-op without `hole`), remembering it for this window. */
  setSidebarCollapsed(on) {
    if (!this.holeEl || on === this.sidebarCollapsed) return;
    this._applyCollapsed(on);
    if (this.cfg.storageKey && this._collapseTitle != null) {
      const key = collapseKey(this.cfg.storageKey, this._collapseTitle);
      if (on) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    }
    this._layoutChanged();
  }

  /** The titlebar button and the host's Toggle Sidebar menu item. */
  toggleSidebar() {
    this.setSidebarCollapsed(!this.sidebarCollapsed);
  }

  /** Adopt window `title`'s remembered state (`update` calls this when the title changes). A page is
   *  one window for its whole life, so a later title is a rename: the state moves with it. */
  _restoreCollapse(title) {
    const prev = this._collapseTitle;
    this._collapseTitle = title;
    if (prev != null) {
      if (this.sidebarCollapsed && this.cfg.storageKey) {
        localStorage.removeItem(collapseKey(this.cfg.storageKey, prev));
        localStorage.setItem(collapseKey(this.cfg.storageKey, title), "1");
      }
      return;
    }
    const on = !!this.cfg.storageKey && localStorage.getItem(collapseKey(this.cfg.storageKey, title)) === "1";
    if (on === this.sidebarCollapsed) return;
    this._applyCollapsed(on);
    this._layoutChanged();
  }

  _applyCollapsed(on) {
    this.sidebarCollapsed = on;
    if (!on) this._setPeek(false, { quiet: true });
    this.root.classList.toggle("cc-collapsed", on);
    this.holeEl.classList.toggle("cc-hole-collapsed", on);
    this.sidebarToggle.setAttribute("aria-expanded", String(!on));
    this._paintTitlebarName();
    this._paintNotice();
  }

  /** Collapsed, the error bar, the update bar and Incoming are off screen, so the toggle carries a
   *  dot naming what is waiting there. */
  _paintNotice() {
    if (!this.sidebarToggle) return;
    const waiting = [];
    if (this.errorBar.style.display === "flex") waiting.push("an error");
    if (this.updateBar.style.display === "flex") waiting.push("an update");
    if ((this.incoming || []).length) waiting.push("incoming links");
    const flag = this.sidebarCollapsed && waiting.length > 0;
    this.sidebarToggle.classList.toggle("cc-notice", flag);
    // With `toggleCount`, a collapsed toggle also says how many tabs the sidebar holds.
    const counted = this.sidebarCollapsed && this.toggleCount;
    const n = this.tabs.length;
    let countEl = this.sidebarToggle.querySelector(".cc-toggle-count");
    if (counted && !countEl) {
      countEl = el("span", { class: "cc-toggle-count" });
      this.sidebarToggle.appendChild(countEl);
    } else if (!counted && countEl) {
      countEl.remove();
    }
    if (counted) countEl.textContent = String(n);
    const count = counted ? ` — ${n} ${n === 1 ? "tab" : "tabs"}` : "";
    const label = `${this.sidebarCollapsed ? "Show" : "Hide"} Sidebar (⌃⌘S)${count}${flag ? ` — ${waiting.join(", ")}` : ""}`;
    this.sidebarToggle.title = label;
    this.sidebarToggle.setAttribute("aria-label", label);
  }

  /** The strip's text: the app's name, or while collapsed the active tab's title — the one thing the
   *  hidden sidebar would otherwise have said about what is on screen. */
  _paintTitlebarName() {
    if (!this.titlebarName) return;
    const tab = this.sidebarCollapsed ? this.tabs.find((t) => t.id === this.active) : null;
    this.titlebarName.textContent = tab ? tab.title : this.cfg.appName || "";
  }

  _layoutChanged() {
    if (this.cb.onLayout) this.cb.onLayout();
  }

  /** A `map` rail's marks: one per tab in list order, lit for the active tab, filled while live
   *  (the active tab always is), amber while it wants attention. Any other style holds none. */
  _paintRail() {
    if (!this.railEl) return;
    this.railEl.textContent = "";
    if (this.railStyle !== "map") return;
    for (const t of this.tabs) {
      const mark = el("span", { class: "cc-rail-mark", "data-id": t.id });
      const active = t.id === this.active;
      mark.classList.toggle("active", active);
      mark.classList.toggle("live", active || !!t.live);
      mark.classList.toggle("attention", t.attention != null && t.attention !== false);
      this.railEl.appendChild(mark);
    }
  }

  _initCollapse() {
    this.holeEl.classList.add("cc-hole");
    this.railEl = el("div", { id: "cc-rail" });
    this.root.appendChild(this.railEl);
    const clock = this.cfg.clock;
    this.railEl.addEventListener("pointerenter", () => {
      if (!this.sidebarCollapsed || this._peeking) return;
      clock.clear(this._railTimer);
      this._railTimer = clock.set(() => this._setPeek(true), PEEK_DELAY_MS);
    });
    this.railEl.addEventListener("pointerleave", () => clock.clear(this._railTimer));
    // pointerenter/leave don't bubble in a browser; the target check keeps a child's (and the fake
    // DOM's bubbling) events from reading as the sidebar's own.
    this.root.addEventListener("pointerenter", (e) => {
      if (e.target !== this.root) return;
      this._pointerInside = true;
      clock.clear(this._leaveTimer);
    });
    this.root.addEventListener("pointerleave", (e) => {
      if (e.target !== this.root) return;
      this._pointerInside = false;
      if (!this._peeking) return;
      clock.clear(this._leaveTimer);
      this._leaveTimer = clock.set(() => this._endPeekUnlessTyping(), PEEK_LEAVE_MS);
    });
    // Out of the window altogether.
    document.documentElement.addEventListener("mouseleave", () => {
      this._pointerInside = false;
      this._endPeekUnlessTyping();
    });
    // The page lost key focus (a click on the content, another app): a field here no longer counts.
    window.addEventListener("blur", () => {
      if (!this._pointerInside) this._endPeekUnlessTyping();
    });
    // A field let go (Esc, Enter, a click on the content): close if the pointer is elsewhere.
    this.root.addEventListener("focusout", (e) => {
      if (e.relatedTarget && this.root.contains(e.relatedTarget)) return;
      if (!this._pointerInside) this._endPeekUnlessTyping();
    });
  }

  /** Whether the keyboard is in a field inside the sidebar (search, URL, a rename). `hasFocus` too:
   *  WebKit leaves `activeElement` on the field after a click moves key focus to a content view. */
  _typing() {
    const a = document.activeElement;
    return document.hasFocus() && !!a && this.root.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
  }

  _endPeekUnlessTyping() {
    if (this._peeking && !this._typing()) this._setPeek(false);
  }

  _setPeek(on, { quiet = false } = {}) {
    this.cfg.clock.clear(this._railTimer);
    this.cfg.clock.clear(this._leaveTimer);
    if (!this.holeEl || on === this._peeking) return;
    this._peeking = on;
    // The column's own laid-out width: the host may clamp it (a narrow window) without a resize event.
    const w = parseFloat(this.root.style.width) || this._lastWidth || this.cfg.defaultWidth;
    if (on) document.documentElement.style.setProperty("--cc-peek-w", `${Math.round(w)}px`);
    this.root.classList.toggle("cc-peek", on);
    this.holeEl.classList.toggle("cc-hole-peek", on);
    if (!quiet) this._layoutChanged();
  }

  // ── resize ──

  _clamp(w) {
    return clampWidth(w, {
      min: this.cfg.minWidth,
      max: this.cfg.maxWidth,
      fraction: this.cfg.maxFraction,
      windowWidth: window.innerWidth,
    });
  }
  _emitResize(w) {
    const cw = this._clamp(w);
    this._lastWidth = cw;
    if (this.cb.onResize) this.cb.onResize(cw);
  }
  _persistWidth(w) {
    if (this.cfg.storageKey && w > 0) localStorage.setItem(this.cfg.storageKey, String(Math.round(w)));
  }
  _restoreWidth() {
    if (!this.cfg.storageKey) return;
    const s = parseInt(localStorage.getItem(this.cfg.storageKey), 10);
    if (Number.isFinite(s)) this._emitResize(s);
  }
  _initResize() {
    const handle = this.resizeEl;
    let startX = 0, startW = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      // Released over a native surface (warden) never reaches us → unstick when no button is held.
      if (e.buttons === 0) { end(); return; }
      this._emitResize(startW + (e.clientX - startX));
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", end);
      window.removeEventListener("blur", end);
      document.body.style.cursor = "";
      this._persistWidth(this._lastWidth);
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startW = this.root.getBoundingClientRect().width;
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", end);
      window.addEventListener("blur", end);
    });
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._emitResize(this.cfg.defaultWidth);
      this._persistWidth(this.cfg.defaultWidth);
    });
  }
}

const ChromeSidebar = {
  /** Mount the sidebar into `container`; returns the instance (see CLAUDE.md for the method set). */
  mount(container, callbacks, config) {
    return new Sidebar(container, callbacks, config);
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ChromeSidebar, Sidebar, collapseKey, folderChain, listSections, navOrder, navAnchor, tileInitial, tileColour, hexToRgb, tintOverBase, liftColour, clampWidth, resolveOffset, presenceClass, armable, canSuspend, canEnd, endIntent, derivePresenceState, buildTree, patchTab, openTabs, backgroundTabs, mirrorContext, filterTabs, treeRows, rescanSummary };
}
if (typeof window !== "undefined") {
  window.ChromeSidebar = ChromeSidebar;
}
