# factory

**Tooling for letting AI coding agents work through your backlog unattended, without shipping work that only looks done.**

You write a short backlog before bed. An orchestrator agent (e.g. Claude Code running in a loop) takes one item at a time. It hands each item to a worker agent, which writes the code and records a video proof of the change running in the app. A script scores that video for visual defects. The orchestrator commits only what passes. In the morning you read one pull request and a log of what shipped, what got stuck, and what needs your eyes.

This repo is the reusable part: the bookkeeping, the environment upkeep, and the proof checks. Your project describes itself in one config file, `factory.toml`; the kit holds no project-specific values.

> **Status: v0.6, early.** It is being extracted from one real app (a SwiftUI iPhone app with a web sibling), one command at a time. Available today: the config reader, bookkeeping (`tick`, `end-night`), machine upkeep (`cleanup`, `disk-guard`, `dev-up`, `dev-status`, `read-api`, `worktree`, `preflight`), and video proofs (`proof`, `proof-matrix`, `proof-verdict`, `proof-calibrate`, `clip-frames`; iOS Simulator today). A safety hook (`hook-guard`). Moving in next: the orchestrator skill and a night-file template.

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

Two files:

- **`factory.toml`**, committed in your repo. It holds every value a script would otherwise hard-code: ports, paths, branch names, simulator ids, files no agent may touch.
- **A night file** outside the repo (e.g. `~/example-factory/night-12.md`). It holds the backlog and the log, nothing else.

## Walkthrough: one night

A made-up app, `example-app`, through one night. Every command shown is in the kit.

**1. The backlog.** Before the first firing, you write and order it:

```markdown
## Backlog
- [ ] P1. Splash flashes white on a cold launch in dark mode
- [ ] C.  Photo viewer: a finger should end the slideshow
- [ ] H.  [needs-user] Pick the onboarding copy

## Log
```

**2. Each firing does one item.**

| Step | Who | What |
|---|---|---|
| Preflight | orchestrator | Check free disk, check the dev server is up, update the worktree, reset the test data: `factory preflight` |
| Ideate (taste items only) | strong model | 2–3 options with side-by-side screenshots. You pick one before anything is built |
| Implement | worker | Changes the code in the night's worktree; reports back in ≤150 words |
| Prove | worker | Records the change running in the app with a self-driving test scenario (no manual taps): `factory proof <scenario>` or `factory proof-matrix` |
| Review | orchestrator | Reads the verdict first, then looks at the flagged frames. At most one round of fixes |
| Ship | orchestrator | Runs your project's pre-commit checks, commits, pushes to the night's branch |
| Log | orchestrator | `factory tick --night 12 --item P1 --sha 3f2a91c --pr 41 --log "…"` |

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

**4. The log.** `factory tick` checks the item off in the night file and in the pull request's checklist, then appends one line:

```
02:14 · P1 · 3f2a91c · splash waits for the first painted frame; matrix 4/4 PASS; check warm-launch timing on a device
```

A stuck item is marked `--blocked "<why>"` and the loop moves on.

**5. Morning.** The night ends by sweeping scratch files and temporary simulators and checking that no secret was blanked. It then writes a summary: what shipped, what's blocked, what to test on a real device (`factory end-night`). You review one draft pull request whose checklist matches the night file.

## Getting started

You need Node 22+, git and bash. The `gh` CLI is needed for pull-request checklists, and Xcode for the iOS proof tools.

**1. Add a `factory.toml` at your repo root.** This is the smallest file that validates:

```toml
[kit]
repo = "https://github.com/Z-Ahmad/factory.git"
ref  = "v0.6.0"

[project]
name          = "example-app"
main_checkout = "~/code/example-app"
state_dir     = "~/example-factory"            # night files, screenshots, logs: kept out of the repo
night_file    = "{state_dir}/night-{n}.md"
item_line     = "- [ ] {id}."
log_line      = "{hhmm} · {id} · {sha} · {note}"

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

## Commands

| Command | Status | What it does |
|---|---|---|
| `factory config validate` | ✓ | Checks `factory.toml`: required keys, types, typos, placeholders |
| `factory config get <key>` | ✓ | Prints one value, e.g. `factory config get git.github` |
| `factory config env --sh` | ✓ | Prints every value as `FK_*` shell exports |
| `factory tick` | ✓ | Checks off a backlog item in the night file and the PR checklist, and appends a log line. `--blocked "why"`, `--dry-run`, `--pr N` |
| `factory cleanup` | ✓ | Lists what can be freed: old proof frames, stale build folders, temp files, extra archives, throwaway simulators, merged agent worktrees. Deletes only with `--apply`. `--only <category>`, `--frames-age N`, `--include-night <name>` |
| `factory disk-guard` | ✓ | Prints free disk space. Below `[disk] min_gb` it runs `cleanup --apply` on frames, temp files and simulators. Exits 2 if space is still below `floor_gb`, so the loop stops |
| `factory dev-up` | ✓ | Starts the dev stack (`[dev] up`) in the background if its ports are down, then resets the test data. Does nothing when it's already up |
| `factory dev-status` | ✓ | One line per dev port, up or down. Exit 1 if a required port is down |
| `factory read-api up\|down` | ✓ | Runs a second API server on its own port (`[dev] read_api`) and stops only the one it started |
| `factory worktree <name>` | ✓ | Makes an isolated git worktree for a night or an agent, sharing installed dependencies through symlinks |
| `factory preflight` | ✓ | Start of every firing: disk-guard, then dev-up, then a test-data reset. One summary line; it names the step that failed |
| `factory end-night --night N` | ✓ | End of the night. Dry run by default; `--apply` sweeps scratch files and temporary simulators. It checks that no required secret is blank and that every worktree is clean (exit 3 if not), then appends a final line to the log |
| `factory hook-guard` | ✓ | A Claude Code `PreToolUse` hook. It blocks what `factory.toml` forbids: edits to `[never_touch]` files, running `never_run_in_worktree` scripts from a worktree, pushes to `never_push` branches, force pushes, `--no-verify`, `gh pr merge`, and starting or killing the dev stack outside `factory dev-up`. Silent when allowed (~45 ms), and it fails open on its own errors |
| `factory help` | ✓ | Lists the commands |
| `factory proof <scenario>` | ✓ | Installs the app on an iOS Simulator, runs a self-driving test scenario, records it, and prints a `VERDICT` line. Writes the clip, a contact sheet, rest frames, `verdict.json`, and `flags.png` when something is flagged. Exit 4 on FAIL (`--no-gate` to record only) |
| `factory proof-matrix --scenario <s>` | ✓ | Runs one scenario across the cells in `[proof.cell.*]` (themes, a theme mismatch, a smaller screen, a first launch on a fresh simulator) from one build. Writes `matrix.md` and one labelled contact sheet. Exit 4 if any cell fails |
| `factory proof-verdict <clip.mp4>` | ✓ | Scores any recording for flash, hold, bounce and the app's fail markers. No simulator needed |
| `factory proof-calibrate <manifest.json>` | ✓ | Runs the verdict over your own labelled clips ("this one must fail") and prints a confusion table, so threshold changes are checked against real defects |
| `factory clip-frames <clip.mp4> …` | ✓ | Grabs frames or contact sheets from a simulator recording without seeking (seeking those files returns stale frames) |

`factory` finds `factory.toml` by walking up from the current directory, then in the main git checkout, so it works from any worktree. Use `FACTORY_TOML=<path>` to name one explicitly.

## `factory.toml` reference

The file is a small subset of [TOML](https://toml.io): tables, `[[arrays of tables]]`, strings, numbers, booleans, arrays and inline tables. Unknown keys are rejected, so typos fail loudly.

| Section | Required | Holds |
|---|---|---|
| `[kit]` | yes | `repo` and `ref`: which kit version this project uses |
| `[project]` | yes | Name, main checkout path, state directory, night-file path and line formats |
| `[git]` | yes | Worktree location and branch naming; `github = "owner/repo"` for PR checklists |
| `[[targets]]` | yes | Branches work can land on, and which paths go where |
| `[worktree]` | no | Folders to share into each worktree (e.g. `node_modules`) instead of reinstalling |
| `[never_touch]` | no | Files no agent may edit, and scripts never to run inside a worktree |
| `[dev]` | no | How to start the dev stack, and which ports mean it is up |
| `[seed]` | no | Commands to snapshot and restore test data |
| `[disk]` | no | Free-space thresholds, and what cleanup may delete |
| `[sim]` | no | Simulator ids and names: the one proofs run on, protected ones, throwaway patterns |
| `[proof.*]` | no | How to build and record proofs, verdict thresholds, matrix cells |
| `[tests]` | no | The unit-test command and the pre-commit gate |
| `[phone]`, `[release.*]` | no | Device builds and beta uploads |
| `[loop]` | no | Which model does which role, review rounds, report lengths |

`{placeholders}` refer to other values: `{state_dir}` and `{main_checkout}` are filled from the file itself, and `~` expands to your home folder. Run-time placeholders such as `{n}` (night number) and `{id}` (item) are filled by the command that uses them. Commands receive every value as an environment variable: `proof.ios.seconds` becomes `FK_PROOF_IOS_SECONDS`, and lists are newline-separated.

## Development

```
npm test        # node --test "test/*.test.mjs"; needs Node 22 and git
```

Bash and Node built-ins only, no dependencies. Tests use made-up fixtures. Commands that need Xcode call `fk_require_darwin` from `lib/darwin.sh`; on other systems they print `skipped: needs Xcode` and exit 0.

All rights reserved.
