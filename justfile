# chrome-core — task runner

# Recipes run in `sh`, which doesn't inherit cargo from an interactive fish/zsh setup.
export PATH := env_var('HOME') + "/.cargo/bin:" + env_var('PATH')

# List available recipes
default:
    @just --list

# The fast loop for iterating on assets/sidebar.{css,js} without building curator or warden.
# URL params: ?density=compact and ?header=1 (mount a header-slot stand-in); see preview.html.
# Open the visual preview (the sidebar mounted in isolation) in your default browser.
[group("dev")]
preview:
    open "{{justfile_directory()}}/preview.html"

# Headless-screenshot the preview to preview.png (git-ignored). Density: `just shot compact`.
[group("dev")]
shot density="comfortable":
    #!/usr/bin/env bash
    set -euo pipefail
    dir="{{justfile_directory()}}"
    browser=""
    for b in chromium google-chrome google-chrome-stable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
      if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then browser="$b"; break; fi
    done
    [ -n "$browser" ] || { echo "✗ no Chromium/Chrome found — install one or just \`just preview\`"; exit 1; }
    "$browser" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=310,900 --default-background-color=00000000 \
      --screenshot="$dir/preview.png" "file://$dir/preview.html?density={{density}}"
    echo "✓ wrote preview.png ({{density}})"

# Unit-test the pure JS logic (tileColour / tintOverBase / clampWidth / resolveOffset / buildTree)
[group("check")]
test:
    node --test

# Compile the include_str! constants (catches a missing/renamed asset)
[group("check")]
build:
    cargo build

# Format Rust sources
[group("check")]
fmt:
    cargo fmt

# Pre-merge gate: rustfmt check (non-mutating), JS unit tests, and the include_str! build.
[group("check")]
gate:
    cargo fmt --check
    node --test
    cargo build
