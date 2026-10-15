#!/usr/bin/env bash
# Portable helpers for kit commands. Source it; it defines functions only.
#   . "$FK_KIT_DIR/lib/sh/common.sh"
# Works on macOS and Linux (no lsof, no GNU-only flags).

fk_die() { echo "factory: $*" >&2; exit 1; }

# fk_port_up <port> [host]: exit 0 when something accepts a TCP connection (node net probe).
fk_port_up() {
  node -e '
    const s = require("node:net").connect({ port: Number(process.argv[2]), host: process.argv[1] });
    s.setTimeout(500);
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("timeout", () => process.exit(1));
    s.on("error", () => process.exit(1));
  ' "${2:-localhost}" "$1"
}

# fk_free_gb [path]: whole GB free on the volume holding path (default /).
fk_free_gb() { df -k "${1:-/}" | awk 'NR==2 {printf "%d", $4/1048576}'; }

# fk_human <kilobytes>: 1536 -> 2M, 3145728 -> 3.0G
fk_human() {
  awk -v k="$1" 'BEGIN { if (k >= 1048576) printf "%.1fG", k/1048576; else if (k >= 1024) printf "%.0fM", k/1024; else printf "%dK", k }'
}

# fk_worktrees [repo]: one line per worktree, tab-separated: path, HEAD sha, branch (empty when detached).
fk_worktrees() {
  git -C "${1:-.}" worktree list --porcelain | awk '
    /^worktree /{p=substr($0, 10)} /^HEAD /{h=$2} /^branch /{b=$2; sub("refs/heads/","",b)}
    /^$/{ if (p) print p "\t" h "\t" b; p="";h="";b="" }
    END{ if (p) print p "\t" h "\t" b }'
}

# fk_dirt <dir>: `git status --porcelain` for a worktree, minus the cache symlinks
# the kit puts there ([worktree] cache_symlinks, from $FK_WORKTREE_CACHE_SYMLINKS).
fk_dirt() {
  git -C "$1" status --porcelain 2>/dev/null | SKIP="${FK_WORKTREE_CACHE_SYMLINKS:-}" awk '
    BEGIN { n = split(ENVIRON["SKIP"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") hide[a[i]] = 1 }
    { path = substr($0, 4); sub(/\/$/, "", path); if (!(($1 == "??") && (path in hide))) print }'
}
