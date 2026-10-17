#!/usr/bin/env node
// usage: node nm-missing.mjs <worktree>
// Lists the packages this worktree's package-lock.json installs that its node_modules overlay lacks: packages only
// this branch depends on, which the main checkout (another branch) never installed. One line each, parents first:
//   <path in the worktree>\t<name>\t<version>
// A nested entry (node_modules/a/node_modules/b) is listed only under a package that is itself listed, so its
// directory will be a real one in this worktree; nothing is ever written through a link into the main checkout.
// Workspace links and packages for another os/cpu are skipped. Prints nothing when there is no lockfile.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const wt = process.argv[2];
if (!wt) { console.error('usage: nm-missing.mjs <worktree>'); process.exit(1); }
const lockPath = join(wt, 'package-lock.json');
if (!existsSync(lockPath)) process.exit(0);
const packages = JSON.parse(readFileSync(lockPath, 'utf8')).packages ?? {};

const fits = (list, value) => !Array.isArray(list) || list.length === 0
  || (list.some((v) => !v.startsWith('!')) ? list.includes(value) : !list.includes(`!${value}`));
const present = (p) => { try { lstatSync(join(wt, p)); return true; } catch { return false; } };
// "node_modules/a/node_modules/@s/b" -> ["node_modules/a", "node_modules/a/node_modules/@s/b"]
const chain = (key) => {
  const parts = key.split('/node_modules/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/node_modules/'));
};

const missing = new Set();
const keys = Object.keys(packages).filter((k) => k.startsWith('node_modules/'))
  .sort((a, b) => chain(a).length - chain(b).length || a.localeCompare(b));
for (const key of keys) {
  const p = packages[key];
  if (p.link || !p.version || !fits(p.os, process.platform) || !fits(p.cpu, process.arch)) continue;
  if (present(key)) continue;
  const ancestors = chain(key).slice(0, -1);
  if (ancestors.some((a) => !missing.has(a))) continue; // under a package we don't own here: leave it
  missing.add(key);
  const name = p.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  console.log(`${key}\t${name}\t${p.version}`);
}
