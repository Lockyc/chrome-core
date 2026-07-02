# chrome-core — agent notes

The shared sidebar chrome for **curator** and **warden** (sibling public macOS Tauri apps). One
component, consumed by both, so a look/behaviour change is made once and both apps move together.

## What this is

- `assets/sidebar.css` + `assets/sidebar.js` — the source of truth: a framework-free `ChromeSidebar`
  component (no bundler, plain `<script>` global + CommonJS export for tests).
- `src/lib.rs` — a thin crate that `include_str!`s those two files into `pub const SIDEBAR_CSS` /
  `SIDEBAR_JS`, so the assets ride cargo's git-dependency fetch.

## The one invariant: the component is a VIEW only

No app-specific Tauri command names, no `#terminal-hole`/`reportRect` (warden's native-surface
plumbing), no browser-nav logic live in `sidebar.js`. Divergence between the two apps enters **only**
through the DTO, the callbacks, and the optional `header` slot. Each app keeps a ~40-line controller
that binds the callbacks to its own backend and maps its events to the setters.

## Interface contract

`ChromeSidebar.mount(container, callbacks, config) -> instance`

- **callbacks:** `onSelect(id, {wasActive})`, `onUnload(id)`, `onKill(id)`, `onStart(id)`, `onResize(width)`,
  `onRescan(group)`, `onUpdate()` (fired when the user clicks the update bar's "Update & Relaunch").
- **config:** `{ header: Node|null, storageKey, defaultWidth, minWidth, maxWidth, maxFraction }`.
  `maxFraction` caps the sidebar at a share of `window.innerWidth`; pass a **falsy** value (e.g. `0`)
  to skip that cap. The cap is only meaningful when the sidebar's `innerWidth` IS the host window's
  width — i.e. the sidebar is the window's full-size main webview, which **both** current consumers
  are (curator + warden are hole-punch main webviews), so both pass a real `maxFraction`. A consumer
  whose sidebar were instead an isolated child webview (its `innerWidth` = the sidebar's own width,
  not the window's) would have the cap pin every drag to `minWidth`, so it would pass a falsy value
  and enforce the share-of-window limit backend-side. `storageKey` doubles as the
  per-instance namespace for tree-collapse persistence (below) — it need only be unique per mounted
  sidebar, its literal contents don't matter beyond that.
- **DTO** (`instance.update(dto)`): `{ title, colour: string|null, density: 'comfortable'|'compact',
  windowDrag?: bool, active?: id, tabs: TabDTO[] }` where `TabDTO = { id, title, group: string|null,
  live: bool, attention: null|true|number, presence: null|'on'|'off', killable: bool, startable: bool,
  warn: bool, tree?: bool, treePath?: string[] }`.
  **`windowDrag`** (default **on** when absent) makes the non-interactive chrome — banner, name, the
  empty area of the tab list, group headers — a `data-tauri-drag-region` so a drag there moves the
  host window (interactive descendants stay clickable; Tauri drags only when the mousedown target
  itself carries the attr). Re-applied every `update`, so a consumer can hot-reload the toggle. A
  consumer opts out with `windowDrag: false`; warden drives it from its `sidebar_drag` config.
  **`active`** selects the ownership model: **present** ⇒ the app owns selection (curator, whose Rust
  side is authoritative) — the component honours it and does NOT fire `onSelect`; **absent** ⇒ the
  component owns it (warden) — it preserves the current selection, falls back to the first tab, and
  fires `onSelect` so the app activates the fallback.
- **`select(id)`** (public): highlight + fire `onSelect` (row clicks, keyboard nav, notification
  focus resolve to this). **`setActive(id)`**: highlight only, no callback (reflect app-actioned
  state, e.g. the neighbour activated after an unload).
- **methods:** `update(dto)`, `setActive(id)`, `setLive(id,live)`, `setAttention(id,val)`,
  `setPresence(id,state)`, `selectByOffset(dir,{liveOnly})`, `selectByIndex(n)`, `setError(msg)`,
  `clearError()`, `setUpdate({version,notes})` / `clearUpdate()` (show/hide the update bar; the
  component stays Tauri-agnostic — the consumer runs the actual check/download/relaunch on `onUpdate`).

**Dot slots (fixed order): attention · presence · live/unload.** Attention = amber dot, rendered as a
count pill when `attention` is a number (curator's unread count). Presence = cyan on/off (warden's
probe; curator never sets it). Live/unload = green live ↔ hover-✕ unload / hollow cold.
**Kill-confirm is a row-overlay state, not a slot** (clicking a killable presence dot reddens the row,
hides the dots, shows ⏻/↩); gated on `killable` (curator: always false). The presence dot is a
**session toggle**: when the session is *present* it kills (2-step confirm, `killable`); when *absent*
and the tab is *live* it **starts** — a single click firing `onStart` (gated on `startable`, curator:
always false), re-running the tab's command. Absent+cold shows no start affordance (no shell to run
in — the row-click activation path starts it instead); the gating lives in `presenceClass`.

The component owns `cc-`-prefixed IDs (`#cc-banner`, `#cc-tab-list`, `#cc-error`, `#cc-resize`) so
they never collide with an app's page-shell IDs; the mount container itself carries the `.cc-root`
class (not an id).

**The banner is a fixed height regardless of the header slot** (`--cc-banner-min` per density; `#cc-banner`
is `box-sizing: border-box` + `min-height`). So curator (nav pill in the slot) and warden (no slot) get
an **identical-height title strip** — without it warden's slot-less banner is ~11px shorter. The token is
sized to curator's nav-pill row (2px pad + 26px `.nav-btn` = 30px, plus that density's title padding). The
`border-box` is set explicitly here because curator resets `box-sizing` globally but warden/`preview.html`
don't — pinning it makes `min-height` mean the total strip height in every host. **Footgun:** this couples
chrome-core to curator's `.nav-btn`/`.nav-pill` height, which live in curator's `chrome.css` (the slot content
is app-owned) — CSS can't import across the repo boundary, so if curator changes that pill height, bump
`--cc-banner-min` to match (the chrome-core-rev lockstep bump across both apps is where this is caught).

**Project-tree sections** (`tree`/`treePath` on `TabDTO`, warden-only — curator never sets them): a
run of consecutive same-`group` tabs whose rows carry `tree: true` renders as a collapsible folder
tree instead of a flat group. `treePath` is the folder-segment chain between the tree's root and the
project (empty for a project sitting directly in the root, or for a non-tree row). The pure helper
`buildTree(rows)` (exported for tests) nests rows by `treePath` into `{ folders: [{label, folders,
rows}], rows }`, compressing single-child folder chains (labels joined with `/`) — a chain rooted at
the anonymous top level whose compression fully absorbs the top folder surfaces its children directly
(no synthetic top-level label), which only matters when the *entire* section is one unbranching chain
with no root-level rows. The tree-head (a `.cc-group.cc-tree-head`) carries the group label + a
`.cc-rescan` button firing `onRescan(group)`; an empty section renders the head plus a muted
`.cc-tree-empty` "No projects found" line. Folder rows (`.cc-folder`) toggle their subtree via a full
repaint (trees are config-scale, so this is simpler than DOM-patching visibility) and persist collapse
state in `localStorage` under `cc-tree:<storageKey>:<group>/<folder-path>` — default policy is top
level (depth 0) expanded, deeper folders collapsed. Depth indentation for both folder rows and leaf
rows (`.cc-tab.cc-tree-row`) is driven by an inline `--cc-depth` custom property against the
`--cc-indent` density token.

## Consumption (build-dep + build.rs) and pinning

Each app is a **build-dependency** consumer pinned by `rev`; its `build.rs` writes `SIDEBAR_CSS`/
`SIDEBAR_JS` into the app's `frontendDist` (`src/` for curator, `ui/` for warden) as
`chrome-core.{css,js}` before `generate_context!` embeds it. The generated files are git-ignored in
each app. **Pin this crate by `rev` and bump it in lockstep with config-core and the Rust toolchain
pin** across curator + warden (the same lockstep discipline those already follow).

Dev iteration on the chrome from inside an app is higher-friction behind a pinned rev: use a cargo
path override (`[patch."https://github.com/Lockyc/chrome-core"]` → a local checkout) while actively
working the chrome, then switch back to the pinned rev before committing the app.

For **visual** tweaks, skip the app round-trip entirely: the checked-in **`preview.html`** mounts the
component in isolation with a representative DTO (loose tabs, a plain group, and a project-tree with
folders + leaves, across the dot states). Open it in a browser, or screenshot it headlessly to *see*
a change without building either app —
`chrome --headless=new --disable-gpu --force-device-scale-factor=2 --window-size=310,900 --screenshot=preview.png "file://$PWD/preview.html"`
(`?density=compact` on the URL previews the compact scale; `preview.png` is git-ignored). This is the
fast loop for iterating on `sidebar.{css,js}`; the pinned-rev round-trip through an app is only for
shipping and final integration.

## Build / test

`cargo build` compiles the `include_str!` constants (catches a missing/renamed asset).
`node --test` unit-tests the pure logic (`tileColour`/`tintOverBase`/`clampWidth`/`resolveOffset`/
`buildTree`); DOM/visual behaviour has no unit coverage — iterate it with `preview.html` (above) and
confirm integration by running the two apps.
