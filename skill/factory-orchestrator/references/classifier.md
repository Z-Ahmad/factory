# Refusals seen in practice, and what to do instead

Three things can refuse a tool call: Claude Code's auto-mode **classifier**, **session/worktree isolation**, and the
project's **`factory hook-guard`** (a `PreToolUse` hook reading `factory.toml`). None of them is a bug to route around.
Retrying the same thing with different quoting, or through `sed`, `python`, `cp` or a script, is working around a
denial: don't. Use the alternative below, or ask the human.

| Refused | Where it bit | Do instead |
|---|---|---|
| `git reset --hard <ref>`, even when the tree already equals the target | the classifier | `git switch -c <new-branch> <ref>` (a new local branch at the ref), or `git merge --ff-only <ref>` when it's a fast-forward |
| Reverting a worker's uncommitted diff (`git checkout -- .`, `git restore .`) | the classifier | Save it first: `git diff > <state_dir>/night-<n>/<id>.patch` (plus untracked files listed by path). Then `git restore <explicit paths>`, or ask the human. Never leave the item half-reverted |
| A script whose heredoc text mentions `git` | worktree isolation | Write the script to a file in a `mktemp -d` job dir (with the Write tool), then run `bash <file>` |
| Compound commands that reach outside the worktree (`cd <other> && git …`) | worktree isolation | Split into separate calls; stay inside your own worktree; use `git -C <your worktree>` only |
| Git on another worktree (e.g. a device-build checkout) | session isolation | Export the ref instead: `git archive <ref> <paths> \| tar -x -C <mktemp dir>`, link the read-only caches from the main checkout, build from the copy |
| Editing the shared main checkout from a background session | worktree isolation | Work in a worktree (`factory worktree <name>`) and enter it before any subagent starts |
| A worker losing write access mid-task | the orchestrator switched worktrees | Never switch worktrees while a subagent runs; to use another tree, have the worker park its diff as a patch first |
| Editing `.claude/settings.json`, hooks, permission rules, or the agent's own instructions | the classifier (self-modification) | **Never work around it.** Show the human the exact diff and ask them to apply it. Hooks load at session start, so a new hook is live only in new sessions |
| Edits to a `[never_touch]` path; running a `never_run_in_worktree` script from a worktree | hook-guard | Policy. Only the human does these, from the main checkout. If a secret looks blank, report it; never "fix" it |
| `git push` to a `never_push` branch, any force push, `--no-verify` | hook-guard | Push to the night's branch; a rejected non-fast-forward means fetch and merge, never force |
| `gh pr merge` | hook-guard (unless `[loop] allow_merge`) | The human merges |
| Starting the dev stack (`[dev] up`), or killing processes on its ports or by name | hook-guard (`[dev] agents_may_start = false`) | `factory dev-up` (detached, a no-op when up); `factory read-api up|down` for a second server; kill only PIDs you started |
| Foreground `sleep` to wait for something | the harness | `ScheduleWakeup`, or a `Monitor` until-loop |
| Bare `git stash` / `git stash pop` | shared across worktrees (another session's stash) | A patch file in the night's state dir, or a temporary WIP commit on your own branch |

When a refusal is new, add a row here (kit) or a line to the project's rules file (project-specific), with what bit and
the alternative that worked.
