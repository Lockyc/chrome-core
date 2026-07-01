//! Shared sidebar chrome as embedded string constants.
//!
//! Consumers (curator, warden) take this as a **build-dependency** and their `build.rs` writes
//! these into the app's `frontendDist` before Tauri's `generate_context!` embeds that dir. The
//! source of truth is `assets/sidebar.{css,js}`; this crate is a thin `include_str!` wrapper so the
//! assets ride cargo's git-dependency fetch (a plain `git clone` of an app still builds).
pub const SIDEBAR_CSS: &str = include_str!("../assets/sidebar.css");
pub const SIDEBAR_JS: &str = include_str!("../assets/sidebar.js");
