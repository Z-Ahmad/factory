# factory

A kit for running an overnight agent factory on a software project: night files, worktrees, disk and dev-stack upkeep, simulator proof runs. Bash and Node, no dependencies. The kit holds no project state and no project values; each project describes itself in a `factory.toml`.

Status: v0.1. The config reader and the dispatcher are in; the commands migrate in next.

## The `factory.toml` contract

A project commits one `factory.toml` at its root. It is a small TOML subset (tables, `[[arrays of tables]]`, strings, numbers, bools, arrays, inline tables). Sections: `[kit]` (repo and pinned ref), `[project]`, `[git]`, `[[targets]]`, and optional `[worktree]`, `[never_touch]`, `[dev]`, `[seed]`, `[disk]`, `[sim]`, `[proof.*]`, `[tests]`, `[phone]`, `[release.*]`, `[loop]`. Required keys and types are checked by `factory config validate`, and unknown keys are rejected. `{placeholders}` and `~` are expanded when the file is read: `{state_dir}`, `{main_checkout}`, `{dd_root}`, `{dd}` and `{trip}` come from the file itself; `{n}`, `{id}`, `{name}` and the other run-time ones are left for the command that owns them. Commands receive every value as an `FK_*` environment variable (`proof.ios.seconds` becomes `FK_PROOF_IOS_SECONDS`; lists are newline-separated).

```
factory config validate
factory config get sim.shooter_udid
factory config env --sh        # FK_* exports, for bash
factory help
```

`factory` finds `factory.toml` by walking up from the current directory, then in the git common root, so it works from any worktree. `FACTORY_TOML` or `--file` name one explicitly.

## Using it from a project

Commit `factory.toml` and a small shim script. The shim reads `[kit] ref`, clones this repo at that tag into `~/.factory-kit/<ref>` on first use, and runs `bin/factory` from there. Each ref has its own directory, so two branches can pin different versions. To work on the kit itself, point a project at your checkout:

```
FACTORY_KIT_DIR=~/path/to/factory <shim> config validate
```

## Development

```
npm test        # node --test "test/*.test.mjs"; needs Node 22 and git
```

Commands that need Xcode source `lib/darwin.sh` and call `fk_require_darwin`: elsewhere they print `skipped: needs Xcode` and exit 0.

All rights reserved.
