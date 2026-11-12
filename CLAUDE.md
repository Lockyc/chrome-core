---
type: architecture
links:
  - rel: see-also
    to: README.md
---

# chrome-core — agent notes

The shared sidebar chrome for **curator**, **warden**, **lector** and **flotilla** (sibling public
macOS Tauri apps). One component, consumed by all four, so a look/behaviour change is made once and every
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
  between apps enters **only** through the DTO, the callbacks, and the mount config;
  each app keeps a thin controller binding those to its backend.
- **Belongs in the core** — capabilities that are the same for *any* app regardless of what it hosts.
  **Self-update is the exemplar:** checking for a release, the update bar, download/install/relaunch,
  the session-dismiss behaviour, and the re-check cadence are identical whether the app hosts terminals,
  webviews, or local doc sites — so every consuming app inherits them from the core. An updater is not
  a terminal feature or a browser feature; it's an *app* feature.

> **Decision (2026-07-08): app-agnostic capabilities (self-update first) are owned by chrome-core, not
> reimplemented per app.** Status: **active; implemented.** The earlier framing — "the component is a
> VIEW only; the consumer owns the updater" — was backwards: it demoted a universal capability to an
> app concern, which led to the updater being copy-pasted into both app controllers. **Do not
> re-litigate this** (it was questioned once already). A shared capability may use a
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

The mount call, callbacks, config, DTO, methods and every row behaviour: [docs/contract.md](docs/contract.md).

## Consumption (build-dep + build.rs) and pinning

Each app is a **build-dependency** consumer pinned by `rev`; its `build.rs` writes `SIDEBAR_CSS`/
`SIDEBAR_JS` into the app's `frontendDist` (`src/` for curator and lector, `ui/` for warden) as
`chrome-core.{css,js}` before `generate_context!` embeds it. The generated files are git-ignored in
each app. **Pin this crate by `rev` and bump it in lockstep with config-core and the Rust toolchain
pin** across curator, warden, lector and flotilla (the same lockstep discipline those already follow).

The `rev` **is** this crate's version identity — the Cargo `version` field is inert (`publish = false`,
nothing reads it) and stays parked at `0.1.0`, matching config-core / shell-core. Footgun: don't bump the
version or cut GitHub releases — no consumer pins by version, so a version bump drifts against the rev that
is the real identity while changing nothing. Re-pin the rev instead; that's the whole mechanism.

Dev iteration on the chrome from inside an app is higher-friction behind a pinned rev — so each app
ships **`just chrome-dev`** (build against a local `../chrome-core` checkout via a normally-commented
`[patch]`) and **`just chrome-pin`** (re-pin the app's rev to `../chrome-core`'s pushed HEAD and
re-comment the patch before you commit); `just gate` in each app refuses a left-active patch. Reach
this repo's preview from any app with **`just chrome-preview`**. See warden's / curator's / lector's CLAUDE.md.

For **visual** tweaks, skip the app round-trip entirely: the checked-in **`preview.html`** mounts the
component in isolation with a representative DTO (loose tabs, a plain group, headed groups expanded
and collapsed, and a project-tree with folders + leaves, across the dot states). **`just dev`** serves the repo with live reload (the house
`tools/dev.sh` over `live-server`; open `preview.html` at the printed URL); **`just shot
[density]`** headless-screenshots it to `preview.png` (git-ignored). Its URL params compose; `preview.html`'s header
comment documents them. This is the fast loop for iterating on `sidebar.{css,js}`; the pinned-rev round-trip through an app is only for shipping.

## Build / test

`just build` (`cargo build`) compiles the `include_str!` constants (catches a missing/renamed asset).
`just test` (`node --test`) unit-tests the exported pure helpers (`tests/sidebar.test.js`), and mounts
the component on the minimal fake DOM in `tests/dom.js` for render/event behaviour; `just gate`
runs rustfmt-check + tests + build together. Visual behaviour has no unit coverage — iterate it with
`just dev` / `just shot` (above) and confirm integration by running the consuming apps.
