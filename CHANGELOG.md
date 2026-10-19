# Changelog

Releases are git tags (`vX.Y.Z`); a project pins one with `[kit] ref` in its `factory.toml`. Releases before v0.12.0 are described in their tag messages and commits.

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
