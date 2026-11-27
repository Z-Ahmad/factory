#!/usr/bin/env node
// desc: run a heavy job under a weighted reservation: queued first come, first served, admitted when the Mac has room
// usage: factory run --job <type> [--dd <dir>] [--sim <udid>] [--owner <id>] [--owner-pid <pid>] [--timeout <s>] [--limit <min>] -- <cmd…>
//        factory run --status            leases, the queue and the gate readings (exit 0 when a build would start now)
//        factory run --reap              free dead leases and kill what they left; kill orphaned recordings and test runs
//        factory run --check --job <t>   exit 0 when a <t> job would start now, 1 (with the reason) when not
//        factory run --wait --job <t>    block until a <t> job would start, without taking a lease (`slot wait`)
//
// A job takes a reservation of its weight ([slot.weights]; build, test, release, device, archive = 2; proof, vite,
// playwright, rules, install = 1; unit, tsc = 0) out of [slot] capacity (default 4). Weight 0 takes no lease. Reservations
// live in <state_dir>/slot/leases.json, changed only under /usr/bin/lockf (flock(1) elsewhere, a lock folder as a last
// resort). A job waits in a first-come, first-served queue, inside this command (the caller never polls), until it is
// first in line, its weight fits, and every gate holds:
//   pressure  sysctl kern.memorystatus_vm_pressure_level is 1 (normal)
//   swapouts  the vm_stat "Swapouts" counter grew by less than [slot] max_swapouts_per_min (default 1000 pages) over the
//             last minute (samples in <state_dir>/slot/swapouts.json). Swap in use is never a gate: macOS keeps pages in
//             swap long after the pressure that wrote them ends.
//   free      sysctl kern.memorystatus_level (memory_pressure's free percentage) at least [slot] min_free_pct (default
//             15; 0 = off)
//   load      shown, never a gate: the 1-minute average stays high for a minute after a job ends, so it held
//             builds on an idle Mac. Capacity and memory are the gates; proofs still wait for the load to settle
//             ([slot] max_load) before they record.
// A reading the system does not give (off macOS) holds nothing. Once admitted it prints how many minutes it waited, runs
// the command in its own process group, and frees the lease when it exits, after stopping whatever the command left
// running in that group. SIGINT, SIGTERM or SIGHUP, or the death of --owner-pid (or a numeric --owner), stop the whole
// group. The command gets FK_RUN_LEASE (the lease id) and FK_SLOT_HELD=1, so a nested `factory run`, `factory slot wait`
// or a proof's own slot wait does not queue again. Exit: the command's status (128 + n for signal n); 75 when the queue
// wait passed --timeout ([slot] timeout_s, default 3600; 0 = no limit); 124 when the command ran past its time limit;
// 74 when the disk is under [disk] floor_gb even after a safe cleanup (nothing was started); 1 on a usage error.
// Time limit: once admitted, a job may run for its type's minutes ([slot.run_limits], merged over the defaults: test 30,
// build 45, device 45, release 60, archive 60, proof 5; other types none) or --limit <min> (0 = none). Past it the whole
// process group is stopped, the lease freed, and it says so: a hung xcodebuild must never hold room for hours.
//
// The reaper (--reap, and at the start of every run) removes leases whose process is gone and kills their leftover
// process group (only when every process in it started after the lease did); kills `simctl io … recordVideo` processes
// whose parent is pid 1 and kit test runs (a node process running a kit checkout's test/*.test.mjs), each older than
// [slot] orphan_minutes (default 60). It prints each thing it killed and touches nothing else.
// Simulators: right after admission the job's lease records which simulators are booted (lease field `booted`). When the
// job ends, however it ends (exit, failure, time limit, signal, owner death), `factory run` shuts down each simulator
// that is booted now, was not booted then, and is not another live lease's: not its `--sim`, and not one that lease's job
// may have booted. Another live lease might have booted a new simulator unless its own `booted` list already holds it
// (then it was booted before that lease started, so during this job but not by that one); a live lease with no list
// leaves every new simulator alone. So when two jobs overlap, a simulator neither list holds stays booted (the janitor
// sweeps it once idle). It prints each one it shuts down. Weight 0 jobs and nested runs do nothing. [slot]
// shutdown_booted = false turns it off. Without xcrun it does nothing.
// Disk: before a build, test, release, proof, device or archive job is queued (not a nested one, not --check or --wait),
// the free space on the build-cache volume ([disk] dd_root, else the state dir, else /) is read. Under [disk] min_gb
// (default 40) it first runs the doctor's safe sweep (stale build folders, scratch, frames, clips; never worktrees or
// simulators; at most 300 s). Still under [disk] floor_gb (default 20) afterwards: exit 74, with the free space, the
// floor and the `factory cleanup` command to run. Otherwise the job goes on to the queue.
// Test hooks: FK_RUN_SWAP_PROBE_S (default 3) is how long a first swap-out sample is measured; FK_RUN_LOCK=mkdir forces
// the lock-folder fallback.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from './config.mjs';
import { bootedSims, shutdownSim } from '../lib/sims.mjs';
import { DEFAULT_FLOOR_GB, DEFAULT_MIN_GB, diskPath, expandHome, freeGb, safeCleanup } from '../lib/disk.mjs';

export const DEFAULT_WEIGHTS = {
  build: 2, test: 2, release: 2, device: 2, archive: 2,
  proof: 1, vite: 1, playwright: 1, rules: 1, install: 1,
  unit: 0, tsc: 0,
};
/** Minutes a job may run once admitted; a type not listed has no limit. */
export const DEFAULT_RUN_LIMITS = { test: 30, build: 45, device: 45, release: 60, archive: 60, proof: 5 };
const SELF = fileURLToPath(import.meta.url);
const say = (m) => process.stderr.write(`run: ${m}\n`);
const die = (m, code = 1) => {
  process.stderr.write(`factory run: ${m}\n`);
  process.exit(code);
};
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ settings

export function settings(file = process.env.FACTORY_TOML) {
  if (!file) die('no factory.toml (run this through bin/factory)');
  const r = load(readFileSync(file, 'utf8'));
  if (r.errors.length) die(`${file} has problems; run \`factory config validate\``);
  const slot = r.resolved.slot ?? {};
  const ncpu = Number(sysctl('hw.ncpu')) || availableParallelism();
  return {
    stateDir: r.resolved.project.state_dir,
    capacity: slot.capacity ?? 4,
    weights: { ...DEFAULT_WEIGHTS, ...(slot.weights ?? {}) },
    maxLoad: slot.max_load ?? 2 * ncpu,
    minFree: slot.min_free_pct ?? 15,
    maxSwapouts: slot.max_swapouts_per_min ?? 1000,
    orphanMin: slot.orphan_minutes ?? 60,
    shutdownBooted: slot.shutdown_booted !== false,
    pollS: slot.poll_s ?? 5,
    timeoutS: slot.timeout_s ?? 3600,
    minGb: r.resolved.disk?.min_gb ?? DEFAULT_MIN_GB,
    floorGb: r.resolved.disk?.floor_gb ?? DEFAULT_FLOOR_GB,
    ddRoot: r.resolved.disk?.dd_root ?? null,
    runLimits: { ...DEFAULT_RUN_LIMITS, ...(slot.run_limits ?? {}) },
  };
}

// ------------------------------------------------------------ readings

function out(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}
function sysctl(key) {
  const o = out('sysctl', ['-n', key]);
  return o == null ? null : o.trim();
}
const intOrNull = (s) => (s != null && /^-?\d+$/.test(s) ? Number(s) : null);

/** The raw figures the gates read: { pressure, free, load, swapouts } (each null when the system does not give it). */
export function readings() {
  let load = null;
  const la = sysctl('vm.loadavg');
  if (la) load = Number(la.replace(/[{}]/g, ' ').trim().split(/\s+/)[0]);
  else if (existsSync('/proc/loadavg')) load = Number(readFileSync('/proc/loadavg', 'utf8').split(/\s+/)[0]);
  if (!Number.isFinite(load)) load = null;
  const vm = out('vm_stat', []);
  const m = vm && /^Swapouts:\s+(\d+)/m.exec(vm);
  return {
    pressure: intOrNull(sysctl('kern.memorystatus_vm_pressure_level')),
    free: intOrNull(sysctl('kern.memorystatus_level')),
    load,
    swapouts: m ? Number(m[1]) : null,
  };
}

/**
 * Swap-outs per minute from the sample file: the counter now against the sample nearest a minute ago (at least 10 s
 * old). Records the new sample. null when there is no usable older sample, or the counter is unknown.
 */
export function swapRate(file, now, count) {
  if (count == null) return null;
  let samples = [];
  try {
    samples = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(samples)) samples = [];
  } catch {}
  // a counter lower than a sample means a reboot: older samples say nothing
  samples = samples.filter((s) => Number.isFinite(s?.t) && Number.isFinite(s?.n) && s.t > now - 600000 && s.t <= now && s.n <= count);
  const older = samples.filter((s) => now - s.t >= 10000);
  const atLeastMin = older.filter((s) => now - s.t >= 60000);
  const base = atLeastMin.length ? atLeastMin.reduce((a, b) => (b.t > a.t ? b : a)) : older.reduce((a, b) => (a && a.t < b.t ? a : b), null);
  samples.push({ t: now, n: count });
  atomicWrite(file, JSON.stringify(samples.slice(-60)));
  if (!base) return null;
  return Math.round(((count - base.n) / (now - base.t)) * 60000);
}

/** Readings plus the swap-out rate, measuring for FK_RUN_SWAP_PROBE_S when there is no recent sample to compare with. */
export function measure(cfg) {
  const file = join(cfg.stateDir, 'slot', 'swapouts.json');
  const r = readings();
  r.swapRate = swapRate(file, Date.now(), r.swapouts);
  const probe = Number(process.env.FK_RUN_SWAP_PROBE_S ?? 3);
  if (r.swapRate == null && r.swapouts != null && probe > 0) {
    sleepMs(probe * 1000);
    const again = readings().swapouts;
    if (again != null && again >= r.swapouts) r.swapRate = Math.round(((again - r.swapouts) / probe) * 60);
    if (again != null) swapRate(file, Date.now(), again);
  }
  return r;
}

const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

/** { ok, text, held: [keys] } for the gate readings. */
export function gates(r, cfg) {
  const parts = [];
  const held = [];
  if (r.pressure != null) {
    // Only critical holds. macOS leaves the level at warn long after the squeeze that raised it (a booted simulator
    // kept it there with 39-54% free, holding a test for 35 min on an idle Mac), the way swap in use lingered before
    // v0.22; the swap-out rate and free memory below are what read a real shortage.
    const ok = r.pressure !== 4;
    const name = PRESSURE[r.pressure] ?? r.pressure;
    parts.push(`pressure ${name}${ok ? (r.pressure === 1 ? '' : ' (not a gate below critical)') : ' (kern.memorystatus_vm_pressure_level is critical)'}`);
    if (!ok) held.push('pressure');
  }
  if (r.swapRate != null) {
    const ok = r.swapRate < cfg.maxSwapouts;
    parts.push(`swapouts ${r.swapRate}/min${ok ? '' : ` >= ${cfg.maxSwapouts} ([slot] max_swapouts_per_min)`}`);
    if (!ok) held.push('max_swapouts_per_min');
  } else if (r.swapouts != null) parts.push('swapouts ?/min');
  if (cfg.minFree !== 0 && r.free != null) {
    const ok = r.free >= cfg.minFree;
    parts.push(`memory ${r.free}% free${ok ? '' : ` < ${cfg.minFree}% ([slot] min_free_pct)`}`);
    if (!ok) held.push('min_free_pct');
  }
  if (r.load != null) parts.push(`load ${r.load}`);
  return { ok: held.length === 0, held, text: parts.join('; ') || 'no readings' };
}

// ------------------------------------------------------------ processes

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** "[[dd-]hh:]mm:ss" -> seconds. */
export function etimeSeconds(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s ?? '');
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** Every process: [{ pid, ppid, pgid, age (s), cmd }]. */
export function processes() {
  const o = out('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,command=']) ?? '';
  const rows = [];
  for (const line of o.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), age: etimeSeconds(m[4]), cmd: m[5] });
  }
  return rows;
}

/** TERM the group, then KILL whatever is left after graceMs. True when there was a group to signal. */
export function killGroup(pgid, graceMs = 3000, first = 'SIGTERM') {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return false;
  try {
    process.kill(-pgid, first);
  } catch {
    return false;
  }
  const end = Date.now() + graceMs;
  while (Date.now() < end && groupAlive(pgid)) sleepMs(50);
  if (groupAlive(pgid)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {}
  }
  return true;
}
export function killPid(pid, graceMs = 3000, first = 'SIGTERM') {
  try {
    process.kill(pid, first);
  } catch {
    return false;
  }
  const end = Date.now() + graceMs;
  while (Date.now() < end && alive(pid)) sleepMs(50);
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  return true;
}

// ------------------------------------------------------------ the lease file

const slotDir = (cfg) => join(cfg.stateDir, 'slot');
const leaseFile = (cfg) => join(slotDir(cfg), 'leases.json');

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
export function readState(cfg) {
  try {
    const s = JSON.parse(readFileSync(leaseFile(cfg), 'utf8'));
    return { leases: Array.isArray(s.leases) ? s.leases : [], queue: Array.isArray(s.queue) ? s.queue : [] };
  } catch {
    return { leases: [], queue: [] };
  }
}
const writeState = (cfg, s) => atomicWrite(leaseFile(cfg), `${JSON.stringify(s, null, 2)}\n`);

/**
 * Removes leases and queue entries whose process is gone. A dead lease's process group is killed when every process
 * still in it started after the lease did (so a reused number is never mistaken for it). Returns lines to print.
 */
function prune(s) {
  const lines = [];
  const procs = s.leases.some((l) => !alive(l.pid) && l.pgid) ? processes() : [];
  s.leases = s.leases.filter((l) => {
    if (alive(l.pid)) return true;
    let what = 'nothing left running';
    if (l.pgid) {
      const members = procs.filter((p) => p.pgid === l.pgid);
      const leaseAge = (Date.now() - Date.parse(l.started)) / 1000;
      if (members.length && members.every((p) => p.age != null && p.age <= leaseAge + 5)) {
        killGroup(l.pgid);
        what = `killed its process group ${l.pgid} (${members.length} process${members.length === 1 ? '' : 'es'})`;
      } else if (members.length) what = `left process group ${l.pgid} alone: it holds processes older than the lease`;
    }
    lines.push(`reaped lease ${l.id} (${l.job}, owner ${l.owner}, pid ${l.pid} gone): ${what}`);
    return false;
  });
  s.queue = s.queue.filter((q) => {
    if (alive(q.pid)) return true;
    lines.push(`dropped queued ${q.job} of ${q.owner} (pid ${q.pid} gone)`);
    return false;
  });
  return lines;
}

const used = (s) => s.leases.reduce((a, l) => a + l.weight, 0);

/** The lease-file operations, each run while holding the lock. */
const OPS = {
  prune(cfg) {
    const s = readState(cfg);
    const lines = prune(s);
    writeState(cfg, s);
    return { lines, state: s };
  },
  enqueue(cfg, entry) {
    const s = readState(cfg);
    const lines = prune(s);
    s.queue.push(entry);
    writeState(cfg, s);
    return { lines };
  },
  // admit the entry when it is first in line, its weight fits, and the gates (read by the caller) hold
  admit(cfg, { id, gatesOk }) {
    const s = readState(cfg);
    const lines = prune(s);
    const at = s.queue.findIndex((q) => q.id === id);
    if (at === -1) {
      writeState(cfg, s);
      return { lines, lost: true };
    }
    const me = s.queue[at];
    const inUse = used(s);
    const fits = inUse + me.weight <= cfg.capacity;
    if (at === 0 && fits && gatesOk) {
      s.queue.splice(at, 1);
      s.leases.push({ ...me, queued: undefined, started: new Date().toISOString(), waited_s: Math.round((Date.now() - Date.parse(me.queued)) / 1000), pgid: null });
      writeState(cfg, s);
      return { lines, admitted: true };
    }
    writeState(cfg, s);
    return { lines, admitted: false, ahead: at, inUse, fits, leases: s.leases };
  },
  setpgid(cfg, { id, pgid, booted }) {
    const s = readState(cfg);
    const l = s.leases.find((x) => x.id === id);
    if (l) {
      l.pgid = pgid;
      if (booted) l.booted = booted;
    }
    writeState(cfg, s);
    return {};
  },
  release(cfg, { id }) {
    const s = readState(cfg);
    s.leases = s.leases.filter((x) => x.id !== id);
    s.queue = s.queue.filter((x) => x.id !== id);
    writeState(cfg, s);
    return {};
  },
};

function lockTool() {
  if (process.env.FK_RUN_LOCK === 'mkdir') return null;
  if (existsSync('/usr/bin/lockf')) return ['/usr/bin/lockf', ['-k', '-t', '60']];
  for (const d of ['/usr/bin', '/bin', '/usr/local/bin']) if (existsSync(join(d, 'flock'))) return [join(d, 'flock'), ['-w', '60']];
  return null;
}

/** Runs OPS[name](cfg, arg) holding the lease lock; returns its result. */
export function locked(cfg, name, arg = {}) {
  const dir = slotDir(cfg);
  mkdirSync(dir, { recursive: true });
  const tool = lockTool();
  if (tool) {
    const r = spawnSync(tool[0], [...tool[1], join(dir, 'leases.lock'), process.execPath, SELF, '--op', name, JSON.stringify({ cfg, arg })], {
      encoding: 'utf8',
      env: process.env,
    });
    if (r.status !== 0) die(`lease lock: ${basename(tool[0])} exited ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
    return JSON.parse(r.stdout);
  }
  // last resort: a lock folder; one left by a process that died is taken over after 60 s
  const lockDir = join(dir, 'leases.lock.d');
  const end = Date.now() + 60000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 60000) rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() > end) die('lease lock: timed out');
      sleepMs(25);
    }
  }
  try {
    return OPS[name](cfg, arg);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ the reaper

/** Kills orphaned recordings and stale kit test runs. Returns lines to print. */
export function reapOrphans(cfg) {
  const lines = [];
  const procs = processes();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const mine = new Set();
  for (let p = process.pid, guard = 0; p > 1 && guard < 64; guard++) {
    mine.add(p);
    p = byPid.get(p)?.ppid ?? 0;
  }
  const limit = cfg.orphanMin * 60;
  for (const p of procs) {
    if (mine.has(p.pid) || p.age == null || p.age <= limit) continue;
    if (/(?:^|[\s/])simctl\s.*\bio\b.*\brecordVideo\b/.test(p.cmd) && p.ppid === 1) {
      // SIGINT is how simctl is told to finish a recording
      if (killPid(p.pid, 3000, 'SIGINT')) lines.push(`killed orphaned recording pid ${p.pid} (${Math.round(p.age / 60)} min, parent gone): ${p.cmd}`);
    } else if (isKitTestRun(p.cmd)) {
      if (killPid(p.pid)) lines.push(`killed kit test run pid ${p.pid} (${Math.round(p.age / 60)} min): ${p.cmd}`);
    }
  }
  return lines;
}

/** A node process running <kit>/test/<x>.test.mjs, where <kit> is a kit checkout (bin/factory and gates/hook-guard.mjs). */
function isKitTestRun(cmd) {
  const words = cmd.split(/\s+/);
  if (!/(?:^|\/)node$/.test(words[0] ?? '')) return false;
  return words.slice(1).some((w) => {
    const m = /^(\/.+)\/test\/[^/]+\.test\.mjs$/.exec(w);
    return m && existsSync(join(m[1], 'bin', 'factory')) && existsSync(join(m[1], 'gates', 'hook-guard.mjs'));
  });
}

/**
 * The simulators a job that has ended may shut down: booted now, not in `before` (booted when it was admitted), not
 * another live lease's `--sim`, and not one another live lease's job may have booted (see the header: a new simulator
 * is theirs unless their own `booted` list already holds it; a lease with no list claims every new one).
 */
export function simsToShut(now, before, others) {
  return [...now].filter((u) => !before.has(u) && !others.some((l) => leaseMayOwn(u, l)));
}

/** A live lease may own a simulator: it is the lease's --sim, or it is not in the lease's `booted` list (no list: all are). */
export const leaseMayOwn = (udid, l) => l.sim === udid || !Array.isArray(l.booted) || !l.booted.includes(udid);

/** Shuts down the simulators this job booted (see simsToShut); prints each. Never throws. */
function shutdownJobSims(cfg, id, before, job) {
  if (!cfg.shutdownBooted || !before) return;
  try {
    const now = bootedSims();
    if (!now) return;
    const { state } = locked(cfg, 'prune');
    const others = state.leases.filter((l) => l.id !== id);
    for (const u of simsToShut(now, before, others))
      say(shutdownSim(u) ? `shut down simulator ${u} (booted during ${job})` : `could not shut down simulator ${u} (booted during ${job})`);
  } catch (e) {
    say(`simulator cleanup skipped: ${e?.message ?? e}`);
  }
}

/** The whole reaper; returns { lines, state } (the lease file after pruning). */
export function reap(cfg) {
  const { lines, state } = locked(cfg, 'prune');
  lines.push(...reapOrphans(cfg));
  for (const l of lines) say(l);
  return { lines, state };
}

// ------------------------------------------------------------ status

const mins = (s) => (s / 60).toFixed(1);
function age(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/** Would a job of this weight start now? { ok, reason }. */
function wouldAdmit(cfg, state, weight, g) {
  const inUse = used(state);
  const why = [];
  if (state.queue.length) why.push(`${state.queue.length} queued ahead`);
  if (inUse + weight > cfg.capacity) why.push(`capacity ${inUse}/${cfg.capacity} in use${leasesText(state.leases)}, needs ${weight} ([slot] capacity)`);
  if (!g.ok) why.push(g.text);
  return { ok: why.length === 0, reason: why.length ? why.join('; ') : `capacity ${inUse}/${cfg.capacity} in use; ${g.text}` };
}
const leasesText = (ls) => (ls.length ? `: ${ls.map((l) => `${l.job} (${l.owner})`).join(', ')}` : '');

function status(cfg) {
  const { state } = reap(cfg);
  const g = gates(measure(cfg), cfg);
  console.log(`capacity ${used(state)}/${cfg.capacity} in use`);
  for (const l of state.leases)
    console.log(`  lease  ${l.job.padEnd(10)} weight ${l.weight}  owner ${l.owner}  age ${age(l.started)}  pid ${l.pid}${l.pgid ? ` group ${l.pgid}` : ''}${l.dd ? `  dd ${l.dd}` : ''}${l.sim ? `  sim ${l.sim}` : ''}  ${l.cmd}`);
  state.queue.forEach((q, i) =>
    console.log(`  queue ${String(i + 1).padStart(2)}. ${q.job.padEnd(10)} weight ${q.weight}  owner ${q.owner}  waiting ${age(q.queued)}  ${q.cmd}`),
  );
  console.log(`gates: ${g.text}${g.ok ? '' : ' (holding)'}`);
  const w = Math.min(cfg.weights.build ?? 2, cfg.capacity);
  const a = wouldAdmit(cfg, state, w, g);
  console.log(a.ok ? `a build (weight ${w}) would start now` : `a build (weight ${w}) would wait: ${a.reason}`);
  return a.ok ? 0 : 1;
}

// ------------------------------------------------------------ running a job

const shq = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

function defaultOwner() {
  const b = out('git', ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
  const here = basename(process.cwd());
  return b && b !== 'HEAD' ? `${b} (${here})` : here;
}

function weightOf(cfg, job) {
  if (!(job in cfg.weights)) die(`unknown job type '${job}' (known: ${Object.keys(cfg.weights).join(', ')}; add one under [slot.weights])`);
  const w = cfg.weights[job];
  return Math.min(Math.max(0, w), cfg.capacity);
}

/** The job types that build or test something big enough to fill the disk. */
export const DISK_JOBS = new Set(['build', 'test', 'release', 'proof', 'device', 'archive']);
export const EXIT_DISK = 74;

/**
 * 0 to go on, or EXIT_DISK with the reason said on stderr. Under min_gb it sweeps first (bounded by the sweep's own
 * deadline); under floor_gb after that it refuses. A disk it cannot read never blocks a job.
 */
export function diskGate(cfg, job, { env = process.env, deps = { freeGb, cleanup: safeCleanup } } = {}) {
  if (!DISK_JOBS.has(job) || env.FK_RUN_LEASE) return 0;
  const path = diskPath({ ddRoot: expandHome(cfg.ddRoot), stateDir: cfg.stateDir });
  let free = deps.freeGb(path);
  if (free == null || free >= cfg.minGb) return 0;
  say(`disk: ${free} GB free (min ${cfg.minGb}); cleaning stale build folders and scratch first`);
  const r = deps.cleanup({ minGb: cfg.minGb, env });
  free = deps.freeGb(path) ?? free;
  say(`disk: ${r.ok ? `freed ${r.freed ?? 'nothing'}` : r.timedOut ? 'cleanup stopped at its deadline' : `cleanup failed (exit ${r.status})`}; ${free} GB free now`);
  if (free >= cfg.floorGb) return 0;
  process.stderr.write(`factory run: not starting the ${job} job: ${free} GB free is under the ${cfg.floorGb} GB floor ([disk] floor_gb), even after cleaning. Run \`factory cleanup --apply\` (add \`--only worktrees\` to drop merged agent worktrees), free some space, then run it again.\n`);
  return EXIT_DISK;
}

async function runJob(cfg, o) {
  const weight = weightOf(cfg, o.job);
  const nested = process.env.FK_RUN_LEASE;
  const id = `${process.pid}-${Date.now().toString(36)}`;
  const entry = {
    id, job: o.job, weight, pid: process.pid, owner: o.owner ?? defaultOwner(),
    owner_pid: o.ownerPid ?? null, dd: o.dd ?? null, sim: o.sim ?? null, cwd: process.cwd(),
    queued: new Date().toISOString(), cmd: o.cmd.map(shq).join(' '),
  };
  let leased = false;
  let child = null;
  let before = null; // the simulators booted when the job was admitted (null: no lease, or xcrun gives none)
  let stopping = false;

  const finish = (code) => {
    if (child?.pid) killGroup(child.pid);
    shutdownJobSims(cfg, id, before, o.job);
    if (leased) locked(cfg, 'release', { id });
    process.exit(code);
  };
  const onSignal = (sig, n) => {
    if (stopping) return;
    stopping = true;
    say(`${sig}: stopping ${o.job}${child ? ` (process group ${child.pid})` : ' (still queued)'}`);
    finish(128 + n);
  };
  process.on('SIGINT', () => onSignal('SIGINT', 2));
  process.on('SIGTERM', () => onSignal('SIGTERM', 15));
  process.on('SIGHUP', () => onSignal('SIGHUP', 1));
  if (entry.owner_pid) {
    setInterval(() => {
      if (stopping || alive(entry.owner_pid)) return;
      stopping = true;
      say(`owner pid ${entry.owner_pid} is gone: stopping ${o.job}${child ? ` (process group ${child.pid})` : ' (still queued)'}`);
      finish(143);
    }, 1000).unref();
  }

  if (nested) say(`inside lease ${nested}: ${o.job} runs without a new reservation`);
  else if (weight === 0) {
    // weight 0: no lease, no queue
  } else {
    reap(cfg);
    for (const l of locked(cfg, 'enqueue', entry).lines) say(l);
    leased = true; // from here a queue entry or a lease is ours to remove
    const start = Date.now();
    let last = '';
    for (;;) {
      const g = gates(measure(cfg), cfg);
      const r = locked(cfg, 'admit', { id, gatesOk: g.ok });
      for (const l of r.lines) say(l);
      if (r.lost) {
        locked(cfg, 'enqueue', entry);
        continue;
      }
      if (r.admitted) {
        say(`${o.job} (weight ${weight}) admitted after ${mins((Date.now() - start) / 1000)} min waiting`);
        break;
      }
      const why = [];
      if (r.ahead) why.push(`${r.ahead} ahead in the queue`);
      if (!r.fits) why.push(`capacity ${r.inUse}/${cfg.capacity} in use${leasesText(r.leases)} ([slot] capacity)`);
      if (!g.ok) why.push(g.text);
      const key = `${r.ahead}|${r.fits}|${g.held.join(',')}`;
      if (key !== last) {
        say(`${o.job} (weight ${weight}) queued: ${why.join('; ')}`);
        last = key;
      }
      if (cfg.timeoutS > 0 && Date.now() - start >= cfg.timeoutS * 1000) {
        say(`gave up after ${mins(cfg.timeoutS)} min in the queue ([slot] timeout_s or --timeout): ${why.join('; ')}`);
        stopping = true;
        finish(75);
      }
      await sleep(cfg.pollS * 1000);
      if (stopping) return;
    }
  }
  if (stopping) return;

  if (leased) before = bootedSims();
  child = spawn(o.cmd[0], o.cmd.slice(1), {
    stdio: 'inherit',
    detached: true, // its own process group (pgid = its pid), so the whole job can be signalled at once
    env: { ...process.env, FK_RUN_LEASE: nested || id, FK_SLOT_HELD: '1' },
  });
  child.on('error', (e) => {
    say(`cannot start ${o.cmd[0]}: ${e.message}`);
    child = null;
    finish(127);
  });
  if (child.pid && leased) locked(cfg, 'setpgid', { id, pgid: child.pid, booted: before ? [...before] : null });
  const limitMin = o.limit ?? cfg.runLimits[o.job] ?? 0;
  if (limitMin > 0) {
    setTimeout(() => {
      if (stopping) return;
      stopping = true;
      say(`${o.job} ran past its ${limitMin} min limit ([slot.run_limits] ${o.job} or --limit): stopping process group ${child?.pid}`);
      finish(124);
    }, limitMin * 60 * 1000).unref();
  }
  child.on('exit', (code, signal) => {
    if (stopping) return;
    stopping = true;
    const pgid = child.pid;
    child = null;
    if (killGroup(pgid)) say(`stopped what ${o.job} left running in process group ${pgid}`);
    shutdownJobSims(cfg, id, before, o.job);
    if (leased) locked(cfg, 'release', { id });
    process.exit(code ?? 128 + (({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 })[signal] ?? 1));
  });
}

async function waitFree(cfg, job, timeoutS) {
  const weight = weightOf(cfg, job);
  const start = Date.now();
  let last = '';
  for (;;) {
    const { state } = reap(cfg);
    const a = wouldAdmit(cfg, state, weight, gates(measure(cfg), cfg));
    if (a.ok) {
      console.log(`run: go after ${mins((Date.now() - start) / 1000)} min (${a.reason})`);
      return 0;
    }
    if (a.reason.replace(/[\d.]+/g, '#') !== last) {
      console.log(`run: waiting (${a.reason})`);
      last = a.reason.replace(/[\d.]+/g, '#');
    }
    if (timeoutS > 0 && Date.now() - start >= timeoutS * 1000) {
      console.log(`run: gave up after ${timeoutS}s (${a.reason})`);
      return 2;
    }
    await sleep(cfg.pollS * 1000);
  }
}

// ------------------------------------------------------------ CLI

const USAGE = 'usage: factory run --job <type> [--dd <dir>] [--sim <udid>] [--owner <id>] [--owner-pid <pid>] [--timeout <s>] [--limit <min>] -- <cmd…>\n       factory run --status | --reap | --check --job <type> | --wait --job <type> [--timeout <s>]';

async function main(argv) {
  if (argv[0] === '--op') {
    const { cfg, arg } = JSON.parse(argv[2]);
    process.stdout.write(JSON.stringify(OPS[argv[1]](cfg, arg)));
    return 0;
  }
  const o = { cmd: [] };
  let mode = 'run';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null) die(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === '--') {
      o.cmd = argv.slice(i + 1);
      break;
    } else if (a === '--job') o.job = val();
    else if (a === '--dd') o.dd = val();
    else if (a === '--sim') o.sim = val();
    else if (a === '--owner') o.owner = val();
    else if (a === '--owner-pid') o.ownerPid = Number(val());
    else if (a === '--timeout') o.timeout = Number(val());
    else if (a === '--limit') o.limit = Number(val());
    else if (['--status', '--reap', '--check', '--wait'].includes(a)) mode = a.slice(2);
    else if (a === '-h' || a === '--help') {
      console.log(USAGE);
      return 0;
    } else die(`unknown argument ${a}\n${USAGE}`);
  }
  if (o.owner && /^\d+$/.test(o.owner) && !o.ownerPid) o.ownerPid = Number(o.owner);
  if (o.ownerPid != null && !(Number.isInteger(o.ownerPid) && o.ownerPid > 0)) die('--owner-pid wants a process id');
  if (o.timeout != null && !(Number.isInteger(o.timeout) && o.timeout >= 0)) die('--timeout wants whole seconds');
  if (o.limit != null && !(Number.isFinite(o.limit) && o.limit >= 0)) die('--limit wants minutes (0 = none)');
  const cfg = settings();
  if (o.timeout != null) cfg.timeoutS = o.timeout;
  if (mode === 'status') return status(cfg);
  if (mode === 'reap') {
    const { lines } = reap(cfg);
    if (!lines.length) say('nothing to reap');
    return 0;
  }
  if (!o.job) die(`--job is required\n${USAGE}`);
  if (mode === 'check') {
    if (process.env.FK_RUN_LEASE) return 0;
    const { state } = locked(cfg, 'prune');
    const w = weightOf(cfg, o.job);
    if (w === 0) return 0;
    const a = wouldAdmit(cfg, state, w, gates(measure(cfg), cfg));
    console.log(a.ok ? `run: a ${o.job} would start now (${a.reason})` : `run: a ${o.job} would wait (${a.reason})`);
    return a.ok ? 0 : 1;
  }
  if (mode === 'wait') {
    if (process.env.FK_RUN_LEASE) {
      console.log(`run: go (inside lease ${process.env.FK_RUN_LEASE})`);
      return 0;
    }
    return waitFree(cfg, o.job, cfg.timeoutS);
  }
  if (!o.cmd.length) die(`no command after --\n${USAGE}`);
  const full = diskGate(cfg, o.job);
  if (full) return full;
  await runJob(cfg, o);
  return null; // the job's exit handler ends the process
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code != null) process.exit(code);
    },
    (e) => die(e?.stack ?? String(e)),
  );
}
