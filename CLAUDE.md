---
type: architecture
links:
  - rel: see-also
    to: README.md
---

# chrome-core — agent notes

The shared sidebar chrome for **curator**, **warden**, and **lector** (sibling public macOS Tauri
apps). One component, consumed by all three, so a look/behaviour change is made once and every
app moves together.

## What this is

- `assets/sidebar.css` + `assets/sidebar.js` — the source of truth: a framework-free `ChromeSidebar`
  component (no bundler, plain `<script>` global + CommonJS export for tests).
- `src/lib.rs` — a thin crate that `include_str!`s those two files into `pub const SIDEBAR_CSS` /
  `SIDEBAR_JS`, so the assets ride cargo's git-dependency fetch.

## The dividing line: app-agnostic belongs here; only app-*type*-specific stays in the app

chrome-core is the shared, composable layer, and the whole reason to share components is that
**capabilities universal across apps live once, here — not just the view.** The line is
**app-agnostic (belongs in the core) vs app-*type*-specific (stays in the app)** — NOT "view vs logic."

- **Stays in the app** — behaviour tied to *what the app is*: app-specific Tauri command *names*,
  `#terminal-hole`/`reportRect` (warden's native-surface plumbing), browser-nav logic. Divergence
  between apps enters **only** through the DTO, the callbacks, and the optional `header` slot;
  each app keeps a thin controller binding those to its backend.
- **Belongs in the core** — capabilities that are the same for *any* app regardless of what it hosts.
  **Self-update is the exemplar:** checking for a release, the update bar, download/install/relaunch,
  the session-dismiss behaviour, and the re-check cadence are identical whether the app hosts terminals,
  webviews, or local doc sites — so they live **once, here**, and every consuming app inherits them. An
  updater is not a terminal feature or a browser feature; it's an *app* feature.

> **Decision (2026-07-08): app-agnostic capabilities (self-update first) are owned by chrome-core, not
> reimplemented per app.** Status: **active; implemented.** The earlier framing — "the component is a
> VIEW only; the consumer owns the updater" — was backwards: it demoted a universal capability to an
> app concern, which led to the updater being copy-pasted into both app controllers. **Do not
> re-litigate this** (it was questioned once already): reimplementing an app-agnostic capability per
> app is the anti-pattern a shared-components repo exists to remove. A shared capability may use a
> platform primitive that *all* consumers share (the Tauri runtime): the core **feature-detects** it
> (`window.__TAURI__?.updater`) so the isolated `preview.html` — which has no Tauri — no-ops, while
> every real app's Tauri runtime is presented the full capability. Each app's own capabilities file
> must still separately grant the updater permission for the plugin call to succeed — a chrome-core-
> external concern owned by each app's own `capabilities/*.json` and CLAUDE.md, not this file. The
> per-app *identity* a universal capability still needs —
> the release endpoint, the signing pubkey, the Rust plugin registration, the `auto_update` gate — is
> config, not logic, and stays in the app. **Where it lives:** `sidebar.js`'s self-update section
> (`checkForUpdate`/`_installUpdate`/`_startUpdater` + `UPDATE_CHECK_INTERVAL_MS`); each app passes
> `autoUpdate` (mount config) and forwards its menu event to `checkForUpdateNow()`.

## Interface contract

`ChromeSidebar.mount(container, callbacks, config) -> instance`

- **callbacks:** `onSelect(id, {wasActive})`, `onUnload(id)`, `onKill(id)`, `onKillClose(id)` (optional —
  see below), `onStart(id)`, `onResize(width)`,
  `onRescan(group)`, `onPopOut(id)` (optional — see below). (The update bar is wired **internally** —
  self-update is a core capability, see the dividing-line decision above — so there is **no**
  `onUpdate`/`onUpdateDismiss` callback.)
- **config:** `{ header: Node|null, appName: string|null, storageKey, defaultWidth, minWidth, maxWidth, maxFraction, autoUpdate }`.
  **`appName`** (default null) names the host app in a strip above the banner, beside the macOS
  traffic lights. Every consumer uses `TitleBarStyle::Overlay`, which hides the native window title
  entirely — so without this the app's own name appears nowhere on screen. chrome-core owns the
  strip (`#cc-titlebar`, `--cc-titlebar-h` tall, `--cc-lights-inset` of left padding to clear the
  lights); before it, each app reserved the same zone with its own `#sidebar { padding-top: 28px }`
  and drew nothing in it — **a consumer passing `appName` must drop that padding**, or the strip
  lands below the lights instead of beside them. Absent/null → no strip, and the layout is exactly
  as it was (so `preview.html` and any slot-less host are untouched).
  **`autoUpdate`** (bool, default false) is the app's config gate for self-update: when true *and* the
  Tauri runtime is present, the component runs a launch check + the recurring re-check; the menu path
  (`checkForUpdateNow()`) works regardless of it. See the dividing-line decision above.
  `maxFraction` caps the sidebar at a share of `window.innerWidth`; pass a **falsy** value (e.g. `0`)
  to skip that cap. The cap is only meaningful when the sidebar's `innerWidth` IS the host window's
  width — i.e. the sidebar is the window's full-size main webview, which **all three** current
  consumers are (curator, warden, and lector are hole-punch main webviews), so each passes a real
  `maxFraction`. A consumer
  whose sidebar were instead an isolated child webview (its `innerWidth` = the sidebar's own width,
  not the window's) would have the cap pin every drag to `minWidth`, so it would pass a falsy value
  and enforce the share-of-window limit backend-side. `storageKey` doubles as the
  per-instance namespace for tree-collapse persistence (below) — it need only be unique per mounted
  sidebar, its literal contents don't matter beyond that.
- **DTO** (`instance.update(dto)`): `{ title, colour: string|null, density: 'comfortable'|'compact',
  windowDrag?: bool, active?: id, tabs: TabDTO[] }` where `TabDTO = { id, title, group: string|null,
  live: bool, attention: null|true|number, presence: null|'on'|'ghost'|'off', killable: bool, startable: bool,
  warn: bool, tree?: bool, treePath?: string[], detached?: bool }`. **`detached`** is opt-in (absent/falsy
  on every row until an app's DTO sets it) — see the pop-out section below for what it does to a row.
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
  `clearError()`, `setUpdate({version,notes})` / `clearUpdate()` (show/hide the update-bar view),
  **`checkForUpdateNow()`** (the menu "Check for Updates…" path — check + announce the result; the app
  forwards its own app-named menu event here), and **`destroy()`** (stop the recurring update check —
  the only long-lived resource the component holds).

**Dot slots (fixed order): attention · presence · live/unload · pop-out.** Attention = amber dot, rendered as a
count pill when `attention` is a number (curator's unread count). Live/unload = green live ↔ hover-✕
unload / hollow cold. **Pop-out (`⤢`)** is an **optional trailing control, rendered only when the app
supplied an `onPopOut(id)` callback** — capability by callback presence, the same idiom as
`onKillClose` below. It fires immediately on click (`e.stopPropagation()`), the same fire-immediately
model as the tree-head `.cc-rescan` button — **not** the armed-kill state machine. What "pop out" means
is entirely the app's business (the component only reports the click); no app wires it yet.

**`detached: true` on a `TabDTO` row means that tab is already popped out into its own window** —
opt-in, like `onPopOut` itself: absent/falsy on every row until an app's DTO sets it. It changes a row
in four ways, all in `_renderRow`: (1) the row gets class `.cc-tab.detached`, muted via `opacity: 0.6`
(the same disabled-affordance treatment `#cc-update-btn:disabled` uses) — **shown, not removed or
reshuffled**, same row height and slot layout as any other row; (2) the interactive `⤢` pop-out control
is suppressed (the existing `!t.detached` guard on `onPopOut`'s render) and replaced with a **static**
`⤢` (`.cc-popout.detached-mark`, same glyph/slot, no independent hover/cursor styling since it isn't
its own control); (3) the **live/unload dot shows live regardless of `t.live`** (`_makeDot(t.detached
|| t.live)`) — a detached tab is always running, just in another window, so `t.live` (a *local*-surface
signal) would misleadingly show it cold — and its **unload click is unwired** (you don't unload a tab
that lives elsewhere; the click falls through to the row's `onSelect` → raise the popped window);
(4) clicking the row still fires `onSelect(id)` but **`select()` short-circuits for a detached
tab — it does NOT move the highlight** (`this.active`). The component adds no new callback: **the app
gives that click meaning**, interpreting `onSelect` on a tab it knows is detached as "raise the
popped-out window," not "activate this tab here." Not moving the highlight is load-bearing — the
detached tab is shown in *another* window, so highlighting its row would steal the selection indicator
from the terminal actually displayed in *this* window (the "clicking a popped-out tab steals the
sidebar focus indicator" bug). This lives in the core (not per-app) per the dividing-line
decision — like `onKillClose`, it's an app-agnostic row affordance, just one whose semantics the
consuming app supplies. Kill-confirm's row-overlay (below) hides the pop-out glyph too
(`.cc-tab.confirming .cc-popout`), covering both the interactive and the static `.detached-mark`
variant with the one rule, since a killable row's confirm overlay already hides the other slots.

**Presence is three-state — `on` | `ghost` | `off`** (warden's probe drives it; curator and lector
never set it, passing `null` = no dot). `on` = cyan, a probe reported a live session. **`ghost` = a
*recoverable* session** — none live, but the host reports one a plain launch would restore (warden:
a crashed amux session, probe exit 3); it paints the ghost mask (`--cc-ghost-mask`) rather than a
cyan dot. `off` = configured-but-absent, hollow. `on` and `ghost` are mutually exclusive. The
authority is `presenceClass` (state + `killable`/`startable`/`live` → class list); `derivePresenceState`
is its inverse, reading the state back off a painted dot.

**Kill-confirm is a row-overlay state, not a slot** (clicking a killable presence dot reddens the row,
hides the dots, shows ⏻/↩); gated on `killable` (curator and lector: always false). The presence dot
is a **session toggle**:
- **`on` + `killable`** → kills (2-step confirm).
- **`ghost` or `off`, + `startable` + the tab is `live`** → **starts**: a single click firing `onStart`
  (curator and lector: `startable` always false), re-running the tab's command. The start affordance is
  offered for **both** non-`on` states — a ghost is decoration *on* that same affordance, not a
  separate path.
- **`ghost` never gets a kill affordance** — a recoverable drop is already a dead session, so there's
  nothing to kill.
- **Cold (not `live`)** shows no start affordance regardless of state (no shell to type into — the
  row-click activation path starts it instead).

> **Footgun — `ghost` is easy to erase.** It reads as a cosmetic variant of `off`, so both a
> `state === "on" ? … : "off"` collapse in `presenceClass` and a `classNames.includes("on") ? "on" : "off"`
> collapse in `derivePresenceState` look like harmless simplifications. The second is the nastier one:
> it silently downgrades a ghost to `off` **on every repaint** (load/unload, live-state change), so the
> recoverable signal decays away with no error — the dot is simply wrong a moment later. `tests/sidebar.test.js`
> guards both; don't "simplify" either mapping to two states.

The confirm row carries an **optional third control, `☠` (kill-both)**, rendered left of `⏻`
**only when the app supplied an `onKillClose(id)` callback** — capability by callback presence, so an
app that doesn't offer it (curator) is untouched. It is a second *terminal action off the same armed
row*: it reads the same `armedKill`, shares `_makeConfirmControl`, and disarms identically — it does
**not** add a second arming path. What "close" means is the app's business (warden: kill the session,
then unload the terminal); the component only reports the click.

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
`--cc-banner-min` to match (the chrome-core-rev lockstep bump across every consuming app is where this is caught).

**Project-tree sections** (`tree`/`treePath` on `TabDTO`, warden-only — curator and lector never
set them): a
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
`SIDEBAR_JS` into the app's `frontendDist` (`src/` for curator and lector, `ui/` for warden) as
`chrome-core.{css,js}` before `generate_context!` embeds it. The generated files are git-ignored in
each app. **Pin this crate by `rev` and bump it in lockstep with config-core and the Rust toolchain
pin** across curator, warden, and lector (the same lockstep discipline those already follow).

The `rev` **is** this crate's version identity — the Cargo `version` field is inert (`publish = false`,
nothing reads it) and stays parked at `0.1.0`, matching config-core / shell-core. Footgun: don't bump it
or cut GitHub releases — an earlier habit did both (v0.1.4/v0.1.5, versions to 0.1.9) and it drifted,
since no consumer pins by version. Re-pin the rev instead; that's the whole mechanism.

Dev iteration on the chrome from inside an app is higher-friction behind a pinned rev — so each app
ships **`just chrome-dev`** (build against a local `../chrome-core` checkout via a normally-commented
`[patch]`) and **`just chrome-pin`** (re-pin the app's rev to `../chrome-core`'s pushed HEAD and
re-comment the patch before you commit); `just gate` in each app refuses a left-active patch. Reach
this repo's preview from any app with **`just chrome-preview`**. See warden's / curator's / lector's CLAUDE.md.

For **visual** tweaks, skip the app round-trip entirely: the checked-in **`preview.html`** mounts the
component in isolation with a representative DTO (loose tabs, a plain group, and a project-tree with
folders + leaves, across the dot states). **`just preview`** opens it in a browser; **`just shot
[density]`** headless-screenshots it to `preview.png` (git-ignored) — both wrap the raw
`chrome --headless … --screenshot` invocation (still documented at the top of `preview.html`). URL
params compose: **`?density=compact`** previews the compact scale, **`?header=1`** mounts a stand-in
in the banner's `header` slot (curator's nav pill; warden leaves it empty) and a corner readout shows
`#cc-banner`'s measured height — which must be identical with and without `?header=1`, the check that
`--cc-banner-min` keeps the banner one height regardless of the slot. This is the fast loop for
iterating on `sidebar.{css,js}`; the pinned-rev round-trip through an app is only for shipping.

## Build / test

`just build` (`cargo build`) compiles the `include_str!` constants (catches a missing/renamed asset).
`just test` (`node --test`) unit-tests the pure logic (`tileInitial`/`tileColour`/`tintOverBase`/
`clampWidth`/`presenceClass`/`derivePresenceState`/`resolveOffset`/`buildTree`); `just gate` runs
rustfmt-check + tests + build together. DOM/visual
behaviour has no unit coverage — iterate it with `just preview` / `just shot` (above) and confirm
integration by running the consuming apps.
