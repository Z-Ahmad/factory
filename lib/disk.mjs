#!/usr/bin/env node
// Low-disk handling shared by `factory janitor` (every pass) and `factory run` (before a heavy job is admitted), and the
// plumbing `factory cleanup` asks of node. The sweep itself is `cmd/cleanup`: this file only decides when to call it and
// reads the disk. It never deletes anything itself.
//
// usage (cleanup's plumbing): node lib/disk.mjs dd-in-use <dd_root> <state_dir>
//   prints "<dd_root>/dd-<name><TAB>why" for each build folder a live lease (`factory run --dd`) or a running process names.
//
// Test hook: none needed beyond PATH: free space is read with `df -k` (a stub on PATH answers for node and for cleanup).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_MIN_GB = 40;
export const DEFAULT_FLOOR_GB = 20;
/** What the janitor and `factory run` may remove when space is low: never worktrees, simulators or archives. */
export const SAFE_ONLY = ['derived-data', 'tmp', 'frames', 'clips'];
/** The longest a safe sweep may take before it is stopped (seconds); the most `factory run` waits on the disk. */
export const CLEANUP_DEADLINE_S = 300;

export const expandHome = (p) => (p ? p.replace(/^~(?=\/|$)/, homedir()).replace(/^\$HOME(?=\/|$)/, homedir()) : p);

/** Whole GB free on the volume holding `path` (`df -k`, the Available column, like cleanup's fk_free_gb); null when unknown. */
export function freeGb(path = '/') {
  try {
    const r = spawnSync('df', ['-k', path], { encoding: 'utf8', timeout: 15000 });
    if (r.error || r.status !== 0) return null;
    const cols = (r.stdout.split('\n')[1] ?? '').trim().split(/\s+/);
    const kb = Number(cols[3]);
    return Number.isFinite(kb) ? Math.floor(kb / 1048576) : null;
  } catch {
    return null;
  }
}

/**
 * The folder whose volume is measured: the build-cache root when it is a readable folder that `unreadable` does not
 * rule out (under launchd, ~/Documents is), else the state dir, else /.
 */
export function diskPath({ ddRoot, stateDir }, unreadable = () => false) {
  for (const p of [expandHome(ddRoot), stateDir]) if (p && existsSync(p) && !unreadable(p)) return p;
  return '/';
}

/** The "13.2G" of cleanup's `total removed: 13.2G (...)` line; null when there is none. */
export const freedText = (stdout) => /^total (?:removed|reclaimable): (\S+)/m.exec(stdout ?? '')?.[1] ?? null;

/**
 * Run the safe sweep: `cleanup --apply --if-below <min> --only derived-data --only tmp --only frames --only clips`,
 * the same code the doctor's low-disk step runs. `noProject` adds --no-project (the caller may not read the project
 * folder). Stops after `timeoutS`. Returns { ok, status, stdout, stderr, freed, timedOut }.
 */
export function safeCleanup({ minGb = DEFAULT_MIN_GB, noProject = false, timeoutS = CLEANUP_DEADLINE_S, env = process.env } = {}) {
  const args = ['--apply', '--if-below', String(minGb), ...SAFE_ONLY.flatMap((c) => ['--only', c]), ...(noProject ? ['--no-project'] : [])];
  const r = spawnSync(join(KIT, 'cmd', 'cleanup'), args, {
    encoding: 'utf8',
    timeout: timeoutS * 1000,
    killSignal: 'SIGKILL',
    env: { ...env, FK_KIT_DIR: KIT },
    maxBuffer: 1 << 26,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return {
    ok: !r.error && r.status === 0,
    status: r.status ?? (timedOut ? 124 : 127),
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error && !timedOut ? r.error.message : ''),
    freed: freedText(r.stdout),
    timedOut,
  };
}

/** Remove the derived-data folders of a worktree that is going away (cleanup's --worktree-caches). Best effort; the count freed, or null. */
export function removeWorktreeCaches(name, branch, { env = process.env, timeoutS = 120 } = {}) {
  const args = ['--apply', '--worktree-caches', name, ...(branch ? ['--branch', branch] : [])];
  const r = spawnSync(join(KIT, 'cmd', 'cleanup'), args, { encoding: 'utf8', timeout: timeoutS * 1000, killSignal: 'SIGKILL', env: { ...env, FK_KIT_DIR: KIT } });
  if (r.error || r.status !== 0) return null;
  const m = /^derived-data: (\d+) build folder/m.exec(r.stdout);
  return m ? { n: Number(m[1]), line: /^derived-data: .*$/m.exec(r.stdout)?.[0] ?? '' } : null;
}

// ------------------------------------------------------------ builds in use

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Map(path -> why) of the build folders under ddRoot that a live lease (--dd) or a running process names. */
export function ddInUse(ddRoot, stateDir) {
  const used = new Map();
  let children = [];
  try {
    children = readdirSync(ddRoot).filter((n) => n.startsWith('dd-'));
  } catch {
    return used;
  }
  try {
    const leases = JSON.parse(readFileSync(join(stateDir, 'slot', 'leases.json'), 'utf8')).leases ?? [];
    for (const l of leases) {
      if (!l?.dd || !Number.isInteger(l.pid) || !alive(l.pid)) continue;
      const want = resolve(l.cwd ?? '.', expandHome(String(l.dd)));
      for (const n of children) {
        const full = join(ddRoot, n);
        if (String(l.dd) === n || String(l.dd) === full || want === resolve(full)) used.set(full, `lease ${l.id} (${l.job}, ${l.owner})`);
      }
    }
  } catch {}
  try {
    const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 26 });
    for (const line of (ps.stdout ?? '').split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) === process.pid) continue;
      for (const n of children) {
        const full = join(ddRoot, n);
        const i = m[2].indexOf(full);
        if (i < 0) continue;
        const after = m[2][i + full.length];
        if (after === undefined || /[\s/'"]/.test(after)) if (!used.has(full)) used.set(full, `pid ${m[1]} (${basename(m[2].split(/\s+/)[0])})`);
      }
    }
  } catch {}
  return used;
}

function main(argv) {
  const [cmd, ddRoot, stateDir] = argv;
  if (cmd !== 'dd-in-use' || !ddRoot) {
    console.error('usage: node lib/disk.mjs dd-in-use <dd_root> <state_dir>');
    return 2;
  }
  for (const [p, why] of ddInUse(ddRoot, stateDir ?? '')) console.log(`${p}\t${why}`);
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked) process.exitCode = main(process.argv.slice(2));
