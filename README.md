# factory

**Tooling for letting AI coding agents work through your backlog unattended, without shipping work that only looks done.**

**TL;DR**
- **Plan**: Build a backlog connected to Linear or GitHub, then send it to an orchestrator.
- **Execute**: Worker agents write the code and record video proofs of the running app changes.
- **Verify**: A script scores the videos for visual bugs, and the orchestrator commits only what passes.
- **Review**: Every morning, you just review one combined PR and a status log of what shipped, got stuck, or needs your eyes

This repo is the reusable part: the bookkeeping, the environment upkeep, and the proof checks. Your project describes itself in one config file, `factory.toml`; the kit holds no project-specific values.

> **Status: v0.11, early.** It is being extracted from one real app (a SwiftUI iPhone app with a web sibling), one command at a time. Available today: the config reader, bookkeeping (`tick`, `end-night`, `night-lint`), machine upkeep (`cleanup`, `disk-guard`, `dev-up`, `dev-status`, `read-api`, `worktree`, `preflight`), and video proofs (`proof`, `proof-matrix`, `proof-verdict`, `proof-calibrate`, `clip-frames`; iOS Simulator today). A safety hook (`hook-guard`), per-night statistics (`stats`), and the orchestrator itself: a Claude Code skill (`install-skill`) and a night-file template (`night-new`).

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
ref  = "v0.8.0"

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

**4. Run a night.** Install the orchestrator skill once, write down your project's own rules, and start a night file:

```
scripts/factory install-skill          # links skill/factory-orchestrator into ~/.claude/skills
scripts/factory night-new 1 --theme "first run"
```

- **Your rules file.** Put the rules no script can check in a short file and name it in `factory.toml` (`[loop] rules = "docs/factory-rules.md"`): your hard quality bar, the guardrails every worker brief should carry, the decisions that are settled.
- **Your backlog.** Fill the night file's Backlog.
- **Start the loop.** In Claude Code, run `/loop` with a one-line prompt that points at the night file, e.g. `/loop Run the factory night in ~/example-factory/night-1.md`. The skill takes it from there: one item per firing, proofs with verdicts, and a log you read in the morning.

## Commands

| Command | Status | What it does |
|---|---|---|
| `factory config validate` | ✓ | Checks `factory.toml`: required keys, types, typos, placeholders |
| `factory config get <key>` | ✓ | Prints one value, e.g. `factory config get git.github` |
| `factory config env --sh` | ✓ | Prints every value as `FK_*` shell exports |
| `factory tick` | ✓ | Checks off a backlog item in the night file and the PR checklist, and appends a log line. `--blocked "why"`, `--dry-run`, `--pr N` |
| `factory cleanup` | ✓ | Lists what can be freed: old proof frames, **proof videos (`clips`)**, stale build folders, temp files (in `/tmp` and in `$TMPDIR`), extra archives, throwaway simulators, merged agent worktrees. Deletes only with `--apply`. `--only <category>`, `--frames-age N`, `--include-night <name>`, `--night N` (limits `clips` to one night). See [`[disk]` and `[sim]`: what end-night frees](#disk-and-sim-what-end-night-frees) |
| `factory disk-guard` | ✓ | Prints free disk space. Below `[disk] min_gb` it runs `cleanup --apply` on frames, temp files and simulators. Exits 2 if space is still below `floor_gb`, so the loop stops |
| `factory dev-up` | ✓ | Starts the dev stack (`[dev] up`) in the background if its ports are down, then resets the test data. Does nothing when it's already up |
| `factory dev-status` | ✓ | One line per dev port, up or down. Exit 1 if a required port is down |
| `factory read-api up\|down` | ✓ | Runs a second API server on its own port (`[dev] read_api`) and stops only the one it started |
| `factory worktree <name>` | ✓ | Makes an isolated git worktree for a night or an agent. Shares installed dependencies and caches from the main checkout through symlinks, but makes npm workspace links and derived build outputs match the worktree's own branch, so a worker never borrows the main checkout's. See [`[worktree]`](#worktree-sharing-from-the-main-checkout) |
| `factory preflight` | ✓ | Start of every firing: disk-guard, then dev-up, then a test-data reset. One summary line; it names the step that failed |
| `factory end-night --night N` | ✓ | End of the night. Dry run by default; `--apply` deletes the night's proof videos, sweeps scratch files and temporary simulators, and **erases** a simulator whose data has bloated (`[sim] shooter_udid`, `erase_at_end_night`). It checks that no required secret is blank, that every worktree is clean and that the night file lints without errors (exit 3 if not), then appends a final line to the log |
| `factory night-lint [--night N \| --file <path>]` | ✓ | Checks a night file against the shape `night-new` writes and `tick` appends to: title, header bullets, the four sections in order, backlog lines per `[project] item_line`, log lines per `log_line`. Read-only, never rewrites. Errors exit 1; warnings print and exit 0. `tick` runs it after every write; `end-night` runs it and fails on errors. See [`night-lint`](#night-lint-what-it-checks) |
| `factory hook-guard` | ✓ | A Claude Code `PreToolUse` hook. It blocks what `factory.toml` forbids: edits to `[never_touch]` files, running `never_run_in_worktree` scripts from a worktree, pushes to `never_push` branches, force pushes, `--no-verify`, `gh pr merge`, and starting or killing the dev stack outside `factory dev-up`. Silent when allowed (~45 ms), and it fails open on its own errors |
| `factory stats [--night N]` | ✓ | Per-night statistics from the agent session transcripts plus GitHub, for charts: wall and active time, subagents by model, tool calls and tool time, estimated model hours, tokens (and cost for models you give prices), PR lines by area, builds, items shipped and blocked, questions asked. Nights are time windows you list in a JSON file; every event is assigned by its own timestamp. Writes `nights-stats.json` and `.csv`, prints a table. Read-only |
| `factory night-new <N> [--from <prev>] [--theme "…"]` | ✓ | Starts the next night file from the template, carrying over the previous night's open and blocked items, "With the user" and "Needs the phone". Never overwrites |
| `factory install-skill` | ✓ | Links the `factory-orchestrator` skill into `~/.claude/skills`, so Claude Code loads the loop. `--dry-run`, `--uninstall` |
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
| `[worktree]` | no | What each worktree shares from the main checkout instead of rebuilding: cache folders, `node_modules`, build outputs, public env files |
| `[never_touch]` | no | Files no agent may edit, and scripts never to run inside a worktree |
| `[dev]` | no | How to start the dev stack, and which ports mean it is up |
| `[seed]` | no | Commands to snapshot and restore test data |
| `[disk]` | no | Free-space thresholds, and what cleanup may delete: caches, frames, **proof videos (`clips`)**, scratch in `/tmp` and `$TMPDIR` |
| `[sim]` | no | Simulator ids and names: the one proofs run on, protected ones, throwaway patterns, and which ones end-night **erases** when they bloat |
| `[proof.*]` | no | How to build and record proofs, verdict thresholds, matrix cells |
| `[tests]` | no | The unit-test command and the pre-commit gate |
| `[stats]` | no | Where the session transcripts are, the nights (windows) file, the output folder, code areas, an optional price table |
| `[phone]`, `[release.*]` | no | Device builds and beta uploads |
| `[loop]` | no | Which model does which role, review rounds, report lengths; `item_ids = "slug"` (default) makes `tick` refuse item IDs that aren't plain-English slugs (`lifetime-globe`, not `G3`), `"any"` turns it off |

`{placeholders}` refer to other values: `{state_dir}` and `{main_checkout}` are filled from the file itself, and `~` expands to your home folder. Run-time placeholders such as `{n}` (night number) and `{id}` (item) are filled by the command that uses them. Commands receive every value as an environment variable: `proof.ios.seconds` becomes `FK_PROOF_IOS_SECONDS`, and lists are newline-separated.

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

### `[disk]` and `[sim]`: what end-night frees

A night's disk goes to proof videos, dead simulator app containers and tool scratch. `factory end-night --night N --apply` (and `factory cleanup`) take them back, and keep the evidence that matters: `verdict.json`, `flags.png`, contact sheets, rest/settled frames, montages and logs.

| Key | Default | What it does |
|---|---|---|
| `[disk] clips` | `"delete"` | `"delete"`: the `clips` cleanup category removes every `*.mp4` under `[project] shots_dir` (`{n}` = the night; a bare `factory cleanup` takes every night's, `--night N` one). `"keep"`: leaves them. `end-night` runs it for the night being closed, in a dry run too, and reports the size. |
| `[disk] tmp_dirs` | `["$TMPDIR"]` | Extra scratch directories the `tmp` category also sweeps for loose **files or directories**. `$TMPDIR` is the per-user temp dir (`/var/folders/…/T/` on macOS), where Instruments traces and TestFlight upload scratch land; `/tmp` stays `[disk] tmp_dir`. `[]` turns it off. A `$TMPDIR/sub` entry works too. |
| `[disk] tmp_dirs_globs` | `["*.ktrace", "*.trace", "instruments*", "XcodeDistPipeline.*"]` | The only names removed from `tmp_dirs`, and only top-level entries owned by you with an mtime over an hour old. Nothing else in `$TMPDIR` is touched. (`tmp_globs` still applies to `tmp_dir` alone.) |
| `[sim] erase_above_gb` | `6` | End-night `--apply` **erases** (`simctl shutdown` + `simctl erase`, never delete) `[sim] shooter_udid` and every `erase_at_end_night` sim whose `data` directory is bigger than this many GB (decimals allowed). Reinstalling the app leaves dead containers behind; an erase takes them with it and keeps the UDID. |
| `[sim] erase_at_end_night` | `[]` | More simulators to erase when bloated: names, UDIDs or globs. |

End-night prints each sim's size before and after (a dry run says "would shut down and erase"). A booted simulator is left alone while any `simctl io … recordVideo` runs. The erase is macOS-only and skips cleanly elsewhere. Add `"clips"` to `[disk] low_cleanup` if `disk-guard` should also drop videos when space runs low (off by default).

### `night-lint`: what it checks

`factory night-lint [--night N | --file <path>] [--quiet] [--limit K]` reads the night file and never writes it. It checks the shape `night-new` renders and `tick` appends to, using `[project] item_line` and `log_line`:

- **Title:** `# <name> factory: night N`, first line.
- **Header bullets:** `Date` and `Theme` (one line), `Branch target`, `The human`, `Rules`, `Previous night`.
- **Sections, in order:** `## Backlog`, `## With the user`, `## Needs the phone`, `## Log`.
- **Backlog lines** (per `item_line`): an `[ ]` or `[x]` mark; an ID (a plain-English slug when `[loop] item_ids = "slug"`, the default); a sha (7–40 hex) right after the ID on `[x]` lines; then tags (`[...]` groups, or the words `IDEATE`, `TASTE`, `"no test"`). Indented lines continue the item.
- **Log lines** (per `log_line`): `hh:mm · <id> · <sha or status word> · <note>`. The note may itself contain ` · `. The ID is a backlog ID, a free slug (`plan`, `phone`, `kit`, `morning`, `lesson`, `end-night`) or `TF <n>`. Two exceptions: one `FINAL (night N) · <summary>` line, and a line that is exactly `STOP`.

**Errors** (exit 1) are what breaks the tools or the ledger: no title line or the wrong night number; a required section missing, repeated or out of order; a backlog line `tick` cannot parse (no ID); a done item without a sha; a duplicate backlog ID. **Warnings** (printed, exit 0) are everything else: a missing header bullet, an extra `##` section, a non-slug ID, a broken tag, a log line in the wrong shape, an unknown log ID, a second `FINAL` line, prose in the Backlog. Nights written before these rules existed warn a lot; that is expected, and nothing rewrites them.

`tick` runs `night-lint --quiet --limit 12` after every write and prints the findings on stderr; its own exit code and stdout do not change. `end-night` runs it as step 8 (after appending its log line), lists the result, and exits 3 on errors, like a dirty worktree. Exit 2 is a bad argument or a missing file.

## Development

```
npm test        # node --test "test/*.test.mjs"; needs Node 22 and git
```

Bash and Node built-ins only, no dependencies. Tests use made-up fixtures. Commands that need Xcode call `fk_require_darwin` from `lib/darwin.sh`; on other systems they print `skipped: needs Xcode` and exit 0.

All rights reserved.
