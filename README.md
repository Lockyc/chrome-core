<h1 align="center">chrome-core</h1>

<p align="center">The shared sidebar chrome for <a href="https://github.com/Lockyc/curator">curator</a>, <a href="https://github.com/Lockyc/warden">warden</a>, and <a href="https://github.com/Lockyc/lector">lector</a> — one component, three apps.</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-555">
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-CSS%20%2B%20vanilla%20JS-F7DF1E?logo=javascript&logoColor=black">
  <img alt="Embedded via" src="https://img.shields.io/badge/embedded%20via-Rust-CE412B?logo=rust&logoColor=white">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/Lockyc/chrome-core"></a>
</p>

curator (browser keeper-tabs), warden (terminals), and lector (local doc sites) are sibling macOS
Tauri apps with the same sidebar silhouette. `chrome-core` is that sidebar, extracted once: a
framework-free CSS + vanilla-JS component (`ChromeSidebar`) plus a thin Rust crate that embeds the
two asset files as string constants so they ride cargo's git-dependency fetch.

chrome-core is the **shared, composable layer** for its apps. It owns the **view** — the banner +
accent tint, grouped tab rows (letter tile, title, and three status/action dot slots — attention,
presence, live/unload), the kill-confirm row overlay, density tokens, the resize-drag, and the error
bar — and, on the same sharing principle, the **app-agnostic capabilities**: anything that's the same
for any app regardless of what it hosts lives here once rather than being reimplemented per app.
**Self-update** is the exemplar and is implemented here (checking, the update bar, install/relaunch,
and the re-check cadence), so every app inherits one implementation. The dividing line is
*app-agnostic vs app-type-specific*, not *view vs logic*. Each app supplies a normalized tab DTO + a
few callbacks (and its own updater *identity* — endpoint/pubkey); each app's content-area plumbing and
backend commands stay in a thin per-app controller. See [`CLAUDE.md`](CLAUDE.md) for the dividing line
and the full interface contract.

## Status

In use. [curator](https://github.com/Lockyc/curator), [warden](https://github.com/Lockyc/warden), and
[lector](https://github.com/Lockyc/lector) all consume chrome-core, each pinned to a **commit rev** —
that rev is this crate's only version identity. There are no tags or releases, and the crate's Cargo
`version` field is inert (`publish = false`; nothing reads it). The component implements the full
sidebar view; each app supplies a thin controller binding it to its own Tauri backend.

## How it's consumed

Each app takes chrome-core as a **build-dependency** pinned by `rev`:

```toml
[build-dependencies]
chrome-core = { git = "https://github.com/Lockyc/chrome-core", rev = "<commit>" }
```

and its `build.rs` writes the constants into the app's `frontendDist` before Tauri embeds it:

```rust
std::fs::write("../src/chrome-core.css", chrome_core::SIDEBAR_CSS)?;
std::fs::write("../src/chrome-core.js",  chrome_core::SIDEBAR_JS)?;
```

The generated files are git-ignored in each app — reproducible from the pinned rev + this recipe, so
a plain `git clone` of any app still builds (cargo fetches chrome-core; build.rs materializes it).

## Build & test

```sh
cargo build     # compiles the include_str! constants (catches missing/renamed assets)
node --test     # unit-tests the component's pure logic (zero deps)
```

## License

MIT.
