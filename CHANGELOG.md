# Changelog

Releases are git tags (`vX.Y.Z`); a project pins one with `[kit] ref` in its `factory.toml`. Releases before v0.12.0 are described in their tag messages and commits.

## v0.28.1

### `factory stack status` stops showing old news

Run against a real repo, `status` drew trees and printed WARN lines for PRs closed months ago on purpose. It now shows
only stacks with an open PR, or a PR merged or closed within `[stack] recent_days` (new, default 7, min 0). It warns only
for an open PR whose base branch is gone or merged, and for a PR closed within the window whose base is gone (GitHub
just closed it). `factory stack status --all` shows everything, as before. `land`, `new` and `bases` are unchanged.

## v0.28.0

### Stacked PRs the kit keeps safe

A stack of PRs went wrong four ways on the Seaglass repo (Nov 23 2026). After the parent squash-merged, the child showed
conflicts in every file the parent touched (GitHub does not rebase the rest of a stack). Deleting the merged parent's
branch while a child still targeted it made GitHub close the child. `gh stack link 683 684 686` chained siblings in
series. And the daily housekeeping could delete a stack's base overnight. The kit now makes these safe, instead of an
agent's memory.

- **`factory stack new <parent-pr|branch>`**: cuts a worktree and branch for the child from the parent's head (through
  `factory worktree`) and records the link in `<state_dir>/stacks.json`. Refuses past `[stack] max_depth` (default 3).
  Prints the `gh pr create --base <parent-branch>` line. Never calls `gh stack`.
- **`factory stack land <merged-pr>`**: after the owner merges, retargets each open child onto `[stack] target`, merges
  the target in (in the child's worktree, or one made for it), settles a conflicted file with the child's side only
  when `git diff --quiet <parent-head> origin/<target> -- <file>` shows the target holds the parent's final version
  (else exit 3, merge left in progress, files listed), commits through the repo's hooks, pushes plainly, and deletes
  the merged branch only after every child is through. `--dry-run`. Run it again after a failure.
- **`factory stack status`**: each stack as a tree (number, title, state, base, mergeable, whether the base exists),
  with warnings for a merged base that was not landed and for a gone base ("will be closed by GitHub" / "closed").
- **No base branch is deleted while an open PR targets it.** hook-guard rule 9 denies `git push <remote> --delete
  <branch>`, `-d` and `:<branch>` then (fails open, with a stderr warning, when `gh` cannot answer). `factory cleanup`
  and the janitor housekeeping keep the worktree and branch of such a base and log `kept: base of #N`.
- **`factory restack`** stays, as the after-the-fact sweep, but no longer skips a PR linked with `gh stack`: GitHub does
  not restack those after a squash merge. The README says so.
- **Config**: `[stack] target` (default `"main"`) and `max_depth` (default 3), in `config validate` and the README. An
  `int` key can now carry a `min` in the schema (`max_depth` needs at least 1).

## v0.27.0

### One dev stack that follows main and can be switched to a PR

The dev-stack worktree (`[dev] cwd`) was never moved forward, so it served old code (20 commits behind main on the
Seaglass Mac), and agents could only run main on it: they may start a stack only through `factory dev up`.

- **`factory dev switch <ref>`**: `<ref>` is a PR number (`123`, `#123`), a branch or `main`. It fetches, resolves the
  ref (a PR's head through `gh pr view`, a branch as `origin/<branch>`), refuses with exit 5 when the worktree has
  uncommitted tracked changes (untracked build output is fine), records `<state_dir>/dev.ref` (`ref=`, `sha=`,
  `time=`), then restarts: the worktree moves to the commit, detached, `[dev] prep` runs and the stack starts.
  `--dry-run`, `--no-seed`. Exit 9 when the ref does not resolve. hook-guard rule 6 holds it to `restart_by`, like
  `restart`: the main session only, unless `[dev] restart_by = "anyone"`.
- **`dev up` and `dev restart` fetch first.** A stack following main (nothing recorded, or `switch main`) is
  fast-forwarded to `origin/main` and prepped before it starts. A switched stack stays on its PR or branch and moves to
  its latest pushed commit. One line says which ref it is on. A stack that is already up is not moved under itself;
  `up` reports how far behind it is. A dirty worktree or an unresolvable ref only warns on `up`/`restart`; a failing
  prep exits 8.
- **`dev status`** first prints the ref, its short sha and subject, and how far behind `origin/main` it is; following
  main and behind, it says so and names `factory dev restart`.
- **Config**: `[dev] prep` (a command run in the worktree after it moves; unset means none) and `[dev] follow`
  (default `"main"`). Both are in `config validate` and the README. `FK_DEV_NET_TIMEOUT_S` (60) and
  `FK_DEV_PREP_TIMEOUT_S` (900) bound every fetch, `gh` call and prep run; `lib/deadline.mjs` does it.

## v0.26.0

### The janitor does the daily housekeeping too

Finished agent worktrees, stale build folders and old scratch only went when someone ran `factory cleanup --apply`,
so they piled up (12 merged worktrees and 20.6 GB of builds on the Seaglass Mac). About once a day, a janitor pass that
can read the project (the session-end pass, or one run by hand; never the launchd one, which macOS keeps out of
~/Documents) runs `factory cleanup --only worktrees --only derived-data --only tmp`, with `--apply` when the pass
applies. Cleanup's own rules decide what is safe: a worktree with unpushed or modified work, a locked one, or one git
touched in the last minutes stays. Its REMOVE lines and totals go to the janitor log. A failed cleanup is logged and
tried again next pass.

A pass run from a kit in a protected folder (a local checkout in ~/Documents) no longer repoints the launchd agent at
itself; `FK_JANITOR_PROTECTED_DIRS` overrides that list for tests.

## v0.25.1

### The janitor's scheduled pass runs where launchd may read

macOS keeps launchd agents out of `~/Documents`, `~/Desktop` and `~/Downloads`, where projects usually live, so the
installed pass failed with "Operation not permitted" before it started. The agent now runs the kit's own `bin/factory`
(in `~/.factory-kit`) against a copy of `factory.toml` kept at `<state_dir>/janitor/factory.toml`, from that folder.
Every pass run by hand or by a hook refreshes the copy, and re-installs the agent when the kit version or the copy's
path changed, keeping its interval. `install` warns when the kit or the state dir is in one of those folders.

## v0.25.0

### Cleanup that no agent has to remember

A Mac ran out of memory: simulators booted by `xcodebuild test` stayed booted, orphaned `xcodebuild` and `xctest`
processes from runs started outside `factory run` lived on, and nothing reacted to memory filling. Three changes, each
built to leave live factory work alone.

**`factory run` shuts down the simulators its job booted.** Right after a job is admitted its lease records which
simulators are booted. When the job ends, by exit, failure, time limit, signal or the owner dying, `factory run` shuts
down each simulator that is booted now, was not booted then, and that no other live lease may own: not another lease's
`--sim`, and not one that lease's job may have booted (a simulator absent from that lease's recorded list, so two jobs
that overlap leave a simulator neither list holds for the janitor). It prints each one. Weight 0 jobs and nested runs do
nothing, and so does a Mac without `xcrun`. `[slot] shutdown_booted = false` turns it off.

**`factory janitor`: a safe periodic sweep.** `janitor run` frees dead leases, stops orphaned build and recording
processes, shuts down idle simulators, and, when memory pressure is critical or swap is at least `[janitor] swap_pct`
(80) full, shuts down every simulator no live lease may own. A process is stopped only if it is a named tool
(`xcodebuild`, `xctest`, `simctl io … recordVideo`, `simctl spawn`, or a `[janitor] tools` entry), its parent is
pid 1 (or every ancestor up to that is a named tool), it is older than `[janitor] orphan_minutes` (10), no live lease
owns it, and it is not Xcode, Simulator or anything under them. Without `--apply` it only logs; every action or
would-be action is a line in `<state_dir>/janitor/janitor.log` (rotated at 1 MB). `janitor install` writes a launchd user
agent (every 300 s, never at load) that runs `janitor run --scheduled`; it starts **disabled**, so it only logs until you
read a few passes and run `janitor enable`. `status`, `disable` and `uninstall` do what they say. Nothing is installed by
upgrading. See the README for the exact rules.

**hook-guard denies a background wait with no deadline.** A Bash call with `run_in_background: true` whose command
holds an `until` or `while` loop and names no deadline (`timeout`, `gtimeout`, `perl -e 'alarm …'`, `$SECONDS`,
`date +%s`) is denied, with the line to add. A `for` loop and a foreground loop pass. `[hook] background_wait_deadline =
false` turns it off.

To use it: `scripts/factory janitor install`, read `janitor.log` for a day, then `scripts/factory janitor enable`.

## v0.24.0

### A proof stops at its time limit too

A proof never ran inside a `factory run` job (it only waits for room), so v0.23's limits never reached it. Each proof
now has its own: once it has room and any `--build` is done, it gets `[slot.run_limits] proof` minutes (default 5;
`0` = none). Past that, everything it started is stopped, its usual cleanup runs (a sim it booted is shut down) and it
exits 124. In a matrix the limit is per cell. `factory run --job proof` defaults to 5 minutes as well.

## v0.23.0

### `factory run` stops a job that runs past its time limit

A hung `xcodebuild test` held its lease for five hours: nothing in the chain had a time limit. Once admitted, a job
now runs for at most its type's minutes: test 30, build 45, device 45, release 60, archive 60 (other types none).
Past that, `factory run` stops the whole process group, frees the lease, says which limit it hit, and exits 124.
Change the numbers with `[slot.run_limits]` (job type -> minutes, 0 = none), or per run with `--limit <min>`.

## v0.22.1

### `factory run` no longer waits on the load average

The 1-minute load stays high for about a minute after a job ends, so `factory run` held a build for two minutes on a
Mac that was close to idle. Capacity, memory pressure, swap-outs and free memory are the gates; the load is still shown.
Proofs still wait for the load to settle under `[slot] max_load` before they record, and still mark a clip
load-unreliable above it.

## v0.22.0

### The night-file loop is gone; cleanup knows today's agent worktrees

About 2,000 lines served the old night-file loop and had no use since Nov 5. Cleanup never removed today's agent
worktrees, because it only knew `factory/lane-*` branches, so 37 worktrees and 18 GB piled up.

**Removed** (with their tests, README sections and config keys):

- `tick`, `night-new`, `night-lint`, `end-night`, `stats` (and `stats/`), `proof-calibrate` (and `proof/verdict/calibrate.mjs`),
  `wip-save`, `disk-guard`, and the night-file template. `test/end-night.test.mjs`, which hung, is gone with its command.
- Config keys: `[project] night_file`, `item_line`, `log_line`; `[loop] item_ids`; `[git] phone_worktree`;
  `[sim] erase_above_gb`, `erase_at_end_night`; the `[stats]` and `[wip]` tables. A `factory.toml` that still sets one fails
  `config validate` as an unknown key: delete the line.

**Merged** (the old names still run and print one deprecation line on stderr):

- `dev-up`, `dev-status`, `dev-restart`, `read-api` -> `factory dev up|status|restart|read-api`. hook-guard's
  restart-is-the-orchestrator's rule covers both spellings.
- `preflight` -> `factory doctor`. Its disk step is `cleanup --apply --if-below <min_gb> --floor <floor_gb>` (step name
  `disk`, exit 2), and it now also flags a `[dev] cwd` worktree whose branch is gone on origin or that is behind the
  default target, and fails with exit 7 (`dev-tools`) when the stack is down and the dev command needs a tool
  `node_modules/.bin` and PATH lack (`npm run <script>` is followed into package.json). The line starts `factory-doctor:`.
- `proof-matrix` -> `factory proof --cells <matrix>`. A `--cells` value that names no `[proof.matrix.*]` is still the old
  `--cells a,b` list.

**cleanup, rewritten worktree category:**

- Removes a worktree anywhere on disk on a `[git] agent_branches` glob (now a string or a list, e.g.
  `["factory/lane-*", "claude/*", "cyrus/*"]`) once its PR merged (`gh pr list --state merged --head <branch>`, and the
  worktree holds no commit newer than the PR's head), or its branch is contained in a `[[targets]]` base, or (as before)
  its commits are patch-equivalent on an `origin/<push_branch prefix>*` branch. The old `agent_worktrees` name glob still counts.
- Never removes a locked worktree, a dirty one (untracked symlinks aside), a protected one, one git touched in the last
  2 hours, the main checkout, the worktree it runs from, or the `[dev] cwd` worktree. Unpushed commits whose newest is over
  7 days old print `FLAG ... not removed`.
- Build caches named after a removed lane go with it (every `agent_branches` glob's literal prefix counts).
- `--if-below <GB> [--floor <GB>]`: sweep only when free disk is under that (the [disk] `low_cleanup` categories, now
  including `worktrees`, with `--frames-age 0`); with `--apply` and `--floor`, exit 2 when still under. A dry run stays the default.

**New: `factory restack`.** For each open PR whose base branch was merged or deleted: `gh pr edit --base <target>`, merge
`origin/<target>` into its head in a temporary worktree, show the diff stat, push with a plain `git push` (never forced).
A PR in a GitHub stack is skipped. Dry run by default; `--apply` acts.

The orchestrator skill drops the night-file loop and names `dev`, `doctor`, `cleanup` and `restack`.

### `factory run`: weighted leases for heavy jobs

The builder slot counted what was running and let each caller poll `slot wait`; nothing stopped four agents passing the
check in the same second, and a job's leftovers (a recording, a test runner) outlived it. `factory run` replaces it.

- **`factory run --job <type> [--dd] [--sim] [--owner] [--owner-pid] [--timeout] -- <cmd…>`** takes a weighted
  reservation out of `[slot] capacity` (default 4): build, test, release, device and archive weigh 2; proof, vite,
  playwright, rules and install 1; unit and tsc 0 (no lease). Leases live in `<state_dir>/slot/leases.json` under
  `/usr/bin/lockf`. The job queues first come, first served and waits inside the command, prints the minutes it waited,
  runs in its own process group, and stops that group and frees the lease on exit, on SIGINT/SIGTERM/SIGHUP, or when
  `--owner-pid` dies. Exit 75 when the wait passes `--timeout` / `[slot] timeout_s`.
- **Gates** for every admission: memory pressure normal (`kern.memorystatus_vm_pressure_level` = 1), fewer than
  `[slot] max_swapouts_per_min` (default 1000) `vm_stat` swap-outs over the last minute, free memory at least
  `[slot] min_free_pct` (default 15), and the 1-minute load at most `[slot] max_load`. Swap in use is never a gate.
- **Reaper** (`factory run --reap`, and at every admission): frees leases whose runner is gone and kills the process
  group they left (only when it holds nothing older than the lease), and kills orphaned `simctl io … recordVideo`
  processes and kit test runs older than `[slot] orphan_minutes` (default 60). It prints what it kills.
- **`factory run --status`** (leases, queue, gate readings), `--check --job <t>` and `--wait --job <t>`.
- **hook-guard** now denies a raw `xcodebuild` (also via `xcrun`), `build.sh`, `test.sh`, or an npm script listed in the
  new `[hook] build_scripts` (globs, default none) outside `factory run`, naming the wrapped command to use. A script not
  on the list, such as a read-only status report, passes; before, every `ios:test*` script was gated without asking.
  Projects list their build scripts, e.g. `build_scripts = ["ios:test*", "ios:native", "ios:testflight*"]`. Inside
  `factory run` a build passes unless the job weighs 0, and the wrapped command is still checked by the other rules. The
  XcodeBuildMCP build and test tools are denied while `factory run --check --job build` says a build would wait.
- Proofs wait with `factory run --wait` (and skip it inside a lease, through `FK_SLOT_HELD`).

### Removed and deprecated

- `factory slot status` and `slot wait` are deprecated aliases of `run --status` and `run --wait --job build`, each
  printing a deprecation line; `--dd`, `--udid` and `--ignore-leftovers` are accepted and ignored.
- `[slot] max_booted_sims` is removed and `[slot] builders` is no longer read (`capacity` replaced both).
- `[slot] max_swap_gb` is removed: macOS keeps pages in swap long after the pressure that wrote them ends, so it held
  builds on an idle Mac (9.9 GB in use while `memory_pressure` showed 50-66% free). `min_free_pct` now defaults to 15
  (`0` turns it off). A `factory.toml` that still sets a removed key fails validation with a message naming the
  replacement; delete the line.

### Config

- New keys: `[slot] capacity`, `[slot.weights]` (job type -> int), `max_swapouts_per_min`, `orphan_minutes`; `poll_s`
  now defaults to 5.
- New `[hook] build_scripts` (string globs).
- New optional `[proof.tier]` table (tier name -> matrix name, strings), which `config validate` accepts.

## v0.21.0 (2026-11-18)

### A still page is not a flash or a hold

simctl writes a frame only when the screen changes, so a scenario that cuts to a page, holds it still for 2.5 s and cuts
back recorded that page as two frames and failed twice: as a 2-frame flash (A -> B -> A counts frames, not time) and as
a 2.5 s hold (the cuts read as motion on both sides of the gap). A real scenario (a review list -> a trip's detail ->
back) failed every cell of its matrix this way while its grow-in was clean frame by frame.

- **Flash:** a burst whose B stayed on screen longer than `--flash-dwell` ms (default 250; `[proof.ios.verdict]
  flash_dwell_ms`) is a cut and a cut back. It is listed in `verdict.json` as `flash.returns` (with its `dwellMs`) and
  on the VERDICT line as "n cut-and-back", and is not judged. A blink of a frame or three still fails as before.
- **Hold:** with app ground truth (`--steps`, aligned by SYNC markers), a gap the app never felt is a still screen: its
  ground-truth lines span the gap and no HITCH within 1.5 s covers half of it (`stillInApp` in `ground-truth.mjs`; the
  wide window is because one early SYNC anchor drifts over half a second from the video ten seconds on). Listed as
  `hold.stills` and "n still screen", not judged. Without ground truth, holds are judged from pixels as before.
- The 6-clip ground-truth corpus gives the same verdicts as v0.20.3, including its injected 150 ms hold (its own 203 ms
  HITCH keeps it a FAIL).

## v0.20.3 (2026-11-06)

### Projects on Windows, and projects with no dev stack

- `factory preflight` skips the dev-stack step when `[dev]` sets neither `up` nor `wait_ports` (a game or a CLI has no
  dev server): its line says "dev skipped (no [dev])", as it already did for `[seed]`. It used to fail at dev-up with
  "[dev] wait_ports is not set". `dev-status` then says there is no dev stack and exits 0.
- `hook-guard` compares paths with forward slashes and case-insensitively, reads Git Bash's `/c/x` as `C:\x`, and lets
  a `never_touch` glob name an absolute path outside the repository (a game install, a save folder). On Windows the
  globs never matched before.
- `night-lint` and `night-new` read night files saved with CRLF line endings (they found no sections before), and
  `tick` writes a PR body's sha before a line's CR, not after it.

## v0.20.2 (2026-10-29)

### dev-restart stops what never listened

- `dev-restart` used to KILL only what still listened after `[dev] stop_s`. A process in the stack's group that never opened a port and ignored TERM survived the restart, orphaned. One was a ts-node-dev child stuck in its synchronous wait for a compile that its stopped parent would never finish: its TERM handler is JavaScript and the loop never yields. It spun a core for 37 hours. Once the grace runs out, `dev-restart` now KILLs whatever is left in the groups it stopped.

## v0.20.1 (2026-10-28)

### Merge protection is scoped to the project's repository

- With `[git] github` set, `[loop] never_merge_into` now guards only that repository's PRs, the same way `never_push` already guarded only its remote. The PR's repository comes from `-R`/`--repo`, a PR URL, or the remotes of the directory the command runs in (after any `cd`). Unknown, or a checkout with any remote naming the project or a non-GitHub host, stays guarded. Before this, merging the kit's own PR into the kit's `main` was denied as if it were the project's `main`.

### A cold boot no longer spoils the proof

- After a cold boot, and after `--build` ran a build, `factory proof` waits until the 1-minute load is back under `[slot] max_load`, at most the new `[slot] boot_settle_s` (default 120). A cold-booted simulator then gets one unrecorded launch, before `[proof.ios] before` and the counted recording. Before this, a cold iPad boot pushed the load to 50–73 against a gate of 16, every such proof came out load-unreliable, and agents worked around it with `--keep-booted` and a discarded first run.
- If the load is still over the gate when the wait runs out, the run says `settle: timed out`, records anyway and is marked load-unreliable, as before. `verdict.json`'s `load.settle` records `waited_s` and `timed_out`.
- `--orientation` turns the simulator after the settle, because a cold-booted 13" iPad comes up in portrait.
- `proof-matrix` uses the same settle (`fk_proof_settle` in `proof/ios/common.sh`) for fresh cells (replacing the fixed 90 s), after a cold-booted shooter (now also installed and launched once, unrecorded) and after its build.

## v0.20.0 (2026-10-28)

### Resource rules as code: the slot gate everywhere, memory, idle simulators

- **Slot gate everywhere.** `factory proof` waits for a builder slot before its build and before it boots the simulator; `proof-matrix` before its build and before each cell (its cells then skip their own wait: `FK_SLOT_HELD=1`). `--no-slot` skips the gate.
- **hook-guard rule 7**: with `[slot]` or `[proof.ios]` set, a build or test (Bash `xcodebuild` with a building action, a `build.sh` / `test.sh`, an `npm run ios:test*`; the XcodeBuildMCP `build_*` / `test_*` tools) is denied while `factory slot status` says busy. The denial says what holds the slot and names the `[slot]` key. A simulator named in the call (`id=<UDID>`, `--udid`) is the caller's; with none, leftover simulators aren't counted. A slot that can't be read allows the call.
- **Memory and simulator limits**: `[slot] max_swap_gb`, `min_free_pct` (memory_pressure's free percentage, `kern.memorystatus_level`) and `max_booted_sims`. Every limit that holds a slot names its key in the reason.
- **Realistic load gate**: `[slot] max_load` defaults to 2 × the CPU count (it had no default), and `config validate` warns above 4 ×, where it never trips. The `unreliable` load flag in `verdict.json` and the matrix's post-boot load settle use the same default.
- **`[sim] protected` simulators count as slot leftovers** now: protection keeps a simulator from deletion, not from loading the Mac. A proof's own run no longer hides a leftover.
- **`factory sims idle [--shutdown]`**: lists, and shuts down (never erases or deletes), every booted simulator nothing uses: no running process names its UDID (`factory proof`, xcodebuild, recordVideo, XcodeBuildMCP's log capture and taps, an agent's command) and no app launch or boot within `[sim] idle_minutes` (default 30). `[sim] keep_booted` globs are never shut down. With `[sim] idle_minutes` set, `tick`, `preflight` and `end-night --apply` run it. The reader is `lib/sims.mjs`.
- **Proofs shut down what they boot**: `factory proof` shuts down a simulator it booted when it ends (`--keep-booted` keeps it); `proof-matrix` boots the shooter only when a shooter cell runs and shuts it down again; `proof-compare` keeps it booted between rounds and shuts it down at the end.
- **`proof-matrix --cells a,b`** runs only those cells; **`--rerun-failed <previous out>`** keeps every cell whose verdict there is PASS (copied in, `kept` in matrix.md) and runs the rest.
- **No-op builds are skipped**: `--build` skips the build when the app's stamp is this checkout's, from HEAD (or from a commit with no change under `[proof.ios] sources`), made by the same build command, with nothing uncommitted under the sources (`app-fresh.mjs --up-to-date`; the stamp now records the build command). `--rebuild` builds anyway.
- **`[proof.ios] before`**: a command (e.g. the seed restore) run from the project root before a proof installs and launches the app; once per matrix.
- **Fresh matrix cells skip the turn back to portrait** (`factory proof --no-turn-back`): the simulator is deleted right after.
- **cleanup never deletes a simulator in use** (a running proof, xcodebuild or recordVideo names it, or it booted or launched an app within `[sim] idle_minutes`), so a low-disk `disk-guard` can't delete one mid-proof.
- **cleanup removes `compare-*` worktrees whose `dd-compare-*` build is gone** (or goes in the same run) and that have no changes, so proof-compare's base checkouts stay in step with their builds.
- **`tick` prints a `WRAP:` line** for each live agent (transcript written in the last 10 minutes) whose context is past `[loop] wrap_context_k`, read from the `[stats] transcripts` (`stats/context.mjs`).

## v0.19.0 (2026-10-27)

### Hung services, and push protection scoped to the project

- `[dev] probe = "http"`: `dev-status` and `dev-up` also send each port an HTTP request (`FK_PROBE_TIMEOUT_S`, default 5 s). A port that accepts connections but never answers is reported `hung`. `dev-status` exits 1, `dev-up` exits 6 naming `factory dev-restart`, and `preflight` passes the 6 on. The default `tcp` keeps the old behaviour for stacks whose ports aren't HTTP.
- hook-guard: with `[git] github` set, `never_push` guards only pushes whose remote is that repository (by the remote's URL; an unknown remote stays guarded). Pushing the kit's own `main` from a project session is no longer blocked.
- hook-guard: a `gh pr merge` whose base can't be looked up now says why when the PR was created in the same command (it doesn't exist yet when the hook runs).

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
