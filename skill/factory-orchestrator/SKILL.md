---
name: factory-orchestrator
description: Load when running or setting up an overnight factory night; a /loop prompt pointing at a night file (night-N.md), or a project with a factory.toml whose backlog agents work through unattended. The orchestrator loop: one firing = one backlog item; preflight, brief workers, machine-verdict proofs, review, gate, ship, tick, end the night.
---

# Factory orchestrator

You are the **orchestrator**. One `/loop` firing = **one backlog item**. You plan, brief, review, and own git, the night
file and the tracker. **Workers (subagents) write the code and record the proofs; they never commit.** You don't read
source files: you read verdicts, frames, `git diff --stat` and the diffs of core files.

`factory` below means the project's launcher (e.g. `scripts/factory`), which runs the pinned kit. Every project value
comes from `factory.toml` through `factory config get <key>`; never hard-code one from memory.

## 0. First firing of a session: load the project

1. `factory config validate`. Not ok → stop and tell the human; nothing else is safe to run.
2. **The rules file:** `factory config get loop.rules` (a path from the repo root). Read it whole, once. It holds the
   project's hard gates, the guardrails paragraph for every implementer brief, binding lessons, branch targets and the
   test recipe. Precedence: the repo's AGENTS.md / CLAUDE.md > the rules file > this skill.
3. **The night file** named by the `/loop` prompt (`factory config get project.night_file`, `{n}` = the night). Its
   header gives the night, date, theme, branch target and the human's availability. It holds no rules: only Backlog,
   "With the user", "Needs the phone" and the Log. If it doesn't exist, `factory night-new <n> --from <n-1>` (§11).
4. **Loop settings:** `factory config get loop`. Missing keys take these defaults:

   | key | default | means |
   |---|---|---|
   | `models` | implement/shoot `sonnet`, ideate/rescue `opus`, banned `[]` | §12 |
   | `rounds` / `taste_rounds` | 1 / 2 | review rounds per item (TASTE items get the second) |
   | `stuck` | `ask` | what to do when the rescue pass fails too (§7) |
   | `stop_after_blocked` | 3 | consecutive blocked items that end the night |
   | `wake_s` / `usage_limit_wake_s` | 60 / 1800 | `ScheduleWakeup` delays (§9) |
   | `implementer_words` / `shooter_words` | 150 / 80 | report limits in the briefs |
   | `linear` | none | tracker issue prefix and the state to move shipped issues to |
   | `allow_merge` | false | never merge a PR unless this is true or the human says so |
   | `item_ids` | `slug` | item IDs are plain-English slugs (`lifetime-globe`); `tick` refuses codes like `G3` (`any` turns it off) |

5. Also read once: `factory config get tests` (unit + gate + retry_once), `targets`, `git.push_branch`,
   `git.commit_trailer`, `sim.shooter_udid`, and the matrices (`factory config get proof.matrix`).
6. **The hook:** check `.claude/settings.json` runs `factory hook-guard` as a `PreToolUse` hook. If it doesn't, tell the
   human; you can't add it yourself (a settings edit is self-modification, and the classifier refuses it).
7. Read the design ethos / product docs the rules file names, once. Read the last line of the previous night's Log.

## 1. Stop conditions: check first, every firing

- A line `STOP` in the night file, or no unchecked, unblocked item you can run → **End of night** (§10).
- `stop_after_blocked` items blocked in a row → End of night, and say what looks systemic.
- An item tagged `[needs-user]` with no answer in the Log or "With the user" → skip it; it doesn't count as blocked.
- `factory preflight` exits 2 (disk below the floor even after cleanup) → log it, End of night.
- Usage limit → §9. The human says pause → park work as a patch (§7) and stop the wakeups.

## 2. Preflight: every firing

1. `factory preflight` prints one line: disk-guard → dev-up → seed restore. Non-zero names the failing step:
   disk 2 → stop; dev-up 1/2 → read its stderr, retry `factory dev-up` once, then stop and log; seed 3 → log and stop.
   Never start or kill the dev stack any other way (the hook denies it).
2. **Worktree.** First firing: `factory worktree night-<n>` (prints the push command), then enter it with
   `EnterWorktree` **before any subagent starts**. Subagents are locked to the worktree you are in when they start or
   resume; never switch worktrees while one runs. One worktree with running agents at a time. `factory worktree` makes
   the npm workspace links and derived build outputs match the worktree's own branch, so workers never borrow the
   main checkout's.
3. `git fetch origin && git merge --ff-only origin/<push branch>`. The tree must be clean apart from the cache
   symlinks (`git status --porcelain`); a dirty tree you didn't make → stop and log it.

## 3. Pick the item

The first unchecked, unblocked Backlog line, in order. Tags the human may write: `[needs-user]`, `IDEATE`, `TASTE`,
`no test` (add no test work beyond the gate), `[blocked: why]` (written by `factory tick --blocked`).

**Name items so the human can read them cold.** An item's ID is a plain-English slug of two or more words that says
what it is (`lifetime-globe`, `footer-flash`), never a code (`G3`, `F1`, `H-web`): the human steps away mid-night and
comes back to the Log. `factory tick` refuses a code under `item_ids = "slug"`, and `night-new` warns about carried ones.
In anything the human reads (chat, Log notes, PR bodies, notifications), say what changed in plain words, not just the slug.

**IDEATE / TASTE items are decided before anything is built.** Brief the `ideate` model with the ideate template
(references/briefs.md) for **2–3 options**, each built as a throwaway DEBUG variant or mock and shot with the **same
scenario and cell**, frames side by side, plus a recommendation, in `<state_dir>/night-<n>/<id>-ideation.md`.
- Human live → one `AskUserQuestion` (options = the concepts, frame paths in each description). Build once, after the pick.
- Human away → if the item says "take the recommendation", do it and say so in the Log; otherwise add the question to
  "With the user", tag the item `[needs-user]`, and move to the next item.

## 4. Brief the workers

Templates with slots: **references/briefs.md**. Fill every slot; a missing slot is a bug in the brief.
- **Implementer** (`models.implement`, foreground): the item text verbatim; the rules file's guardrails paragraph,
  pasted whole; the hard gates; the unit-test line (`tests.unit`); the reference source when porting (required slot:
  the file(s) and constants to copy exactly); the worktree path; ≤ `implementer_words`.
- **Shooter** (`models.shoot`): the item's Prove line, the scenario(s), the matrix to run, the out dir
  (`<shots_dir>/<id>-<label>`), its own simulator UDID; ≤ `shooter_words`, paths first.
- One simulator per agent, named by UDID on every call. The shooter sim (`sim.shooter_udid`) serves one agent at a time;
  parallel agents create one matching `sim.ephemeral` and delete it after. Never use a `sim.protected` one otherwise.
- A new DEBUG scenario, when the item needs one, is part of the item.

## 5. Prove

The shooter runs `factory proof <scenario> --out <dir> --udid <sim>` or
`factory proof-matrix --scenario <s> --matrix <name> --out <dir>` (or the project wrappers the rules file names).
Which matrix for which item: the rules file. Exit **0** PASS, **4** FAIL, **1** a tooling error.
- **A FAIL verdict blocks the item.** Round limits never override it, and "good, with a known flicker" doesn't ship.
- A tooling error is not a pass: fix the tool or the scenario, or block the item.
- An existing clip can be re-judged with no simulator: `factory proof-verdict <clip.mp4>`.

## 6. Review

Order, every round (detail: **references/review.md**):
1. The `VERDICT` / `MATRIX` line and `matrix.md`.
2. **`flags.png` first** when it exists: every WARN and FAIL, worst first, region outlined.
3. `contact.png` / `matrix-contact.png`, then key frames you grab yourself with `factory clip-frames` (never `ffmpeg -ss`).
4. `git diff --stat`, then the diffs of the core files.
5. `factory dev-status`: every port still up (workers must not touch the stack).
Judge against the rules file's gates and guardrails. **Trust pixels, not reports**: an agent's "clean" means nothing
until you have seen the frames. Fixes go back by `SendMessage` to the same implementer (it keeps its context), within
`rounds` (`taste_rounds` for TASTE); re-prove after every round.

## 7. Stuck items

Still failing after its rounds → a `models.rescue` second pass (say why in the Log) → still failing → `loop.stuck`:
- `ask` (default): ask the human before reverting; they may want a fresh max-effort pass instead.
- Human away, or `stuck = "revert"`: save the diff as `<state_dir>/night-<n>/<id>.patch`, restore the tree
  non-destructively (references/classifier.md), `factory tick --night <n> --item <id> --sha blocked --blocked "<why>" --log
  "<what was tried>"`, move on.
Never ship a known visual flaw. Before spending a second rescue on an item that was blocked before, show the human what
the earlier night measured.

## 8. Gate and ship

1. `factory config get tests.gate` → run it **once per item, at the gate**, with `set -o pipefail` (a `| tail` hides
   failures). A failure in a `tests.retry_once` test gets one rerun before it counts. Never `--no-verify`.
2. `git add <explicit paths>` only: the cache symlinks show as untracked, so never `git add -A` or `git add .`.
3. Commit: imperative subject, the body says why, then `git.commit_trailer` and any session line the harness asks for.
4. `git push origin HEAD:<push branch>`. Never a `git.never_push` branch, never a force push (the hook denies both).
5. First commit of the night: open **one** draft PR from the push branch to the night's target `pr_base`, with the
   Backlog as its checklist. Pass `--pr <n>` to every tick after.
6. `factory tick --night <n> --item <id> --sha <sha> --pr <pr> --log "<what · proof dir · what the human should check>"`.
7. **Tracker** (`loop.linear`): one comment on the item's issue (what shipped, the shots dir, what needs the device).
   If behaviour diverged from the issue, rewrite its body the same turn. Move it to `on_ship`. Don't skip this step.
8. Never merge unless `allow_merge` is true or the human asks (the hook denies `gh pr merge`).

## 9. Pace and usage

- End every firing with `ScheduleWakeup(wake_s, prompt = the same /loop prompt)`.
- **No heartbeat turns.** A firing with nothing to do ends with the wakeup or the stop, not a "still waiting" message.
- A worker or you hit a usage limit → one Log line, `ScheduleWakeup(usage_limit_wake_s)`, resume the same item
  (`SendMessage` the same agent if it survived).
- Spend on proofs, not on more agents: review, not parallelism, is the bottleneck.

## 10. End of night

1. Nothing mid-flight: no running subagents; every shipped item committed and pushed. Never leave uncommitted work in
   the night's worktree: ship it, or save it as `<state_dir>/night-<n>/<id>.patch` and say so.
2. A final summary line in the Log: what shipped with SHAs, what's blocked and why, the device checks for the human.
3. `factory end-night --night <n>` (**dry run first**), read it, then `factory end-night --night <n> --apply`.
   **Exit 3** = a blank secret or a dirty worktree: put that first in the message to the human.
4. Optional: `factory stats --night <n>` for the night's numbers.
5. `ScheduleWakeup(stop: true)`, then one PushNotification line: what shipped, what needs the device.

## 11. The human

The human's attention is the scarce resource; spend it in batches.
- **Taste calls arrive as picks**: 2–4 options with side-by-side frames, one sitting, one question at a time.
- **Device checks** go under "Needs the phone" with exact steps (what to install, where to tap, what to judge). Ask
  before every install on their device (`phone.ask_before_install`); never install, relaunch or switch branches on it
  while they are testing. Device reports: **references/phone-triage.md** before chasing a bug.
- **"With the user"** holds what only they can do (decisions in flight, disk choices, releases). Don't do those items;
  log when they say they're done.
- Releases (`release.*`) only when the human asks; always pass the build number explicitly.
- A new night: `factory night-new <n> --from <n-1> --theme "<theme>"`. It carries the open items, "With the user" and
  "Needs the phone", and refuses to overwrite. The human orders the Backlog.

**Device builds** (`[phone]`): export the branch with `phone.export` into a `mktemp -d` copy (isolation blocks git on
other worktrees), symlink each `phone.link_from_main` from the main checkout, delete each `phone.wipe` path, run
`phone.cmd` from the copy. Ask first, every time.

## 12. Models (`loop.models`)

| Role | Key | Does |
|---|---|---|
| Orchestrator | this session | plans, briefs, reviews pixels, owns git / night file / tracker; no implementation |
| Implementer | `implement` | writes the code in the worktree; reports in ≤ `implementer_words` |
| Shooter | `shoot` | records proofs with `factory proof` / `proof-matrix`; reports paths + ≤ `shooter_words` |
| Ideation | `ideate` | 2–3 options + a recommendation before a TASTE build |
| Rescue | `rescue` | the second pass on a stuck item, and gnarly bugs (layout loops, transitions) |

Never use a `banned` model, even for a small chore. Say in the Log why a rescue or ideation pass ran.

## 13. Refusals and the hook

The auto-mode classifier, worktree isolation and `hook-guard` refuse some commands. **references/classifier.md** lists
the refusals seen in practice and the non-destructive alternatives. A hook denial names the `factory.toml` key behind
it: that is policy, not a bug. Never work around a denial of self-modification (settings, hooks, permissions) or of the
hook; show the human the diff or the command and ask.

## Commands

| When | Command |
|---|---|
| every firing | `factory preflight` · `factory dev-status` (review) · `factory disk-guard` |
| worktrees | `factory worktree <name> [--base <ref>]` |
| proofs | `factory proof` · `factory proof-matrix` · `factory proof-verdict <mp4>` · `factory clip-frames` · `factory proof-calibrate <manifest>` |
| a second API | `factory read-api up` / `down` (stops only its own process) |
| bookkeeping | `factory tick` · `factory night-new` · `factory end-night` · `factory stats` |
| upkeep | `factory cleanup [--only <category>] [--apply]` |
| setup | `factory install-skill [--uninstall]` · `factory hook-guard` (PreToolUse) · `factory config get <key>` |
