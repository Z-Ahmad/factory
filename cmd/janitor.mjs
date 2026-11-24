#!/usr/bin/env node
// desc: a safe periodic sweep: reap dead leases, stop orphaned builds and recordings, shut down idle simulators and, when memory is tight, the rest
// usage: factory janitor run [--apply] [--scheduled]   one pass (a dry run, which only logs what it would do, unless applied)
//        factory janitor enable | disable              whether the scheduled pass applies (default: disabled = dry run)
//        factory janitor status                        installed? enabled? the last pass and the last log lines
//        factory janitor install [--interval 300] [--shim <path>] | uninstall    the launchd user agent that runs a pass
//
// `factory run` cleans up after the jobs it runs; this cleans up after everything else (a build started outside it, an
// agent that died). A pass makes no model call and starts a handful of subprocesses (ps, xcrun, sysctl). A missing tool
// skips its step. Every action, or in a dry run every would-be action, is one line in <state_dir>/janitor/janitor.log
// (timestamp, apply|dry, what, why; rotated at 1 MB to janitor.log.1).
//
// The pass, in order:
//   a. reap      leases whose process is gone are freed and their leftover process group killed (`factory run --reap`);
//                a dry run only lists them.
//   b. orphans   a process is stopped only when ALL of these hold:
//                  1. it is a named tool: the executable is xcodebuild or xctest, or the command is `simctl io … recordVideo`
//                     or `simctl spawn …`, or it matches [janitor] tools (a name, a glob, or text with a space);
//                  2. it is an orphan: its parent is pid 1 (or gone), or every ancestor up to such a parent is itself a
//                     named tool (xctest under an orphaned xcodebuild). Any other ancestor (a shell, an editor, Xcode,
//                     an agent, node) means someone still owns it;
//                  3. it is older than [janitor] orphan_minutes (default 10);
//                  4. it is not in the process group of, nor a descendant of, nor the pid of, any live lease (nor this pass);
//                  5. it is not an app's main binary (anything under .app/Contents/MacOS/: Xcode, Simulator, Spotify) and
//                     no ancestor is Xcode or Simulator.
//                A recording gets SIGINT (so the file is finished), the rest SIGTERM, then SIGKILL after 3 s.
//   c. idle sims booted simulators idle for [sim] idle_minutes (default 30; lib/sims.mjs: no process names the UDID, no app
//                launched and no boot in that time), that no live lease may own, and that [sim] keep_booted does not name,
//                are shut down.
//   d. memory    when memory pressure is critical (sysctl kern.memorystatus_vm_pressure_level = 4) or swap in use is at
//                least [janitor] swap_pct (default 80) of its total (vm.swapusage), every booted simulator no live lease may
//                own, that no running process names, and keep_booted does not name, is shut down, idle or not. The
//                readings before and after are logged.
// A live lease "may own" a simulator when it is the lease's --sim, or the simulator is not in the lease's `booted` list
// (what was booted when the job was admitted): the job may have booted it (the same rule `factory run` uses at the end of
// a job). Nothing ever erases or deletes a simulator.
//
// Housekeeping: about once a day, a pass that can read the project (the session-end pass, or one run by hand; never the
// launchd one) runs `factory cleanup --only worktrees --only derived-data --only tmp`, with --apply when the pass applies,
// so merged agent worktrees, stale build folders and old scratch go without anyone remembering. Cleanup's own rules
// decide what is safe; its REMOVE lines and totals are logged.
//
// Scheduling: `install` writes ~/Library/LaunchAgents/com.factory-kit.janitor.<project>.plist (every --interval seconds,
// default 300, never at load) running `<kit>/bin/factory janitor run --scheduled` (or --shim) against a copy of
// factory.toml kept at <state_dir>/janitor/factory.toml, from that folder. macOS keeps launchd agents out of ~/Documents,
// ~/Desktop and ~/Downloads (privacy protection), where projects usually live, so the scheduled pass never reads the
// project folder: only the kit checkout (~/.factory-kit) and the state dir. Every pass run by hand or by a hook (not a
// scheduled one) refreshes the copy, and re-installs the agent when the kit version or the copy's path changed. `--scheduled` applies only after `enable`; `run --apply`
// applies regardless. It is DISABLED after install: read a few dry-run passes in the log, then enable.
// Test hooks: FK_JANITOR_AGENTS_DIR (the LaunchAgents folder; with it set, install also works off macOS) and launchctl
// found on PATH; FK_JANITOR_KILL (a command run as `<cmd> <SIGNAL> <pid>` instead of signalling).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from './config.mjs';
import { alive, killPid, leaseMayOwn, processes, readState, reap } from './run.mjs';
import { bootedSimNames, shutdownSim, simsInUse } from '../lib/sims.mjs';

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_MAX = 1024 * 1024;
const BUILTIN_TOOL_NAMES = new Set(['xcodebuild', 'xctest']);
const SIMCTL_TOOL = /(?:^|[\s/])simctl\s+(?:io\s.*\brecordVideo\b|spawn\s)/;
const RECORDING = /\brecordVideo\b/;
const APP_MAIN = /\.app\/Contents\/MacOS\//;
const PROTECTED_ANCESTOR = /\/(?:Xcode[^/]*|Simulator)\.app\/Contents\/MacOS\//;
const PROTECTED_NAMES = new Set(['launchd', 'loginwindow', 'kernel_task', 'WindowServer', 'Finder', 'Dock', 'sshd']);

// ------------------------------------------------------------ settings

export function settings(file = process.env.FACTORY_TOML) {
  if (!file) throw new Error('no factory.toml (run this through bin/factory)');
  const r = load(readFileSync(file, 'utf8'));
  if (r.errors.length) throw new Error(`${file} has problems; run \`factory config validate\``);
  const j = r.resolved.janitor ?? {};
  const stateDir = r.resolved.project.state_dir;
  return {
    project: r.resolved.project.name,
    mainCheckout: r.resolved.project.main_checkout,
    stateDir,
    dir: join(stateDir, 'janitor'),
    orphanMin: j.orphan_minutes ?? 10,
    swapPct: j.swap_pct ?? 80,
    tools: j.tools ?? [],
    idleMin: r.resolved.sim?.idle_minutes ?? 30,
    keepBooted: r.resolved.sim?.keep_booted ?? [],
    runCfg: { stateDir, orphanMin: r.resolved.slot?.orphan_minutes ?? 60 },
  };
}

// ------------------------------------------------------------ what counts as a tool

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** The patterns from [janitor] tools that are safe to use; { ok: [matcher], ignored: [text] }. */
export function toolPatterns(list) {
  const ok = [];
  const ignored = [];
  for (const raw of list ?? []) {
    const t = String(raw).trim();
    // a bare wildcard, or a few letters of text, would match half the Mac
    if (!t || /^[*?\s]*$/.test(t) || t.replace(/[*?\s]/g, '').length < 3) ignored.push(t);
    else if (/\s/.test(t)) ok.push((cmd) => cmd.includes(t));
    else {
      const re = globRe(t);
      ok.push((cmd) => re.test(basename(cmd.split(/\s+/)[0] ?? '')));
    }
  }
  return { ok, ignored };
}

export function isTool(cmd, extra = []) {
  const exe = basename(cmd.split(/\s+/)[0] ?? '');
  return BUILTIN_TOOL_NAMES.has(exe) || SIMCTL_TOOL.test(cmd) || extra.some((m) => m(cmd));
}

// ------------------------------------------------------------ the sweep

const fmtAge = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);

/** The ancestors of a process (nearest first), by ppid; stops at pid 1, a missing parent or a loop. */
function ancestors(p, byPid) {
  const out = [];
  const seen = new Set([p.pid]);
  for (let cur = p; cur.ppid > 1; ) {
    const parent = byPid.get(cur.ppid);
    if (!parent || seen.has(parent.pid)) break;
    out.push(parent);
    seen.add(parent.pid);
    cur = parent;
  }
  return out;
}

/**
 * The orphaned tool processes to stop: [{ pid, cmd, age, signal, why }]. `leases` are the live ones, `selfPids` this
 * pass's own process and ancestors. See the header for the rules.
 */
export function orphanCandidates(procs, leases, cfg, selfPids = new Set()) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const extra = toolPatterns(cfg.tools).ok;
  const lease = {
    pids: new Set(leases.map((l) => l.pid)),
    pgids: new Set(leases.flatMap((l) => (Number.isInteger(l.pgid) && l.pgid > 1 ? [l.pgid] : []))),
  };
  const out = [];
  for (const p of procs) {
    if (p.pid <= 1 || selfPids.has(p.pid) || p.age == null || p.age < cfg.orphanMin * 60) continue;
    if (!isTool(p.cmd, extra)) continue;
    if (APP_MAIN.test(p.cmd) || PROTECTED_NAMES.has(basename(p.cmd.split(/\s+/)[0] ?? ''))) continue;
    const up = ancestors(p, byPid);
    // a live lease owns it: its process, its group, or anything below either
    if ([p, ...up].some((q) => lease.pids.has(q.pid) || lease.pgids.has(q.pgid))) continue;
    if (up.some((q) => PROTECTED_ANCESTOR.test(q.cmd))) continue;
    // orphan: the chain up to launchd (or a vanished parent) holds nothing but named tools
    const top = up.length ? up[up.length - 1] : p;
    const orphanedAtTop = top.ppid <= 1 || !byPid.has(top.ppid);
    if (!orphanedAtTop || !up.every((q) => isTool(q.cmd, extra))) continue;
    out.push({
      pid: p.pid,
      cmd: p.cmd,
      age: p.age,
      signal: RECORDING.test(p.cmd) ? 'SIGINT' : 'SIGTERM',
      why: `${fmtAge(p.age)} old, ${up.length ? `under orphaned ${basename(top.cmd.split(/\s+/)[0])} (pid ${top.pid})` : 'parent gone (pid 1)'}, no live lease owns it`,
    });
  }
  return out;
}

/** ps rows -> the text lib/sims.mjs reads ("pid etime command"). */
const simsPsText = (procs) => procs.map((p) => `${p.pid} ${Math.floor((p.age ?? 0) / 60)}:${String((p.age ?? 0) % 60).padStart(2, '0')} ${p.cmd}`).join('\n');

/** Swap in use as a percentage of the total, from `sysctl -n vm.swapusage`; null when unknown. */
export function swapPercent(text) {
  const num = (k) => {
    const m = new RegExp(`${k}\\s*=\\s*([\\d.]+)\\s*([KMGT]?)`, 'i').exec(text ?? '');
    return m ? Number(m[1]) * { '': 1, K: 1 << 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 }[m[2].toUpperCase()] : null;
  };
  const total = num('total');
  const used = num('used');
  return total && used != null ? (used / total) * 100 : null;
}

function memoryReading() {
  const run = (k) => {
    try {
      const r = spawnSync('sysctl', ['-n', k], { encoding: 'utf8', timeout: 10000 });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const raw = run('kern.memorystatus_vm_pressure_level');
  const level = /^\d+$/.test(raw ?? '') ? Number(raw) : null;
  const swap = swapPercent(run('vm.swapusage'));
  return { pressure: level, swap, text: `pressure ${level ?? '?'}, swap ${swap == null ? '?' : `${Math.round(swap)}%`}` };
}

function realDeps() {
  return {
    now: () => new Date(),
    procs: processes,
    deadLeases: (cfg) => readState(cfg.runCfg).leases.filter((l) => !alive(l.pid)),
    liveLeases: (cfg) => readState(cfg.runCfg).leases.filter((l) => alive(l.pid)),
    reap: (cfg) => reap(cfg.runCfg).lines,
    booted: bootedSimNames,
    shutdownSim,
    kill(pid, signal) {
      if (process.env.FK_JANITOR_KILL) return spawnSync(process.env.FK_JANITOR_KILL, [signal, String(pid)]).status === 0;
      return killPid(pid, 3000, signal);
    },
    memory: memoryReading,
  };
}

/**
 * One pass. `apply` false only reports. Returns the lines it wrote ({ what, why }); `log(line)` records each.
 * Never throws for a missing tool: a step that cannot read its input is skipped.
 */
export function sweep(cfg, { apply = false, log = () => {}, deps = realDeps() } = {}) {
  const actions = [];
  const act = (what, why, doit) => {
    let did = '';
    if (apply) {
      try {
        did = doit() === false ? ' (failed)' : '';
      } catch (e) {
        did = ` (failed: ${e?.message ?? e})`;
      }
    }
    actions.push({ what: what + did, why });
    log({ what: what + did, why });
  };
  const guarded = (name, fn) => {
    try {
      fn();
    } catch (e) {
      log({ what: `${name} skipped`, why: `error: ${e?.message ?? e}` });
    }
  };

  // a. dead leases
  guarded('reap', () => {
    const dead = deps.deadLeases(cfg);
    if (!dead.length) return;
    if (apply) {
      for (const l of deps.reap(cfg)) {
        actions.push({ what: l, why: 'lease holder gone' });
        log({ what: l, why: 'lease holder gone' });
      }
    } else for (const l of dead) act(`reap lease ${l.id} (${l.job}, owner ${l.owner}, pid ${l.pid} gone)`, 'lease holder gone', () => true);
  });

  let procs = [];
  let leases = [];
  guarded('read processes and leases', () => {
    procs = deps.procs();
    leases = deps.liveLeases(cfg);
  });
  const selfPids = new Set();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (let p = process.pid, i = 0; p > 1 && i < 64; i++, p = byPid.get(p)?.ppid ?? 0) selfPids.add(p);

  // b. orphaned tools
  guarded('orphans', () => {
    for (const c of orphanCandidates(procs, leases, cfg, selfPids))
      act(`stop orphaned pid ${c.pid} (${c.signal}): ${c.cmd.slice(0, 160)}`, c.why, () => deps.kill(c.pid, c.signal));
  });

  // c. idle simulators; d. the memory backstop
  const booted = deps.booted();
  if (!booted?.size) return actions;
  const gone = new Set();
  const keepRes = cfg.keepBooted.map(globRe);
  const keep = (u) => keepRes.some((re) => re.test(u) || re.test(booted.get(u)));
  const owned = (u) => leases.some((l) => leaseMayOwn(u, l));
  const shut = (u, why) => {
    gone.add(u);
    act(`shut down simulator ${booted.get(u)} (${u})`, why, () => deps.shutdownSim(u));
  };
  let named = new Map();
  guarded('idle simulators', () => {
    const inUse = simsInUse(simsPsText(procs), { idleMin: cfg.idleMin, selfPid: process.pid });
    named = simsInUse(simsPsText(procs), { idleMin: 0, selfPid: process.pid });
    for (const u of booted.keys()) {
      if (inUse.has(u) || keep(u) || owned(u)) continue;
      shut(u, `idle for at least ${cfg.idleMin} min ([sim] idle_minutes), no live lease may own it`);
    }
  });
  guarded('memory backstop', () => {
    const m = deps.memory();
    const critical = m.pressure === 4;
    const swapFull = m.swap != null && m.swap >= cfg.swapPct;
    if (!critical && !swapFull) return;
    const left = [...booted.keys()].filter((u) => !gone.has(u));
    const reason = `${critical ? 'memory pressure critical' : `swap ${Math.round(m.swap)}% >= ${cfg.swapPct}% ([janitor] swap_pct)`} (${m.text})`;
    if (!left.length) return;
    for (const u of left) {
      if (keep(u)) log({ what: `kept simulator ${booted.get(u)} (${u})`, why: `${reason}; [sim] keep_booted names it` });
      else if (owned(u)) log({ what: `kept simulator ${booted.get(u)} (${u})`, why: `${reason}; a live lease may own it` });
      else if (named.has(u)) log({ what: `kept simulator ${booted.get(u)} (${u})`, why: `${reason}; ${named.get(u)} uses it` });
      else shut(u, reason);
    }
    if (apply) log({ what: 'memory after', why: `${m.text} -> ${deps.memory().text}` });
  });
  return actions;
}

// ------------------------------------------------------------ log and state files

function makeLogger(cfg, mode) {
  mkdirSync(cfg.dir, { recursive: true });
  const file = join(cfg.dir, 'janitor.log');
  try {
    if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`);
  } catch {}
  return ({ what, why }) => {
    const line = `${new Date().toISOString()} ${mode} ${what} | ${why}`;
    appendFileSync(file, `${line}\n`);
    process.stdout.write(`janitor: ${mode} ${what} | ${why}\n`);
  };
}

const enabledFile = (cfg) => join(cfg.dir, 'enabled');
const isEnabled = (cfg) => existsSync(enabledFile(cfg));

// a pass already running (a manual one beside the scheduled one) is not doubled; a lock older than 10 minutes is stale
function takeLock(cfg) {
  const dir = join(cfg.dir, 'pass.lock');
  mkdirSync(cfg.dir, { recursive: true });
  try {
    mkdirSync(dir);
    return () => rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      if (Date.now() - statSync(dir).mtimeMs > 600000) {
        rmSync(dir, { recursive: true, force: true });
        return takeLock(cfg);
      }
    } catch {}
    return null;
  }
}

// ------------------------------------------------------------ housekeeping
const HOUSEKEEPING_EVERY_MS = 20 * 60 * 60 * 1000; // about once a day
const HOUSEKEEPING_ONLY = ['worktrees', 'derived-data', 'tmp'];

/**
 * Once a day, `factory cleanup` for what finished work leaves behind: merged agent worktrees, stale build folders and
 * old scratch. Cleanup's own rules decide (a worktree with unpushed or modified work, a locked one, or one git touched
 * in the last minutes is kept). Dry unless applying: then only its REMOVE lines are logged. Skipped from launchd, which
 * may not read the project (it runs against the config copy): the session-end pass and passes by hand do it.
 */
export function housekeeping(cfg, { apply = false, log = () => {}, now = Date.now(), env = process.env } = {}) {
  if (!env.FACTORY_TOML || env.FACTORY_TOML === snapshotPath(cfg)) return [];
  const stamp = join(cfg.dir, 'housekeeping');
  try {
    if (now - statSync(stamp).mtimeMs < HOUSEKEEPING_EVERY_MS) return [];
  } catch {}
  const cmd = env.FK_JANITOR_CLEANUP || join(KIT, 'bin', 'factory');
  const args = [...(env.FK_JANITOR_CLEANUP ? [] : ['cleanup']), ...HOUSEKEEPING_ONLY.flatMap((c) => ['--only', c]), ...(apply ? ['--apply'] : [])];
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15 * 60 * 1000, env });
  if (r.error || r.status !== 0) {
    log({ what: 'housekeeping', why: `factory cleanup failed (${r.error?.message ?? `exit ${r.status}`}); tries again next pass` });
    return [];
  }
  mkdirSync(cfg.dir, { recursive: true });
  writeFileSync(stamp, `${new Date(now).toISOString()}\n`);
  const actions = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*REMOVE\s+(.*)$/.exec(line);
    if (m) {
      actions.push({ kind: 'housekeeping', what: m[1] });
      log({ what: `${apply ? 'removed' : 'would remove'} ${m[1]}`, why: 'factory cleanup (merged worktree, stale build or old scratch)' });
    }
  }
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*KEPT\s+(\S+)\s+\((kept: base of [^)]*)\)/.exec(line);
    if (m) log({ what: `kept ${m[1]}`, why: m[2] });
  }
  for (const summary of [/^derived-data: [^\n]*/m.exec(r.stdout)?.[0], /^total (?:reclaimable|removed)[^\n]*/m.exec(r.stdout)?.[0]]) {
    if (summary) log({ what: 'housekeeping', why: summary });
  }
  return actions;
}

function runPass(cfg, { apply, scheduled }) {
  const doApply = apply || (scheduled && isEnabled(cfg));
  const mode = doApply ? 'apply' : 'dry';
  const unlock = takeLock(cfg);
  if (!unlock) {
    console.log('janitor: another pass is running; skipped');
    return 0;
  }
  try {
    const ignored = toolPatterns(cfg.tools).ignored;
    const logger = makeLogger(cfg, mode);
    for (const t of ignored) logger({ what: `ignored [janitor] tools entry ${JSON.stringify(t)}`, why: 'too broad: a name, glob or text of at least 3 characters' });
    const actions = sweep(cfg, { apply: doApply, log: logger });
    actions.push(...housekeeping(cfg, { apply: doApply, log: logger }));
    writeFileSync(join(cfg.dir, 'last'), `${JSON.stringify({ time: new Date().toISOString(), mode, actions: actions.length })}\n`);
    if (!actions.length) console.log(`janitor: ${mode} pass: nothing to do`);
  } finally {
    unlock();
  }
  return 0;
}

// ------------------------------------------------------------ launchd

const label = (cfg) => `com.factory-kit.janitor.${cfg.project.replace(/[^A-Za-z0-9_.-]+/g, '-')}`;
const agentsDir = () => process.env.FK_JANITOR_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
const plistPath = (cfg) => join(agentsDir(), `${label(cfg)}.plist`);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// the kit's own entry point, not the project's shim: the project folder is usually one launchd can't read
const shimPath = (given) => given || join(KIT, 'bin', 'factory');
const snapshotPath = (cfg) => join(cfg.dir, 'factory.toml');
// folders macOS's privacy protection keeps from a launchd agent
// FK_JANITOR_PROTECTED_DIRS (colon-separated) replaces the list: tests run from a checkout in ~/Documents
const protectedDirs = () =>
  process.env.FK_JANITOR_PROTECTED_DIRS != null
    ? process.env.FK_JANITOR_PROTECTED_DIRS.split(':').filter(Boolean)
    : ['Documents', 'Desktop', 'Downloads'].map((d) => join(homedir(), d));
const isProtected = (p) => protectedDirs().some((d) => p === d || p.startsWith(`${d}/`));

/** Copy the project's factory.toml to the state dir when it changed; returns the copy's path. */
function syncSnapshot(cfg) {
  const snap = snapshotPath(cfg);
  const src = process.env.FACTORY_TOML;
  if (!src || src === snap) return snap;
  const text = readFileSync(src, 'utf8');
  let old = null;
  try {
    old = readFileSync(snap, 'utf8');
  } catch {}
  if (old !== text) {
    mkdirSync(cfg.dir, { recursive: true });
    writeFileSync(snap, text);
  }
  return snap;
}

export function plist(cfg, { interval, shim, toml }) {
  const dict = (o) => Object.entries(o).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label(cfg))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(shim)}</string>
    <string>janitor</string>
    <string>run</string>
    <string>--scheduled</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${dict({ FACTORY_TOML: toml, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() })}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(cfg.dir)}</string>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(join(cfg.dir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(cfg.dir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8', timeout: 30000 });
const domain = () => `gui/${process.getuid?.() ?? 501}`;

function install(cfg, o) {
  if (process.platform !== 'darwin' && !process.env.FK_JANITOR_AGENTS_DIR) {
    console.error('factory janitor install: launchd is macOS only');
    return 1;
  }
  const file = plistPath(cfg);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(cfg.dir, { recursive: true });
  const toml = syncSnapshot(cfg);
  const shim = shimPath(o.shim);
  for (const [what, p] of [['the kit', shim], ['the state dir', cfg.dir]]) {
    if (isProtected(p)) console.error(`factory janitor install: warning: ${what} (${p}) is in a folder macOS keeps from launchd agents; scheduled passes will fail with "Operation not permitted"`);
  }
  writeFileSync(file, plist(cfg, { interval: o.interval, shim, toml }));
  launchctl('bootout', `${domain()}/${label(cfg)}`); // a copy already loaded is replaced; nothing loaded is fine
  const r = launchctl('bootstrap', domain(), file);
  if (r.error || r.status !== 0) {
    console.error(`factory janitor install: launchctl bootstrap failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
    return 1;
  }
  console.log(`janitor: installed ${file} (every ${o.interval}s)`);
  console.log(isEnabled(cfg) ? 'janitor: enabled: scheduled passes apply' : 'janitor: DISABLED (dry run): scheduled passes only log. After reading a few in the log, run `factory janitor enable`');
  return 0;
}

/**
 * From a pass run by hand or by a hook: keep the scheduled pass's copy of factory.toml current, and re-install the agent
 * when what it would run changed (a new kit version, the copy's path). Keeps the installed interval. Never installs.
 */
function refreshAgent(cfg) {
  // a kit run from a protected folder (a local checkout in ~/Documents) is one launchd can't run: keep the agent as is
  if (isProtected(KIT)) return;
  try {
    syncSnapshot(cfg);
    const file = plistPath(cfg);
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    const interval = Number(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1] ?? 300);
    const shim = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
    // a --shim given at install is kept; the kit's own entry point follows the kit version this pass runs
    const custom = shim && !isProtected(shim) && !shim.endsWith('/bin/factory') ? shim : null;
    const want = plist(cfg, { interval, shim: shimPath(custom), toml: snapshotPath(cfg) });
    if (want === text) return;
    writeFileSync(file, want);
    launchctl('bootout', `${domain()}/${label(cfg)}`);
    launchctl('bootstrap', domain(), file);
    makeLogger(cfg, 'refresh')({ what: 'agent', why: `re-installed ${file}: the kit or its config copy changed` });
  } catch {
    // a refresh never blocks the pass
  }
}

function uninstall(cfg) {
  const file = plistPath(cfg);
  launchctl('bootout', `${domain()}/${label(cfg)}`);
  const had = existsSync(file);
  rmSync(file, { force: true });
  console.log(had ? `janitor: uninstalled ${file}` : 'janitor: was not installed');
  return 0;
}

function status(cfg) {
  console.log(`installed: ${existsSync(plistPath(cfg)) ? `yes (${plistPath(cfg)})` : 'no'}`);
  console.log(`enabled:   ${isEnabled(cfg) ? 'yes: scheduled passes apply' : 'no: scheduled passes only log (dry run)'}`);
  try {
    const l = JSON.parse(readFileSync(join(cfg.dir, 'last'), 'utf8'));
    console.log(`last pass: ${l.time} (${l.mode}, ${l.actions} action${l.actions === 1 ? '' : 's'})`);
  } catch {
    console.log('last pass: never');
  }
  try {
    const lines = readFileSync(join(cfg.dir, 'janitor.log'), 'utf8').trim().split('\n').slice(-10);
    console.log(`log (last ${lines.length}):`);
    for (const l of lines) console.log(`  ${l}`);
  } catch {
    console.log('log: empty');
  }
  return 0;
}

// ------------------------------------------------------------ CLI

const USAGE = 'usage: factory janitor run [--apply] [--scheduled] | enable | disable | status | install [--interval <s>] [--shim <path>] | uninstall';

export function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help') {
    console.log(USAGE);
    return sub ? 0 : 1;
  }
  const o = { apply: false, scheduled: false, interval: 300, shim: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--scheduled') o.scheduled = true;
    else if (a === '--interval') o.interval = Number(rest[++i]);
    else if (a === '--shim') o.shim = rest[++i];
    else {
      console.error(`factory janitor: unknown argument ${a}\n${USAGE}`);
      return 1;
    }
  }
  if (!Number.isInteger(o.interval) || o.interval < 60) {
    console.error('factory janitor: --interval wants whole seconds, at least 60');
    return 1;
  }
  let cfg;
  try {
    cfg = settings();
  } catch (e) {
    console.error(`factory janitor: ${e.message}`);
    return 1;
  }
  switch (sub) {
    case 'run':
      if (!o.scheduled) refreshAgent(cfg);
      return runPass(cfg, o);
    case 'enable':
      mkdirSync(cfg.dir, { recursive: true });
      writeFileSync(enabledFile(cfg), `${new Date().toISOString()}\n`);
      console.log('janitor: enabled: scheduled passes now apply');
      return 0;
    case 'disable':
      rmSync(enabledFile(cfg), { force: true });
      console.log('janitor: disabled: scheduled passes only log (dry run)');
      return 0;
    case 'status':
      return status(cfg);
    case 'install':
      return install(cfg, o);
    case 'uninstall':
      return uninstall(cfg);
    default:
      console.error(`factory janitor: unknown command ${sub}\n${USAGE}`);
      return 1;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked) process.exitCode = main(process.argv.slice(2));
