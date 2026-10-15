#!/usr/bin/env bash
# usage: factory proof <scenario> --out <dir> [--udid <sim>] [--seconds N] [--fps 20] [--build] [--dd <deriveddata>]
#                      [--env KEY=VAL ...] [--no-install] [--keep-frames] [--system-appearance light|dark] [--warm-resume]
#                      [--no-gate] [--verdict-skip S] [--verdict-arg ARG ...] [--plan]
#                      [--<flag> VAL ...]   one per key of [proof.ios] flag_env (e.g. --appearance), and --trip when launch_env
#                                           has a {trip} (default: [seed] trip)
# Scenario -> reviewable evidence with no taps and no Simulator.app: installs the built app on a SIMULATOR, boots it headless,
# launches it with the scenario's name in [proof.ios] scenario_env (plus [proof.ios] launch_env and the flags above), records
# video for N seconds, then writes into <dir>:
#   <scenario>.mp4     the recording
#   frames/f_%04d.png  constant-fps frame dump (<= 1000px tall) -- ONLY with --keep-frames (default: a temp dir, deleted on exit)
#   contact.png        contact sheet, [proof.ios] contact_cols columns at ~2-4 tiles per second (frame grabs never seek: clip-frames.mjs)
#   rest-start.png / rest-end.png   a settled frame just after launch ([proof.ios] rest_at_s) / the last frame
#   steps.log          the simulator log lines containing a [proof.ios] log_markers or fail_markers text
#   verdict.json       the machine verdict (verdict/proof-verdict.mjs): flash/ghost, hold/stall, bounce and fail-marker findings
#                      with timestamps, worst values, PASS/FAIL; plus one `VERDICT: PASS|FAIL (...)` line in the output
#   flags.png          only when something is flagged: each flagged event as a before / flagged / after frame triple
# Exit 0 PASS, 4 FAIL (a FAIL verdict; 0 with --no-gate), 1 error.
# --no-gate: record and write the verdict, but exit 0 on a FAIL.
# --verdict-skip S: skip S seconds blind instead of detecting the launch screen (0 = judge everything).
# --verdict-arg ARG: pass ARG through to proof-verdict.mjs, one word per flag (explicit flags beat the scenario's budget).
# --warm-resume: after the clip's N seconds, background the app (Settings comes forward), wait 2s, foreground the same process
# (no relaunch), and record 4s more.
# --system-appearance is the SIMULATOR's own light/dark, set before install/launch.
# --plan: print the launch environment the run would use (the password shown as <password>) and stop; touches no simulator.
# Simulators only: never a physical device. Needs ffmpeg, and node.
set -euo pipefail
. "${FK_KIT_DIR:?run this through bin/factory (factory proof ...)}/lib/sh/common.sh"
. "$FK_KIT_DIR/lib/darwin.sh"
. "$FK_KIT_DIR/proof/ios/common.sh"
fk_require_darwin

SCENARIO_ENV="${FK_PROOF_IOS_SCENARIO_ENV:?set [proof.ios] scenario_env}"
BUNDLE_ID="${FK_PROOF_IOS_BUNDLE_ID:?set [proof.ios] bundle_id}"
PROCESS="${FK_PROOF_IOS_PROCESS:?set [proof.ios] process}"
PREFIX="${FK_PROOF_IOS_ENV_PREFIX:-}"

# Flag names the config adds: one per flag_env key, and trip when launch_env uses {trip}. {password} is filled from password_from.
FLAG_ENV_JSON="$(fk_proof_json proof.ios.flag_env)"; FLAG_ENV_JSON="${FLAG_ENV_JSON:-{\}}"
LAUNCH_ENV_JSON="$(fk_proof_json proof.ios.launch_env)"; LAUNCH_ENV_JSON="${LAUNCH_ENV_JSON:-{\}}"
FLAG_NAMES="$(node -e '
  const f = JSON.parse(process.argv[1]), l = JSON.parse(process.argv[2]), out = new Set(Object.keys(f))
  if (Object.values(l).some((v) => String(v).includes("{trip}"))) out.add("trip")
  console.log([...out].join("\n"))
' "$FLAG_ENV_JSON" "$LAUNCH_ENV_JSON")"
flag_known() { printf '%s\n' "$FLAG_NAMES" | grep -qxF -- "$1"; }

UDID="${FK_SIM_SHOOTER_UDID:-}" SCENARIO="" OUT="" SECONDS_REC="${FK_PROOF_IOS_SECONDS:-20}" BUILD=0 DD_ARG="" FPS="${FK_PROOF_IOS_FPS:-20}"
KEEP_FRAMES=0 INSTALL=1 SYSTEM_APPEARANCE="" WARM_RESUME=0 GATE=1 VERDICT_SKIP="" PLAN=0
EXTRA_ENV=() VERDICT_ARGS=() FLAG_VALUES=()   # FLAG_VALUES: "name=value"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --udid) UDID="${2:?}"; shift 2 ;;
    --scenario) SCENARIO="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --seconds) SECONDS_REC="${2:?}"; shift 2 ;;
    --env) [[ "${2:-}" == *=* ]] || { echo "--env wants KEY=VAL" >&2; exit 1; }; EXTRA_ENV+=("$2"); shift 2 ;;
    --build) BUILD=1; shift ;;
    --dd) DD_ARG="${2:?}"; shift 2 ;;
    --fps) FPS="${2:?}"; shift 2 ;;
    --keep-frames) KEEP_FRAMES=1; shift ;;
    # Launch what is installed: a second cold launch on the same install, as a person's is.
    --no-install) INSTALL=0; shift ;;
    --system-appearance) SYSTEM_APPEARANCE="${2:?}"; shift 2 ;;
    --warm-resume) WARM_RESUME=1; shift ;;
    --no-gate) GATE=0; shift ;;
    --verdict-skip) VERDICT_SKIP="${2:?}"; shift 2 ;;
    --verdict-arg) VERDICT_ARGS+=("${2:?}"); shift 2 ;;
    --plan) PLAN=1; shift ;;
    --*) if flag_known "${1#--}"; then FLAG_VALUES+=("${1#--}=${2?${1} wants a value}"); shift 2
         else echo "unknown arg: $1" >&2; exit 1; fi ;;
    *) if [[ -z "$SCENARIO" ]]; then SCENARIO="$1"; shift; else echo "unexpected arg: $1" >&2; exit 1; fi ;;
  esac
done
[[ -n "$UDID" && -n "$SCENARIO" && ( -n "$OUT" || "$PLAN" == 1 ) ]] || { echo "usage: factory proof <scenario> --out <dir> [--udid <sim>] [options]; see the header of $0" >&2; exit 1; }
[[ "$SECONDS_REC" =~ ^[0-9]+$ ]] || { echo "--seconds must be an integer" >&2; exit 1; }
[[ -z "$VERDICT_SKIP" || "$VERDICT_SKIP" =~ ^[0-9.]+$ ]] || { echo "--verdict-skip must be a number of seconds" >&2; exit 1; }
if [[ -n "$SYSTEM_APPEARANCE" ]]; then
  [[ "$SYSTEM_APPEARANCE" == light || "$SYSTEM_APPEARANCE" == dark ]] || { echo "--system-appearance is light or dark" >&2; exit 1; }
fi

# The value a flag was given (last one wins), or empty.
flag_value() { local kv v=""; for kv in ${FLAG_VALUES[@]+"${FLAG_VALUES[@]}"}; do [[ "${kv%%=*}" == "$1" ]] && v="${kv#*=}"; done; printf '%s' "$v"; }
flag_given() { local kv; for kv in ${FLAG_VALUES[@]+"${FLAG_VALUES[@]}"}; do [[ "${kv%%=*}" == "$1" ]] && return 0; done; return 1; }

# The password: [proof.ios] password_from = "<file>:<NAME>" reads `const NAME = '...';` from the file (relative to the project root).
PASSWORD=""
if [[ "$LAUNCH_ENV_JSON" == *"{password}"* ]]; then
  FROM="${FK_PROOF_IOS_PASSWORD_FROM:-}"
  [[ "$FROM" == *:* ]] || { echo "launch_env uses {password}: set [proof.ios] password_from = \"<file>:<NAME>\"" >&2; exit 1; }
  PASS_FILE="${FROM%:*}" PASS_NAME="${FROM##*:}"
  [[ "$PASS_FILE" == /* ]] || PASS_FILE="$FK_ROOT/$PASS_FILE"
  [[ -f "$PASS_FILE" ]] && PASSWORD="$(sed -n "s/^const $PASS_NAME = '\(.*\)';.*/\1/p" "$PASS_FILE")"
  [[ -n "$PASSWORD" ]] || { echo "could not read $PASS_NAME from ${FROM%:*}" >&2; exit 1; }
fi

# The launch environment, one NAME<TAB>VALUE per line: launch_env (placeholders filled), then the flags, then --env.
# simctl hands SIMCTL_CHILD_<NAME> to the launched app as <NAME>.
build_env() { # build_env <password to substitute>
  local k v kv trip
  if flag_given trip; then trip="$(flag_value trip)"; else trip="${FK_SEED_TRIP:-}"; fi
  while IFS=$'\t' read -r k v; do
    [[ -n "$k" ]] || continue
    printf '%s\t%s\n' "${PREFIX}${k}" "$(fk_fill "$v" password "$1" trip "$trip")"
  done < <(node -e 'for (const [k, v] of Object.entries(JSON.parse(process.argv[1]))) console.log(k + "\t" + v)' "$LAUNCH_ENV_JSON")
  printf '%s\t%s\n' "$SCENARIO_ENV" "$SCENARIO"
  while IFS=$'\t' read -r k v; do
    [[ -n "$k" ]] || continue
    if flag_given "$k" && [[ -n "$(flag_value "$k")" ]]; then printf '%s\t%s\n' "${PREFIX}${v}" "$(flag_value "$k")"; fi
  done < <(node -e 'for (const [k, v] of Object.entries(JSON.parse(process.argv[1]))) console.log(k + "\t" + v)' "$FLAG_ENV_JSON")
  for kv in ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}; do printf '%s\t%s\n' "${kv%%=*}" "${kv#*=}"; done
}

if [[ "$PLAN" == 1 ]]; then
  echo "bundle:   $BUNDLE_ID (process $PROCESS)"
  echo "scenario: $SCENARIO on ${UDID} for ${SECONDS_REC}s @ ${FPS}fps"
  echo "launch environment (SIMCTL_CHILD_*):"
  build_env "<password>" | sed 's/^/  /'
  exit 0
fi

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found (brew install ffmpeg)" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found (the verdict needs it)" >&2; exit 1; }
# Must be a simulator we can see; this script never touches devicectl / physical phones.
xcrun simctl list devices | grep -q "$UDID" || { echo "no simulator with UDID $UDID (xcrun simctl list devices)" >&2; exit 1; }

DD="$(fk_proof_dd "$DD_ARG")"
if [[ "$BUILD" == 1 ]]; then
  BUILD_TPL="$(fk_proof_json proof.ios.build)"
  [[ -n "$BUILD_TPL" ]] || { echo "--build needs [proof.ios] build in factory.toml" >&2; exit 1; }
  ( cd "$FK_ROOT" && bash -c "$(fk_fill "$BUILD_TPL" dd "$(printf '%q' "$DD")")" )
fi
APP="$(fk_proof_app "$DD")"
[[ -d "$APP" ]] || { echo "no built app at $APP (pass --build)" >&2; exit 1; }

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
rm -rf "$OUT/frames"
if [[ "$KEEP_FRAMES" == 1 ]]; then FRAMES_DIR="$OUT/frames"; mkdir -p "$FRAMES_DIR"; else FRAMES_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sim-proof-frames.XXXXXX")"; fi
cleanup_frames() { [[ "$KEEP_FRAMES" == 1 ]] || rm -rf "$FRAMES_DIR"; }
trap cleanup_frames EXIT
VIDEO="$OUT/$SCENARIO.mp4"
rm -f "$VIDEO"

echo "installing on ${UDID}..."
xcrun simctl boot "$UDID" 2>/dev/null || true   # already-booted is fine
xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1
if [[ -n "$SYSTEM_APPEARANCE" ]]; then xcrun simctl ui "$UDID" appearance "$SYSTEM_APPEARANCE"; fi
if [[ "$INSTALL" == 1 ]]; then xcrun simctl install "$UDID" "$APP"; fi

while IFS=$'\t' read -r k v; do
  [[ -n "$k" ]] || continue
  export "SIMCTL_CHILD_${k}=${v}"
done < <(build_env "$PASSWORD")

# Record first so the scenario's opening beats are in the clip, then launch.
xcrun simctl io "$UDID" recordVideo --codec h264 --force "$VIDEO" >"$OUT/record.log" 2>&1 &
REC_PID=$!
trap 'kill -INT "$REC_PID" 2>/dev/null || true; cleanup_frames' EXIT
sleep 1.5
kill -0 "$REC_PID" 2>/dev/null || { echo "recorder died:" >&2; cat "$OUT/record.log" >&2; exit 1; }

LAUNCH_AT=$SECONDS
echo "launching scenario '$SCENARIO' for ${SECONDS_REC}s..."
xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE_ID" >/dev/null
sleep "$SECONDS_REC"
VERDICT_IGNORE=()
if [[ "$WARM_RESUME" == 1 ]]; then
  # iOS's own app-switch animations (out to Settings, back in) are not the app's: the verdict skips that window
  # (clip time = the 1.5s pre-roll + the scenario's seconds).
  VERDICT_IGNORE=(--ignore "$((SECONDS_REC + 1))-$((SECONDS_REC + 5))")
  echo "warm resume: background, then foreground the same process..."
  xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null
  sleep 2
  xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null   # no --terminate-running-process: the process resumes
  sleep 4
  SECONDS_REC=$((SECONDS_REC + 6))
fi

kill -INT "$REC_PID" 2>/dev/null || true
wait "$REC_PID" 2>/dev/null || true
trap cleanup_frames EXIT
[[ -s "$VIDEO" ]] || { echo "no video written to $VIDEO" >&2; cat "$OUT/record.log" >&2; exit 1; }

# Step log first (it is time-limited), while the lines are fresh.
LOG_MARKERS=() FAIL_MARKERS=()
while IFS= read -r m; do [[ -z "$m" ]] || LOG_MARKERS+=("$m"); done <<<"${FK_PROOF_IOS_LOG_MARKERS:-}"
while IFS= read -r m; do [[ -z "$m" ]] || FAIL_MARKERS+=("$m"); done < <(fk_proof_fail_markers)
PRED="" SEEN=$'\n'
for m in ${LOG_MARKERS[@]+"${LOG_MARKERS[@]}"} ${FAIL_MARKERS[@]+"${FAIL_MARKERS[@]}"}; do
  [[ "$SEEN" == *$'\n'"$m"$'\n'* ]] && continue
  SEEN+="$m"$'\n'; PRED+="${PRED:+ OR }eventMessage CONTAINS \"$m\""
done
LOG_SECS=$((SECONDS_REC + 10))
xcrun simctl spawn "$UDID" log show --last "${LOG_SECS}s" --info --debug \
  --predicate "process == \"$PROCESS\" AND ($PRED)" 2>&1 | grep -v 'log run noninteractively' >"$OUT/steps.log" || true

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")"
CLIP_FRAMES="$FK_KIT_DIR/proof/clip-frames.mjs"
node "$CLIP_FRAMES" "$VIDEO" --dump "$FRAMES_DIR" --rate "$FPS"
FRAMES="$(find "$FRAMES_DIR" -name 'f_*.png' | wc -l | tr -d ' ')"
[[ "$FRAMES" -gt 0 ]] || { echo "frame dump produced nothing" >&2; exit 1; }

# Contact sheet: ~3 tiles per second (fewer for long clips so it stays <= contact_max_tiles), contact_cols columns.
RATE="$(awk -v d="$DUR" -v m="${FK_PROOF_IOS_CONTACT_MAX_TILES:-48}" 'BEGIN { r = m / d; if (r > 3) r = 3; if (r < 0.5) r = 0.5; printf "%.3f", r }')"
# Frame grabs never seek (simctl's variable-frame-rate h264 has duplicate and out-of-order timestamps, so -ss / -sseof /
# fps return stale frames): clip-frames.mjs decodes in order and keeps frames by index, timed by ffprobe's pts.
node "$CLIP_FRAMES" "$VIDEO" --contact "$OUT/contact.png" --rate "$RATE" --cols "${FK_PROOF_IOS_CONTACT_COLS:-6}" --height "${FK_PROOF_IOS_CONTACT_HEIGHT:-420}"

# Rest frames: one shortly after launch (past the opening settle) and the last frame.
REST_AT="$(awk -v d="$DUR" -v t="${FK_PROOF_IOS_REST_AT_S:-4.5}" 'BEGIN { if (t > d / 2) t = d / 2; printf "%.2f", t }')"
node "$CLIP_FRAMES" "$VIDEO" --at "$REST_AT" "$OUT/rest-start.png"
node "$CLIP_FRAMES" "$VIDEO" --at end "$OUT/rest-end.png"

STEPS=0
if [[ ${#LOG_MARKERS[@]} -gt 0 ]]; then
  GREP_ARGS=(); for m in "${LOG_MARKERS[@]}"; do GREP_ARGS+=(-e "$m"); done
  STEPS="$(grep -c -F "${GREP_ARGS[@]}" "$OUT/steps.log" || true)"
fi
echo
echo "== sim-proof: $SCENARIO on $UDID (${DUR%.*}s clip, launch took $((SECONDS - LAUNCH_AT))s wall) =="
echo "video:       $VIDEO"
echo "contact:     $OUT/contact.png"
echo "rest frames: $OUT/rest-start.png  $OUT/rest-end.png"
if [[ "$KEEP_FRAMES" == 1 ]]; then echo "frames:      $FRAMES @ ${FPS}fps in $OUT/frames/"; else echo "frames:      $FRAMES @ ${FPS}fps extracted, deleted (--keep-frames to retain; strips: ffmpeg from the .mp4)"; fi
echo "steps.log:   $OUT/steps.log ($STEPS ${LOG_MARKERS[0]:-log} lines)"
for m in ${FAIL_MARKERS[@]+"${FAIL_MARKERS[@]}"}; do
  N="$(grep -c -F -e "$m" "$OUT/steps.log" || true)"
  if [[ "$N" -gt 0 ]]; then
    echo "$m: $N line(s):"
    grep -F -e "$m" "$OUT/steps.log" | head -20
  else
    echo "$m: none"
  fi
done
if [[ ${#LOG_MARKERS[@]} -gt 0 && "$STEPS" -eq 0 ]]; then echo "note: no ${LOG_MARKERS[0]} lines in the log (scenario '$SCENARIO' may not exist in this build yet)"; fi

# Machine verdict (flash/ghost, hold/stall, bounce, fail markers): verdict.json, one VERDICT line, flags.png when flagged.
# Thresholds, budgets and fail markers come from factory.toml through the FK_* variables. Exit 4 on FAIL unless --no-gate;
# any other non-zero is the tool itself failing.
VERDICT_RC=0
node "$FK_KIT_DIR/proof/verdict/proof-verdict.mjs" "$VIDEO" --out "$OUT" --steps "$OUT/steps.log" --scenario "$SCENARIO" ${VERDICT_SKIP:+--skip-start "$VERDICT_SKIP"} ${VERDICT_ARGS[@]+"${VERDICT_ARGS[@]}"} ${VERDICT_IGNORE[@]+"${VERDICT_IGNORE[@]}"} || VERDICT_RC=$?
echo "verdict:     $OUT/verdict.json"
if [[ "$VERDICT_RC" == 4 ]]; then
  if [[ "$GATE" == 1 ]]; then echo "FAIL: the verdict is a FAIL (open flags.png first; --no-gate records without failing)" >&2; exit 4; fi
  echo "note: verdict FAIL ignored (--no-gate)"
elif [[ "$VERDICT_RC" != 0 ]]; then
  echo "proof-verdict.mjs failed (exit $VERDICT_RC)" >&2; exit "$VERDICT_RC"
fi
