#!/usr/bin/env node
// Which build is a proof about to install, and is it older than the source?
//   node app-fresh.mjs --app <.app> --dd <derived data> --root <project root> [--built]
// --built (right after a `--build`): records HEAD, whether the tree had changes, and the time in <dd>/factory-build.json.
// Always prints one line for the report: "app: <path> built <time> from <sha>[+dirty]" (sha "unknown" when no stamp).
// Without --built, the app is STALE when the source changed after it was built: a commit or an uncommitted file under
// [proof.ios] sources (git pathspecs; default the whole tree) is newer than the app's files, or the stamp's commit differs
// from HEAD in those paths. A stale app prints a WARNING on stderr; with [proof.ios] stale_app = "refuse" it exits 3.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const app = opt('--app'), dd = opt('--dd'), root = opt('--root');
const built = args.includes('--built');
if (!app || !dd || !root) { console.error('usage: app-fresh.mjs --app <.app> --dd <dir> --root <dir> [--built]'); process.exit(1); }

const specs = (process.env.FK_PROOF_IOS_SOURCES || '').split('\n').filter(Boolean);
// A big untracked tree (derived data inside the checkout) prints megabytes: the buffer is large, and a failure is
// reported as unknown, never read as "no changes".
const git = (...a) => { try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }); } catch { return null; } };
const stampFile = join(dd, 'factory-build.json');
const when = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
// uncommitted files (changed, added, untracked) under the source paths, never counting the derived data itself when it
// sits inside the checkout; null when git could not say
const ddRel = relative(resolve(root), resolve(dd));
const ddExclude = ddRel && !ddRel.startsWith('..') && !ddRel.startsWith('/') ? [`:(top,exclude)${ddRel}`] : [];
const dirtyFiles = () => {
  const out = git('status', '--porcelain', '-z', '--untracked-files=all', '--', ...(specs.length ? specs : ['.']), ...ddExclude);
  return out === null ? null : out.split('\0').filter((e) => e.length > 3).map((e) => e.slice(3));
};
const unknown = () => console.error(`WARNING: could not read \`git status\` in ${root}; uncommitted changes were not checked.`);

if (built) {
  const sha = git('rev-parse', '--short=10', 'HEAD')?.trim() || 'unknown';
  const files = dirtyFiles();
  if (files === null) unknown();
  writeFileSync(stampFile, `${JSON.stringify({ sha, dirty: files === null ? null : files.length > 0, at: new Date().toISOString() })}\n`);
}

// the app's own files (the binary and Info.plist are rewritten by every build that changes them)
let appMs = 0;
for (const f of readdirSync(app)) {
  try { const s = statSync(join(app, f)); if (s.isFile()) appMs = Math.max(appMs, s.mtimeMs); } catch { /* gone */ }
}
if (!appMs) appMs = statSync(app).mtimeMs;
let stamp = null;
try { stamp = JSON.parse(readFileSync(stampFile, 'utf8')); } catch { /* none */ }
const from = stamp ? `${stamp.sha}${stamp.dirty ? '+dirty' : stamp.dirty === null ? ' (dirty unknown)' : ''}` : 'unknown (built outside --build)';
console.log(`app: ${app} built ${when(appMs)} from ${from}`);
if (built) process.exit(0);

const why = [];
const commitS = Number(git('log', '-1', '--format=%ct', 'HEAD', '--', ...specs)?.trim() || 0);
if (commitS * 1000 > appMs + 1000) why.push(`commit ${git('log', '-1', '--format=%h', 'HEAD', '--', ...specs)?.trim()} at ${when(commitS * 1000)}`);
let newest = null;
const files = dirtyFiles();
if (files === null) unknown();
for (const f of files ?? []) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  const m = statSync(p).mtimeMs;
  if (m > appMs + 1000 && (!newest || m > newest.m)) newest = { f, m };
}
if (newest) why.push(`uncommitted ${newest.f} at ${when(newest.m)}`);
if (stamp && git('cat-file', '-e', `${stamp.sha}^{commit}`) !== null && git('diff', '--quiet', stamp.sha, 'HEAD', '--', ...specs) === null) {
  const head = git('rev-parse', '--short=10', 'HEAD')?.trim();
  if (head && head !== stamp.sha) why.push(`built from ${stamp.sha}, HEAD is ${head}`);
}
if (why.length) {
  const refuse = process.env.FK_PROOF_IOS_STALE_APP === 'refuse';
  console.error(`${refuse ? 'REFUSED' : 'WARNING'}: the installed app is older than the source (${why.join('; ')}). Pass --build, or this proof records an old build.`);
  if (refuse) process.exit(3);
}
