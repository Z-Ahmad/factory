#!/usr/bin/env node
// desc: Claude Code PreToolUse hook: deny never-touch edits, banned git/gh/dev-stack commands (reads JSON on stdin)
// usage: factory hook-guard < payload.json     (wired in .claude/settings.json; see gates/hook-guard.mjs for the rules)
import { main } from '../gates/hook-guard.mjs';

main();
