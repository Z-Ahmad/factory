# Changelog

Releases are git tags (`vX.Y.Z`); a project pins one with `[kit] ref` in its `factory.toml`. Releases before v0.12.0 are described in their tag messages and commits.

## v0.15.0 (2026-10-20)

### Hold detector: no more holds on a still screen after a spring settles

- simctl records a frame only when the screen changes, so a settling spring's last sub-pixel step can land as one late, near-identical frame. The gap after it, and the seconds of still screen before the next movement, were reported as holds (a 215 ms and a 3237 ms FAIL on a static screen). "Moving on both sides" now means the mean motion of the frames **near** the gap: up to 3 frames within 50 ms (or `hold_warn_ms`, if larger) of its start, and of the frame that ends it. A frame count alone used to reach seconds away.
- Calibrated on 18 real clips: the two false positives are gone (a FAIL and a 75 ms WARN), every mid-motion hitch WARN is kept with the same worst value, and the synthetic dropped-frame holds still FAIL. Expect fewer hold events on clips with still screens between movements.

### `[sim] runtime`

- New optional `[sim] runtime` (`"iOS-26-5"` or the full `com.apple.CoreSimulator.SimRuntime.…` identifier). Every simulator the kit creates (proof-matrix fresh cells) uses it, falling back to the shooter's runtime as before. `factory config validate` fails when it is not an installed, available runtime (macOS only). Project scripts get it as `FK_SIM_RUNTIME`. `preflight` names booted simulators that are not `[sim] protected` and run another runtime.

## v0.14.1 (2026-10-20)

- `[proof.ios] orientation_build`: the command `--build` uses (in `proof`, `proof-matrix` and `proof-compare`) when `orientation_cmd` will turn the simulator, e.g. a `build-for-testing` so the UI-test runner the turn needs is in the derived data. Before, `--build --orientation landscape` built only the app, and a runner-based turn failed.
- A turn that fails is no longer "turned back" (that only printed a second, misleading warning).
- preflight has a new `git` step: the main checkout and the worktree you run from must be working trees with `core.bare` unset. A test's scratch `git init` that inherits a hook's `GIT_DIR` can set `core.bare = true` on the shared repo and break git in every worktree. Preflight now exits **5** with the fix.

## v0.14.0 (2026-10-20)

### Builder slots, enforced

- New `factory slot wait --dd <name>` (and `slot status`): blocks until fewer than `[slot] builders` (default 2, you included) other builds and proofs run, and the 1-minute load is at or under `[slot] max_load` when that is set. Builds are real `xcodebuild … -derivedDataPath` runs and `factory proof` runs, counted once per derived-data folder; your own `--dd` doesn't count. A booted simulator that no running proof is using (a stopped agent's) counts as a builder; `[sim] protected` ones and your `--udid` never do. It prints why it waits, once per reason, then `slot: go`, and exits 2 after `timeout_s`.
- Proofs record the 1-minute load at the start and end of the clip in `verdict.json` (`"load": {"start", "end"}`) and in a new matrix.md column.

### Same-load compares

- New `factory proof-compare --scenario <s> --base <ref>`. It builds the base once in a `compare-<sha8>` worktree, which is kept for the next compare. It then alternates base and patch runs on one simulator (base, patch, then patch, base…) for `--runs` rounds and writes `compare.md` with each run's verdict, holds, flash, bounce and load. It ends with a `COMPARE:` line of median holds and loads, and warns when the two sides' loads differ by more than a quarter. `--base-dd` takes a prebuilt base; `--slot` gates every run.
- `factory proof --source-root <dir>|none` points the stale-app check at the tree the app was built from.

### Saving a stopped isolated agent's work

- New `factory wip-save <worktree> --base <ref> [--on <patch>] --out <patch>`. It writes the worktree's uncommitted work as a `git diff --binary` patch, without running git in that worktree: modes (+x), binaries, new and deleted files. It exports the base (plus `--on`) to a scratch repo, copies the worktree's files over, and checks that the patch applies. The worktree's `.gitignore`, `[wip] exclude`, `[worktree] cache_symlinks` and `copy_files` stay out.

### Orientation

- `factory proof --orientation <o>`. `[proof.ios] orientation_cmd` turns the simulator before install and back to portrait after the clip, including on failure; `orientation_env` hands the orientation to the app. A matrix cell can set `orientation`, and `proof-matrix --orientation` sets the default for cells without one.

### Skill

- Briefs: `slot wait` before every build or proof; on a hold FAIL at high load, `proof-compare` before blaming the patch; `--orientation` for iPad and landscape items. A stopped isolated agent's work is saved with `wip-save`.

## v0.13.0 (2026-10-20)

### Preflight catches a broken Xcode

- A new `xcode` step: `xcodebuild -checkFirstLaunchStatus` must pass and an available iOS simulator must exist. It runs on macOS when `[proof.ios]` is set, or with `[preflight] xcode = true` (`false` turns it off). An App Store update of Xcode that needs `sudo xcodebuild -runFirstLaunch` now fails preflight with **exit 4**, the fix, and "stop the night and notify the human", instead of hours of exit-70 builds. The line notes when App Store auto-update is on.
- Optional `[preflight] xcode_probe`: a deeper check (e.g. `-showdestinations`) that must list an iOS Simulator. It reruns only when `xcodebuild -version` or CoreSimulator's version changes.

### The Mac stays awake

- `[preflight] keep_awake` (default `true`, macOS) keeps one `caffeinate -dimsu` running for `keep_awake_hours` (default 12), with its PID in `<state_dir>/caffeinate.pid`. `end-night --apply` stops it (new step 9). A closed MacBook lid still sleeps the Mac.

### Proofs say which build they install

- `factory proof` and `proof-matrix` print an `app:` line saying when the app was built and from which commit (stamped by `--build`); matrix.md starts with it. Without `--build`, an app older than the source (a newer commit, an uncommitted edit, or a stamp from another commit) gets a WARNING. `[proof.ios] sources` limits which paths count, and `[proof.ios] stale_app = "refuse"` makes it exit 3.

### Context is the budget (skill)

- SKILL.md §9 and §12 and briefs.md: implement/rescue agents do the design rounds, then hand back a patch; a fresh shooter or the orchestrator does the remaining proofs. Never two high-effort implement/rescue agents at once. An agent past `loop.wrap_context_k` (default 400k tokens) wraps up and saves its patch. On a usage or session limit, log the reset time and wake just after it; isolated agents are rebuilt from patches, never resumed.
- Preflight exit 4 is a stop condition (§1).

### Behaviour changes on upgrade

- On macOS, `preflight` now starts a `caffeinate` unless `[preflight] keep_awake = false`.
- Projects with `[proof.ios]` get the Xcode check on every preflight (about 1–2 s).

## v0.12.0 (2026-10-18)

### Briefs no longer demand an exact port

- The implementer brief's reference slot used to say "Port constants, curves and timings exactly from these files". It now names what the feature does elsewhere and which approved-look constants carry over, by file. The implementer copies exactly only those constants and designs the rest for the platform it is building on.
- The slot table points at the rules file's rule on what carries over between platforms. SKILL.md (§3) and review.md (§5, "a carried-over constant that drifted") match.

### Stale derived data is pruned automatically

- New `[disk]` keys: `dd_stale_hours` (default `6`), `dd_roots_extra` (default `[]`), `dd_extra_keep` (default: Xcode's shared caches) and `dd_auto` (default `true`).
- `cleanup`'s `derived-data` category now takes only **stale** folders: nothing under them modified for `dd_stale_hours`. A build in use is never touched. `--dd-all` drops the age rule for `dd_root`. Each line says why (`stale 14h`, `worktree gone: agent-x`). Symlinks are never followed, and `/` and the home folder are refused as roots.
- `preflight` prunes stale derived data first and adds `dd pruned N (X freed)` to its line when it removed something. `end-night` includes derived data in its disk step. Set `dd_auto = false` to leave both to a manual `factory cleanup`.
- `disk-guard`'s default `low_cleanup` gains `derived-data`.
- When `cleanup` removes an agent worktree, it also removes the `dd_root` folders and `[sim] ephemeral` simulators named for it. Keep lists and `[sim] protected` still win. Extra roots get the age rule only, since they are shared with other projects.
- New optional `[git] agent_branches` glob (e.g. `"factory/lane-*"`). The branch name minus the glob's literal prefix is one more name to match, for lanes whose builds and simulators are named after the branch rather than the worktree folder.

### Behaviour changes on upgrade

- A manual `factory cleanup --only derived-data` now spares `dd_root` builds written within `dd_stale_hours`. Use `--dd-all` for the old behaviour.
- With `dd_root` or `dd_roots_extra` set, `preflight` now deletes stale derived data on every firing unless `dd_auto = false`.
- `package.json` now carries the release version.
