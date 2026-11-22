#!/usr/bin/env node
// Which booted simulators is something using right now? Counted from the running processes, never remembered.
//   node lib/sims.mjs in-use [--idle-min N]     one "<UDID>\t<why>" line per simulator in use
// A simulator is in use when
//   - a running process outside it names its UDID on the command line: `factory proof` (sim-proof-core.sh --udid),
//     xcodebuild (-destination id=...), `simctl io ... recordVideo`, `simctl spawn ... log stream` (XcodeBuildMCP's log
//     capture), axe (XcodeBuildMCP's taps), any agent's shell command that names it;
//   - an app (a .app's main binary, not a widget or other extension) was launched in it less than N minutes ago
//     (XcodeBuildMCP's build_run_sim and launch_app_sim launch one; default 30);
//   - it booted less than N minutes ago (its launchd_sim is that young): someone is about to use it.
// The simulator's own processes (launchd_sim and everything under CoreSimulator/Devices/<UDID>/) name it too; those
// count only through the two age rules. Reads `ps -axo pid=,etime=,command=`.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const UDID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g;
const DEVICE_PATH = /\/CoreSimulator\/Devices\/([0-9A-F-]{36})\//;
const APP_MAIN = /\/data\/Containers\/Bundle\/Application\/[^/]+\/([^/]+)\.app\/([^/\s]+)(\s|$)/;

/** ps etime ("[[dd-]hh:]mm:ss") -> seconds; null when unreadable. */
export function etimeSeconds(t) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(t).trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** ps text -> Map(UDID -> why), the first reason found per simulator. */
export function simsInUse(psText, { idleMin = 30, selfPid = null } = {}) {
  const used = new Map();
  const add = (u, why) => { if (!used.has(u)) used.set(u, why); };
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, etime, cmd] = m;
    if (selfPid !== null && Number(pid) === selfPid) continue;
    const own = DEVICE_PATH.exec(cmd);
    if (own) {
      const age = etimeSeconds(etime);
      if (age === null || age >= idleMin * 60) continue;
      const mins = Math.floor(age / 60);
      if (/^\S*launchd_sim\s/.test(cmd)) add(own[1], `booted ${mins}m ago`);
      else {
        const app = APP_MAIN.exec(cmd);
        // the main binary is named like its .app; an extension lives deeper (PlugIns/X.appex/X) and never matches
        if (app && app[1] === app[2]) add(own[1], `${app[1]} launched ${mins}m ago`);
      }
      continue;
    }
    const ids = cmd.match(UDID);
    if (!ids) continue;
    const word = basename(cmd.split(/\s+/)[0]);
    const what = /recordVideo/.test(cmd) ? 'simctl recordVideo' : /sim-proof-core\.sh/.test(cmd) ? 'factory proof' : word;
    for (const u of ids) add(u, `${what} (pid ${pid})`);
  }
  return used;
}

/** The UDIDs of the booted simulators (`xcrun simctl list devices booted -j`); null when xcrun is missing or answers badly. */
export function bootedSims() {
  const m = bootedSimNames();
  return m ? new Set(m.keys()) : null;
}

/** Map(UDID -> name) of the booted simulators; null when xcrun is missing or answers badly. */
export function bootedSimNames() {
  try {
    const r = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 24 });
    if (r.error || r.status !== 0) return null;
    const out = new Map();
    for (const list of Object.values(JSON.parse(r.stdout).devices ?? {}))
      for (const d of list) if (d?.udid && d.state === 'Booted') out.set(d.udid, d.name ?? d.udid);
    return out;
  } catch {
    return null;
  }
}

/** `xcrun simctl shutdown <udid>`; true when it succeeded. */
export function shutdownSim(udid) {
  if (!/^[0-9A-Za-z-]+$/.test(udid)) return false;
  const r = spawnSync('xcrun', ['simctl', 'shutdown', udid], { encoding: 'utf8', timeout: 60000 });
  return !r.error && r.status === 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'in-use') {
    console.error('usage: node lib/sims.mjs in-use [--idle-min N]');
    return 2;
  }
  const i = rest.indexOf('--idle-min');
  const idleMin = i >= 0 ? Number(rest[i + 1]) : 30;
  if (!Number.isFinite(idleMin) || idleMin < 0) {
    console.error('--idle-min wants minutes');
    return 2;
  }
  const ps = spawnSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
  for (const [u, why] of simsInUse(ps.stdout ?? '', { idleMin, selfPid: process.pid })) console.log(`${u}\t${why}`);
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked) process.exitCode = main(process.argv.slice(2));
