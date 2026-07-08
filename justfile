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
