#!/usr/bin/env bash
# Keep the Mac awake for the night: one `caffeinate -dimsu` per project, its PID in <state_dir>/caffeinate.pid.
# Source it after common.sh. doctor starts it ([preflight] keep_awake, default true); it ends when the timer runs out.
# A MacBook still sleeps when its lid is closed, whatever caffeinate says.

fk_awake_pidfile() { printf '%s/caffeinate.pid' "${FK_PROJECT_STATE_DIR:?}"; }

# fk_awake_pid: the recorded PID while that process is still a caffeinate; prints nothing otherwise.
fk_awake_pid() {
  local f pid
  f="$(fk_awake_pidfile)"
  [[ -f "$f" ]] || return 0
  pid="$(tr -dc '0-9' < "$f")"
  [[ -n "$pid" ]] || return 0
  if [[ "$(ps -p "$pid" -o command= 2>/dev/null)" == *caffeinate* ]]; then echo "$pid"; fi
  return 0
}

# fk_awake_start: start one for [preflight] keep_awake_hours (default 12) and record it. Prints the PID; fails when
# caffeinate is missing or does not start.
fk_awake_start() {
  local hours="${FK_PREFLIGHT_KEEP_AWAKE_HOURS:-12}" pid
  command -v caffeinate >/dev/null 2>&1 || return 1
  mkdir -p "${FK_PROJECT_STATE_DIR:?}"
  pid="$(fk_spawn_detached "$FK_PROJECT_STATE_DIR" /dev/null "exec caffeinate -dimsu -t $((hours * 3600))")" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid" > "$(fk_awake_pidfile)"
  echo "$pid"
}

# fk_awake_stop: stop the recorded caffeinate (never any other process) and forget it. Prints its PID when one ran.
fk_awake_stop() {
  local pid
  pid="$(fk_awake_pid)"
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; echo "$pid"; fi
  rm -f "$(fk_awake_pidfile)"
}
