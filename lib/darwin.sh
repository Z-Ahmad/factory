#!/usr/bin/env bash
# Guard for commands that need macOS and Xcode. Source it, then call fk_require_darwin
# first thing: on any other OS the command prints one line and exits 0, so cloud VMs
# and Linux CI treat it as a pass, not a failure.
#   . "$FK_KIT_DIR/lib/darwin.sh"; fk_require_darwin

# fk_is_darwin: exit 0 on macOS. Use it to skip one part of a command; fk_require_darwin
# skips the whole command. FK_UNAME lets tests pretend to be another OS.
fk_is_darwin() { [[ "${FK_UNAME:-$(uname -s)}" == "Darwin" ]]; }

fk_require_darwin() {
  if ! fk_is_darwin; then
    echo "skipped: needs Xcode"
    exit 0
  fi
}
