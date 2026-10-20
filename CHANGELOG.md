# Changelog

Releases are git tags (`vX.Y.Z`); a project pins one with `[kit] ref` in its `factory.toml`. Releases before v0.12.0 are described in their tag messages and commits.

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
