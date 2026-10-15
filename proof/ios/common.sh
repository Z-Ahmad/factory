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
# the project root; no arg means <disk.dd_root>/dd-<proof.ios.dd>.
fk_proof_dd() {
  local arg="${1:-}" abs
  if [[ -z "$arg" ]]; then
    abs="${FK_DISK_DD_ROOT:?set [disk] dd_root, or pass --dd}/dd-${FK_PROOF_IOS_DD:-app}"
  elif [[ "$arg" == /* ]]; then abs="$arg"
  else abs="$FK_ROOT/$arg"; fi
  mkdir -p "$abs"
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

# fk_proof_fail_markers: [proof.ios] fail_markers, one per line (LAYOUT-LOOP when unset).
fk_proof_fail_markers() { printf '%s\n' "${FK_PROOF_IOS_FAIL_MARKERS:-LAYOUT-LOOP}"; }
