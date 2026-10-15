# Device-report triage

The simulator is accurate for layout, motion and materials. When the human reports something on their phone that the
proofs don't show, check the device's state **before** chasing a bug. Ask one question at a time; most of these cost
the human ten seconds to check and save a night of rescue passes.

| Report | Ask / check first | Why |
|---|---|---|
| "Glass looks opaque / flat / grey on the phone" | Is **Reduce Transparency** on (Settings → Accessibility → Display & Text Size)? | It replaces translucent materials with opaque fills. It's a supported path, not a defect: if it looks wrong *with* RT on, prove it on a simulator with RT on |
| "Choppy", "stutters", "not 120 Hz" | Is **Low Power Mode** on (yellow battery)? Is the phone hot or charging? | Low Power Mode caps the display at 60 Hz and throttles the CPU. Re-test with it off before profiling |
| "Old icon / old splash / wrong colours flash before launch" after an update | Was it an update over an older install? Does a restart, or delete-and-reinstall, clear it? | iOS caches a launch-screen snapshot per install (and per appearance). An update can show the previous build's snapshot. Renaming the launch storyboard forces a new one; on the simulator, a **fresh** simulator with its appearance set **before** install is the honest test |
| "Colours wrong on first launch" | System appearance vs the app's own theme: do they differ? | Theme mismatches (system dark + app light, and the reverse) are their own matrix cells for this reason |
| "Keyboard never appears / stays up" (simulator or UI test) | Reset that simulator's keyboard preferences (`com.apple.keyboard.preferences`, e.g. `xcrun simctl spawn <udid> defaults delete com.apple.keyboard.preferences`) and reboot it | Stale hardware-keyboard prefs fake keyboard failures. A fresh simulator never has them; `[sim] reset_keyboard_prefs` records the intent, but no kit command resets them yet |
| "Feels slower than last build" on a cable install | Was it a Debug build? | Debug builds are slower than Release. Judge feel on a release / beta build |
| "It worked yesterday" after a cable install | Which build is on the phone (commit, build number)? Was the derived data wiped first? | Stale incremental device builds install old code. Wipe the device build dir (`[phone] wipe`) before every install |
| "Map / images / previews blank" | Is the project's API token present? (end-night checks `[never_touch] secret_nonempty`) | A blanked token looks like a rendering bug. Only the human restores it |
| "Taps do nothing" on a simulator | Did one known-good tap land first? | Simulator taps can silently no-op when no simulator window shows that device. Prefer DEBUG scenarios to taps |

Log each answer in the night file's Log, and move a confirmed environment cause to the project's rules file if it will
come up again.
