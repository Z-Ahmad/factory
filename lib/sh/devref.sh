# Helpers for the dev stack's worktree: which ref it runs, moving it, the project's prep step.
# Source it after common.sh. It defines functions only.
#   . "$FK_KIT_DIR/lib/sh/common.sh"; . "$FK_KIT_DIR/lib/sh/devref.sh"
# State: <state_dir>/dev.ref holds `ref=` (as typed), `sha=` (what it resolved to) and `time=` (UTC, when it was
# switched). No file, or ref = [dev] follow (default "main"), means the stack follows origin/<follow>.
# Every network call and the prep step run under a deadline (FK_DEV_NET_TIMEOUT_S, default 60;
# FK_DEV_PREP_TIMEOUT_S, default 900).

fk_dev_follow() { printf '%s\n' "${FK_DEV_FOLLOW:-main}"; }

# fk_dev_dir [override]: the dev worktree ([dev] cwd, relative to the main checkout, or the override).
fk_dev_dir() {
  local d="${1:-${FK_DEV_CWD:-}}"
  [[ -n "$d" ]] || return 1
  [[ "$d" == /* ]] || d="${FK_PROJECT_MAIN_CHECKOUT:?}/$d"
  printf '%s\n' "$d"
}

# fk_dev_is_worktree <dir>: the directory is the root of its own git work tree (not a folder inside another checkout).
fk_dev_is_worktree() {
  local top real
  [[ -d "$1" ]] || return 1
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  real="$(cd "$1" && pwd -P)"
  [[ "$top" == "$real" ]]
}

fk_dev_ref_file() { printf '%s\n' "${FK_PROJECT_STATE_DIR:?}/dev.ref"; }

# fk_dev_ref: the recorded ref, empty when none.
fk_dev_ref() {
  local f; f="$(fk_dev_ref_file)"
  if [[ -f "$f" ]]; then sed -n 's/^ref=//p' "$f" | head -n 1; fi
}

# fk_dev_following <ref>: true for no ref, "main" or [dev] follow.
fk_dev_following() { [[ -z "$1" || "$1" == main || "$1" == "$(fk_dev_follow)" ]]; }

# fk_dev_record <ref> <sha> [time]: write the state file.
fk_dev_record() {
  local f; f="$(fk_dev_ref_file)"
  mkdir -p "$(dirname "$f")"
  printf 'ref=%s\nsha=%s\ntime=%s\n' "$1" "$2" "${3:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" > "$f"
}

fk_dev_deadline() { local s="$1"; shift; node "$FK_KIT_DIR/lib/deadline.mjs" "$s" "$@"; }
fk_dev_net() { fk_dev_deadline "${FK_DEV_NET_TIMEOUT_S:-60}" "$@"; }

# fk_dev_fetch <dir>
fk_dev_fetch() { fk_dev_net git -C "$1" fetch --prune --quiet origin; }

# fk_dev_dirty <dir>: true when a tracked file is modified or staged (untracked build output is fine).
fk_dev_dirty() { [[ -n "$(git -C "$1" status --porcelain --untracked-files=no 2>/dev/null)" ]]; }

# fk_dev_resolve <ref> <dir>: print the commit the ref means now (after a fetch); a message on stderr and status 1 when it
# means none. main / [dev] follow -> origin/<follow>; 123 or #123 -> the PR's head (gh); else origin/<branch>.
fk_dev_resolve() {
  local ref="$1" dir="$2" n json sha
  if fk_dev_following "$ref"; then
    git -C "$dir" rev-parse --verify -q "origin/$(fk_dev_follow)^{commit}" && return 0
    echo "factory-dev: no origin/$(fk_dev_follow) in $dir" >&2; return 1
  fi
  n="${ref#\#}"
  if [[ "$n" =~ ^[0-9]+$ ]]; then
    local args=(pr view "$n" --json headRefName,headRefOid)
    if [[ -n "${FK_GIT_GITHUB:-}" ]]; then args+=(-R "$FK_GIT_GITHUB"); fi
    if ! json="$(cd "$dir" && fk_dev_net gh "${args[@]}" 2>&1)"; then
      echo "factory-dev: cannot read PR #$n: $json" >&2; return 1
    fi
    sha="$(node -e 'try { process.stdout.write(String(JSON.parse(process.argv[1]).headRefOid || "")); } catch {}' "$json")"
    [[ -n "$sha" ]] || { echo "factory-dev: PR #$n has no head commit ($json)" >&2; return 1; }
    if ! git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null; then
      fk_dev_net git -C "$dir" fetch --quiet origin "refs/pull/$n/head" >/dev/null 2>&1 || true
      git -C "$dir" cat-file -e "$sha^{commit}" 2>/dev/null || { echo "factory-dev: PR #$n head ${sha:0:7} is not on origin" >&2; return 1; }
    fi
    printf '%s\n' "$sha"; return 0
  fi
  git -C "$dir" rev-parse --verify -q "origin/$ref^{commit}" && return 0
  echo "factory-dev: no branch origin/$ref (and $ref is not a PR number)" >&2; return 1
}

# fk_dev_describe <dir> [rev]: "<short sha> <subject>"
fk_dev_describe() { git -C "$1" log -1 --format='%h %s' "${2:-HEAD}" 2>/dev/null; }

# fk_dev_behind <dir>: commits on origin/<follow> that HEAD lacks.
fk_dev_behind() { git -C "$1" rev-list --count "HEAD..origin/$(fk_dev_follow)" 2>/dev/null || echo 0; }

# fk_dev_prep <dir>: run [dev] prep in the dir. Status 8 (output on stderr) when it fails.
fk_dev_prep() {
  [[ -n "${FK_DEV_PREP:-}" ]] || return 0
  local out rc=0
  out="$(cd "$1" && fk_dev_deadline "${FK_DEV_PREP_TIMEOUT_S:-900}" bash -c "$FK_DEV_PREP" 2>&1)" || rc=$?
  if (( rc != 0 )); then
    printf '%s\n' "$out" | tail -n 20 >&2
    echo "factory-dev: prep ($FK_DEV_PREP) failed (exit $rc$([[ $rc == 124 ]] && echo ', the deadline'))" >&2
    return 8
  fi
  echo "factory-dev: prep ok ($FK_DEV_PREP)"
}

# fk_dev_move <dir> <sha> <ref label>: detach the worktree at the commit and run prep. Status 5 when tracked files
# are modified, 8 when prep fails, 9 when git refuses.
fk_dev_move() {
  local dir="$1" sha="$2"
  if fk_dev_dirty "$dir"; then
    echo "factory-dev: $dir has uncommitted tracked changes; not moving it" >&2; return 5
  fi
  git -C "$dir" checkout --detach --quiet "$sha" || { echo "factory-dev: could not check out ${sha:0:7} in $dir" >&2; return 9; }
  fk_dev_prep "$dir"
}

# fk_dev_sync <dir>: before the stack starts. Fetch, then move the worktree to what the recorded ref means now
# (origin/<follow> when following), run prep when it moved, print one line saying which ref it is on.
# Status 0 also when the dir is no git worktree of its own (nothing to follow). 5, 8, 9 as fk_dev_move;
# callers treat 5 and 9 as a warning (start on what is there) and 8 as fatal.
fk_dev_sync() {
  local dir="$1" ref sha head rc=0 label
  fk_dev_is_worktree "$dir" || return 0
  fk_dev_fetch "$dir" || echo "factory-dev: fetch failed; using what was last fetched" >&2
  ref="$(fk_dev_ref)"
  sha="$(fk_dev_resolve "$ref" "$dir")" || return 9
  head="$(git -C "$dir" rev-parse HEAD 2>/dev/null)"
  if [[ "$head" != "$sha" ]]; then
    fk_dev_move "$dir" "$sha" || rc=$?
    (( rc == 0 )) || return "$rc"
  fi
  if [[ -n "$ref" ]] && ! fk_dev_following "$ref"; then
    [[ "$(sed -n 's/^sha=//p' "$(fk_dev_ref_file)")" == "$sha" ]] || fk_dev_record "$ref" "$sha"
    label="on $ref"
  else
    label="following origin/$(fk_dev_follow)"
  fi
  echo "factory-dev: $label at $(fk_dev_describe "$dir")"
}

# fk_dev_note <dir>: a stack that is already up is not moved under itself; say where it stands.
fk_dev_note() {
  local dir="$1" ref behind label
  fk_dev_is_worktree "$dir" || return 0
  fk_dev_fetch "$dir" 2>/dev/null || true
  ref="$(fk_dev_ref)"; behind="$(fk_dev_behind "$dir")"
  if fk_dev_following "$ref"; then label="following origin/$(fk_dev_follow)"; else label="on $ref"; fi
  echo "factory-dev: $label at $(fk_dev_describe "$dir"); $behind behind origin/$(fk_dev_follow)$([[ "$behind" -gt 0 ]] && echo '; `factory dev restart` moves it')"
}
