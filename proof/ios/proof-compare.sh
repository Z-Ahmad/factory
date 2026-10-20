#!/usr/bin/env bash
# usage: factory proof-compare --scenario <s> --out <dir> (--base <ref> | --base-dd <dd>) [--dd <patch dd>] [--build]
#                              [--runs N] [--udid <sim>] [--slot] [any other `factory proof` args, passed through]
# "Compare base and patch at the same load before blaming a hold": runs the scenario on the base app and on the patch app,
# alternating on one simulator (base, patch, then patch, base, ... so a load that drifts hits both sides alike), N rounds
# (default 3), and puts each run's verdict, worst hold, flash, bounce and load side by side.
#   patch  the app in --dd (default <[disk] dd_root>/dd-<[proof.ios] dd>); --build builds it first ([proof.ios] build).
#   base   --base-dd <dd>: an app already built from the base. --base <ref>: `factory worktree compare-<sha8> --base <ref>`
#          (reused when it exists, and left for the next compare; remove it with `git worktree remove`), built once into
#          <[disk] dd_root>/dd-compare-<sha8> with [proof.ios] build, from that worktree.
# --slot: `factory slot wait` before every run (the builder-slot gate), so no run starts while others build.
# Writes into <out>: base-<i>/ and patch-<i>/ (the usual proof artifacts) and compare.md, and ends with
# `COMPARE: base hold <median> ms at load <median> vs patch <median> ms at load <median> (<delta>); PASS base k/N, patch k/N`,
# plus a warning when the two sides' median loads differ by more than a quarter. Exit 0 when every run recorded (the
# numbers are for you to judge), 1 when a run or a build failed. Simulators only.
set -euo pipefail
. "${FK_KIT_DIR:?run this through bin/factory (factory proof-compare ...)}/lib/sh/common.sh"
. "$FK_KIT_DIR/lib/darwin.sh"
. "$FK_KIT_DIR/proof/ios/common.sh"
fk_require_darwin
HERE="$FK_KIT_DIR/proof/ios"
SIM_PROOF="${FK_PROOF_CORE:-$HERE/sim-proof-core.sh}"   # FK_PROOF_CORE: tests only

UDID="${FK_SIM_SHOOTER_UDID:-}" SCENARIO="" OUT="" BASE_REF="" BASE_DD="" DD_ARG="" BUILD=0 RUNS=3 SLOT=0
PASS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario) SCENARIO="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --base) BASE_REF="${2:?}"; shift 2 ;;
    --base-dd) BASE_DD="${2:?}"; shift 2 ;;
    --dd) DD_ARG="${2:?}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --runs) RUNS="${2:?}"; shift 2 ;;
    --udid) UDID="${2:?}"; shift 2 ;;
    --slot) SLOT=1; shift ;;
    --no-gate|--no-install|--plan) echo "$1: proof-compare sets this itself" >&2; exit 1 ;;
    *) PASS_ARGS+=("$1"); shift ;;
  esac
done
USAGE="usage: factory proof-compare --scenario <s> --out <dir> (--base <ref> | --base-dd <dd>) [--dd <dd>] [--build] [--runs N] [--udid <sim>] [--slot] [proof args]"
[[ -n "$SCENARIO" && -n "$OUT" ]] || { echo "$USAGE" >&2; exit 1; }
[[ -n "$BASE_REF" || -n "$BASE_DD" ]] && ! [[ -n "$BASE_REF" && -n "$BASE_DD" ]] || { echo "pass one of --base <ref> or --base-dd <dd>" >&2; exit 1; }
[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] || { echo "--runs wants a whole number" >&2; exit 1; }
[[ -n "$UDID" ]] || { echo "no simulator: pass --udid or set [sim] shooter_udid" >&2; exit 1; }
BUILD_TPL="$(fk_proof_json proof.ios.build)"
build_into() { # build_into <tree> <dd>
  [[ -n "$BUILD_TPL" ]] || { echo "building needs [proof.ios] build in factory.toml" >&2; return 1; }
  ( cd "$1" && bash -c "$(fk_fill "$BUILD_TPL" dd "$(printf '%q' "$2")")" )
}

DD="$(fk_proof_dd "$DD_ARG")"
if [[ "$BUILD" == 1 ]]; then echo "building the patch into $DD..."; build_into "$FK_ROOT" "$DD" || exit 1; fi
[[ -d "$(fk_proof_app "$DD")" ]] || { echo "no patch app in $DD (pass --build)" >&2; exit 1; }

BASE_ROOT=none
if [[ -n "$BASE_REF" ]]; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null || echo "${FK_PROJECT_MAIN_CHECKOUT:?}")"
  SHA="$(git -C "$REPO" rev-parse --verify -q "$BASE_REF^{commit}")" || { echo "--base $BASE_REF is not a commit" >&2; exit 1; }
  NAME="compare-${SHA:0:8}"
  "$FK_KIT_DIR/cmd/worktree" "$NAME" --base "$SHA" >&2 || { echo "could not make the base worktree $NAME" >&2; exit 1; }
  BASE_ROOT="$(cd "${FK_PROJECT_MAIN_CHECKOUT:?}" && pwd -P)/${FK_GIT_WORKTREES_DIR:?}/$NAME"
  BASE_DD="$(fk_proof_dd "${FK_DISK_DD_ROOT:?set [disk] dd_root}/dd-$NAME")"
  if [[ ! -d "$(fk_proof_app "$BASE_DD")" ]]; then
    echo "building the base ($BASE_REF, ${SHA:0:8}) into $BASE_DD..."
    build_into "$BASE_ROOT" "$BASE_DD" || exit 1
  fi
  echo "base worktree: $BASE_ROOT (kept for the next compare; git worktree remove it when done)"
else
  BASE_DD="$(fk_proof_dd "$BASE_DD")"
fi
[[ -d "$(fk_proof_app "$BASE_DD")" ]] || { echo "no base app in $BASE_DD" >&2; exit 1; }

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
ROWS=() FAILED=0
run_side() { # run_side <base|patch> <round>
  local side="$1" i="$2" dd root dir rc=0
  if [[ "$side" == base ]]; then dd="$BASE_DD" root="$BASE_ROOT"; else dd="$DD" root="$FK_ROOT"; fi
  dir="$OUT/$side-$i"
  rm -rf "$dir"; mkdir -p "$dir"
  if [[ "$SLOT" == 1 ]]; then "$FK_KIT_DIR/cmd/slot" wait --dd "$dd" --udid "$UDID" || { echo "no builder slot for $side-$i" >&2; FAILED=1; return 0; }; fi
  echo "== $side, round $i =="
  "$SIM_PROOF" --udid "$UDID" --scenario "$SCENARIO" --out "$dir" --dd "$dd" --source-root "$root" --no-gate \
    ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} </dev/null >"$dir/run.log" 2>&1 || rc=$?
  if [[ "$rc" != 0 || ! -s "$dir/verdict.json" ]]; then
    echo "factory proof failed for $side-$i (exit $rc); tail of $dir/run.log:" >&2; tail -15 "$dir/run.log" >&2
    FAILED=1; ROWS+=("$side	$i	ERROR	-	-	-	-	-"); return 0
  fi
  ROWS+=("$(node -e '
    const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), l = v.load || {}, f = (x) => (x == null ? "-" : x)
    console.log([process.argv[2], process.argv[3], v.verdict, v.hold.worstMs, v.flash.worstScore, v.bounce.worstScore, f(l.start), f(l.end)].join("\t"))
  ' "$dir/verdict.json" "$side" "$i")")
  grep -E '^VERDICT:' "$dir/run.log" || true
}
for ((i = 1; i <= RUNS; i++)); do
  if (( i % 2 == 1 )); then run_side base "$i"; run_side patch "$i"; else run_side patch "$i"; run_side base "$i"; fi
done

# compare.md and the COMPARE line
SUMMARY="$(printf '%s\n' "${ROWS[@]}" | node -e '
  const rows = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => l.split("\t"))
  const [scenario, base, runs] = process.argv.slice(1)
  const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
  const side = (name) => {
    const r = rows.filter((x) => x[0] === name && x[2] !== "ERROR")
    const load = r.map((x) => (Number(x[6]) + Number(x[7])) / 2)
    return { hold: med(r.map((x) => Number(x[3]))), load: med(load), pass: r.filter((x) => x[2] === "PASS").length }
  }
  const b = side("base"), p = side("patch"), fmt = (x) => (x == null ? "?" : Math.round(x * 10) / 10)
  const md = ["# Proof compare: " + scenario, "", "base: " + base, "",
    "| run | side | verdict | worst hold ms | worst flash | worst bounce | load start→end |", "|---|---|---|---|---|---|---|"]
  for (const x of rows) md.push(`| ${x[1]} | ${x[0]} | **${x[2]}** | ${x[3]} | ${x[4]} | ${x[5]} | ${x[6]}→${x[7]} |`)
  const delta = b.hold != null && p.hold != null ? (p.hold - b.hold >= 0 ? "+" : "") + fmt(p.hold - b.hold) + " ms" : "?"
  let line = `COMPARE: base hold ${fmt(b.hold)} ms at load ${fmt(b.load)} vs patch ${fmt(p.hold)} ms at load ${fmt(p.load)} (${delta}); PASS base ${b.pass}/${runs}, patch ${p.pass}/${runs}`
  md.push("", line)
  if (b.load && p.load && Math.abs(b.load - p.load) / Math.max(b.load, p.load) > 0.25) {
    const w = "warning: the two sides ran at loads more than a quarter apart; run again (or with --slot) before judging"
    md.push(w); line += "\n" + w
  }
  require("fs").writeFileSync(process.argv[4], md.join("\n") + "\n")
  console.log(line)
' "$SCENARIO" "${BASE_REF:-$BASE_DD}" "$RUNS" "$OUT/compare.md")"
echo
echo "compare: $OUT/compare.md"
echo "$SUMMARY"
exit "$FAILED"
