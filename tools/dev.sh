#!/usr/bin/env bash
# Serve the site on loopback with live reload, for design iteration. Nothing is
# built or rewritten. House contract: lockyc-config skill, references/dev-server.md.
set -euo pipefail

# The directory to serve — the ONLY line to change per repo. "." for a repo whose
# root is the site; "site", "public", "mockup" for one that keeps it in a subdir.
SITE_DIR="."

# Resolved from THIS SCRIPT's location, never the caller's cwd: a cwd-derived root
# silently serves whatever repo you happen to be standing in, and makes every repo
# hash to the same port. Works outside a git checkout too.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

command -v live-server >/dev/null || {
	echo "dev: live-server not found on PATH — 'cargo install live-server'" >&2
	exit 1
}

# No argument: a deterministic per-repo base in 31000–31999, stable across restarts
# (yesterday's browser tab still works) and distinct per project (two repos never
# collide), rolling forward through the band if something is already listening.
# An argument is an explicit request: bind exactly it and let the bind fail loudly.
# Probes by connecting, so a listener on another interface or a socket in TIME_WAIT
# is invisible here — the server's own bind failure is the backstop, not this.
dev_port() {
	local want=${1:-} base p i
	[[ -n $want ]] && { printf '%s' "$want"; return 0; }
	base=$((31000 + $(basename "$ROOT" | cksum | cut -d' ' -f1) % 1000))
	for ((i = 0; i < 128; i++)); do
		p=$((31000 + (base - 31000 + i) % 1000))
		(exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null || { printf '%s' "$p"; return 0; }
	done
	echo "dev: no free port in 31000-31999" >&2
	return 1
}

PORT=$(dev_port "${1:-${DEV_PORT:-}}")
URL="http://127.0.0.1:${PORT}/"

# The URL is the one output rule 5 guarantees, so it gets its own line, short enough
# never to wrap, as an OSC 8 hyperlink (clickable even where URL sniffing isn't).
# Styling only on a terminal and never under NO_COLOR, so piped output stays plain.
b='' d='' c='' r='' link=$URL
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
	b=$'\e[1m' d=$'\e[2m' c=$'\e[1;36m' r=$'\e[0m'
	link=$'\e]8;;'"$URL"$'\e\\'"$URL"$'\e]8;;\e\\'
fi
printf '\n  %s%s%s %sdev%s\n\n  %s➜%s  %s%s%s\n  %s%s/ · live reload · Ctrl-C to stop%s\n\n' \
	"$b" "$(basename "$ROOT")" "$r" "$d" "$r" "$c" "$r" "$b" "$link" "$r" "$d" "$SITE_DIR" "$r"

# RUST_LOG=warn drops live-server's INFO lines, which only repeat the banner above;
# warnings and errors (a failed bind) still print.
RUST_LOG=warn exec live-server -H 127.0.0.1 -p "$PORT" -I "${ROOT}/${SITE_DIR}"
