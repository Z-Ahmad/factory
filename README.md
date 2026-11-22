# factory

**Tooling for letting AI coding agents work through your backlog unattended, without shipping work that only looks done.**

**TL;DR**
- **Plan**: Build a backlog connected to Linear or GitHub, then send it to an orchestrator.
- **Execute**: Worker agents write the code and record video proofs of the running app changes.
- **Verify**: A script scores the videos for visual bugs, and the orchestrator commits only what passes.
- **Review**: Every morning, you just review one combined PR and a status log of what shipped, got stuck, or needs your eyes

This repo is the reusable part: the bookkeeping, the environment upkeep, and the proof checks. Your project describes itself in one config file, `factory.toml`; the kit holds no project-specific values.

> **Status: v0.22 (unreleased), early.** It is being extracted from one real app (a SwiftUI iPhone app with a web sibling), one command at a time. Available today: the config reader, machine upkeep (`doctor`, `cleanup`, `restack`, `dev`, `worktree`, `sims`, `slot`), video proofs (`proof`, `proof-compare`, `proof-verdict`, `clip-frames`; iOS Simulator today), a safety hook (`hook-guard`), and the orchestrator itself: a Claude Code skill (`install-skill`).

## Why it exists

Running coding agents overnight on a real app goes wrong in predictable ways:

- **"Done" isn't done.** An agent reports success, and the screen flashes for one frame, stalls, or breaks on a smaller phone. Someone has to scrub the video to find out, and that someone becomes the bottleneck.
- **Rules pile up as prose.** Every mistake becomes another line in a long instructions file: "never edit the secrets file", "always test dark mode". Long prose gets skimmed and forgotten.
- **The machine fills up and drifts.** Frame dumps fill the disk. Test simulators pile up. The dev server is down when the next item needs it.

The factory's answer: a fixed loop shape; proofs that end in a **machine verdict** instead of a reviewer's opinion; and **scripts instead of prose** for every rule that can be checked.

## How it works

Three roles:

| Role | Who | Does |
|---|---|---|
| Human | you | Orders the backlog, makes the taste calls (picks between 2–3 options), tests on a real device, merges |
| Orchestrator | one strong agent session | Takes one item per loop firing, briefs workers, reviews proofs, commits, keeps the log |
| Workers | cheaper agents, one per item | Write the code in an isolated git worktree and record the proof; they never commit |

One file: **`factory.toml`**, committed in your repo. It holds every value a script would otherwise hard-code: ports, paths, branch names, simulator ids, files no agent may touch. The backlog lives where your tracker keeps it (Linear, GitHub issues); the orchestrator keeps its own notes outside the repo.

## Walkthrough: one night

A made-up app, `example-app`, through one night.

**1. The backlog.** Before the first firing, you write and order it in your tracker:

```
splash-flash     Splash flashes white on a cold launch in dark mode
photo-slideshow  Photo viewer: a finger should end the slideshow
onboarding-copy  [needs-user] Pick the onboarding copy
```

**2. Each firing does one item.**

| Step | Who | What |
|---|---|---|
| Doctor | orchestrator | Check free disk, the dev stack and its worktree, reset the test data: `factory doctor` |
| Ideate (taste items only) | strong model | 2–3 options with side-by-side screenshots. You pick one before anything is built |
| Implement | worker | Changes the code in the night's worktree; reports back in ≤150 words |
| Prove | worker | Records the change running in the app with a self-driving test scenario (no manual taps): `factory proof <scenario>` or `factory proof --cells <matrix>` |
| Review | orchestrator | Reads the verdict first, then looks at the flagged frames. At most one round of fixes |
| Ship | orchestrator | Runs your project's pre-commit checks, commits, pushes the item's branch and opens its PR |

**3. Proofs end in a verdict.** The worker's recording is scored by a script, which prints one line and writes the evidence:

```
VERDICT: FAIL (flash 87.3 > 30 at 4.21 s; hold 0 ms; bounce 0; LAYOUT-LOOP 0)
  verdict.json  flags.png  contact.png  steps.log
```

It looks for:
- a **flash**: part of the screen changes and snaps back within 3 frames (a glitch)
- a **hold**: the screen stops updating while things are moving (a stutter)
- a **bounce**: a big change that reverses within a second (e.g. light → dark → light)
- a **LAYOUT-LOOP**: a warning line the app itself logs

`flags.png` shows each suspect frame between its neighbours, with the region outlined, so review starts at the defect instead of at frame 1.

A **matrix** runs the same scenario where defects usually hide: light and dark themes, phone and app themes that disagree, a smaller screen, and a first launch on a fresh device. It returns one table:

```
| cell     | launch | system | app   | verdict | flash | hold ms | bounce |
| light    | warm   | light  | light | PASS    | 0     | 0       | 0      |
| mismatch | first  | dark   | light | PASS    | 0     | 0       | 0      |
| size     | first  | light  | light | FAIL    | 0     | 0       | 212    |
MATRIX: FAIL (2/3 cells)
```

**4. Morning.** `factory cleanup` takes back the night's disk (proof videos, merged agent worktrees, build caches), and `factory restack` retargets any PR whose parent was merged. You review the PRs and the proofs' verdict lines.

## Getting started

You need Node 22+, git and bash. The `gh` CLI is needed for pull-request checklists, and Xcode for the iOS proof tools.

**1. Add a `factory.toml` at your repo root.** This is the smallest file that validates:

```toml
[kit]
repo = "https://github.com/Z-Ahmad/factory.git"
ref  = "v0.8.0"

[project]
name          = "example-app"
main_checkout = "~/code/example-app"
state_dir     = "~/example-factory"            # screenshots, logs: kept out of the repo

[git]
github          = "you/example-app"
worktrees_dir   = ".worktrees"               # where each night's isolated checkout lives
worktree_branch = "factory/{name}-wt"
push_branch     = "factory/{name}"           # the branch the night's pull request comes from

[[targets]]                                    # where finished work can land
name    = "main"
base    = "origin/main"
pr_base = "main"
paths   = ["**"]
default = true
```

Add the optional sections from the reference below as you adopt more commands.

**2. Add a small launcher script to your repo** (e.g. `scripts/factory`). It pins the kit version your project uses, so the kit itself is not a dependency of your app:

```bash
#!/usr/bin/env bash
set -euo pipefail
ref="$(sed -n 's/^ref *= *"\(.*\)".*/\1/p' factory.toml | head -1)"
kit="${FACTORY_KIT_DIR:-$HOME/.factory-kit/$ref}"
[[ -x "$kit/bin/factory" ]] || git -c advice.detachedHead=false clone -q --depth 1 --branch "$ref" \
  https://github.com/Z-Ahmad/factory.git "$kit"
exec "$kit/bin/factory" "$@"
```

**3. Check it:**

```
scripts/factory config validate
scripts/factory help
```

To work on the kit itself, point the launcher at your checkout: `FACTORY_KIT_DIR=~/path/to/factory scripts/factory …`.

**4. Run a night.** Install the orchestrator skill once and write down your project's own rules:

```
scripts/factory install-skill          # links skill/factory-orchestrator into ~/.claude/skills
```

- **Your rules file.** Put the rules no script can check in a short file and name it in `factory.toml` (`[loop] rules = "docs/factory-rules.md"`): your hard quality bar, the guardrails every worker brief should carry, the decisions that are settled.
- **Your backlog.** Put the items in your tracker.
- **Start the loop.** In Claude Code, run `/loop` with a one-line prompt that names the backlog. The skill takes it from there: one item per firing, proofs with verdicts, and PRs you read in the morning.

## Commands

| Command | Status | What it does |
|---|---|---|
| `factory config validate` | ✓ | Checks `factory.toml`: required keys, types, typos, placeholders |
| `factory config get <key>` | ✓ | Prints one value, e.g. `factory config get git.github` |
| `factory config env --sh` | ✓ | Prints every value as `FK_*` shell exports |
| `factory cleanup` | ✓ | Lists what can be freed: **stale derived data** (build folders nobody has written to for `[disk] dd_stale_hours`, in `dd_root` and `dd_roots_extra`), old proof frames, **proof videos (`clips`)**, temp files (in `/tmp` and in `$TMPDIR`), extra archives, throwaway simulators, and **merged agent worktrees** (any worktree on a `[git] agent_branches` glob whose PR merged, or whose branch is in a target; never a locked, dirty, protected or just-touched one; unpushed commits older than 7 days are flagged, not removed). Deletes only with `--apply`. `--only <category>`, `--frames-age N`, `--include-night <name>`, `--night N` (limits `clips` to one night), `--if-below <GB> [--floor <GB>]` (sweep only when free disk is under that: what `disk-guard` did). See [`[disk]` and `[sim]`: what cleanup frees](#disk-and-sim-what-cleanup-frees) |
| `factory restack` | ✓ | For each open PR whose base branch was merged or deleted: `gh pr edit --base <target>`, then in a temporary worktree merge `origin/<target>` into its head, show the diff stat and push with a plain `git push` (never forced). A PR in a GitHub stack (`gh stack`) is skipped: GitHub restacks it. Dry run by default; `--apply` acts; `--target <branch>`, `--pr <n>` |
| `factory dev up\|status\|restart\|read-api` | ✓ | The dev stack. `up` starts `[dev] up` in the background if its ports are down, then resets the test data (nothing to do when it is up). `status`: one line per dev port, up, down, or (with `[dev] probe = "http"`) hung, a port that accepts connections but never answers; exit 1 if a required port is down or hung. `restart` stops it (TERM to each listener's process group on `[dev] all_ports`, KILL after `stop_s`) and runs `up` again, for a wedged emulator; only the main session may run it: hook-guard denies it from a subagent unless `[dev] restart_by = "anyone"`; `--dry-run`, `--no-seed`. `read-api up\|down` runs a second API server on its own port (`[dev] read_api`) and stops only the one it started. The old names (`dev-up`, `dev-status`, `dev-restart`, `read-api`) still work and print a deprecation line |
| `factory worktree <name>` | ✓ | Makes an isolated git worktree for a night or an agent. Shares installed dependencies and caches from the main checkout through symlinks, but makes npm workspace links and derived build outputs match the worktree's own branch, so a worker never borrows the main checkout's. See [`[worktree]`](#worktree-sharing-from-the-main-checkout) |
| `factory doctor` | ✓ | Start of every firing: prune stale derived data (`[disk] dd_auto`); **disk** (`cleanup --apply --if-below [disk] min_gb --floor floor_gb`: exit 2 when space is still under the floor); a **git check** (exit 5 when a checkout is no longer a working tree, e.g. `core.bare = true` set by a stray `git init`); an **Xcode check** (exit 4 when Xcode can't build for the simulator); **keep-awake** (one night-long `caffeinate`); the **dev-stack worktree** (`[dev] cwd`) is flagged when its branch is gone on origin or it is behind its target, and a tool the dev command needs but `node_modules/.bin` and PATH lack fails with exit 7 while the stack is down (it would never come up); then `dev up`, then a test-data reset. One summary line; it names the step that failed. `preflight` still works as an alias. See [`[preflight]`](#preflight-xcode-and-keep-awake) |
| `factory hook-guard` | ✓ | A Claude Code `PreToolUse` hook. It blocks what `factory.toml` forbids: edits to `[never_touch]` files, running `never_run_in_worktree` scripts from a worktree, pushes to `never_push` branches, force pushes, `--no-verify` (pushes to `never_push` only toward the `[git] github` repository when it is set), `gh pr merge` (or, with `allow_merge`, merges into a `[loop] never_merge_into` base, again only in the `[git] github` repository when it is set), and starting or killing the dev stack outside `factory dev up` / `dev restart` (the latter only from the main session). Silent when allowed (~45 ms), and it fails open on its own errors |
| `factory install-skill` | ✓ | Links the `factory-orchestrator` skill into `~/.claude/skills`, so Claude Code loads the loop. `--dry-run`, `--uninstall` |
| `factory help` | ✓ | Lists the commands |
| `factory proof <scenario>` | ✓ | Installs the app on an iOS Simulator, runs a self-driving test scenario, records it, and prints a `VERDICT` line. Writes the clip, a contact sheet, rest frames, `verdict.json`, and `flags.png` when something is flagged. Exit 4 on FAIL (`--no-gate` to record only). `--orientation landscape` turns the simulator first and back after (see [orientation](#proof-orientation-builder-slots-and-same-load-compares)); `verdict.json` records the load at the start and end of the clip |
| `factory proof --cells <matrix> --scenario <s>` | ✓ | Runs one scenario across the cells of `[proof.matrix.<matrix>]` (cells in `[proof.cell.*]`: themes, a theme mismatch, a smaller screen, a first launch on a fresh simulator) from one build. Writes `matrix.md` and one labelled contact sheet. Exit 4 if any cell fails. A `--cells` value that names no matrix is the old `--cells a,b` (only those cells of the default matrix); `proof-matrix` still works as an alias |
| `factory proof-compare --scenario <s> --base <ref>` | ✓ | Base and patch side by side at the same load: builds the base once in its own worktree, alternates base and patch runs on one simulator, writes `compare.md` and a `COMPARE` line with median holds and loads. `--base-dd` for a prebuilt base, `--slot` to gate each run |
| `factory run --job <type> -- <cmd…>` | ✓ | Runs a heavy job (a build, a test run, a proof, a vite build, an emulator suite) under a **weighted reservation**: queued first come, first served, admitted when its weight fits `[slot] capacity` and the memory and load gates hold, so the Mac is never oversubscribed and the caller never polls. Runs the command in its own process group, stops that group on exit, on a signal or when `--owner-pid` dies, and frees the lease. `--status`, `--reap`, `--check`. See [`factory run`](#factory-run-weighted-leases-for-heavy-jobs) |
| `factory janitor run [--apply]` | ✓ | A safe periodic sweep for what `factory run` cannot see: frees dead leases, stops orphaned `xcodebuild`/`xctest`/recording processes, shuts down idle simulators and, when memory is critical or swap is nearly full, every simulator no live lease may own. Without `--apply` it only logs what it would do. `enable`, `disable`, `status`, `install` (a launchd user agent), `uninstall`. See [`factory janitor`](#factory-janitor-a-safe-periodic-sweep) |
| `factory slot status\|wait` | ✓ | Deprecated aliases: `slot status` is `run --status`, `slot wait` is `run --wait --job build` (blocks until a build would start, without a lease). Each prints a deprecation line |
| `factory sims idle [--shutdown]` | ✓ | Lists the booted simulators nothing uses (no running process names the UDID, no app launched and no boot within `[sim] idle_minutes`); `--shutdown` shuts them down (never erases or deletes). `doctor` runs it when `[sim] idle_minutes` is set |
| `factory proof-verdict <clip.mp4>` | ✓ | Scores any recording for flash, hold, bounce and the app's fail markers. No simulator needed |
| `factory clip-frames <clip.mp4> …` | ✓ | Grabs frames or contact sheets from a simulator recording without seeking (seeking those files returns stale frames) |

`factory` finds `factory.toml` by walking up from the current directory, then in the main git checkout, so it works from any worktree. Use `FACTORY_TOML=<path>` to name one explicitly.

## `factory.toml` reference

The file is a small subset of [TOML](https://toml.io): tables, `[[arrays of tables]]`, strings, numbers, booleans, arrays and inline tables. Unknown keys are rejected, so typos fail loudly.

| Section | Required | Holds |
|---|---|---|
| `[kit]` | yes | `repo` and `ref`: which kit version this project uses |
| `[project]` | yes | Name, main checkout path, state directory, proof shots folder |
| `[git]` | yes | Worktree location and branch naming; `github = "owner/repo"` for `gh -R`; `agent_branches` (a glob or a list of globs) for the branches `cleanup` clears once merged |
| `[[targets]]` | yes | Branches work can land on, and which paths go where |
| `[worktree]` | no | What each worktree shares from the main checkout instead of rebuilding: cache folders, `node_modules`, build outputs, public env files |
| `[never_touch]` | no | Files no agent may edit, and scripts never to run inside a worktree |
| `[dev]` | no | How to start the dev stack, and which ports mean it is up |
| `[seed]` | no | Commands to snapshot and restore test data |
| `[disk]` | no | Free-space thresholds, and what cleanup may delete: caches, frames, **proof videos (`clips`)**, scratch in `/tmp` and `$TMPDIR` |
| `[preflight]` | no | The Xcode check (on for iOS projects) and the night-long keep-awake `caffeinate`. See [`[preflight]`](#preflight-xcode-and-keep-awake) |
| `[sim]` | no | Simulator ids and names: the one proofs run on, protected ones, throwaway patterns, and the throwaway patterns `cleanup` deletes |
| `[proof.*]` | no | How to build and record proofs, verdict thresholds, matrix cells |
| `[tests]` | no | The unit-test command and the pre-commit gate |
| `[phone]`, `[release.*]` | no | Device builds and beta uploads |
| `[slot]` | no | `factory run`'s capacity, job weights and gates |
| `[loop]` | no | Which model does which role, review rounds, report lengths, `wrap_context_k` (default 400: an agent past that many thousand tokens of context hands back a patch) |

`{placeholders}` refer to other values: `{state_dir}` and `{main_checkout}` are filled from the file itself, and `~` expands to your home folder. Run-time placeholders such as `{n}` (night number) and `{name}` are filled by the command that uses them. Commands receive every value as an environment variable: `proof.ios.seconds` becomes `FK_PROOF_IOS_SECONDS`, and lists are newline-separated.

### `[preflight]`: Xcode and keep-awake

| Key | Default | What it does |
|---|---|---|
| `[preflight] xcode` | on when `[proof.ios]` is set | `xcodebuild -checkFirstLaunchStatus` must pass and `xcrun simctl list devices available` must list an iOS simulator. An App Store update of Xcode can leave it needing `sudo xcodebuild -runFirstLaunch` (an admin password): then every build, test and proof fails with exit 70, and agents burn hours on workarounds. `doctor` exits **4** instead, prints the fix and says to stop the night and notify the human. The line notes "App Store auto-update on" when it is. macOS only; `false` turns it off. |
| `[preflight] xcode_probe` | unset | An extra command run from the main checkout that must print an `iOS Simulator` row, e.g. `xcodebuild -project ios/App.xcodeproj -scheme App -showdestinations -skipPackageUpdates`. It is slow (15 s or more), so it reruns only when `xcodebuild -version` or CoreSimulator's version changed since it last passed, which is exactly what an Xcode update changes. |
| `[preflight] keep_awake` | `true` | macOS: `doctor` makes sure one `caffeinate -dimsu` runs (PID in `<state_dir>/caffeinate.pid`), so the Mac doesn't sleep mid-night; it ends when `keep_awake_hours` run out. A closed MacBook lid sleeps the Mac anyway. |
| `[preflight] keep_awake_hours` | `12` | How long each `caffeinate` lasts; a later `doctor` starts a new one if it has ended. |

The proof commands check the build they install, too: without `--build`, `factory proof` (single or matrix) prints an `app:` line (when it was built and from which commit; matrix.md starts with it) and warn when the installed app is older than the source. `[proof.ios] sources` (git pathspecs, default the whole tree) says which changes count; `[proof.ios] stale_app = "refuse"` makes a stale app exit 3 instead of warning.

### Proof orientation, the slot and same-load compares

| Key | Default | What it does |
|---|---|---|
| `[proof.ios] orientation_cmd` | unset | A command that turns a simulator: `{udid}`, `{orientation}` and `{dd}` are filled in, run from the project root. `factory proof --orientation landscape` runs it before install and runs it again with `portrait` after the clip (on failure too: a turn persists on the simulator). Simulators have no rotate command, so a project typically drives `XCUIDevice.shared.orientation` from a UI-test method with `xcodebuild test-without-building`; that costs a test-runner launch, so it happens once per proof. |
| `[proof.ios] orientation_build` | unset | The `--build` command when `orientation_cmd` will turn the simulator (`{dd}` filled in), e.g. a `build-for-testing` that also builds the UI-test runner the turn needs. Without it `--build` uses `build`, and a turn that needs the runner fails. |
| `[proof.ios] orientation_env` | unset | An environment variable the app reads at launch, set to the orientation (`env_prefix` is prepended, as for `flag_env`). Either key, or both, may be set. |
| `[proof.cell.<c>] orientation` | unset | The cell runs with `--orientation <o>`; `proof --cells <matrix> --orientation <o>` is the default for cells without one. matrix.md shows it next to the device. |
| `[slot] max_load` | 2 × CPUs | The load above which a proof's `verdict.json` says `"unreliable": true`, and what a proof waits for before it records. `factory run` shows the load but never waits on it. `config validate` warns above 4 × the CPUs, where it never trips. |
| `[slot] boot_settle_s` | `120` | After a cold boot or a build, how long a proof waits for the 1-minute load to come back under `max_load` before the counted clip. A cold-booted simulator then gets one unrecorded launch, and `--orientation` turns it after the settle. A settle that runs out is said (`settle: timed out`), the clip records anyway and may come out load-unreliable; `verdict.json`'s `load.settle` has `waited_s` and `timed_out`. |

The slot is checked everywhere a build or a boot starts: `factory proof` waits (`factory run --wait`) before its build and before it boots the simulator (`--no-slot` skips both, and so does running the proof inside `factory run`), and `proof --cells` before its build and before each cell.

Proofs stop loading the Mac once they are done: a simulator `factory proof` booted is shut down when it ends (`--keep-booted` keeps it), a matrix proof boots the shooter only for a shooter cell and shuts it down again, and `factory sims idle --shutdown` shuts down every booted simulator nothing uses (see `[sim] idle_minutes`). `--build` skips a build that would change nothing (the app's stamp is from HEAD, or from a commit with no change under `[proof.ios] sources`, with the same build command and nothing uncommitted under the sources; `--rebuild` builds anyway). `[proof.ios] before` (e.g. the seed restore) runs before each proof installs the app, once per matrix. `proof --cells a,b` runs some cells of the default matrix; `--rerun-failed <previous out>` keeps the cells that passed there and runs the rest.

### `factory janitor`: a safe periodic sweep

`factory run` cleans up after the jobs it runs. The janitor cleans up after everything else: a build started outside `factory run`, an agent that died, a simulator nobody shut down. One pass costs a few subprocesses (`ps`, `xcrun`, `sysctl`), no model call; a missing tool skips its step.

```
factory janitor run              # a dry run: logs what it would do, changes nothing
factory janitor run --apply      # one real pass
factory janitor install          # a launchd agent, every 300 s; DISABLED (dry run) until you enable it
factory janitor status           # installed? enabled? last pass, last log lines
factory janitor enable           # scheduled passes now apply (disable undoes it)
factory janitor uninstall
```

Roll it out in order: `install`, read the dry-run lines in `<state_dir>/janitor/janitor.log` for a day, then `enable`. `install [--interval <s>] [--shim <path>]` writes `~/Library/LaunchAgents/com.factory-kit.janitor.<project>.plist` (`StartInterval` 300, never run at load) that runs `<shim> janitor run --scheduled` with `FACTORY_TOML` set; the shim is `--shim`, else the project's `scripts/factory/factory` or `scripts/factory`, else this kit. `install` is idempotent; `uninstall` boots it out and deletes the file. `--scheduled` applies only after `enable`; `run --apply` applies regardless. Every action, or would-be action, is one line (`time apply|dry what | why`) in `janitor.log`, rotated at 1 MB.

A pass, in order:

1. **Reap.** Leases whose process is gone are freed and their leftover process group killed (`factory run --reap`). A dry run lists them.
2. **Orphaned tools.** A process is stopped only when all hold: it is a named tool (`xcodebuild`, `xctest`, `simctl io … recordVideo`, `simctl spawn`, or a `[janitor] tools` entry); it is an orphan (its parent is pid 1 or gone, or every ancestor up to such a parent is itself a named tool, like `xctest` under an orphaned `xcodebuild`; a shell, editor, Xcode, agent or node above it means someone owns it); it is older than `[janitor] orphan_minutes` (10); it is not the pid or in the process group of, nor a descendant of, any live lease; it is not an app's main binary (`….app/Contents/MacOS/…`: Xcode, Simulator, Spotify) and has no Xcode or Simulator ancestor. A recording gets SIGINT, the rest SIGTERM then SIGKILL after 3 s.
3. **Idle simulators.** A booted simulator idle for `[sim] idle_minutes` (30; the same test as `factory sims idle`), that no live lease may own and `[sim] keep_booted` does not name, is shut down.
4. **Memory backstop.** When `kern.memorystatus_vm_pressure_level` is 4 (critical) or swap in use is at least `[janitor] swap_pct` (80) of the total, every booted simulator no live lease may own, that no running process names, and `keep_booted` does not name, is shut down, idle or not. The readings before and after are logged.

A live lease **may own** a simulator when it is the lease's `--sim`, or the simulator is not in the `booted` list the lease recorded when it was admitted (the job may have booted it). A lease with no list may own every simulator. Nothing is ever erased or deleted.

### `factory run`: weighted leases for heavy jobs

Heavy work goes through one command, so a night of agents never builds four apps at once on an 8-core Mac, nobody sits in a polling loop, and nothing a job starts outlives it:

```
factory run --job build --owner "$BRANCH" --dd dd-feature -- xcodebuild -scheme App -derivedDataPath dd-feature build
factory run --job proof --owner-pid $$ -- factory proof scrub --udid "$SIM"
factory run --status
```

- **Weights.** Each job type weighs something out of `[slot] capacity` (default 4): `build`, `test`, `release`, `device`, `archive` (xcodebuild-class) 2; `proof` (boot plus record), `vite` (a production build), `playwright`, `rules` (an emulator suite), `install` (npm install) 1; `unit` and `tsc` 0, which take no lease and never wait. `[slot.weights]` changes a weight or adds a type. An unknown `--job` is refused; a weight past the capacity counts as the capacity.
- **Queue.** Reservations live in `<state_dir>/slot/leases.json`, changed only under `/usr/bin/lockf` (`flock` elsewhere, a lock folder as a last resort). A job joins the queue and waits **inside the command** until it is first in line and its weight fits: first come, first served, so a small job never jumps a big one that came first. Once admitted it prints how many minutes it waited.
- **Gates.** Admission also needs, each time: `sysctl kern.memorystatus_vm_pressure_level` = 1 (normal); fewer than `[slot] max_swapouts_per_min` swap-outs over the last minute (the `vm_stat` "Swapouts" counter, sampled into `<state_dir>/slot/swapouts.json`; a first run with no recent sample measures for 3 s); free memory (`kern.memorystatus_level`) at least `[slot] min_free_pct`. Swap in use and the load are never gates: the 1-minute load stays high for a minute after a job ends, so it held builds on an idle Mac. A reading the system does not give (off macOS) holds nothing. While it waits, a line names what holds it and its `[slot]` key, printed again only when that changes.
- **Leases.** Each records the job, weight, the runner's pid, the command's process group, the owner (`--owner`, default the branch and folder), `--dd`, `--sim`, the start time and the command.
- **Process group.** The command runs in its own process group. When it exits, whatever it left running in that group is stopped (TERM, then KILL after 3 s) before the lease is freed. SIGINT, SIGTERM or SIGHUP to `factory run`, or the death of `--owner-pid` (a numeric `--owner` counts as one), stop the whole group too. Exit: the command's own status (128 + n for a signal); 75 when the wait passed `--timeout` / `[slot] timeout_s`.
- **Time limit.** Once admitted, a job runs for at most its type's minutes (test 30, build 45, device 45, release 60, archive 60, proof 5; other types none). Past it the whole process group is stopped, the lease freed, and `factory run` exits 124 naming the limit. `[slot.run_limits]` changes the numbers, `--limit <min>` one run (`0` = none). A proof applies `proof` itself, from when it has room and its build is done; in a matrix, per cell.
- **Nesting.** The command gets `FK_RUN_LEASE` and `FK_SLOT_HELD=1`: a `factory run` inside it takes no second reservation, and a proof inside it skips its own slot waits.
- **Reaper.** `factory run --reap`, also run at every admission: removes leases whose `factory run` is gone and kills the process group it left, but only when every process in it started after the lease did (a reused number is left alone); kills `simctl io … recordVideo` processes whose parent is pid 1, and kit test runs (node running a kit checkout's `test/*.test.mjs`), older than `[slot] orphan_minutes`. It prints each thing it kills and never touches a process it can't attribute to a lease or one of those two patterns.
- **Status.** `factory run --status` lists the leases (job, weight, owner, age, process group, command), the queue, the gate readings, and whether a build would start now (exit 0) or wait (exit 1). `--check --job <t>` is the one-line form; `--wait --job <t>` blocks until a `<t>` would start without taking a lease (what `slot wait` now does).

**Hook.** With `[slot]` or `[proof.ios]` set, hook-guard denies a raw build or test outside `factory run`: Bash `xcodebuild` (also through `xcrun`; `-list`, `-showBuildSettings` and other queries pass), a `build.sh` or `test.sh`, an npm/pnpm/yarn/bun script that `[hook] build_scripts` lists. The denial gives the `factory run --job <type> -- <cmd>` to run instead. Wrapped, it passes, unless the `--job` weighs 0; the wrapped command is still checked by the other rules. The XcodeBuildMCP `build_*` and `test_*` tools can't be wrapped, so they are denied while `factory run --check --job build` says a build would wait. A project adds those tools to its hook matcher (`"matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__XcodeBuildMCP__build_.*|mcp__XcodeBuildMCP__test_.*"`).

| Key | Default | What it does |
|---|---|---|
| `[slot] capacity` | `4` | The sum of job weights that may run at once: two xcodebuild-class jobs, or one and two proofs. |
| `[slot.weights]` | see above | Job type → weight (an int), merged over the defaults, e.g. `build = 3` or `lint = 1` (a new type). |
| `[slot] max_load` | 2 × CPUs | The highest 1-minute load a job is admitted at. |
| `[slot] min_free_pct` | `15` | The least free memory a job is admitted at: memory_pressure's "System-wide memory free percentage" (`sysctl kern.memorystatus_level`). `0` turns it off. |
| `[slot] max_swapouts_per_min` | `1000` | The most pages swapped out over the last minute a job is admitted at. Unlike swap in use, which macOS keeps long after the pressure that wrote it ends, the rate falls as soon as the pressure does. |
| `[slot] shutdown_booted` | `true` | When a `factory run` job ends (exit, failure, time limit, signal, owner death), it shuts down the simulators the job booted: booted now, not booted when it was admitted, not another live lease's (its `--sim`, or one that lease's job may have booted). `false` leaves them. |
| `[slot] orphan_minutes` | `60` | The age past which the reaper kills an orphaned recording or a kit test run. |
| `[slot] poll_s` / `timeout_s` | `5` / `3600` | How often a queued job looks again, and when it gives up (exit 75; `0` waits for ever). `--timeout` overrides it. |
| `[slot.run_limits]` | test 30, build 45, device 45, release 60, archive 60, proof 5 | Minutes a job may run once admitted; past it the job is stopped (exit 124). `0` = none; `--limit` overrides one run. |
| `[hook] build_scripts` | `[]` | Globs of npm/pnpm/yarn/bun script names that build or test, e.g. `["ios:test*", "ios:native", "ios:testflight*"]`; hook-guard denies them outside `factory run` (a name containing `test` suggests `--job test`, else `--job build`). A script not listed, such as a read-only status report, always passes. |
| `[hook] background_wait_deadline` | `true` | hook-guard denies a Bash call with `run_in_background: true` whose command holds an `until`/`while` loop and names no deadline (`timeout`, `gtimeout`, `perl -e 'alarm …'`, `$SECONDS`, `date +%s`): a wait nobody bounds outlives the session. A `for` loop and a foreground loop pass. `false` turns it off. |
| `[janitor] orphan_minutes` | `10` | The least age of an orphaned tool process before `factory janitor` stops it. |
| `[janitor] swap_pct` | `80` | The share of swap in use that, like critical memory pressure, makes the janitor shut down every simulator no live lease may own. |
| `[janitor] tools` | `[]` | Extra tool names the janitor may stop when orphaned: an executable name or glob (`"test-runner"`), or text with a space the command line must contain (`"npm run ios:test"`). Built in: `xcodebuild`, `xctest`, `simctl io … recordVideo`, `simctl spawn`. A bare wildcard or an entry under 3 characters is ignored (and logged). |
| `[slot] builders` | — | No longer read: `capacity` replaced it. `max_booted_sims` and `max_swap_gb` were removed; `config validate` names them. |

### `[proof.tier]`

An optional table of tier name → matrix name (strings), for projects whose rules pick how much proof an item needs, e.g. `motion = "default"`, `visual = "quick"`, `logic = "none"`. The kit validates it and passes it on as `FK_PROOF_TIER_<NAME>`; what a tier means is the project's.

### App-reported ground truth: `HITCH` and settle

Video alone can't see everything: a first tap that blocks before any motion leaves no gap in the recording, and a border drawn twice for a few frames after a morph settles is a 1 px change. A DEBUG build can report what it knows through its existing `SCENARIO <name> …` log prefix (so `steps.log` already collects it), and `proof-verdict` reads it. Every line is optional; a clip without them is judged from pixels alone. Times are `CACurrentMediaTime` seconds (`%.4f`).

| Line | Meaning |
|---|---|
| `CLOCK media=<s> wall=<epoch s>` | once at scenario start: pairs the media clock with wall time (steps get their media time through it) |
| `SYNC media=<s>` | a #FF00FF square at x/y 4–10 pt (inside the status band the verdict ignores), on for 3 frames; media = its first frame. Puts log time on the video. Emit one at every step and every UI `MOTION end`: recordings drift from the app's clock (~9% was seen), so a window is judged only within 2 s of an anchor |
| `HITCH media= dur=<ms> expected=<ms> frame=<n> step=<label>` | a display frame that came late (`step=` takes the rest of the line) |
| `MOTION start\|end kind=camera\|roll\|morph\|sheet id=<n> media=` | an animation on purpose; `camera` moves only the map |
| `MAPRECT media= x= y= w= h= scale=<px/pt>` · `SHEETTOP media= y=` | the map's frame and the sheet's top (points, window coordinates), on change |
| `LIVE start\|end id= media= x= y= w= h=` | a view that changes on purpose (a caret, a spinner): not judged by the settle check |
| `INJECT kind=hold\|blink\|ghost id= media= dur= step=` | a fault injected for calibration (labelled manifests) |

- **hitch**: each `HITCH` with `dur` ≥ `hold_warn_ms` is a hold event (`hold_fail_ms` FAILs, the launch window only WARNs).
- **settle**: after each stretch of UI motion (roll / sheet / morph) ends, the sheet and chrome must not change (more than `settle_floor_px` pixels by more than `settle_luma` grey levels, at one pixel per point) until the next UI motion or step, or `settle_ms`. The map above the sheet, the status band and `LIVE` rects are not judged.

Both appear in `verdict.json` and the `VERDICT` line from the first clip that carries the lines, **report-only**: they decide the verdict only with `[proof.ios.verdict] hitch_gate = true` / `settle_gate = true` (or `--hitch-gate` / `--settle-gate`). Review a few nights of reports before turning them on: a clean run can log several 50 ms+ hitches.

### `[worktree]`: sharing from the main checkout

`factory worktree` cuts a worktree from the branch you name, which is often not the branch the main checkout is on. So anything it shares must still be right for the *worktree's* branch.

```toml
[worktree]
cache_symlinks = ["node_modules", "packages/core/.cache", "app/.build"]
node_modules   = "overlay"                 # or "link"; default "overlay"
copy_files     = ["web/.env.local"]        # public values only, see below

[[worktree.derived]]
path   = "packages/core/dist"              # the output
source = "packages/core/src"               # the path whose content decides
build  = "npm run build -w packages/core"  # shell command, run from the worktree root
```

| Key | What it does |
|---|---|
| `cache_symlinks` | Paths symlinked whole from the main checkout when they exist there and not yet in the worktree. A path whose first folder is not in the worktree's checkout (it lives on another branch) is skipped, so no stray untracked tree appears |
| `node_modules` | `"overlay"` (default): every `cache_symlinks` entry named `node_modules` becomes a real directory holding one symlink per entry of the main checkout's (dot entries too; `@scope/` folders become real folders with per-entry links). Each npm workspace package (the worktree's root `package.json` `workspaces`, each folder's `name`) is linked to the **worktree's** own folder with a relative link, as npm makes it, so the worktree never imports the main checkout's copy. Re-running refreshes the overlay, and replaces an old whole-directory link from an earlier kit version (the link only, never its target). A package the worktree's `package-lock.json` installs but the main checkout lacks (a dependency only that branch has) is fetched with `npm pack` at its locked version into a real directory in the worktree, never through a link; a version that differs from the main checkout's is not detected yet. `"link"`: the old behaviour, one symlink to the main checkout's `node_modules` |
| `copy_files` | Files copied (not linked) from the main checkout when they are missing in the worktree. Never overwritten. Reported as `copy <path>` |
| `[[worktree.derived]]` | A build output that depends on source. If `source` is identical in the main checkout's HEAD and the worktree's HEAD (`git diff --quiet`), `path` is symlinked from the main checkout; otherwise `build` runs in the worktree, after the `node_modules` overlay exists, and the output is real. An existing link at `path` that now needs a build is removed first (the link only). A failed build is printed on stderr and `factory worktree` exits 1. A `path` must not also be in `cache_symlinks` (`factory config validate` says so) |

**`copy_files` is only for values that are public by construction**, such as env files that end up in a browser bundle. A copy does not follow later edits to the original, and a copied secret sits in another folder, outside the places you guard. Secrets and anything private are never copied: leave them out, and workers must stop and report that they need them (see the worker rules in the skill). Listing a path in `[never_touch]` as well is a good habit.

### `[disk]` and `[sim]`: what cleanup frees

A night's disk goes to proof videos, dead simulator app containers, tool scratch and agent worktrees nobody removed. `factory cleanup --apply` takes them back, and keeps the evidence that matters: `verdict.json`, `flags.png`, contact sheets, rest/settled frames, montages and logs.

| Key | Default | What it does |
|---|---|---|
| `[disk] dd_stale_hours` | `6` | A derived-data folder is **stale** when no file under it was modified for this many hours. A build in use is written constantly, so it is never stale. The check stops at the first fresh file, so busy folders cost almost nothing. Only stale folders are removed (`factory cleanup --dd-all` drops the rule for `dd_root`, not for extra roots). |
| `[disk] dd_roots_extra` | `[]` | More derived-data roots, e.g. `["~/Library/Developer/Xcode/DerivedData"]` (`~` and `$HOME` expand). Every child folder that is stale and matches no `dd_extra_keep` glob goes. `/` and the home folder are refused as roots. |
| `[disk] dd_extra_keep` | `["ModuleCache.noindex", "SDKStatCaches.noindex", "SymbolCache.noindex", "CompilationCache.noindex", "SDKExplicitPrecompiledModules"]` | Globs never removed from the extra roots (Xcode's shared caches). Setting it replaces the default list; `[]` keeps nothing. `dd_keep` / `dd_keep_derive` / `dd_keep_patterns` still decide what stays in `dd_root`. |
| `[disk] dd_auto` | `true` | `factory doctor` runs the stale prune first (`cleanup --apply --only derived-data`) and prints `dd pruned N (X freed)` in its one line when it removed something. `false` leaves it to a manual `factory cleanup`. |
| `[disk] clips` | `"delete"` | `"delete"`: the `clips` cleanup category removes every `*.mp4` under `[project] shots_dir` (`{n}` = the night; a bare `factory cleanup` takes every night's, `--night N` one). `"keep"`: leaves them. |
| `[disk] tmp_dirs` | `["$TMPDIR"]` | Extra scratch directories the `tmp` category also sweeps for loose **files or directories**. `$TMPDIR` is the per-user temp dir (`/var/folders/…/T/` on macOS), where Instruments traces and TestFlight upload scratch land; `/tmp` stays `[disk] tmp_dir`. `[]` turns it off. A `$TMPDIR/sub` entry works too. |
| `[disk] tmp_dirs_globs` | `["*.ktrace", "*.trace", "instruments*", "XcodeDistPipeline.*"]` | The only names removed from `tmp_dirs`, and only top-level entries owned by you with an mtime over an hour old. Nothing else in `$TMPDIR` is touched. (`tmp_globs` still applies to `tmp_dir` alone.) |
| `[sim] idle_minutes` | unset (30 for `sims idle`) | A booted simulator nothing has used for this long is idle. Set, `doctor` shuts idle simulators down (`factory sims idle --shutdown`); `cleanup` never deletes a simulator in use. |
| `[sim] keep_booted` | `[]` | Names, UDIDs or globs `sims idle` never shuts down. |
| `[sim] runtime` | unset | The simulator runtime every simulator the kit creates uses (matrix fresh cells; default: the shooter's runtime), e.g. `"com.apple.CoreSimulator.SimRuntime.iOS-26-5"` or `"iOS-26-5"`. Pin it when a newer default runtime misbehaves. `factory config validate` checks it is installed; it reaches project scripts as `FK_SIM_RUNTIME`; `doctor` names booted simulators (not `[sim] protected`) on another runtime. |

Every derived-data line says why it goes (`stale 14h`, `worktree gone: agent-x`). Folders are never removed through a symlink, and nothing outside the configured roots is touched. When `cleanup` removes an agent worktree (on a `[git] agent_branches` glob, or named like `[git] agent_worktrees`) it also removes the `dd_root` folders whose name contains the worktree's lane slug (its name minus the glob's literal prefix), its name, its branch's last segment, or its branch minus the literal prefix of an `[git] agent_branches` glob (a glob or a list, such as `["factory/lane-*", "claude/*", "cyrus/*"]`; unset by default) (4+ characters), and the `[sim] ephemeral` simulators whose name contains one of those (shut down first), whatever their age. Keep lists and `[sim] protected` still win. `dd_roots_extra` are shared with other projects, so only the age rule applies there.

A booted simulator is left alone while any `simctl io … recordVideo` runs. Add `"clips"` to `[disk] low_cleanup` if `cleanup --if-below` should also drop videos when space runs low (off by default); the default `low_cleanup` is frames, tmp, sims, derived-data and worktrees.

## Development

```
npm test        # node --test "test/*.test.mjs"; needs Node 22 and git
```

Bash and Node built-ins only, no dependencies. Tests use made-up fixtures. Commands that need Xcode call `fk_require_darwin` from `lib/darwin.sh`; on other systems they print `skipped: needs Xcode` and exit 0.

All rights reserved.
