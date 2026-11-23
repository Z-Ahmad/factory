#!/usr/bin/env node
// usage: node deadline.mjs <seconds> <command> [args...]
// Runs the command with its output passed through and kills it when the deadline passes.
// Exits with the command's status, 128 + n when a signal ended it, 124 when the deadline did.
import { spawnSync } from 'node:child_process';

const [secs, cmd, ...args] = process.argv.slice(2);
if (!(Number(secs) > 0) || !cmd) {
  console.error('usage: deadline.mjs <seconds> <command> [args...]');
  process.exit(2);
}
const r = spawnSync(cmd, args, { stdio: 'inherit', timeout: Number(secs) * 1000, killSignal: 'SIGKILL' });
if (r.error?.code === 'ETIMEDOUT') process.exit(124);
if (r.error) {
  console.error(`deadline: ${r.error.message}`);
  process.exit(127);
}
process.exit(r.status ?? 128 + 9);
