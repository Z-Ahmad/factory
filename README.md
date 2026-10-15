# factory

A kit for running an overnight agent factory on a software project: night files, worktrees, disk and dev-stack upkeep, simulator proof runs. Bash and Node, no dependencies. The kit holds no project state and no project values; each project describes itself in a `factory.toml`.

Status: v0.2. The config reader, the dispatcher and `factory tick` are in; the other commands migrate in next.

## The `factory.toml` contract

A project commits one `factory.toml` at its root. It is a small TOML subset (tables, `[[arrays of tables]]`, strings, numbers, bools, arrays, inline tables). Sections: `[kit]` (repo and pinned ref), `[project]`, `[git]`, `[[targets]]`, and optional `[worktree]`, `[never_touch]`, `[dev]`, `[seed]`, `[disk]`, `[sim]`, `[proof.*]`, `[tests]`, `[phone]`, `[release.*]`, `[loop]`. Required keys and types are checked by `factory config validate`, and unknown keys are rejected. `{placeholders}` and `~` are expanded when the file is read: `{state_dir}`, `{main_checkout}`, `{dd_root}`, `{dd}` and `{trip}` come from the file itself; `{n}`, `{id}`, `{name}` and the other run-time ones are left for the command that owns them. Commands receive every value as an `FK_*` environment variable (`proof.ios.seconds` becomes `FK_PROOF_IOS_SECONDS`; lists are newline-separated).

```
factory config validate
factory config get sim.shooter_udid
factory config env --sh        # FK_* exports, for bash
factory tick --night 12 --item P1 --sha 3f2a91c --log "…" [--pr 41] [--blocked "why"] [--dry-run]
factory help
```

`factory tick` checks an item off in the night file (`project.night_file`, `project.item_line`), appends a `project.log_line`, and with `--pr` ticks the same line in the PR body. It finds the GitHub repo from `[git] github = "owner/repo"`, or from `project.main_checkout`'s origin remote, so it runs from any directory.

`factory` finds `factory.toml` by walking up from the current directory, then in the git common root, so it works from any worktree. `FACTORY_TOML` or `--file` name one explicitly.

## Using it from a project

Commit `factory.toml` and a small shim script. The shim reads `[kit] ref`, clones this repo at that tag into `~/.factory-kit/<ref>` on first use, and runs `bin/factory` from there. Each ref has its own directory, so two branches can pin different versions. To work on the kit itself, point a project at your checkout:

```
FACTORY_KIT_DIR=~/path/to/factory <shim> config validate
```

## Walkthrough: one night in the factory

The factory is one orchestrator agent working through a backlog, one item per loop firing. Cheaper agents write the code and shoot the proofs. The orchestrator reviews the pixels, then owns git and the log. The human picks the backlog, makes the taste calls, and holds the phone. This walkthrough follows a made-up app, `example-app`, through one night. Commands marked *(planned)* still live in the project and move into the kit in later releases.

**1. Describe the project once.** `factory.toml` sits at the repo root and holds everything a script would otherwise hard-code:

```toml
[kit]
repo = "https://github.com/Z-Ahmad/factory.git"
ref  = "v0.1.0"

[project]
name       = "example-app"
state_dir  = "~/example-factory"              # night files, shots, logs: never in the repo
night_file = "{state_dir}/night-{n}.md"
item_line  = "- [ ] {id}."
log_line   = "{hhmm} · {id} · {sha} · {note}"

[dev]
up         = "npm run dev"
wait_ports = [8080, 5173]

[never_touch]
paths = [".env*", "ios/Config/Secrets.xcconfig"]
```

**2. Write the night file.** `~/example-factory/night-12.md` is the backlog plus the log, and nothing else. The human picks the order before the first firing:

```markdown
## Backlog
- [ ] P1. Splash flashes white on a cold launch in dark mode
- [ ] C.  Photo viewer: a finger should end the slideshow
- [ ] H.  [needs-user] Pick the onboarding copy

## Log
```

**3. Each firing does one item.**

| Step | Who | What |
|---|---|---|
| Preflight | orchestrator | Check disk, check the dev stack is up, fast-forward the worktree, restore the seed data: `factory preflight` *(planned)* |
| Ideate (taste items) | strong model | 2–3 options with side-by-side frames. The human picks one before anything is built |
| Implement | worker agent | Works only in the night's worktree, never commits, reports in ≤150 words |
| Prove | worker agent | Records the item's scenario: `sim-proof.sh` / `proof-matrix.sh` *(planned: `proof/`)* |
| Review | orchestrator | Opens the verdict first, then the frames. One review round, sent to the same worker |
| Gate and ship | orchestrator | The project's own pre-commit gate, then commit and push to the night's branch |
| Bookkeeping | orchestrator | `factory tick --night 12 --item P1 --sha 3f2a91c --pr 41 --log "…"` *(v0.2)* |

**4. Proofs end in a verdict, not an opinion.** A proof run records the app driving itself through a DEBUG scenario (no taps), then scores the clip:

```
VERDICT: FAIL (flash 87.3 > 30 at 4.21 s; hold 0 ms; bounce 0; LAYOUT-LOOP 0)
  verdict.json  flags.png  contact.png  steps.log
```

`flags.png` puts each flagged frame next to its neighbours, with the region outlined, so a reviewer starts on the defect instead of scrubbing 600 frames. The checks:
- a **flash**: a region that changes and reverts within 3 frames
- a **hold**: no new frame while things move on both sides
- a **bounce**: a large swing that reverses within a second
- **LAYOUT-LOOP**: a tripwire line the app logs

A **matrix** runs one scenario across the cells defects hide in:
- both themes
- a system/app theme mismatch
- a second screen size
- a true first launch on a fresh device

It returns one table:

```
| cell     | launch | system | app   | verdict | flash | hold ms | bounce |
| light    | warm   | light  | light | PASS    | 0     | 0       | 0      |
| mismatch | first  | dark   | light | PASS    | 0     | 0       | 0      |
| size     | first  | light  | light | FAIL    | 0     | 0       | 212    |
MATRIX: FAIL (2/3 cells)
```

**5. The log tells the morning story.** `factory tick` checks the item off in the night file and in the PR checklist, and appends one line:

```
02:14 · P1 · 3f2a91c · splash waits for the first painted frame; matrix 4/4 PASS; judge warm-launch timing on the phone
```

A stuck item gets `--blocked "<why>"` and the loop moves on. Three blocked items in a row stop the night.

**6. End of night.** The orchestrator sweeps scratch frames and temporary simulators, then checks that no secret was blanked and every worktree is clean. It writes a final summary of what shipped, what's blocked, and what needs the human's phone: `factory end-night` *(planned)*. In the morning the human reads one draft PR whose checklist matches the night file, plus a short list of phone checks.

**What stays prose.** The night file holds the backlog, the log and the human's availability. Rules the human has given twice become mechanisms:
- a script check
- a verdict gate
- a pre-tool-use hook
- a line in the project's agent instructions

Prose rules decay; scripts don't.

## Development

```
npm test        # node --test "test/*.test.mjs"; needs Node 22 and git
```

Commands that need Xcode source `lib/darwin.sh` and call `fk_require_darwin`: elsewhere they print `skipped: needs Xcode` and exit 0.

All rights reserved.
