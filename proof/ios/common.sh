#!/usr/bin/env bash
# Helpers shared by sim-proof-core.sh and proof-matrix.sh. Source it; it defines functions only.
#   . "$FK_KIT_DIR/proof/ios/common.sh"
# Needs the FK_* variables bin/factory exports from factory.toml.

# fk_proof_json <dotted.key>: a config value as JSON (tables) or text; `--raw` keeps {placeholders} as written.
# Prints nothing and returns 0 when the key is not set.
fk_proof_json() {
  node "${FK_KIT_DIR:?run this through bin/factory}/cmd/config.mjs" get --raw "$1" 2>/dev/null || true
}

# fk_proof_dd [arg]: the derived-data directory, created. An absolute arg is used as is, a relative one is relative to
# the project root; no arg means <disk.dd_root>/dd-<proof.ios.dd>, and from a git worktree (a project root whose .git is
# a file) <disk.dd_root>/dd-<proof.ios.dd>-<worktree folder name>, so a proof never installs another checkout's
# build. Every one gets a .metadata_never_index, so Spotlight does not index gigabytes of build products.
fk_proof_dd() {
  local arg="${1:-}" abs main here
  if [[ -z "$arg" ]]; then
    abs="${FK_DISK_DD_ROOT:?set [disk] dd_root, or pass --dd}/dd-${FK_PROOF_IOS_DD:-app}"
    main="$(cd "${FK_PROJECT_MAIN_CHECKOUT:-$FK_ROOT}" 2>/dev/null && pwd -P || true)"
    here="$(cd "$FK_ROOT" && pwd -P)"
    # a git worktree has a .git FILE; the main checkout a .git directory
    if [[ -f "$here/.git" && "$here" != "$main" ]]; then abs="$abs-${here##*/}"; fi
  elif [[ "$arg" == /* ]]; then abs="$arg"
  else abs="$FK_ROOT/$arg"; fi
  mkdir -p "$abs"
  [[ -e "$abs/.metadata_never_index" ]] || : > "$abs/.metadata_never_index"
  echo "$abs"
}

# fk_proof_app <dd>: the built .app inside a derived-data directory ([proof.ios] app, with {dd} filled in).
fk_proof_app() {
  local tpl app
  tpl="$(fk_proof_json proof.ios.app)"
  [[ -n "$tpl" ]] || fk_die "[proof.ios] app is not set in factory.toml"
  app="$(fk_fill "$tpl" dd "$1")"
  [[ "$app" == /* ]] || app="$FK_ROOT/$app"
  echo "$app"
}

# fk_proof_build_tpl <turns 0|1>: the build command for --build. With 1 (a non-portrait orientation will be turned by
# [proof.ios] orientation_cmd), [proof.ios] orientation_build when set (e.g. a build-for-testing that also builds the
# runner the turn needs), else [proof.ios] build.
fk_proof_build_tpl() {
  local t=""
  if [[ "$1" == 1 ]]; then t="$(fk_proof_json proof.ios.orientation_build)"; fi
  [[ -n "$t" ]] || t="$(fk_proof_json proof.ios.build)"
  printf '%s' "$t"
}

# fk_sim_runtime: [sim] runtime as a full identifier ("iOS-26-5" -> com.apple.CoreSimulator.SimRuntime.iOS-26-5), or nothing.
fk_sim_runtime() {
  local r="${FK_SIM_RUNTIME:-}"
  [[ -z "$r" || "$r" == com.apple.* ]] || r="com.apple.CoreSimulator.SimRuntime.$r"
  printf '%s' "$r"
}

# fk_proof_fail_markers: [proof.ios] fail_markers, one per line (LAYOUT-LOOP when unset).
fk_proof_fail_markers() { printf '%s\n' "${FK_PROOF_IOS_FAIL_MARKERS:-LAYOUT-LOOP}"; }
