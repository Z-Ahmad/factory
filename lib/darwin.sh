#!/usr/bin/env bash
# Guard for commands that need macOS and Xcode. Source it, then call fk_require_darwin
# first thing: on any other OS the command prints one line and exits 0, so cloud VMs
# and Linux CI treat it as a pass, not a failure.
#   . "$FK_KIT_DIR/lib/darwin.sh"; fk_require_darwin

fk_require_darwin() {
  local os="${FK_UNAME:-$(uname -s)}" # FK_UNAME lets tests pretend to be another OS
  if [[ "$os" != "Darwin" ]]; then
    echo "skipped: needs Xcode"
    exit 0
  fi
}
