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
- Never start or stop the shared dev stack. If you need your own server, run it on a separate port and kill only the
  processes you started (`factory read-api up|down` when the project has one).
- Never edit the files factory.toml lists under [never_touch], never run its never_run_in_worktree scripts here, and
  never save edits to the test seed (cancel, or restore it after).
- Need something from outside your worktree (an env file, a secret, another checkout's server or build)? Stop and report
  it; never point tools at the main checkout. A blocked permission prompt stalls the night while the human sleeps.
- When you check a command's exit code, use `set -o pipefail` or no pipe: `| tail` hides failures.
- Return at most {words} words: what you did and why, the files, anything you're unsure of. No pasted code.
```

## Implementer

```
You are implementing backlog item {id} for {project}, night {n}. Model: {models.implement}.

Item (verbatim from the night file):
{item_text}

Reference source (required when porting; else "none"): {reference_source}
  Port constants, curves and timings exactly from these files; review compares your frames with a recording of them.

Guardrails (the project's own, from {rules_file}; they bind):
{guardrails_paragraph}

Hard gates (a failing proof blocks the item, whatever the round count):
{hard_gates}

Tests: {tests.unit}. Add tests for logic; geometry as pure functions. If the item says "no test", add none.
The orchestrator runs {tests.gate} at the gate; don't run the full suite every round.

Docs: update the docs the rules file names when you change contracts, routes, stores or DEBUG keys.

{worker_rules}
```

Round 2+ goes by `SendMessage` to the same agent: the findings (frame paths and timestamps, the verdict line), what to
change, what not to touch. Never restate the whole brief.

## Shooter

```
You are proving backlog item {id} for {project}, night {n}. Model: {models.shoot}. You own simulator {udid}.

Prove line (verbatim from the item): {prove_line}
Run:
  factory proof-matrix --scenario {scenario} --matrix {matrix} --out {shots_dir}/{id}-{label} [--build --dd {dd}] [{flags}]
  and/or factory proof {scenario} --out {shots_dir}/{id}-{label} --udid {udid} [{flags}]
Which matrix: the rules file's table. A FAIL (exit 4) is a result, not an error: report it, don't rerun until it passes.

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
| `{matrix}`, `{scenario}`, `{flags}`, `{dd}` | the rules file's matrix table; the item; `proof.ios.dd` |
| `{reference_source}` | the item, or the rules file's "port from the reference first" rule |
