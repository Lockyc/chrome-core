<h1 align="center">chrome-core</h1>

<p align="center">The shared sidebar chrome for <a href="https://github.com/Lockyc/curator">curator</a>, <a href="https://github.com/Lockyc/warden">warden</a>, and <a href="https://github.com/Lockyc/lector">lector</a> — one component, three apps.</p>

<p align="center">
  <a href="https://github.com/lockyc/chrome-core/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/lockyc/chrome-core/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-555">
  <img alt="Built with" src="https://img.shields.io/badge/built%20with-CSS%20%2B%20vanilla%20JS-F7DF1E?logo=javascript&logoColor=black">
  <img alt="Embedded via" src="https://img.shields.io/badge/embedded%20via-Rust-CE412B?logo=rust&logoColor=white">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/Lockyc/chrome-core"></a>
</p>

curator (browser keeper-tabs), warden (terminals), and lector (local doc sites) are sibling macOS
Tauri apps with the same sidebar. `chrome-core` is that sidebar: a framework-free CSS + vanilla-JS
component (`ChromeSidebar`) plus a thin Rust crate that exposes the two asset files as string
constants.

It provides two things:

- **The view**: the window-name banner and its accent colour; grouped tab rows, each with a letter
  tile, a title and three status dots (needs attention, session present, loaded/unload); the
  end-session confirmation (⏻ suspend / ☠ destroy); comfortable/compact sizing; the sidebar resize
  drag; and the error bar.
- **Capabilities every app needs**, notably **self-update**: the update check, the update bar,
  install and relaunch, and the periodic re-check.

Each app supplies a normalized tab DTO, a few callbacks, and its updater
identity (endpoint/pubkey); its content area and backend commands stay in a thin per-app
controller. The interface contract is in [`CLAUDE.md`](CLAUDE.md).

## Status

In use. [curator](https://github.com/Lockyc/curator), [warden](https://github.com/Lockyc/warden), and
[lector](https://github.com/Lockyc/lector) all consume chrome-core, each pinned to a **commit rev**.
There are no tags or releases.

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

The generated files are git-ignored in each app; `cargo build` regenerates them, so a fresh clone
builds as-is.

## Build & test

```sh
cargo build     # compiles the include_str! constants (catches missing/renamed assets)
node --test     # unit-tests the component's pure logic (zero deps)
```

## License

MIT.
