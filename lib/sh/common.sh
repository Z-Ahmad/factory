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

# fk_worktree_hidden: the paths `factory worktree` puts in a worktree and git must not count as dirt, one per
# line: [worktree] cache_symlinks, copy_files and each derived output path.
fk_worktree_hidden() {
  local i n="${FK_WORKTREE_DERIVED_COUNT:-0}" v
  printf '%s\n' "${FK_WORKTREE_CACHE_SYMLINKS:-}" "${FK_WORKTREE_COPY_FILES:-}"
  for ((i = 0; i < n; i++)); do v="FK_WORKTREE_DERIVED_${i}_PATH"; printf '%s\n' "${!v:-}"; done
}

# fk_dirt <dir>: `git status --porcelain` for a worktree, minus what the kit puts there (fk_worktree_hidden).
fk_dirt() {
  git -C "$1" status --porcelain 2>/dev/null | SKIP="$(fk_worktree_hidden)" awk '
    BEGIN { n = split(ENVIRON["SKIP"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") hide[a[i]] = 1 }
    { path = substr($0, 4); sub(/\/$/, "", path); if (!(($1 == "??") && (path in hide))) print }'
}

# fk_fill <template> <name> <value> [<name> <value>...]: replaces {name} for the names given, in one
# pass, so a value is never expanded again and special characters in it stay literal.
# Any other {word} is left as written. Prints the result and a newline.
fk_fill() {
  local tpl="$1"; shift
  local names="" vars=()
  while [[ $# -gt 1 ]]; do vars+=("FILL_$1=$2"); names+=" $1"; shift 2; done
  env ${vars[@]+"${vars[@]}"} FILL_NAMES="$names" FILL_TPL="$tpl" awk '
    BEGIN {
      s = ENVIRON["FILL_TPL"]; names = " " ENVIRON["FILL_NAMES"] " "; out = ""
      while ((i = index(s, "{")) > 0) {
        out = out substr(s, 1, i - 1); s = substr(s, i)
        j = index(s, "}")
        if (j > 0) {
          name = substr(s, 2, j - 2)
          if (name ~ /^[A-Za-z_]+$/ && index(names, " " name " ") > 0) {
            out = out ENVIRON["FILL_" name]; s = substr(s, j + 1); continue
          }
        }
        out = out "{"; s = substr(s, 2)
      }
      print out s
    }'
}

# fk_listen_pids <port>: PIDs listening on a TCP port, one per line (empty when none, or when lsof is missing).
fk_listen_pids() { lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true; }

# fk_spawn_detached <dir> <logfile> <shell command>: start the command in <dir> in its own session
# (so it outlives this shell and can be signalled as a group), output appended to the log.
# Prints the PID, which is also the process group id.
fk_spawn_detached() {
  mkdir -p "$(dirname "$2")"
  node -e '
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [dir, log, cmd] = process.argv.slice(1);
    const fd = fs.openSync(log, "a");
    const p = spawn("/bin/sh", ["-c", cmd], { cwd: dir, detached: true, stdio: ["ignore", fd, fd] });
    p.on("error", (e) => { console.error(e.message); process.exit(1); });
    p.unref();
    if (p.pid === undefined) setImmediate(() => process.exit(1));
    else console.log(p.pid);
  ' "$1" "$2" "$3"
}

# fk_seed_restore: run [seed] restore from the main checkout. Prints its combined output and returns its status.
# With no [seed] restore configured it prints one line and returns 0.
fk_seed_restore() {
  if [[ -z "${FK_SEED_RESTORE:-}" ]]; then echo "no [seed] restore command; skipped"; return 0; fi
  ( cd "${FK_PROJECT_MAIN_CHECKOUT:?}" && bash -c "$FK_SEED_RESTORE" 2>&1 )
}
