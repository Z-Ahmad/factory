import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, factory, scratch } from './helpers.mjs';
import { isTool, orphanCandidates, plist, sweep, swapPercent, toolPatterns } from '../cmd/janitor.mjs';
const KIT_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Fake pids sit above any real pid (macOS stops at 99998, Linux at 4194304), so no test can signal a real process.
const P = (n) => 90_000_000 + n;
const row = (n, ppid, age, cmd, pgid = n) => ({ pid: P(n), ppid: ppid === 1 ? 1 : P(ppid), pgid: P(pgid), age, cmd });
const XB = '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -scheme App -destination platform=iOS';
const XCT = '/Applications/Xcode.app/Contents/Developer/Library/Xcode/Agents/xctest';
const CFG = { orphanMin: 10, swapPct: 80, tools: [], idleMin: 30, keepBooted: [] };
const MIN = 60;

const ids = (cands) => cands.map((c) => c.pid - 90_000_000).sort((a, b) => a - b);

test('orphans: only an old named tool whose parent is gone and that no live lease owns is a candidate', () => {
  const procs = [
    // positives
    row(10, 1, 3600, XB), // old orphan xcodebuild
    row(11, 10, 3600, XCT), // its xctest child: the whole chain up to launchd is named tools
    row(12, 1, 1200, '/usr/bin/xcrun simctl io 8A1B recordVideo --codec=h264 /tmp/x.mp4'),
    row(13, 1, 1200, 'xcrun simctl spawn 8A1B log stream'),
    // the live lease's xcodebuild and its xctest, reparented to launchd (group = the lease's)
    row(20, 1, 3600, XB, 21),
    row(21, 1, 3600, XB, 21),
    row(22, 21, 3600, XCT, 21),
    row(23, 20, 3600, XCT, 23), // child of a process in no lease group, but descended from lease pid 20 (see leases)
    // started from Xcode.app: the parent chain includes Xcode
    row(30, 1, 99999, '/Applications/Xcode.app/Contents/MacOS/Xcode'),
    row(31, 30, 3600, XB),
    row(32, 31, 3600, XCT),
    // a young orphan
    row(40, 1, 5 * MIN, XB),
    // unrelated user processes, however old and orphaned
    row(50, 1, 99999, '/Applications/Spotify.app/Contents/MacOS/Spotify'),
    row(51, 1, 99999, 'node /Users/me/app/server.js'),
    row(52, 1, 99999, '/Applications/Simulator.app/Contents/MacOS/Simulator'),
    // a tool under a live shell: someone still owns it
    row(60, 61, 3600, XB),
    row(61, 1, 3600, '-zsh'),
    // a tool under a live non-tool process that is itself an orphan
    row(70, 71, 3600, XB),
    row(71, 1, 3600, 'node /Users/me/mcp-server.js'),
  ];
  const leases = [
    { pid: P(19), pgid: P(21), job: 'test' },
    { pid: P(20), pgid: P(20), job: 'build' },
  ];
  const got = orphanCandidates(procs, leases, CFG);
  assert.deepEqual(ids(got), [10, 11, 12, 13]);
  const byPid = Object.fromEntries(got.map((c) => [c.pid - 90_000_000, c]));
  assert.equal(byPid[12].signal, 'SIGINT'); // a recording is told to finish
  assert.equal(byPid[10].signal, 'SIGTERM');
  assert.match(byPid[11].why, /under orphaned xcodebuild/);
  // the age limit is [janitor] orphan_minutes
  assert.deepEqual(ids(orphanCandidates(procs, leases, { ...CFG, orphanMin: 2 })), [10, 11, 12, 13, 40]);
  assert.deepEqual(ids(orphanCandidates(procs, leases, { ...CFG, orphanMin: 100 })), []);
  // this pass and its ancestors are never candidates
  assert.deepEqual(ids(orphanCandidates(procs, leases, CFG, new Set([P(10), P(12)]))), [11, 13]);
});

test('orphans: [janitor] tools adds names but a broad entry is ignored', () => {
  const { ok, ignored } = toolPatterns(['*', '?', 'ab', ' ', 'mytestrunner', 'run-*', 'npm run ios:test']);
  assert.deepEqual(ignored, ['*', '?', 'ab', '']);
  assert.equal(ok.length, 3);
  const tools = ['mytestrunner', 'npm run ios:test'];
  const procs = [
    row(1, 1, 3600, '/opt/bin/mytestrunner --all'),
    row(2, 1, 3600, 'node /x/npm-cli.js run ios:test -w app'),
    row(3, 1, 3600, 'npm run ios:test'),
    row(4, 1, 3600, '/usr/bin/bash /Users/me/other.sh'),
    row(5, 1, 99999, '/Applications/Spotify.app/Contents/MacOS/Spotify'),
  ];
  assert.deepEqual(ids(orphanCandidates(procs, [], { ...CFG, tools })), [1, 3]);
  // even a configured pattern never reaches an app's main binary, nor a process that is not an orphan
  const wide = { ...CFG, tools: ['Spotify', 'bash', 'zsh'] };
  assert.deepEqual(ids(orphanCandidates([...procs, row(6, 7, 3600, 'zsh'), row(7, 8, 3600, 'sleep 5'), row(8, 1, 3600, 'init')], [], wide)), [4]);
  assert.ok(isTool('xcrun simctl spawn X log', []));
  assert.ok(!isTool('xcrun simctl list devices', []));
  assert.ok(!isTool('/usr/bin/open -a Xcode', []));
});

// ------------------------------------------------------------ the whole pass, with fakes

const U = (n) => `0000000${n}-AAAA-BBBB-CCCC-DDDDDDDDDDDD`;
function fakes(extra = {}) {
  const calls = { kill: [], shutdown: [], reap: 0 };
  const lines = [];
  const booted = new Map([[U(1), 'idle'], [U(2), 'held'], [U(3), 'named'], [U(4), 'kept'], [U(5), 'leasebooted'], [U(6), 'young'], [U(7), 'old-in-lease-list']]);
  const procs = [
    row(10, 1, 3600, XB),
    row(11, 1, 5 * MIN, XB),
    row(20, 1, 3600, `${XB.replace('platform=iOS', `id=${U(3)}`)}`, 21), // names U(3); in lease group 21
    // U(6) booted a minute ago: its launchd_sim is young
    row(30, 1, 60, `/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${U(6)}/data/var/run/launchd_bootstrap.plist`),
  ];
  const deps = {
    procs: () => procs,
    deadLeases: () => [],
    liveLeases: () => [
      { id: 'L1', pid: P(19), pgid: P(21), job: 'test', sim: U(2), booted: [U(1), U(3), U(4), U(6), U(7)] },
    ],
    reap: () => {
      calls.reap++;
      return [];
    },
    booted: () => booted,
    shutdownSim: (u) => (calls.shutdown.push(u), true),
    kill: (pid, sig) => (calls.kill.push([pid - 90_000_000, sig]), true),
    memory: () => ({ pressure: 1, swap: 10, text: 'pressure 1, swap 10%' }),
    ...extra,
  };
  return { calls, lines, deps, run: (apply, cfg = {}) => sweep({ ...CFG, ...cfg }, { apply, deps, log: (l) => lines.push(l) }) };
}

test('sweep (dry): logs what it would do and never signals or shuts down anything', () => {
  const f = fakes({ memory: () => ({ pressure: 4, swap: 95, text: 'pressure 4, swap 95%' }) });
  const acts = f.run(false, { keepBooted: ['kept'] });
  assert.deepEqual(f.calls.kill, []);
  assert.deepEqual(f.calls.shutdown, []);
  assert.equal(f.calls.reap, 0);
  assert.ok(acts.some((a) => /stop orphaned pid 90000010/.test(a.what)));
  assert.ok(acts.some((a) => /shut down simulator idle/.test(a.what)));
  assert.equal(acts.some((a) => /\(failed/.test(a.what)), false);
});

test('sweep (apply): an old orphan is stopped, an idle sim shut down; live leases, young, named and kept things stay', () => {
  const f = fakes();
  f.run(true, { keepBooted: ['kept'] });
  // pid 10 is the old orphan; pid 11 is young; pid 20 is in the live lease's group
  assert.deepEqual(f.calls.kill, [[10, 'SIGTERM']]);
  // idle: U(1) only. held (lease --sim), named (a process names it), kept ([sim] keep_booted), a sim the lease may have
  // booted (not in its list), young (booted a minute ago): untouched. U(7) is in the lease's list and old: idle.
  assert.deepEqual(f.calls.shutdown.sort(), [U(1), U(7)].sort());
  assert.ok(f.lines.every((l) => l.why));
});

test('sweep: memory critical or swap over [janitor] swap_pct shuts down every sim no live lease may own, even young ones', () => {
  for (const mem of [{ pressure: 4, swap: 10 }, { pressure: 1, swap: 85 }]) {
    const f = fakes({ memory: () => ({ ...mem, text: `pressure ${mem.pressure}, swap ${mem.swap}%` }) });
    f.run(true, { keepBooted: ['kept'] });
    // U(1), U(7) idle; U(6) young: shut by the backstop. Not: held U(2), named U(3), kept U(4), lease-may-own U(5)
    assert.deepEqual(f.calls.shutdown.sort(), [U(1), U(6), U(7)].sort());
    assert.ok(f.lines.some((l) => /memory after/.test(l.what) && /pressure/.test(l.why)));
    assert.ok(f.lines.some((l) => l.what.includes(`kept simulator named`) && /uses it/.test(l.why)));
    assert.ok(f.lines.some((l) => l.what.includes('kept simulator leasebooted') && /live lease may own/.test(l.why)));
  }
  // normal pressure, swap under the limit: the young sim stays
  const f = fakes({ memory: () => ({ pressure: 1, swap: 79, text: 'x' }) });
  f.run(true);
  assert.ok(!f.calls.shutdown.includes(U(6)));
  assert.equal(swapPercent('total = 11264.00M  used = 10137.00M  free = 1127.00M  (encrypted)').toFixed(1), '90.0');
  assert.equal(swapPercent('total = 2.00G  used = 512.00M'), 25);
  assert.equal(swapPercent('total = 0.00M  used = 0.00M'), null);
  assert.equal(swapPercent(null), null);
});

test('sweep: a missing xcrun, ps or sysctl skips its step and never throws', () => {
  const f = fakes({ booted: () => null, procs: () => [], memory: () => ({ pressure: null, swap: null, text: 'pressure ?, swap ?' }) });
  assert.deepEqual(f.run(true), []);
  const g = fakes({ procs: () => { throw new Error('ps is missing'); } });
  assert.doesNotThrow(() => g.run(true));
});

test('sweep: dead leases are reaped (listed in a dry run)', () => {
  const dead = [{ id: 'D1', job: 'build', owner: 'a', pid: P(1) }];
  const f = fakes({ deadLeases: () => dead, reap: () => ['reaped lease D1 (build, owner a, pid gone): nothing left running'] });
  f.run(false);
  assert.ok(f.lines.some((l) => /reap lease D1/.test(l.what)));
  assert.equal(f.calls.reap, 0);
  const g = fakes({ deadLeases: () => dead, reap: () => ['reaped lease D1 (build, owner a, pid gone): nothing left running'] });
  g.run(true);
  assert.ok(g.lines.some((l) => /^reaped lease D1/.test(l.what)));
});

// ------------------------------------------------------------ the command, against stubbed ps, xcrun, sysctl, launchctl

function project() {
  const s = scratch();
  const dir = realpathSync(s.dir);
  const p = (...a) => join(dir, ...a);
  for (const d of ['bin', 'r', 'agents']) mkdirSync(p(d));
  const R = p('r');
  const stub = (name, body) => {
    writeFileSync(p('bin', name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p('bin', name), 0o755);
  };
  // plenty of free disk, so the disk gate and the janitor's disk check never act on the machine running the tests
  stub('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 1 1 524288000 1%% /\\n"')
  stub('osascript', 'exit 0')
  stub('ps', `cat '${R}/ps' 2>/dev/null; true`);
  stub('sysctl', `case "$2" in
  kern.memorystatus_vm_pressure_level) cat '${R}/pressure' 2>/dev/null || echo 1 ;;
  vm.swapusage) cat '${R}/swap' 2>/dev/null || echo "total = 1000.00M  used = 10.00M  free = 990.00M  (encrypted)" ;;
  *) exit 1 ;;
esac`);
  stub('xcrun', `B='${R}/booted'
if [ "$1 $2 $3 $4" = "simctl list devices booted" ]; then
  printf '{"devices":{"rt":['; first=1
  for u in $(cat "$B" 2>/dev/null); do [ $first = 1 ] || printf ','; first=0; printf '{"udid":"%s","name":"%s","state":"Booted"}' "$u" "$u"; done
  echo ']}}'
elif [ "$1 $2" = "simctl shutdown" ]; then echo "$3" >> '${R}/shutdowns'
else exit 1; fi`);
  stub('killrec', `echo "$1 $2" >> '${R}/kills'`);
  stub('launchctl', `echo "$@" >> '${R}/launchctl'`);
  // factory cleanup stand-in: records its arguments, prints what the real one would
  stub('cleanuprec', `echo "$@" >> '${R}/cleanup'
echo "== worktrees =="
echo "  REMOVE agent-old  (branch claude/x, PR #12 merged)"
echo "  KEPT  agent-live (locked)"
DD=reclaimable; T=reclaimable
case " $* " in *" --apply "*) DD=freed; T=removed ;; esac
echo "derived-data: 2 stale build folders, 3.0G $DD"
echo "total $T: 3.1G (derived-data, frames, clips, tmp, archives)"`);
  writeFileSync(p('factory.toml'), `[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.0.0"

[project]
name          = "fixture app"
main_checkout = "${dir}"
state_dir     = "${p('state')}"

[git]
worktrees_dir   = ".worktrees"
worktree_branch = "x/{name}"
push_branch     = "n/{name}"

[[targets]]
name    = "app"
base    = "origin/trunk"
pr_base = "trunk"
default = true

[sim]
idle_minutes = 30

[janitor]
orphan_minutes = 10
`);
  const env = {
    FACTORY_TOML: p('factory.toml'),
    PATH: `${p('bin')}:${process.env.PATH}`,
    FK_JANITOR_KILL: p('bin', 'killrec'),
    FK_JANITOR_AGENTS_DIR: p('agents'),
    FK_JANITOR_CLEANUP: p('bin', 'cleanuprec'),
    FK_JANITOR_PROTECTED_DIRS: p('protected'),
    FK_RUN_SWAP_PROBE_S: '0',
  };
  const etime = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const setPs = (rows) => writeFileSync(p('r', 'ps'), rows.map((r) => `${r.pid} ${r.ppid} ${r.pgid} ${etime(r.age)} ${r.cmd}`).join('\n') + '\n');
  const read = (...a) => (existsSync(p(...a)) ? readFileSync(p(...a), 'utf8').split('\n').filter(Boolean) : []);
  const jan = (args, more = {}) => factory(['janitor', ...args], { cwd: dir, env: { ...env, ...more } });
  const leaseFile = p('state', 'slot', 'leases.json');
  const setLeases = (leases) => {
    mkdirSync(p('state', 'slot'), { recursive: true });
    writeFileSync(leaseFile, JSON.stringify({ leases, queue: [] }));
  };
  return { dir, p, s, read, jan, setPs, setLeases, leaseFile, kills: () => read('r', 'kills'), shutdowns: () => read('r', 'shutdowns'), booted: (...u) => writeFileSync(p('r', 'booted'), u.join('\n') + '\n') };
}

function scene(t) {
  t.setPs([
    row(10, 1, 3600, XB), // old orphan
    row(11, 1, 5 * MIN, XB), // young orphan
    row(20, 1, 3600, XB, 21), // the live lease's
    row(21, 20, 3600, XCT, 21),
    row(30, 1, 99999, '/Applications/Xcode.app/Contents/MacOS/Xcode'),
    row(31, 30, 3600, XB),
    row(50, 1, 99999, '/Applications/Spotify.app/Contents/MacOS/Spotify'),
    row(51, 1, 99999, 'node /Users/me/app/server.js'),
  ]);
  t.booted(U(1), U(2));
  t.setLeases([
    { id: 'live', job: 'test', weight: 2, pid: process.pid, owner: 'me', pgid: P(21), sim: U(2), booted: [U(1), U(2)], started: new Date().toISOString() },
    { id: 'dead', job: 'build', weight: 2, pid: P(99), owner: 'gone', pgid: null, started: new Date().toISOString() },
  ]);
}

test('janitor run: without --apply, and while disabled, it only logs; nothing is killed, shut down or reaped', () => {
  const t = project();
  try {
    scene(t);
    for (const args of [['run'], ['run', '--scheduled']]) {
      const r = t.jan(args);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /janitor: dry stop orphaned pid 90000010 \(SIGTERM\)/);
      assert.match(r.stdout, /janitor: dry shut down simulator/);
      assert.match(r.stdout, /janitor: dry reap lease dead/);
      assert.doesNotMatch(r.stdout, /pid 9000001[1]|pid 9000002|pid 9000003|pid 9000005/);
    }
    assert.deepEqual(t.kills(), []);
    assert.deepEqual(t.shutdowns(), []);
    assert.equal(JSON.parse(readFileSync(t.leaseFile, 'utf8')).leases.length, 2);
    const log = t.read('state', 'janitor', 'janitor.log');
    assert.ok(log.length >= 6);
    assert.match(log.find((l) => /orphaned/.test(l)), /^\d{4}-\d\d-\d\dT[\d:.]+Z dry stop orphaned pid 90000010 .* \| .*old/);
  } finally {
    t.s.cleanup();
  }
});

test('janitor: --apply applies at once; --scheduled applies only after enable; disable stops it again', () => {
  const t = project();
  try {
    scene(t);
    const r = t.jan(['run', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(t.kills(), ['SIGTERM 90000010']);
    // the sim the live lease holds (U2) stays; U1 is in its list and idle, so it goes
    assert.deepEqual(t.shutdowns(), [U(1)]);
    assert.deepEqual(JSON.parse(readFileSync(t.leaseFile, 'utf8')).leases.map((l) => l.id), ['live']);
    assert.match(t.read('state', 'janitor', 'janitor.log').join('\n'), / apply stop orphaned pid 90000010/);
    // enable: a scheduled pass applies
    assert.match(t.jan(['enable']).stdout, /enabled/);
    assert.ok(existsSync(t.p('state', 'janitor', 'enabled')));
    t.booted(U(1), U(2));
    t.jan(['run', '--scheduled']);
    assert.equal(t.kills().length, 2);
    assert.equal(t.shutdowns().length, 2);
    // disable: back to a dry run
    assert.match(t.jan(['disable']).stdout, /disabled/);
    t.jan(['run', '--scheduled']);
    assert.equal(t.kills().length, 2);
    const st = t.jan(['status']).stdout;
    assert.match(st, /enabled: {3}no/);
    assert.match(st, /last pass: .*\(dry, \d+ actions?\)/);
    assert.match(st, /installed: no/);
  } finally {
    t.s.cleanup();
  }
});

test('janitor: memory pressure critical shuts down the sims no live lease holds, not the held one', () => {
  const t = project();
  try {
    t.setPs([row(60, 1, 60, `/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${U(3)}/data/var/run/launchd_bootstrap.plist`)]);
    t.booted(U(2), U(3), U(4));
    t.setLeases([{ id: 'live', job: 'test', weight: 2, pid: process.pid, owner: 'me', pgid: P(21), sim: U(2), booted: [U(2), U(3), U(4)], started: new Date().toISOString() }]);
    writeFileSync(t.p('r', 'pressure'), '4');
    const dry = t.jan(['run']);
    assert.match(dry.stdout, /dry shut down simulator .*memory pressure critical/);
    assert.deepEqual(t.shutdowns(), []);
    t.jan(['run', '--apply']);
    assert.deepEqual(t.shutdowns().sort(), [U(3), U(4)].sort()); // U(3) booted a minute ago, U(4) idle; U(2) held
    assert.match(t.read('state', 'janitor', 'janitor.log').join('\n'), /memory after \| pressure 4, swap \d+% -> pressure 4/);
  } finally {
    t.s.cleanup();
  }
});

test('janitor: the log rotates at about 1 MB', () => {
  const t = project();
  try {
    scene(t);
    mkdirSync(t.p('state', 'janitor'), { recursive: true });
    writeFileSync(t.p('state', 'janitor', 'janitor.log'), 'x'.repeat(1024 * 1024 + 10) + '\n');
    t.jan(['run']);
    assert.ok(existsSync(t.p('state', 'janitor', 'janitor.log.1')));
    assert.ok(readFileSync(t.p('state', 'janitor', 'janitor.log'), 'utf8').length < 5000);
  } finally {
    t.s.cleanup();
  }
});

test('janitor install / uninstall: a launchd agent in the (overridden) agents folder, idempotent, disabled by default', () => {
  const t = project();
  try {
    const plistFile = t.p('agents', 'com.factory-kit.janitor.fixture-app.plist');
    // the kit's own entry point and a copy of factory.toml in the state dir: launchd can't read ~/Documents, where the
    // project usually lives, so the scheduled pass never touches the project folder
    const shim = join(KIT_DIR, 'bin', 'factory');
    const snap = t.p('state', 'janitor', 'factory.toml');
    const a = t.jan(['install']);
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /DISABLED \(dry run\)/);
    const text = readFileSync(plistFile, 'utf8');
    assert.match(text, /<string>com\.factory-kit\.janitor\.fixture-app<\/string>/);
    assert.match(text, new RegExp(`<string>${shim}</string>\\s*<string>janitor</string>\\s*<string>run</string>\\s*<string>--scheduled</string>`));
    assert.match(text, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
    assert.match(text, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.match(text, new RegExp(`<key>FACTORY_TOML</key>\\s*<string>${snap}</string>`));
    assert.match(text, new RegExp(`<key>WorkingDirectory</key>\\s*<string>${t.p('state', 'janitor')}</string>`));
    assert.equal(readFileSync(snap, 'utf8'), readFileSync(t.p('factory.toml'), 'utf8'));
    assert.match(text, /StandardOutPath<\/key>\s*<string>[^<]*\/state\/janitor\/launchd\.out\.log/);
    assert.ok(!existsSync(t.p('state', 'janitor', 'enabled')));
    const calls = t.read('r', 'launchctl');
    assert.match(calls[0], /^bootout gui\/\d+\/com\.factory-kit\.janitor\.fixture-app$/);
    assert.match(calls[1], new RegExp(`^bootstrap gui/\\d+ ${plistFile}$`));
    // again: same file, bootout then bootstrap again, no error; a new interval replaces the old
    assert.equal(t.jan(['install']).status, 0);
    assert.equal(readFileSync(plistFile, 'utf8'), text);
    assert.equal(t.jan(['install', '--interval', '600']).status, 0);
    assert.match(readFileSync(plistFile, 'utf8'), /<integer>600<\/integer>/);
    assert.equal(t.read('r', 'launchctl').length, 6);
    assert.match(t.jan(['status']).stdout, /installed: yes/);
    // too short an interval is refused
    assert.equal(t.jan(['install', '--interval', '5']).status, 1);
    // a pass run by hand refreshes the copy, and re-installs an agent pointing at an old kit (keeping its interval)
    writeFileSync(t.p('factory.toml'), `${readFileSync(t.p('factory.toml'), 'utf8')}\n# changed\n`);
    writeFileSync(plistFile, readFileSync(plistFile, 'utf8').replace(shim, '/old/.factory-kit/v0.1.0/bin/factory'));
    const before = t.read('r', 'launchctl').length;
    assert.equal(t.jan(['run']).status, 0);
    assert.match(readFileSync(snap, 'utf8'), /# changed/);
    const now = readFileSync(plistFile, 'utf8');
    assert.ok(now.includes(`<string>${shim}</string>`) && /<integer>600<\/integer>/.test(now), now);
    assert.equal(t.read('r', 'launchctl').length, before + 2);
    // unchanged: no re-install
    assert.equal(t.jan(['run']).status, 0);
    assert.equal(t.read('r', 'launchctl').length, before + 2);
    // a kit running from a protected folder (a checkout in ~/Documents) never repoints the agent at itself
    writeFileSync(plistFile, readFileSync(plistFile, 'utf8').replace(shim, '/old/.factory-kit/v0.1.0/bin/factory'));
    const held = readFileSync(plistFile, 'utf8');
    assert.equal(t.jan(['run'], { FK_JANITOR_PROTECTED_DIRS: KIT_DIR }).status, 0);
    assert.equal(readFileSync(plistFile, 'utf8'), held);
    // uninstall
    const u = t.jan(['uninstall']);
    assert.equal(u.status, 0, u.stderr);
    assert.ok(!existsSync(plistFile));
    assert.match(t.read('r', 'launchctl').at(-1), /^bootout gui\/\d+\/com\.factory-kit\.janitor\.fixture-app$/);
    assert.match(t.jan(['uninstall']).stdout, /was not installed/);
  } finally {
    t.s.cleanup();
  }
});

test('janitor: usage errors and an unknown subcommand exit 1', () => {
  const t = project();
  try {
    assert.equal(t.jan([]).status, 1);
    assert.equal(t.jan(['frobnicate']).status, 1);
    assert.equal(t.jan(['run', '--nope']).status, 1);
  } finally {
    t.s.cleanup();
  }
});

test('janitor: plist escapes XML in paths', () => {
  const text = plist({ project: 'a&b', mainCheckout: '/x', dir: '/s/<y>/janitor' }, { interval: 300, shim: '/s/f', toml: '/s/<y>/janitor/factory.toml' });
  assert.match(text, /\/s\/&lt;y&gt;\/janitor/);
  assert.match(text, /janitor\.a&amp;b|janitor\.a-b/);
});

test('janitor housekeeping: once a day, factory cleanup for worktrees, builds and scratch; dry logs, apply passes --apply; never from launchd', () => {
  const t = project();
  try {
    // dry (not enabled): cleanup runs without --apply, its REMOVE lines are logged as "would remove"
    assert.equal(t.jan(['run']).status, 0);
    assert.deepEqual(t.read('r', 'cleanup'), ['--only worktrees --only derived-data --only tmp']);
    const log = t.read('state', 'janitor', 'janitor.log').join('\n');
    assert.match(log, /dry would remove agent-old {2}\(branch claude\/x, PR #12 merged\)/);
    assert.match(log, /derived-data: 2 stale build folders, 3\.0G reclaimable/);
    assert.ok(!log.includes('agent-live'), 'a KEPT worktree is not an action');
    // within the day: not again
    assert.equal(t.jan(['run', '--apply']).status, 0);
    assert.equal(t.read('r', 'cleanup').length, 1);
    // a day later, applying: --apply is passed and the totals say removed
    utimesSync(t.p('state', 'janitor', 'housekeeping'), new Date(Date.now() - 21 * 3600e3), new Date(Date.now() - 21 * 3600e3));
    assert.equal(t.jan(['run', '--apply']).status, 0);
    assert.equal(t.read('r', 'cleanup').at(-1), '--only worktrees --only derived-data --only tmp --apply');
    assert.match(t.read('state', 'janitor', 'janitor.log').join('\n'), /apply removed agent-old[\s\S]*total removed: 3\.1G/);
    // from launchd (the config copy): never, however long it has been
    utimesSync(t.p('state', 'janitor', 'housekeeping'), new Date(0), new Date(0));
    const copy = t.p('state', 'janitor', 'factory.toml');
    copyFileSync(t.p('factory.toml'), copy);
    assert.equal(t.jan(['run', '--scheduled'], { FACTORY_TOML: copy }).status, 0);
    assert.equal(t.read('r', 'cleanup').length, 2);
    // a failing cleanup is logged and tried again next pass (no stamp)
    rmSync(t.p('state', 'janitor', 'housekeeping'));
    const f = t.jan(['run'], { FK_JANITOR_CLEANUP: '/usr/bin/false' });
    assert.equal(f.status, 0, f.stdout + f.stderr);
    assert.match(f.stdout, /factory cleanup failed/, f.stdout + f.stderr);
    assert.match(t.read('state', 'janitor', 'janitor.log').join('\n'), /factory cleanup failed \(exit 1\); tries again next pass/);
    assert.ok(!existsSync(t.p('state', 'janitor', 'housekeeping')));
  } finally {
    t.s.cleanup();
  }
});
