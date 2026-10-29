#!/usr/bin/env bash
# usage: factory proof-matrix --scenario <s> --out <dir> [--matrix <name>] [--udid <shooter sim>]
#                             [--build] [--rebuild] [--dd <deriveddata>] [--keep-sims] [--plan] [--no-slot]
#                             [--cells <a,b>] [--rerun-failed <previous out>] [any other `factory proof` args, passed through]
# Runs one scenario across the cells every UI proof owes (both finishes, a system/app theme mismatch, a second screen size),
# so a reviewer no longer has to remember to ask. The cells are the project's, in factory.toml:
#   [proof.matrix.<name>]  cells = ["<cell>", ...]  plus optional warm_launch (default true), seconds, args
#   [proof.cell.<cell>]    sim = "shooter" | "fresh", system = "light" | "dark", app = "<the app's own finish>",
#                          device_types = ["<SimDeviceType suffix>", ...]   (the first one this Mac has wins; absent = the shooter's type)
#                          orientation = "landscape" | ...   (optional: the cell runs `factory proof --orientation <o>`, which
#                          turns the sim and back once per cell; --orientation <o> here is the default for cells without one)
# sim = "shooter" runs on --udid (default [sim] shooter_udid) as it is. sim = "fresh" gets an ephemeral simulator on
# [sim] runtime (default: the shooter's runtime), named from the
# first [sim] ephemeral pattern (its trailing * replaced by <cell>-<rand>), whose system appearance is set BEFORE the app is
# installed, so the launch snapshot is honest; it is deleted when its cell is done and on exit/failure/Ctrl-C (unless --keep-sims).
# No other simulator is touched; the shooter's own light/dark is put back on exit, and the shooter is booted only when a
# shooter cell runs and shut down again on exit when this run booted it. One build serves every cell: --build builds once
# into --dd ([proof.ios] build), then every cell installs that app; the build is skipped when the app is already a build
# of this tree (see `factory proof`; --rebuild builds anyway).
# The builder slot (`factory slot wait`) before the build and before each cell, so a cell never boots or records while
# two others build or the Mac is short of load or memory ([slot]); --no-slot skips it. [proof.ios] before (e.g. the seed
# restore) runs once, before the first cell.
# --cells a,b runs only those cells of the matrix. --rerun-failed <previous out> keeps every cell whose
# <previous out>/<cell>/verdict.json is a PASS (copied into --out when it is another dir; "kept" in matrix.md) and runs
# the rest.
# A fresh sim is settled (and, with warm_launch, warmed by an unrecorded launch) before it records, so the clip starts within ~2 s
# of the app launch, as on the shooter. With warm_launch = false the cell is a REAL first launch: install, settle, record, launch
# (empty caches, the first-ever launch snapshot; the slow first launch blocks inside simctl launch). matrix.md says which
# per cell. Each cell is `factory proof --no-gate` (so every cell runs) and its verdict.json is read. Extra args after the known
# ones go to every cell, e.g. `--detent mid`, `--env K=V`, `--seconds 30`.
# Writes into <out>:
#   <cell>/             the usual proof artifacts (mp4, contact.png, verdict.json, flags.png when flagged, run.log)
#   matrix.md           one row per cell: device, launch, system / app appearance, verdict, worst flash, worst hold ms, worst bounce,
#                       fail-marker count, flags.png, the 1-minute load when the clip started and ended (⚠ above [slot]
#                       max_load). A fresh cell waits up to 90 s after boot for the load to settle before it records.
#   matrix-contact.png  every cell's contact sheet scaled to one height, side by side under a label band (label.swift)
# and ends with `MATRIX: PASS|FAIL (n/m cells; launches: <cell> first|warm, ...)`. Exit 0 every cell PASS, 4 any cell FAIL,
# 3 a stale app refused ([proof.ios] stale_app = "refuse"), 1 a tooling error. matrix.md starts with the "app:" line (which
# build, from which commit). --plan prints the cells and stops (no simulator is touched).
# Needs ffmpeg, node and (for the label band) swift. Simulators only: never a physical device.
set -euo pipefail
. "${FK_KIT_DIR:?run this through bin/factory (factory proof-matrix ...)}/lib/sh/common.sh"
. "$FK_KIT_DIR/lib/darwin.sh"
. "$FK_KIT_DIR/proof/ios/common.sh"
fk_require_darwin
HERE="$FK_KIT_DIR/proof/ios"
BUNDLE_ID="${FK_PROOF_IOS_BUNDLE_ID:?set [proof.ios] bundle_id}"

UDID="${FK_SIM_SHOOTER_UDID:-}" SCENARIO="" OUT="" MATRIX="default" BUILD=0 DD_ARG="" KEEP_SIMS=0 PLAN=0 ORIENTATION_DEFAULT=""
REBUILD=0 SLOT=1 ONLY_CELLS="" PREV=""
[[ "${FK_SLOT_HELD:-0}" == 1 ]] && SLOT=0
PASS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario) SCENARIO="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --matrix) MATRIX="${2:?}"; shift 2 ;;
    --udid) UDID="${2:?}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --dd) DD_ARG="${2:?}"; shift 2 ;;
    --keep-sims) KEEP_SIMS=1; shift ;;
    --plan) PLAN=1; shift ;;
    --orientation) ORIENTATION_DEFAULT="${2:?}"; shift 2 ;;
    --rebuild) REBUILD=1; shift ;;
    --no-slot) SLOT=0; shift ;;
    --cells) ONLY_CELLS="${2:?}"; shift 2 ;;
    --rerun-failed) PREV="${2:?}"; shift 2 ;;
    --appearance|--system-appearance|--no-gate|--no-install)
      echo "$1 is set per cell by the matrix ([proof.cell.*] in factory.toml); run \`factory proof\` directly for a one-off" >&2; exit 1 ;;
    *) PASS_ARGS+=("$1"); shift ;;
  esac
done
[[ -n "$SCENARIO" && ( -n "$OUT" || "$PLAN" == 1 ) ]] || { echo "usage: factory proof-matrix --scenario <s> --out <dir> [--matrix <name>] [--build --dd <dd>] [--keep-sims] [proof args]; see the header of $0" >&2; exit 1; }
[[ -n "$UDID" ]] || { echo "no shooter simulator: pass --udid or set [sim] shooter_udid" >&2; exit 1; }

# The cells of the chosen matrix, one per line: name, sim, system, app, deviceTypes, orientation ("-" = none), tab separated.
# Then the matrix options on the first line: warm_launch (default true: launch the app once unrecorded on a fresh sim),
# seconds (default for --seconds when the caller passes none), args (extra `factory proof` args for every cell).
PLAN_TEXT="$(node -e '
  const [, matricesJson, cellsJson, name] = process.argv
  const matrices = JSON.parse(matricesJson || "{}"), cells = JSON.parse(cellsJson || "{}"), fail = (m) => { console.error(m); process.exit(1) }
  const m = matrices[name]
  if (!m) fail("unknown matrix \"" + name + "\" (have: " + Object.keys(matrices).join(", ") + ")")
  console.log(["opts", m.warm_launch === false ? "0" : "1", m.seconds || "-", (m.args || []).join(" ") || "-"].join("\t"))
  for (const n of m.cells) {
    const c = cells[n]
    if (!c) fail("matrix \"" + name + "\" names an undefined cell: " + n + " (define [proof.cell." + n + "])")
    if (c.sim !== "shooter" && c.sim !== "fresh") fail("cell " + n + ": sim must be \"shooter\" or \"fresh\", got \"" + c.sim + "\"")
    if (c.system !== "light" && c.system !== "dark") fail("cell " + n + ": system must be \"light\" or \"dark\", got \"" + c.system + "\"")
    console.log([n, c.sim, c.system, c.app, (c.device_types || []).join(",") || "-", c.orientation || process.argv[4] || "-"].join("\t"))
  }
' "$(fk_proof_json proof.matrix)" "$(fk_proof_json proof.cell)" "$MATRIX" "$ORIENTATION_DEFAULT")" || exit 1
IFS=$'\t' read -r _ WARM DEFAULT_SECONDS DEFAULT_ARGS <<<"$(printf '%s\n' "$PLAN_TEXT" | head -n 1)"
CELLS="$(printf '%s\n' "$PLAN_TEXT" | tail -n +2)"
if [[ -n "$ONLY_CELLS" ]]; then
  for c in ${ONLY_CELLS//,/ }; do
    printf '%s\n' "$CELLS" | awk -F'\t' -v c="$c" '$1 == c { f = 1 } END { exit !f }' || { echo "--cells: matrix $MATRIX has no cell \"$c\" (have: $(printf '%s\n' "$CELLS" | cut -f1 | paste -sd' ' -))" >&2; exit 1; }
  done
  CELLS="$(printf '%s\n' "$CELLS" | awk -F'\t' -v only=",$ONLY_CELLS," 'index(only, "," $1 ",")')"
fi
if [[ -n "$PREV" ]]; then
  [[ -d "$PREV" ]] || { echo "--rerun-failed: no such dir: $PREV" >&2; exit 1; }
  PREV="$(cd "$PREV" && pwd)"
fi
# kept <cell>: the previous run's verdict for the cell was a PASS (--rerun-failed).
kept() {
  [[ -n "$PREV" && -s "$PREV/$1/verdict.json" ]] || return 1
  node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).verdict === "PASS" ? 0 : 1)' "$PREV/$1/verdict.json" 2>/dev/null
}
if [[ "$DEFAULT_SECONDS" != "-" && " ${PASS_ARGS[*]-} " != *" --seconds "* ]]; then PASS_ARGS+=(--seconds "$DEFAULT_SECONDS"); fi
if [[ "$DEFAULT_ARGS" != "-" ]]; then read -r -a MATRIX_ARGS <<<"$DEFAULT_ARGS"; PASS_ARGS+=("${MATRIX_ARGS[@]}"); fi

if [[ "$PLAN" == 1 ]]; then
  echo "matrix $MATRIX: $SCENARIO on shooter $UDID (warm launch on fresh sims: $([[ "$WARM" == 1 ]] && echo yes || echo no))"
  while IFS= read -r line; do
    printf '%s\n' "$line" | awk -F'\t' -v k="$(kept "${line%%$'\t'*}" && echo "  (kept: PASS in $PREV)")" '{ printf "  %-12s sim %-8s system %-5s app %-12s device types %s%s%s\n", $1, $2, $3, $4, $5, ($6 == "-" ? "" : "  orientation " $6), k }'
  done <<<"$CELLS"
  [[ ${#PASS_ARGS[@]} -eq 0 ]] || echo "  proof args: ${PASS_ARGS[*]}"
  exit 0
fi

command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
xcrun simctl list devices | grep -q "$UDID" || { echo "no simulator with UDID $UDID (xcrun simctl list devices)" >&2; exit 1; }

# Ephemeral simulators are named from the first [sim] ephemeral pattern: "demo-*" -> "demo-<cell>-<rand>".
EPHEMERAL_PREFIX="$(printf '%s\n' "${FK_SIM_EPHEMERAL:-fk-proof-*}" | head -n 1)"
EPHEMERAL_PREFIX="${EPHEMERAL_PREFIX%\*}"

DD="$(fk_proof_dd "$DD_ARG")"
# slot_wait <what>: the builder-slot gate (factory slot), unless --no-slot or the caller holds the slot.
slot_wait() {
  [[ "$SLOT" == 1 ]] || return 0
  "$FK_KIT_DIR/cmd/slot" wait --dd "$DD" --udid "$UDID" || { echo "no builder slot for $1 (factory slot; --no-slot skips the gate)" >&2; exit 1; }
}
APP="$(fk_proof_app "$DD")"
BUILT=0 BUILD_TPL=""
if [[ "$BUILD" == 1 ]]; then
  TURNS=0
  if [[ -n "$(fk_proof_json proof.ios.orientation_cmd)" ]] && printf '%s\n' "$CELLS" | awk -F'\t' '$6 != "-" && $6 != "portrait" { f = 1 } END { exit !f }'; then TURNS=1; fi
  BUILD_TPL="$(fk_proof_build_tpl "$TURNS")"
  [[ -n "$BUILD_TPL" ]] || { echo "--build needs [proof.ios] build in factory.toml" >&2; exit 1; }
  if [[ "$REBUILD" == 0 && -d "$APP" ]] && SKIP="$(node "$FK_KIT_DIR/proof/ios/app-fresh.mjs" --app "$APP" --dd "$DD" --root "$FK_ROOT" --up-to-date --build-cmd "$BUILD_TPL")"; then
    echo "$SKIP"
  else
    slot_wait "the build"
    ( cd "$FK_ROOT" && bash -c "$(fk_fill "$BUILD_TPL" dd "$(printf '%q' "$DD")")" )
    BUILT=1
  fi
fi
[[ -d "$APP" ]] || { echo "no built app in $DD (pass --build)" >&2; exit 1; }
# Which build this is; without --build, a warning (or, with [proof.ios] stale_app = "refuse", exit 3) when the app is older
# than the source.
if [[ "$BUILT" == 1 ]]; then STAMP=(--built --build-cmd "$BUILD_TPL"); else STAMP=(); fi
APP_LINE="$(node "$FK_KIT_DIR/proof/ios/app-fresh.mjs" --app "$APP" --dd "$DD" --root "$FK_ROOT" ${STAMP[@]+"${STAMP[@]}"})" || exit $?
echo "$APP_LINE"
# The cells' own proofs neither wait for a slot (this run waits once per cell) nor run [proof.ios] before (it runs once, below).
export FK_SLOT_HELD=1

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/proof-matrix.XXXXXX")"
EPHEMERAL=""        # the one ephemeral sim currently alive (cells run one at a time)
SHOOTER_WAS=""      # the shooter's own light/dark, put back on exit
SHOOTER_BOOTED=0    # 1 when this run booted the shooter: shut down again on exit

delete_ephemeral() {
  [[ -n "$EPHEMERAL" ]] || return 0
  if [[ "$KEEP_SIMS" == 1 ]]; then echo "kept simulator $EPHEMERAL (--keep-sims)"; else
    xcrun simctl shutdown "$EPHEMERAL" >/dev/null 2>&1 || true
    xcrun simctl delete "$EPHEMERAL" >/dev/null 2>&1 || true
  fi
  EPHEMERAL=""
}
cleanup() {
  trap - EXIT INT TERM
  delete_ephemeral
  if [[ -n "$SHOOTER_WAS" ]]; then xcrun simctl ui "$UDID" appearance "$SHOOTER_WAS" >/dev/null 2>&1 || true; fi
  if [[ "$SHOOTER_BOOTED" == 1 && "$KEEP_SIMS" == 0 ]]; then
    xcrun simctl shutdown "$UDID" >/dev/null 2>&1 && echo "shut down the shooter $UDID (this run booted it)" || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The shooter boots only when a shooter cell will run (every cell fresh, or kept, leaves it as it is).
NEED_SHOOTER=0
while IFS=$'\t' read -r c k _; do
  [[ "$k" == shooter ]] && ! kept "$c" && NEED_SHOOTER=1
done <<<"$CELLS"
if [[ "$NEED_SHOOTER" == 1 ]]; then
  slot_wait "the shooter"
  xcrun simctl list devices | grep -F "($UDID)" | grep -q '(Booted)' || SHOOTER_BOOTED=1
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
  SHOOTER_WAS="$(xcrun simctl ui "$UDID" appearance 2>/dev/null || true)"
  [[ "$SHOOTER_WAS" == light || "$SHOOTER_WAS" == dark ]] || SHOOTER_WAS=""
fi
if [[ -n "${FK_PROOF_IOS_BEFORE:-}" ]] && printf '%s\n' "$CELLS" | while IFS=$'\t' read -r c _; do kept "$c" || exit 1; done; then :
elif [[ -n "${FK_PROOF_IOS_BEFORE:-}" ]]; then
  echo "before: $FK_PROOF_IOS_BEFORE"
  ( cd "$FK_ROOT" && bash -c "$FK_PROOF_IOS_BEFORE" ) >"$OUT/before.log" 2>&1 || { echo "[proof.ios] before failed; tail of $OUT/before.log:" >&2; tail -15 "$OUT/before.log" >&2; exit 1; }
fi
export FK_PROOF_BEFORE_DONE=1

# The shooter's runtime and device type (a fresh sim is the same runtime), as "runtime<TAB>typeId".
SHOOTER_INFO="$(xcrun simctl list devices -j | node -e '
  const j = JSON.parse(require("fs").readFileSync(0, "utf8"))
  for (const [rt, ds] of Object.entries(j.devices)) for (const d of ds) if (d.udid === process.argv[1]) console.log(rt + "\t" + d.deviceTypeIdentifier)
' "$UDID")"
RUNTIME="${SHOOTER_INFO%%$'\t'*}" SHOOTER_TYPE="${SHOOTER_INFO##*$'\t'}"
# [sim] runtime pins every fresh simulator's runtime (a newer default runtime can be broken); else the shooter's
if [[ -n "$(fk_sim_runtime)" ]]; then RUNTIME="$(fk_sim_runtime)"; fi
[[ -n "$RUNTIME" && -n "$SHOOTER_TYPE" ]] || { echo "could not read the runtime / device type of $UDID" >&2; exit 1; }

# "id<TAB>name" of the first installed device type among the given SimDeviceType suffixes (comma separated).
pick_device_type() {
  xcrun simctl list devicetypes -j | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8")), pre = "com.apple.CoreSimulator.SimDeviceType."
    for (const s of process.argv[1].split(",")) { const t = j.devicetypes.find((d) => d.identifier === pre + s); if (t) { console.log(t.identifier + "\t" + t.name); break } }
  ' "$1"
}
type_name() {
  xcrun simctl list devicetypes -j | node -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8")); const t = j.devicetypes.find((d) => d.identifier === process.argv[1]); console.log(t ? t.name : process.argv[1])
  ' "$1"
}

# The first launch of an app on a fresh simulator is slow (dyld closures, code-signature checks, caches: 10-25 s), and
# `simctl launch` blocks for all of it, so a clip recorded around it spends that long on the home screen before the app shows.
# Launch and terminate the app once, unrecorded, before the cell records (the proof then runs with --no-install: the install
# already happened, on this appearance).
warm_launch() {
  local t=$SECONDS
  xcrun simctl launch --terminate-running-process "$1" "$BUNDLE_ID" >/dev/null 2>&1 || echo "note: the warm-up launch failed on $1" >&2
  sleep 3
  xcrun simctl terminate "$1" "$BUNDLE_ID" >/dev/null 2>&1 || true
  echo "first launch (unrecorded warm-up) took $((SECONDS - t))s"
}

# `bootstatus -b` returns while SpringBoard is still settling: for ~10-15 s the home screen is black with blank widgets,
# then the wallpaper and icons load. A clip recorded then spends ~12 s on the home screen before the app launches. And a
# fresh simulator posts a "Ready for Apple Intelligence" notification banner at an unpredictable time (~20-60 s after
# boot, shown ~5 s, over whatever is on screen: the clip). Nothing suppresses it reliably, so wait it out: the screen must
# be IDENTICAL (the whole screenshot, so the banner arriving and leaving restarts the count; a minute rolling over the
# status-bar clock does too, which only costs a few seconds) for 5 screenshots in a row, and at least 45 s must have passed
# since boot (the banner has normally come and gone by then) unless the banner is seen to have fired (it is in the
# simulator's delivered notifications) and the screen has been still for 5 s since, which needs 20 s since boot. Capped at
# 60 s after the wait starts; at the cap it says where the last change was (crop=w:h:x:y of the last differing
# screenshots, in pixels) so a sim that never settles is diagnosable.
banner_fired() {
  local f
  for f in "$HOME/Library/Developer/CoreSimulator/Devices/$1/data/Library/UserNotifications"/*/DeliveredNotifications.plist; do
    [[ -f "$f" ]] && plutil -p "$f" 2>/dev/null | grep -q "Ready for Apple Intelligence" && return 0
  done
  return 1
}
settle_sim() {
  local udid="$1" start=$SECONDS same=0 h prev_h="" cur="$SCRATCH/settle-cur.png" prev="$SCRATCH/settle-prev.png" last_a="$SCRATCH/settle-a.png" last_b="$SCRATCH/settle-b.png" changes=0 since_boot fired=0
  rm -f "$cur" "$prev" "$last_a" "$last_b"
  while (( SECONDS - start < 60 )); do
    xcrun simctl io "$udid" screenshot --type=png "$cur" >/dev/null 2>&1 || true
    h=""; [[ -f "$cur" ]] && h="$(md5 -q "$cur")"
    if [[ -n "$h" && "$h" == "$prev_h" ]]; then same=$((same + 1))
    else
      same=0
      if [[ -n "$prev_h" && -f "$prev" ]]; then cp "$prev" "$last_a"; cp "$cur" "$last_b"; changes=$((changes + 1)); fi
    fi
    prev_h="$h"; mv -f "$cur" "$prev" 2>/dev/null || true
    since_boot=$((SECONDS - ${BOOT_T:-$start}))
    if (( fired == 0 )) && banner_fired "$udid"; then fired=1; same=0; fi
    if (( same >= 5 )) && { (( since_boot >= 45 )) || { (( fired == 1 )) && (( since_boot >= 20 )); }; }; then
      echo "simulator settled ${since_boot}s after boot (Apple Intelligence banner: $([[ $fired == 1 ]] && echo 'came and went' || echo 'not seen'))"; return 0
    fi
    sleep 1
  done
  local where=""
  if [[ -f "$last_a" && -f "$last_b" ]]; then
    where="$(ffmpeg -v info -i "$last_a" -i "$last_b" -filter_complex "[0][1]blend=all_mode=difference,format=gray,cropdetect=limit=10:round=2:reset=0" -f null - 2>&1 | grep -o 'crop=[0-9:]*' | tail -1 || true)"
  fi
  echo "note: simulator still changing 60s after the wait began ($changes changes; last at ${where:-unknown}); recording anyway" >&2
}

# Booting a fresh simulator alone can push the 1-minute load from ~60 to 200: a clip recorded then measures the boot.
# Wait (up to 90 s) until it is back under [slot] max_load (default 2 x the CPU count), or, when neither is known, within
# 15% of where it was before the boot.
settle_load() {
  local target t=$SECONDS l
  target="$(fk_max_load)"
  if [[ -z "$target" && -n "${LOAD_BEFORE:-}" ]]; then target="$(awk -v b="$LOAD_BEFORE" 'BEGIN { printf "%.2f", b * 1.15 + 1 }')"; fi
  [[ -n "$target" ]] || return 0
  while :; do
    l="$(fk_load1)"
    [[ -z "$l" ]] && return 0
    if awk -v l="$l" -v m="$target" 'BEGIN { exit !(l <= m) }'; then echo "load settled at $l (target $target) after $((SECONDS - t))s"; return 0; fi
    if (( SECONDS - t >= 90 )); then echo "note: load still $l after 90s (target $target); recording anyway" >&2; return 0; fi
    sleep 3
  done
}

ROWS=()       # matrix.md rows
KINDS=()      # "<cell> first|warm" for the MATRIX line
CONTACTS=()   # name|status|device line|contact.png for matrix-contact.png
PASSED=0 TOTAL=0 FAILED=0 ERRORED=0
SIM_PROOF="${FK_PROOF_CORE:-$HERE/sim-proof-core.sh}"   # FK_PROOF_CORE: tests only
MARKER_RE="$(fk_proof_fail_markers | paste -sd'|' -)"

while IFS=$'\t' read -r CELL SIMKIND SYSTEM APPEARANCE TYPES ORIENT; do
  TOTAL=$((TOTAL + 1))
  CELL_DIR="$OUT/$CELL"
  KEEP=0; kept "$CELL" && KEEP=1
  if [[ "$KEEP" == 1 ]]; then
    if [[ "$PREV/$CELL" != "$CELL_DIR" ]]; then rm -rf "$CELL_DIR"; cp -R "$PREV/$CELL" "$CELL_DIR"; fi
  else rm -rf "$CELL_DIR"; mkdir -p "$CELL_DIR"; fi
  echo
  echo "== cell $CELL: system $SYSTEM, app $APPEARANCE ($SIMKIND sim)$([[ "$KEEP" == 0 ]] || echo ": kept, PASS in $PREV") =="
  CELL_UDID="$UDID" DEVICE_TYPE="$SHOOTER_TYPE" CELL_RC=0 NO_INSTALL=() LAUNCH_KIND=warm ORIENT_ARGS=()
  [[ "$KEEP" == 0 ]] || LAUNCH_KIND=kept
  if [[ "$ORIENT" != "-" ]]; then ORIENT_ARGS=(--orientation "$ORIENT"); fi
  if [[ "$SIMKIND" == fresh && "$TYPES" != "-" ]]; then
    PICK="$(pick_device_type "$TYPES")"
    if [[ -z "$PICK" ]]; then echo "no device type among: $TYPES (xcrun simctl list devicetypes)" >&2; [[ "$KEEP" == 1 ]] || CELL_RC=1; else DEVICE_TYPE="${PICK%%$'\t'*}"; fi
  fi
  [[ "$KEEP" == 1 || "$CELL_RC" != 0 ]] || slot_wait "cell $CELL"
  if [[ "$SIMKIND" == fresh && "$KEEP" == 0 ]]; then
    # the sim is deleted right after its cell: turning it back to portrait is wasted time
    if [[ ${#ORIENT_ARGS[@]} -gt 0 ]]; then ORIENT_ARGS+=(--no-turn-back); fi
    if [[ "$CELL_RC" == 0 ]]; then
      LOAD_BEFORE="$(fk_load1)"
      if CELL_UDID="$(xcrun simctl create "${EPHEMERAL_PREFIX}$CELL-$RANDOM" "$DEVICE_TYPE" "$RUNTIME" 2>"$CELL_DIR/create.log")"; then
        EPHEMERAL="$CELL_UDID"
        xcrun simctl boot "$CELL_UDID"
        xcrun simctl bootstatus "$CELL_UDID" -b >/dev/null 2>&1
        BOOT_T=$SECONDS
        # Before the first install: the launch snapshot iOS takes is then in this appearance.
        xcrun simctl ui "$CELL_UDID" appearance "$SYSTEM"
        xcrun simctl install "$CELL_UDID" "$APP"
        if [[ "$WARM" == 1 ]]; then warm_launch "$CELL_UDID"; LAUNCH_KIND=warm; fi
        settle_sim "$CELL_UDID"
        settle_load
        NO_INSTALL=(--no-install)
        [[ "$WARM" == 1 ]] || LAUNCH_KIND=first
      else
        echo "could not create a $DEVICE_TYPE simulator:" >&2; cat "$CELL_DIR/create.log" >&2; CELL_RC=1
      fi
    fi
  fi
  DEVICE="$(type_name "$DEVICE_TYPE")"

  if [[ "$CELL_RC" == 0 && "$KEEP" == 0 ]]; then
    "$SIM_PROOF" --udid "$CELL_UDID" --scenario "$SCENARIO" --out "$CELL_DIR" --dd "$DD" \
      --appearance "$APPEARANCE" --system-appearance "$SYSTEM" --no-gate ${NO_INSTALL[@]+"${NO_INSTALL[@]}"} ${ORIENT_ARGS[@]+"${ORIENT_ARGS[@]}"} ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} </dev/null >"$CELL_DIR/run.log" 2>&1 || CELL_RC=$?
    grep -E "^(VERDICT:|($MARKER_RE):)" "$CELL_DIR/run.log" || true
    if [[ "$CELL_RC" != 0 ]]; then echo "factory proof failed for cell $CELL (exit $CELL_RC); tail of $CELL_DIR/run.log:" >&2; tail -15 "$CELL_DIR/run.log" >&2; fi
  fi

  if [[ "$CELL_RC" == 0 && -s "$CELL_DIR/verdict.json" ]]; then
    RES="$(node -e '
      const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
      const l = v.load || {}, f = (x) => (x == null ? "?" : x)
      console.log([v.verdict, v.flash.worstScore, v.hold.worstMs, v.bounce.worstScore, v.layoutLoop.count, v.flagsPng || "-", f(l.start) + "→" + f(l.end) + (l.unreliable ? " ⚠" : "")].join("\t"))
    ' "$CELL_DIR/verdict.json")"
    IFS=$'\t' read -r VERDICT FLASH HOLD BOUNCE LOOPS FLAGS LOAD <<<"$RES"
    PX="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$CELL_DIR/$SCENARIO.mp4" 2>/dev/null || true)"
    case "$VERDICT" in PASS) PASSED=$((PASSED + 1)) ;; *) FAILED=$((FAILED + 1)) ;; esac
  else
    VERDICT="ERROR" FLASH="-" HOLD="-" BOUNCE="-" LOOPS="-" FLAGS="-" LOAD="-" PX="" ERRORED=$((ERRORED + 1))
  fi
  [[ "$FLAGS" == "-" ]] && FLAGS_CELL="-" || FLAGS_CELL="\`${FLAGS#"$OUT/"}\`"
  KINDS+=("$CELL $LAUNCH_KIND")
  ROWS+=("| $CELL | $DEVICE${PX:+ ($PX px)}$([[ "$ORIENT" == "-" ]] || echo ", $ORIENT") | $LAUNCH_KIND | $SYSTEM | $APPEARANCE | **$VERDICT** | $FLASH | $HOLD | $BOUNCE | $LOOPS | $FLAGS_CELL | $LOAD |")
  [[ -s "$CELL_DIR/contact.png" ]] && CONTACTS+=("$CELL|$VERDICT|$DEVICE${PX:+ $PX} · system $SYSTEM · app $APPEARANCE|$CELL_DIR/contact.png")
  delete_ephemeral
done <<<"$CELLS"

# matrix.md
{
  echo "# Proof matrix: $SCENARIO ($MATRIX)"
  echo
  echo "$APP_LINE"$'\n'
  [[ ${#PASS_ARGS[@]} -eq 0 ]] || echo "sim-proof args: \`${PASS_ARGS[*]}\`"$'\n'
  echo "| cell | device | launch | system | app | verdict | worst flash | worst hold ms | worst bounce | LAYOUT-LOOP | flags | load start→end |"
  echo "|---|---|---|---|---|---|---|---|---|---|---|---|"
  printf '%s\n' "${ROWS[@]}"
} >"$OUT/matrix.md"

# matrix-contact.png: each cell's contact sheet scaled to one height, side by side, under a label band.
# This ffmpeg may have no drawtext, so the bands are drawn by label.swift (CoreText, no packages).
if [[ ${#CONTACTS[@]} -gt 0 ]]; then
  H=1800
  for c in "${CONTACTS[@]}"; do
    h="$(ffprobe -v error -show_entries stream=height -of csv=p=0 "${c##*|}" | head -1)"
    [[ "$h" -lt "$H" ]] && H="$h"
  done
  LABEL_ARGS=() FF_IN=() FILTER="" N=0
  for c in "${CONTACTS[@]}"; do
    IFS='|' read -r NAME ST LINE2 PNG <<<"$c"
    ffmpeg -v error -y -i "$PNG" -vf "scale=-2:$H" "$SCRATCH/c$N.png"
    W="$(ffprobe -v error -show_entries stream=width -of csv=p=0 "$SCRATCH/c$N.png" | head -1)"
    LABEL_ARGS+=("$SCRATCH/b$N.png" "$W" "$NAME" "$LINE2" "$ST")
    FF_IN+=(-i "$SCRATCH/b$N.png" -i "$SCRATCH/c$N.png")
    FILTER+="[$((2 * N))][$((2 * N + 1))]vstack,pad=iw+16:ih:8:0:color=0x1b1d22[col$N];"
    N=$((N + 1))
  done
  swift "$HERE/label.swift" "${LABEL_ARGS[@]}"
  if [[ "$N" == 1 ]]; then FILTER="${FILTER%\[col0\];}[out]"; else
    for ((k = 0; k < N; k++)); do FILTER+="[col$k]"; done
    FILTER+="hstack=inputs=$N[out]"
  fi
  ffmpeg -v error -y "${FF_IN[@]}" -filter_complex "$FILTER" -map "[out]" -frames:v 1 "$OUT/matrix-contact.png"
fi

echo
cat "$OUT/matrix.md"
echo
echo "matrix:  $OUT/matrix.md"
[[ -f "$OUT/matrix-contact.png" ]] && echo "contact: $OUT/matrix-contact.png"
if [[ "$FAILED" == 0 && "$ERRORED" == 0 ]]; then RESULT=PASS; else RESULT=FAIL; fi
KIND_LINE=""; for k in ${KINDS[@]+"${KINDS[@]}"}; do KIND_LINE+="${KIND_LINE:+, }${k% *} ${k#* }"; done
echo "MATRIX: $RESULT ($PASSED/$TOTAL cells; launches: $KIND_LINE)"
if [[ "$ERRORED" -gt 0 ]]; then echo "$ERRORED cell(s) hit a tooling error (see <cell>/run.log)" >&2; exit 1; fi
[[ "$FAILED" == 0 ]] || exit 4
exit 0
