import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, factory, scratch } from './helpers.mjs';
import { alive, waitFor } from './procs.mjs';
import { etimeSeconds, gates, swapRate } from '../cmd/run.mjs';

// factory run against a scratch project whose sysctl and vm_stat are fakes reading the files in <dir>/r (pressure,
// free, load, ncpu, swapouts), so a test changes a reading by writing a file. Leases live in <dir>/state/slot.
function project(slot = '') {
  const s = scratch();
  const dir = realpathSync(s.dir);
  const p = (...a) => join(dir, ...a);
  mkdirSync(p('bin'));
  mkdirSync(p('r'));
  const stub = (name, body) => {
    writeFileSync(p('bin', name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p('bin', name), 0o755);
  };
  const R = p('r');
  stub('sysctl', `v() { cat '${R}'/"$1" 2>/dev/null || echo "$2"; }
case "$2" in
  vm.loadavg) echo "{ $(v load 1.00) 1.00 1.00 }" ;;
  hw.ncpu) v ncpu 8 ;;
  kern.memorystatus_vm_pressure_level) v pressure 1 ;;
  kern.memorystatus_level) v free 46 ;;
  vm.swapusage) echo "total = 11264.00M  used = 10137.00M  free = 1.00M  (encrypted)" ;;
  *) exit 1 ;;
esac`);
  stub('vm_stat', `echo "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
echo "Swapouts:                                 $(cat '${R}/swapouts' 2>/dev/null || echo 100)."`);
  writeFileSync(p('factory.toml'), `[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.0.0"

[project]
name          = "fixture"
main_checkout = "${dir}"
state_dir     = "${p('state')}"
night_file    = "{state_dir}/night-{n}.md"

[git]
worktrees_dir   = ".worktrees"
worktree_branch = "x/{name}"
push_branch     = "n/{name}"

[[targets]]
name    = "app"
base    = "origin/trunk"
pr_base = "trunk"
default = true

[slot]
poll_s = 1
${slot}
`);
  const env = { FACTORY_TOML: p('factory.toml'), PATH: `${p('bin')}:${process.env.PATH}`, FK_RUN_SWAP_PROBE_S: '0', FK_RUN_LEASE: '', FK_SLOT_HELD: '' };
  const set = (name, value) => writeFileSync(p('r', name), String(value));
  const run = (args, more = {}) => factory(['run', ...args], { cwd: dir, env: { ...env, ...more } });
  const kids = [];
  // a background `factory run`; its stderr is collected in .err
  const start = (args, more = {}) => {
    const c = spawn(join(KIT, 'bin', 'factory'), ['run', ...args], { cwd: dir, env: { ...process.env, ...env, ...more }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.err = '';
    c.out = '';
    c.stderr.on('data', (d) => (c.err += d));
    c.stdout.on('data', (d) => (c.out += d));
    c.done = new Promise((ok) => c.on('exit', (code, signal) => ok({ code, signal })));
    kids.push(c);
    return c;
  };
  const leases = () => {
    try {
      return JSON.parse(readFileSync(p('state', 'slot', 'leases.json'), 'utf8'));
    } catch {
      return { leases: [], queue: [] };
    }
  };
  // a job that holds until the file <dir>/go-<name> exists, then exits 0
  const hold = (name) => ['sh', '-c', `while [ ! -f '${p(`go-${name}`)}' ]; do sleep 0.05; done`];
  const release = (name) => writeFileSync(p(`go-${name}`), '');
  const cleanup = async () => {
    for (const c of kids) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
    await Promise.all(kids.map((c) => c.done));
    s.cleanup();
  };
  return { dir, p, env, set, run, start, leases, hold, release, cleanup };
}

const sleeper = (args = [], opts = {}) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', ...args], { stdio: 'ignore', ...opts });

test('run: a job takes its weight out of the capacity; past it the next one queues inside, weight 0 never does', async () => {
  const t = project('capacity = 4');
  try {
    const a = t.start(['--job', 'build', '--owner', 'agent-a', '--dd', 'dd-a', '--sim', 'SIM-A', '--', ...t.hold('a')]);
    assert.ok(await waitFor(() => t.leases().leases.length === 1), a.err);
    const b = t.start(['--job', 'test', '--owner', 'agent-b', '--', ...t.hold('b')]);
    assert.ok(await waitFor(() => t.leases().leases.length === 2), b.err);
    const [la, lb] = t.leases().leases;
    assert.deepEqual([la.job, la.weight, la.owner, la.dd, la.sim], ['build', 2, 'agent-a', 'dd-a', 'SIM-A']);
    assert.deepEqual([lb.job, lb.weight, lb.owner], ['test', 2, 'agent-b']);
    assert.equal(la.pid, a.pid);
    assert.ok(Number.isInteger(la.pgid) && la.pgid !== la.pid, 'the command runs in a process group of its own');
    assert.match(la.cmd, /^sh -c 'while/);
    assert.ok(Date.parse(la.started) <= Date.now());
    // full: a proof (weight 1) queues, and says why
    const c = t.start(['--job', 'proof', '--owner', 'agent-c', '--', 'echo', 'proof ran']);
    assert.ok(await waitFor(() => /queued: capacity 4\/4 in use: build \(agent-a\), test \(agent-b\) \(\[slot\] capacity\)/.test(c.err)), c.err);
    assert.equal(t.leases().queue.length, 1);
    // weight 0 runs at once, with no lease
    const u = t.run(['--job', 'unit', '--', 'echo', 'unit ran']);
    assert.equal(u.status, 0, u.stderr);
    assert.equal(u.stdout, 'unit ran\n');
    assert.equal(t.leases().leases.length, 2);
    // status: the leases, the queue, the gates
    const st = t.run(['--status']);
    assert.equal(st.status, 1, st.stdout);
    assert.match(st.stdout, /^capacity 4\/4 in use\n {2}lease {2}build {6}weight 2 {2}owner agent-a {2}age \d+s {2}pid \d+ group \d+ {2}dd dd-a {2}sim SIM-A {2}sh -c/);
    assert.match(st.stdout, /\n {2}queue {2}1\. proof {6}weight 1 {2}owner agent-c {2}waiting \d+s {2}echo 'proof ran'\n/);
    assert.match(st.stdout, /\ngates: pressure normal; swapouts (?:\?|\d+)\/min; memory 46% free; load 1\n/);
    assert.match(st.stdout, /\na build \(weight 2\) would wait: 1 queued ahead; capacity 4\/4 in use: build \(agent-a\), test \(agent-b\), needs 2 \(\[slot\] capacity\)\n$/);
    // one lease frees: the proof starts, says how long it waited, and frees its own lease on exit
    t.release('a');
    assert.equal((await a.done).code, 0);
    assert.equal((await c.done).code, 0, c.err);
    assert.match(c.err, /run: proof \(weight 1\) admitted after \d+\.\d min waiting/);
    assert.equal(c.out, 'proof ran\n');
    t.release('b');
    await b.done;
    assert.deepEqual(t.leases(), { leases: [], queue: [] });
  } finally {
    await t.cleanup();
  }
});

test('run: the queue is first come, first served: a small job that would fit waits behind a big one', async () => {
  const t = project('capacity = 3');
  try {
    const a = t.start(['--job', 'build', '--owner', 'a', '--', ...t.hold('a')]);
    assert.ok(await waitFor(() => t.leases().leases.length === 1));
    const b = t.start(['--job', 'build', '--owner', 'b', '--', ...t.hold('b')]);
    assert.ok(await waitFor(() => t.leases().queue.length === 1));
    const c = t.start(['--job', 'proof', '--owner', 'c', '--', ...t.hold('c')]);
    assert.ok(await waitFor(() => t.leases().queue.length === 2));
    // c (weight 1) fits in 3 - 2, but b came first
    assert.ok(await waitFor(() => /1 ahead in the queue/.test(c.err)), c.err);
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(t.leases().leases.map((l) => l.owner), ['a']);
    t.release('a');
    assert.ok(await waitFor(() => t.leases().leases.map((l) => l.owner).join() === 'b,c', 8000), JSON.stringify(t.leases()));
    t.release('b');
    t.release('c');
    await Promise.all([a.done, b.done, c.done]);
  } finally {
    await t.cleanup();
  }
});

test('run: [slot.weights] adds job types and changes weights; an unknown type is refused; a weight past the capacity is capped', async () => {
  const t = project('capacity = 2\n\n[slot.weights]\nlint = 1\nbuild = 5');
  try {
    let r = t.run(['--job', 'frob', '--', 'true']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown job type 'frob' \(known: build, test, .*lint; add one under \[slot\.weights\]\)/);
    const a = t.start(['--job', 'lint', '--', ...t.hold('a')]);
    assert.ok(await waitFor(() => t.leases().leases[0]?.weight === 1));
    r = t.run(['--check', '--job', 'build']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^run: a build would wait \(capacity 1\/2 in use: lint \(.*\), needs 2 \(\[slot\] capacity\)\)\n$/);
    t.release('a');
    await a.done;
    assert.equal(t.run(['--check', '--job', 'build']).status, 0);
    assert.equal(t.run(['--job', 'build', '--']).status, 1, 'no command');
  } finally {
    await t.cleanup();
  }
});

test('run: the gates: pressure, swap-outs per minute, free memory and load each hold admission and name their key; swap in use never does', async () => {
  const t = project('capacity = 4');
  try {
    // a Mac with 10 GB of swap in use (vm.swapusage) and half its memory free: it admits
    t.set('free', 52);
    let r = t.run(['--check', '--job', 'build']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pressure normal; swapouts (?:\?|\d+)\/min; memory 52% free; load 1\)/);
    assert.doesNotMatch(r.stdout, /swap /);
    t.set('pressure', 2);
    assert.match(t.run(['--check', '--job', 'build']).stdout, /would wait \(.*pressure warn \(kern\.memorystatus_vm_pressure_level is not 1\)/);
    t.set('pressure', 1);
    t.set('free', 9);
    assert.match(t.run(['--check', '--job', 'build']).stdout, /memory 9% free < 15% \(\[slot\] min_free_pct\)/);
    t.set('free', 50);
    t.set('load', 16.5);
    assert.match(t.run(['--check', '--job', 'build']).stdout, /load 16\.5 > 16 \(\[slot\] max_load\)/);
    t.set('ncpu', 10);
    assert.equal(t.run(['--check', '--job', 'build']).status, 0, 'max_load defaults to 2 x the CPU count');
    // swap-outs: 4000 pages since a sample a minute ago
    t.set('load', 1);
    writeFileSync(t.p('state', 'slot', 'swapouts.json'), JSON.stringify([{ t: Date.now() - 60000, n: 1000 }]));
    t.set('swapouts', 5000);
    r = t.run(['--check', '--job', 'build']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /swapouts (?:39[5-9]\d|4000)\/min >= 1000 \(\[slot\] max_swapouts_per_min\)/);
    // a weight-0 job never waits on the gates
    assert.equal(t.run(['--check', '--job', 'tsc']).status, 0);
    // the job waits inside, then starts when the reading recovers
    writeFileSync(t.p('state', 'slot', 'swapouts.json'), '[]');
    t.set('free', 5);
    const a = t.start(['--job', 'build', '--', 'echo', 'built']);
    assert.ok(await waitFor(() => /build \(weight 2\) queued: .*memory 5% free < 15% \(\[slot\] min_free_pct\)/.test(a.err)), a.err);
    t.set('free', 40);
    assert.equal((await a.done).code, 0, a.err);
    assert.match(a.err, /admitted after \d+\.\d min waiting/);
    assert.equal(a.out, 'built\n');
  } finally {
    await t.cleanup();
  }
  const off = project('min_free_pct = 0\nmax_swapouts_per_min = 50000\nmax_load = 40');
  try {
    off.set('free', 3);
    off.set('load', 30);
    writeFileSync(off.p('r', 'swapouts'), '5000');
    mkdirSync(off.p('state', 'slot'), { recursive: true });
    writeFileSync(off.p('state', 'slot', 'swapouts.json'), JSON.stringify([{ t: Date.now() - 60000, n: 1000 }]));
    const r = off.run(['--check', '--job', 'build']);
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /memory/);
  } finally {
    await off.cleanup();
  }
});

test('run: a queued job gives up after --timeout (exit 75) and leaves the queue', async () => {
  const t = project('capacity = 2');
  try {
    const a = t.start(['--job', 'build', '--', ...t.hold('a')]);
    assert.ok(await waitFor(() => t.leases().leases.length === 1));
    const r = t.run(['--job', 'build', '--timeout', '1', '--', 'true']);
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /gave up after 0\.0 min in the queue/);
    assert.equal(t.leases().queue.length, 0);
    t.release('a');
    await a.done;
  } finally {
    await t.cleanup();
  }
});

test('run: the command runs in its own process group; what it leaves running is stopped when it exits', async () => {
  const t = project();
  try {
    const r = t.run(['--job', 'proof', '--', 'sh', '-c', `sleep 300 & echo $! > '${t.p('bg.pid')}'; echo "$FK_RUN_LEASE $FK_SLOT_HELD"; exit 3`]);
    assert.equal(r.status, 3, 'the command\'s own status');
    assert.match(r.stdout, /^\d+-\w+ 1\n$/);
    assert.match(r.stderr, /stopped what proof left running in process group \d+/);
    const bg = Number(readFileSync(t.p('bg.pid'), 'utf8'));
    assert.ok(await waitFor(() => !alive(bg)), 'the background sleep is gone');
    assert.deepEqual(t.leases(), { leases: [], queue: [] });
    // nested: inside a lease, a run takes no new reservation
    const n = t.run(['--job', 'build', '--', 'true'], { FK_RUN_LEASE: 'outer-1' });
    assert.equal(n.status, 0);
    assert.match(n.stderr, /inside lease outer-1: build runs without a new reservation/);
    assert.equal(t.run(['--wait', '--job', 'build'], { FK_RUN_LEASE: 'outer-1' }).stdout, 'run: go (inside lease outer-1)\n');
  } finally {
    await t.cleanup();
  }
});

test('run: SIGTERM, SIGINT or the owner pid dying kill the whole process group and free the lease', async () => {
  const t = project();
  try {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      const pidFile = t.p(`${sig}.pid`);
      const a = t.start(['--job', 'build', '--', 'sh', '-c', `sleep 300 & echo $! > '${pidFile}'; wait`]);
      assert.ok(await waitFor(() => existsSync(pidFile) && t.leases().leases[0]?.pgid), a.err);
      const bg = Number(readFileSync(pidFile, 'utf8'));
      a.kill(sig);
      const { code } = await a.done;
      assert.equal(code, sig === 'SIGTERM' ? 143 : 130);
      assert.match(a.err, new RegExp(`${sig}: stopping build \\(process group \\d+\\)`));
      assert.ok(await waitFor(() => !alive(bg)), `${sig}: the job's background process is gone`);
      assert.deepEqual(t.leases().leases, []);
    }
    const owner = sleeper();
    const pidFile = t.p('owner.pid');
    const a = t.start(['--job', 'build', '--owner-pid', String(owner.pid), '--', 'sh', '-c', `sleep 300 & echo $! > '${pidFile}'; wait`]);
    assert.ok(await waitFor(() => existsSync(pidFile)), a.err);
    owner.kill('SIGKILL');
    assert.equal((await a.done).code, 143);
    assert.match(a.err, new RegExp(`owner pid ${owner.pid} is gone: stopping build`));
    assert.ok(await waitFor(() => !alive(Number(readFileSync(pidFile, 'utf8')))));
    assert.deepEqual(t.leases().leases, []);
    // a numeric --owner is watched too, and a queued job whose owner dies leaves the queue
    const holder = t.start(['--job', 'build', '--', ...t.hold('h')]);
    const filler = t.start(['--job', 'build', '--', ...t.hold('f')]);
    assert.ok(await waitFor(() => t.leases().leases.length === 2));
    const owner2 = sleeper();
    const q = t.start(['--job', 'proof', '--owner', String(owner2.pid), '--', 'true']);
    assert.ok(await waitFor(() => t.leases().queue.length === 1));
    owner2.kill('SIGKILL');
    assert.equal((await q.done).code, 143);
    assert.match(q.err, /still queued/);
    assert.equal(t.leases().queue.length, 0);
    t.release('h');
    t.release('f');
    await Promise.all([holder.done, filler.done]);
  } finally {
    await t.cleanup();
  }
});

test('run --reap: a dead lease is freed and its leftover group killed, but never a group with older processes', async () => {
  const t = project();
  const kids = [];
  try {
    // two detached process groups standing in for a killed runner's jobs
    const ours = sleeper([], { detached: true });
    const reused = sleeper([], { detached: true });
    kids.push(ours, reused);
    const dead = spawn('true');
    await new Promise((r) => dead.on('exit', r));
    const now = Date.now();
    mkdirSync(t.p('state', 'slot'), { recursive: true });
    writeFileSync(t.p('state', 'slot', 'leases.json'), JSON.stringify({
      leases: [
        { id: 'x1', job: 'build', weight: 2, pid: dead.pid, pgid: ours.pid, owner: 'gone-agent', started: new Date(now - 600000).toISOString(), cmd: 'xcodebuild' },
        { id: 'x2', job: 'proof', weight: 1, pid: dead.pid, pgid: reused.pid, owner: 'other', started: new Date(now - 60000).toISOString(), cmd: 'proof' },
      ],
      queue: [{ id: 'q1', job: 'build', weight: 2, pid: dead.pid, owner: 'gone-too', queued: new Date().toISOString(), cmd: 'x' }],
    }));
    // ps (a fake): ours started 2 minutes ago, after its lease; "reused" holds a process from before its lease
    writeFileSync(t.p('bin', 'ps'), `#!/usr/bin/env bash
echo "${ours.pid} 1 ${ours.pid} 02:00 node -e sleeper"
echo "${reused.pid} 1 ${reused.pid} 10:00 node -e sleeper"
`);
    chmodSync(t.p('bin', 'ps'), 0o755);
    const r = t.run(['--reap']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`reaped lease x1 \\(build, owner gone-agent, pid ${dead.pid} gone\\): killed its process group ${ours.pid} \\(1 process\\)`));
    assert.match(r.stderr, new RegExp(`reaped lease x2 \\(proof, owner other, pid ${dead.pid} gone\\): left process group ${reused.pid} alone: it holds processes older than the lease`));
    assert.match(r.stderr, /dropped queued build of gone-too/);
    assert.ok(await waitFor(() => !alive(ours.pid)), 'the dead lease\'s group is gone');
    assert.ok(alive(reused.pid), 'an unattributable group is left alone');
    assert.deepEqual(t.leases(), { leases: [], queue: [] });
    assert.match(t.run(['--reap']).stderr, /^run: nothing to reap\n$/);
  } finally {
    for (const k of kids) k.kill('SIGKILL');
    await t.cleanup();
  }
});

test('run --reap: kills orphaned simulator recordings and kit test runs past [slot] orphan_minutes, and nothing else', async () => {
  const t = project('orphan_minutes = 60');
  const kids = [];
  try {
    const [oldRec, youngRec, parentedRec, kitTest, otherTest, plain] = Array.from({ length: 6 }, () => {
      const k = sleeper();
      kids.push(k);
      return k;
    });
    writeFileSync(t.p('bin', 'ps'), `#!/usr/bin/env bash
cat <<'PS'
${oldRec.pid} 1 ${oldRec.pid} 01:30:00 /Applications/Xcode.app/Contents/Developer/usr/bin/simctl io 1111 recordVideo --codec=h264 /x/run.mp4
${youngRec.pid} 1 ${youngRec.pid} 10:00 xcrun simctl io booted recordVideo /x/b.mp4
${parentedRec.pid} 4242 ${parentedRec.pid} 2-01:00:00 xcrun simctl io booted recordVideo /x/c.mp4
${kitTest.pid} 999 ${kitTest.pid} 03:00:00 ${process.execPath} --test-reporter=spec ${join(KIT, 'test', 'end-night.test.mjs')}
${otherTest.pid} 999 ${otherTest.pid} 03:00:00 node /somewhere/else/test/x.test.mjs
${plain.pid} 1 ${plain.pid} 9-00:00:00 /usr/bin/ssh-agent -l
PS
`);
    chmodSync(t.p('bin', 'ps'), 0o755);
    const r = t.run(['--reap']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`killed orphaned recording pid ${oldRec.pid} \\(90 min, parent gone\\): .*simctl io 1111 recordVideo`));
    assert.match(r.stderr, new RegExp(`killed kit test run pid ${kitTest.pid} \\(180 min\\): .*end-night\\.test\\.mjs`));
    assert.equal(r.stderr.trim().split('\n').length, 2, r.stderr);
    assert.ok(await waitFor(() => !alive(oldRec.pid) && !alive(kitTest.pid)));
    for (const k of [youngRec, parentedRec, otherTest, plain]) assert.ok(alive(k.pid), `pid ${k.pid} is left alone`);
  } finally {
    for (const k of kids) k.kill('SIGKILL');
    await t.cleanup();
  }
});

test('run: a lease file written by another process is shared under the lock (two runs never both take the last room)', async () => {
  const t = project('capacity = 2');
  try {
    const runs = Array.from({ length: 4 }, (_, i) => t.start(['--job', 'build', '--owner', `r${i}`, '--', 'sh', '-c', `echo start >> '${t.p('log')}'; sleep 0.3; echo end >> '${t.p('log')}'`]));
    const codes = await Promise.all(runs.map((r) => r.done));
    assert.deepEqual(codes.map((c) => c.code), [0, 0, 0, 0], runs.map((r) => r.err).join('\n'));
    // with room for one build at a time, starts and ends alternate
    assert.equal(readFileSync(t.p('log'), 'utf8'), 'start\nend\n'.repeat(4));
  } finally {
    await t.cleanup();
  }
});

test('run: the lock-folder fallback serves when there is no lockf or flock', async () => {
  const t = project('capacity = 2');
  try {
    const more = { FK_RUN_LOCK: 'mkdir' };
    const a = t.start(['--job', 'build', '--', ...t.hold('a')], more);
    assert.ok(await waitFor(() => t.leases().leases.length === 1));
    assert.equal(t.run(['--check', '--job', 'proof'], more).status, 1);
    t.release('a');
    assert.equal((await a.done).code, 0);
    assert.equal(existsSync(t.p('state', 'slot', 'leases.lock.d')), false);
  } finally {
    await t.cleanup();
  }
});

test('run: pure helpers: etime, the swap-out rate, the gate text', () => {
  assert.equal(etimeSeconds('05'), null);
  assert.equal(etimeSeconds('01:05'), 65);
  assert.equal(etimeSeconds('02:01:05'), 7265);
  assert.equal(etimeSeconds('3-02:01:05'), 266465);
  const s = scratch();
  try {
    const f = join(s.dir, 'swap.json');
    const now = 1_000_000_000;
    assert.equal(swapRate(f, now - 120000, 100), null, 'no sample yet');
    assert.equal(swapRate(f, now - 60000, 200), 100, '100 pages in a minute');
    assert.equal(swapRate(f, now, 700), 500, 'against the sample about a minute old');
    assert.equal(swapRate(f, now + 5000, 10), null, 'a lower counter is a reboot: older samples are dropped');
    assert.equal(swapRate(f, now + 20000, 30), 80, 'a sample under a minute old is scaled to a minute');
  } finally {
    s.cleanup();
  }
  const cfg = { maxSwapouts: 1000, minFree: 15, maxLoad: 16 };
  assert.deepEqual(gates({ pressure: null, free: null, load: null, swapouts: null, swapRate: null }, cfg), { ok: true, held: [], text: 'no readings' });
  const g = gates({ pressure: 4, free: 10, load: 20, swapouts: 5, swapRate: 2000 }, cfg);
  assert.deepEqual(g.held, ['pressure', 'max_swapouts_per_min', 'min_free_pct', 'max_load']);
});

test('slot status / slot wait: deprecated aliases of run --status and run --wait', () => {
  const t = project('capacity = 4');
  try {
    const slot = (args, more = {}) => factory(['slot', ...args], { cwd: t.dir, env: { ...t.env, ...more } });
    let r = slot(['status', '--dd', 'dd-x', '--udid', 'X', '--ignore-leftovers']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^factory slot is deprecated: use factory run --status\n/);
    assert.match(r.stdout, /^capacity 0\/4 in use\ngates: .*\na build \(weight 2\) would start now\n$/);
    r = slot(['wait', '--dd', 'dd-x', '--timeout', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /deprecated: run the job itself with factory run --job <type> -- <cmd>/);
    assert.match(r.stdout, /^run: go after 0\.0 min/);
    t.set('load', 99);
    r = slot(['wait', '--timeout', '1']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /^run: waiting \(.*load 99 > 16 \(\[slot\] max_load\)\)\n(?:.*\n)*run: gave up after 1s/);
    assert.equal(slot(['frob']).status, 1);
  } finally {
    t.cleanup();
  }
});

test('hook-guard asks factory run itself: an XcodeBuildMCP build is denied while a build would wait, allowed once there is room', async () => {
  const t = project('capacity = 4');
  try {
    const hook = (tool, input = {}) => factory(['hook-guard'], {
      env: t.env,
      cwd: t.dir,
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: t.dir }),
    });
    const a = t.start(['--job', 'build', '--owner', 'agent-a', '--', ...t.hold('a')]);
    const b = t.start(['--job', 'build', '--owner', 'agent-b', '--', ...t.hold('b')]);
    assert.ok(await waitFor(() => t.leases().leases.length === 2));
    let r = hook('mcp__XcodeBuildMCP__build_run_sim');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /XcodeBuildMCP build_run_sim would start a build the Mac has no room for: run: a build would wait \(capacity 4\/4 in use: build \(agent-[ab]\), build \(agent-[ab]\), needs 2 \(\[slot\] capacity\)\)/);
    // a raw build in Bash is denied whatever the room; wrapped, it passes
    r = hook('Bash', { command: 'xcodebuild -scheme App build' });
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /must run through `factory run`/);
    assert.equal(hook('Bash', { command: 'factory run --job build -- xcodebuild -scheme App build' }).stdout, '');
    t.release('a');
    await a.done;
    r = hook('mcp__XcodeBuildMCP__build_run_sim');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    t.release('b');
    await b.done;
  } finally {
    await t.cleanup();
  }
});
