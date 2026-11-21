# Brief templates

Fill every `{slot}`. Values come from the night file (the item), the rules file (`factory config get loop.rules`:
guardrails, gates, test recipe) and `factory.toml` (`factory config get <key>`). A slot you can't fill is a question for
the human or a reason to block the item, never a blank. Keep briefs short: the worker reads the repo's AGENTS.md itself.

## Worker rules (paste into every brief, implementer and shooter alike)

```
Worker rules:
- Work only in {worktree}. Do not commit, push, merge or switch branches; the orchestrator ships.
- Drive a simulator only through `factory proof` / `factory proof-matrix`, with --udid {udid}, and name that UDID on every
  other simulator call too. Never set shared tool defaults. Never touch the human's device.
- Scratch goes in `mktemp -d` and is deleted when you're done: frame strips, profiler traces (they run to GBs), build
  copies. No loose /tmp/<name> folders. Delete any simulator you create.
- Every xcodebuild, test run or proof goes through `factory run --job <build|test|proof> --dd {dd} -- <cmd>` (a weighted lease; it waits inside, never poll).
  The orchestrator runs at most 2 iOS agents at once (builders or provers); never start a third.
- Never start or stop the shared dev stack. If you need your own server, run it on a separate port and kill only the
  processes you started (`factory read-api up|down` when the project has one).
- Never edit the files factory.toml lists under [never_touch], never run its never_run_in_worktree scripts here, and
  never save edits to the test seed (cancel, or restore it after).
- Need something from outside your worktree (an env file, a secret, another checkout's server or build)? Stop and report
  it; never point tools at the main checkout. A blocked permission prompt stalls the night while the human sleeps.
- When you check a command's exit code, use `set -o pipefail` or no pipe: `| tail` hides failures.
- Return at most {words} words: what you did and why, the files, anything you're unsure of. No pasted code.
- Context is the budget: once you pass ~{wrap_context_k}k tokens, or when told to wrap up, finish the current step, save
  your diff to {patch_path} (`git diff` against the base, plus new files) and report. A fresh agent takes it from there.
```

## Implementer

```
You are implementing backlog item {id} for {project}, night {n}. Model: {models.implement}.

Item (verbatim from the night file):
{item_text}

Reference (what the feature does elsewhere, and which approved-look constants carry over, named by file; else "none"):
  {reference_source}
  Read it for behaviour. Copy exactly only the constants named here; design the rest for this platform.

Guardrails (the project's own, from {rules_file}; they bind):
{guardrails_paragraph}

Proof tier: {tier} (M motion, V visual or L logic; the rules file's table says what each owes). Tier L: no simulator, no
proof; unit and UI tests plus the gate. Say in your report if the files you touched suggest a higher tier.

Hard gates (a failing proof blocks the item, whatever the round count; they bind tier M and V proofs):
{hard_gates}

Tests: {tests.unit}. Add tests for logic; geometry as pure functions. If the item says "no test", add none.
The orchestrator runs {tests.gate} at the gate; don't run the full suite every round.

Docs: update the docs the rules file names when you change contracts, routes, stores or DEBUG keys.

{worker_rules}
```

Round 2+ goes by `SendMessage` to the same agent: the findings (frame paths and timestamps, the verdict line), what to
change, what not to touch. Never restate the whole brief. After a few design rounds, or past `loop.wrap_context_k`, ask for
the patch and hand the remaining proofs and re-checks to a fresh shooter started from it (SKILL.md §9).

## Shooter

Started only for tier M and V items. A tier L item has no shooter brief.

```
You are proving backlog item {id} for {project}, night {n}. Model: {models.shoot}. You own simulator {udid}.

Proof tier: {tier}. Prove line (verbatim from the item): {prove_line}
Run (the matrix is the one the project's `factory.toml` maps {tier} to):
  factory proof-matrix --scenario {scenario} --matrix {matrix} --out {shots_dir}/{id}-{label} [--build --dd {dd}] [{flags}]
  and/or factory proof {scenario} --out {shots_dir}/{id}-{label} --udid {udid} [{flags}]
Which matrix: the rules file's table. A FAIL (exit 4) is a result, not an error: report it, don't rerun until it passes.
Run every build or proof as factory run --job <build|proof> --dd {dd} --sim {udid} -- <cmd> (it queues while too much else runs; report its lines).
A hold FAIL with a high load in verdict.json: factory proof-compare --scenario {scenario} --base {base_ref} --udid {udid}
  --out {shots_dir}/{id}-compare, and report its COMPARE line. iPad and landscape items: add --orientation landscape, or use
  a matrix whose cells set orientation.

Interactive checks only when no scenario can express the check: name the simulator on every call, prove one known-good tap
lands before trusting any tap, and fall back to a scenario if it doesn't.

Report (paths first, then at most {words} words): the VERDICT / MATRIX line, matrix.md, flags.png, contact sheets,
anything that looked wrong to you. Don't describe frames as clean; the orchestrator looks.

{worker_rules}
```

## Ideation (IDEATE / TASTE items, before any build)

```
You are ideating backlog item {id} for {project}, night {n}. Model: {models.ideate}. Work in {worktree}; commit nothing.

Item (verbatim): {item_text}
What the human has said about it so far: {quotes_from_log}
Reference / taste bar: {reference} (an approved clip, a reference source file, or "none")

Produce 2–3 genuinely different options, not three tunings of one. For each:
- one sentence on the idea and one on its cost/risk;
- a throwaway DEBUG variant (behind a launch flag or scenario option) shot with the SAME scenario and cell as the others,
  so frames compare side by side: factory proof {scenario} --out {shots_dir}/{id}-opt-<x> --udid {udid} [{flags}];
- the frames that show the difference (grab them with `factory clip-frames`, never ffmpeg -ss).
Then a recommendation and why, in one paragraph.

Write it to {state_dir}/night-{n}/{id}-ideation.md (options, frame paths, recommendation). Revert the DEBUG variants or
leave them clearly marked for the implementer. Return at most {words} words.

{worker_rules}
```

## Slots

| Slot | From |
|---|---|
| `{id}`, `{item_text}`, `{prove_line}` | the night file's Backlog line |
| `{project}`, `{n}`, `{state_dir}`, `{shots_dir}` | `project.name`, the night, `project.state_dir`, `project.shots_dir` |
| `{worktree}` | the path `factory worktree` printed |
| `{udid}` | `sim.shooter_udid`, or the ephemeral sim you created for a parallel agent |
| `{words}` | `loop.implementer_words` / `loop.shooter_words` (ideation: the implementer limit) |
| `{guardrails_paragraph}`, `{hard_gates}`, `{rules_file}` | the rules file (`loop.rules`) |
| `{tests.unit}`, `{tests.gate}` | `factory config get tests` |
| `{tier}` | the item and the files it touches, via the rules file's tier table (M, V or L); review can raise it, never lower it |
| `{matrix}`, `{scenario}`, `{flags}`, `{dd}` | the matrix `{tier}` maps to (the rules file's table); the item; `proof.ios.dd` |
| `{base_ref}` | the item's base: the night branch's merge base, or the commit before the patch |
| `{wrap_context_k}`, `{patch_path}` | `loop.wrap_context_k` (default 400); `<state_dir>/night-<n>/<id>.patch` |
| `{reference_source}` | the item, plus the rules file's rule on what carries over between platforms (an exact port only for a look the human approved) |
