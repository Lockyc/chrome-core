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

- **callbacks:** `onSelect(id, {wasActive})`, `onUnload(id)`, `onKill(id)`, `onResize(width)`.
- **config:** `{ header: Node|null, storageKey, defaultWidth, minWidth, maxWidth, maxFraction }`.
- **DTO** (`instance.update(dto)`): `{ title, colour: string|null, density: 'comfortable'|'compact',
  tabs: TabDTO[] }` where `TabDTO = { id, title, group: string|null, live: bool,
  attention: null|true|number, presence: null|'on'|'off', killable: bool, warn: bool }`.
- **methods:** `update(dto)`, `setActive(id)`, `setLive(id,live)`, `setAttention(id,val)`,
  `setPresence(id,state)`, `selectByOffset(dir,{liveOnly})`, `selectByIndex(n)`, `setError(msg)`,
  `clearError()`.

**Dot slots (fixed order): attention · presence · live/unload.** Attention = amber dot, rendered as a
count pill when `attention` is a number (curator's unread count). Presence = cyan on/off (warden's
probe; curator never sets it). Live/unload = green live ↔ hover-✕ unload / hollow cold.
**Kill-confirm is a row-overlay state, not a slot** (clicking a killable presence dot reddens the row,
hides the dots, shows ⏻/↩); gated on `killable` (curator: always false).

The component owns `cc-`-prefixed IDs (`#cc-sidebar`, `#cc-banner`, `#cc-tab-list`, `#cc-error`,
`#cc-resize`) so they never collide with an app's page-shell IDs.

## Consumption (build-dep + build.rs) and pinning

Each app is a **build-dependency** consumer pinned by `rev`; its `build.rs` writes `SIDEBAR_CSS`/
`SIDEBAR_JS` into the app's `frontendDist` (`src/` for curator, `ui/` for warden) as
`chrome-core.{css,js}` before `generate_context!` embeds it. The generated files are git-ignored in
each app. **Pin this crate by `rev` and bump it in lockstep with config-core and the Rust toolchain
pin** across curator + warden (the same lockstep discipline those already follow).

Dev iteration on the chrome from inside an app is higher-friction behind a pinned rev: use a cargo
path override (`[patch."https://github.com/Lockyc/chrome-core"]` → a local checkout) while actively
working the chrome, then switch back to the pinned rev before committing the app.

## Build / test

`cargo build` compiles the `include_str!` constants (catches a missing/renamed asset).
`node --test` unit-tests the pure logic (`tileColour`/`tintOverBase`/`clampWidth`/`resolveOffset`);
DOM/visual behaviour is verified by running the two apps.
