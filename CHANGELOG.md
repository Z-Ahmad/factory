# Changelog

Releases are git tags (`vX.Y.Z`); a project pins one with `[kit] ref` in its `factory.toml`. Releases before v0.12.0 are described in their tag messages and commits.

## v0.18.0 (2026-10-27)

### Restarting a wedged dev stack

- `factory dev-restart [--no-seed] [--dry-run]`: TERM to the process group of every listener on `[dev] all_ports` (the wait ports when unset), KILL to what still listens after `[dev] stop_s` (default 30), then `dev-up` (start, wait, seed). Exit 4 when a port won't close.
- hook-guard rule 6: `factory dev-restart` is the orchestrator's. Claude Code puts `agent_id` in a hook's input when a subagent makes the call; such a call is denied unless `[dev] restart_by = "anyone"`.

## v0.17.0 (2026-10-27)

### Merging with a protected base

- `[loop] never_merge_into` (globs, e.g. `["main"]`): with `allow_merge = true`, `gh pr merge` is allowed except for a PR whose base branch matches. The hook looks the base up with `gh pr view <pr> --json baseRefName` (10 s timeout); a base it can't look up, or a PR named through a variable, is denied, and `gh api` merges are denied while the list is set. Without the key, `allow_merge` behaves as before.

## v0.16.0 (2026-10-21)

### App-reported ground truth in the verdict

- `proof-verdict` reads `HITCH`, `MOTION`, `SYNC`, `CLOCK`, `MAPRECT`, `SHEETTOP`, `LIVE` and `INJECT` lines from `steps.log` (contract in the README and `proof/verdict/ground-truth.mjs`).
- **hitch**: holds the app measured itself, judged like holds (WARN-only in the launch window). Report-only unless `[proof.ios.verdict] hitch_gate = true`.
- **settle**: after UI motion ends, the sheet and chrome must stay still until the next motion or step. Judged at one pixel per point outside the map and `LIVE` rects, so a doubled 1 px border registers. Report-only unless `settle_gate = true`; keys `settle_ms` (1000), `settle_floor_px` (40), `settle_luma` (16).
- **Alignment**: SYNC markers are found in the status band and paired with `SYNC` lines by their gaps. A marker a launch stall delayed is dropped, and times are interpolated between anchors because recordings drift from the app's clock. A settle window more than 2 s from any anchor is reported "not judged", never guessed: with only launch SYNCs (today's Seaglass clips) nothing is judged yet.

### Flash detector

- A block match must also be good in absolute terms (mean difference ≤ 12 grey levels), so a garbage match on one side can no longer veto the "an object moved through this tile" discount.
- One-sided travel: content found displaced in the frame before but gone from the frame after (it slid under a clipping edge) counts as travel when it also came the same way from the frame before that. A one-frame jump has no such history.
- Calibrated on 24 Seaglass clips: two by-eye travel cases drop from FAIL (119, 53) to WARN, an injected blink still FAILs (69), and the rest are unchanged within ±1.

### Proof hygiene

- The default proof derived data is per worktree (`dd-<proof.ios.dd>-<worktree>` from a git worktree), so a proof without `--dd` no longer installs another checkout's build.
- The `--build` stamp records the tree it was built from, and an app built from another checkout is reported stale ("built from another checkout"); `stale_app = "refuse"` exits 3.
- `verdict.json` marks `"load": {"unreliable": true}` above `[slot] max_load`, and the proof output says so; matrix.md marks the cell's load with ⚠.
- proof-matrix fresh cells wait (up to 90 s) after the simulator boots for the load to settle back under `[slot] max_load` (or near its pre-boot level) before recording.
- Every derived-data folder the kit creates gets a `.metadata_never_index`, so Spotlight leaves build products alone.

### proof-compare

- The `COMPARE` line adds each side's median worst flash and flash FAIL count, so a one-off flash FAIL is weighed against how often base fails the same way.

## v0.15.1 (2026-10-21)

- Fix: the stale-app check and the `--build` stamp could silently miss uncommitted work. With derived data inside the checkout (`--dd app`), `git status --untracked-files=all` printed megabytes, more than the 1 MB buffer it was read with. The error was then read as "no changes", so the stamp said `dirty: false` and the "uncommitted file newer than the app" check never fired. The buffer is now large, the derived-data folder is excluded from the status, and a git failure is reported as `dirty: null` ("dirty unknown") with a WARNING instead of passing.

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
