# chrome-core — task runner

# Recipes run in `sh`, which doesn't inherit cargo from an interactive fish/zsh setup.
export PATH := env_var('HOME') + "/.cargo/bin:" + env_var('PATH')

# `default` pipes `just --list` through a small stock-perl filter that clips long recipe
# docs to your terminal width (…) instead of wrapping. Self-contained — no external files;
# falls back to plain `just --list` where perl is absent. Edit the recipes below, not this.
# List available recipes
default:
    @if command -v perl >/dev/null 2>&1; then just --color always --list | perl -CS -Mutf8 -lpe 'BEGIN{($w)=`stty size 2>/dev/null </dev/tty`=~/ (\d+)/; $w||=100; $col=(-t STDOUT && !exists $ENV{NO_COLOR})} s/\e\[[0-9;]*m//g unless $col; (my $v=$_)=~s/\e\[[0-9;]*m//g; if(length($v)>$w){my($o,$n)=("",0); while(length && $n<$w-1){ if($col && s/^(\e\[[0-9;]*m)//){$o.=$1}else{s/^(.)//;$o.=$1;$n++} } $_=$o."…".($col?"\e[0m":"")}'; else just --list; fi

# The fast loop for iterating on assets/sidebar.{css,js} without building curator or warden.
# Serves the repo root, so the sidebar mounted in isolation is at <printed URL>preview.html;
# pass a port to pin it. URL params (they compose): see preview.html's header comment.
# Serve the visual preview with live reload — open preview.html at the printed URL
[group("dev")]
dev port="":
    ./tools/dev.sh {{ port }}

# Renders through plate (github.com/lockyc/plate). A file:// URL, since plate reads a bare path as a file name, query and all.
# Screenshot the preview to preview.png (git-ignored). Density: `just shot compact`.
[group("dev")]
shot density="comfortable":
    plate render --png preview.png --size 310x900 --scale 2 "file://{{justfile_directory()}}/preview.html?density={{density}}"

# Regenerate the README's screenshot, docs/screenshots/sidebar.png
[group("dev")]
readme-shot:
    plate render --png docs/screenshots/sidebar.png --size 520x760 preview.html

# Covers the pure helpers and render/event behaviour on a fake DOM (tests/). Visual behaviour is out of scope — use `just dev` / `just shot`.
# Unit- and property-test the component's JS logic (node:test + fast-check)
[group("check")]
test: _deps
    node --test

# Occasional: the operation-sequence property test at 20× its usual runs (FC_RUNS)
[group("check")]
soak runs="8000": _deps
    FC_RUNS={{ runs }} node --test tests/sidebar.state.test.js

# Install the test harness's dev dependencies when the lockfile is newer than node_modules
[private]
_deps:
    @[ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund --silent

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
gate: _deps
    cargo fmt --check
    node --test
    cargo build
