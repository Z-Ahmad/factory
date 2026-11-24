import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';
import { diskPass, notify, topUsers } from '../cmd/janitor.mjs';
import { diskGate } from '../cmd/run.mjs';

// Low-disk handling: the janitor's disk check every pass, `factory run`'s check before a heavy job, and a removed
// worktree taking its build folders along. The fixture tree supplies temp dd/tmp/state roots; `df`, `osascript` and
// `sysctl` are stubs first on PATH. The fake df answers $DF_LOW while cache/dd-big exists and $DF_HIGH once cleanup
// has removed it, so "cleaning freed space" is something a test can watch.
const DEADLINE_MS = 120_000; // every call to the kit has one

function project({ janitor = '', diskOverrides = {} } = {}) {
  const t = tree({ diskOverrides, extraToml: () => `\n[janitor]\n${janitor}\n` });
  const bin = t.p('bin');
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('df', `if [ -d '${t.p('cache', 'dd-big')}' ]; then gb="$DF_LOW"; else gb="$DF_HIGH"; fi
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "fake 1000 1000 $((gb * 1048576)) 1% /"`);
  stub('osascript', `printf '%s\\n' "$*" >> '${t.p('osascript.log')}'`);
  stub('sysctl', `case "$2" in
  kern.memorystatus_vm_pressure_level) echo 1 ;;
  kern.memorystatus_level) echo 50 ;;
  vm.loadavg) echo "{ 0.10 0.10 0.10 }" ;;
  hw.ncpu) echo 8 ;;
  *) exit 1 ;;
esac`);
  stub('vm_stat', 'echo "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\necho "Swapouts:                                 100."');
  const env = {
    ...t.env,
    DF_LOW: '30',
    DF_HIGH: '60',
    FK_JANITOR_CLEANUP: '/usr/bin/true', // the daily housekeeping, not under test
    FK_JANITOR_AGENTS_DIR: t.p('agents'),
    FK_RUN_SWAP_PROBE_S: '0',
    FK_RUN_LEASE: '',
    FK_SLOT_HELD: '',
  };
  /** A big stale build folder cleanup takes (nothing under it changed for a day). */
  const big = () => {
    mkdirSync(t.p('cache', 'dd-big'), { recursive: true });
    writeFileSync(t.p('cache', 'dd-big', 'blob'), Buffer.alloc(64 * 1024, 1));
    t.ago(t.p('cache', 'dd-big', 'blob'), 24);
    t.ago(t.p('cache', 'dd-big'), 24);
  };
  const jan = (more = {}, args = ['run']) => factory(['janitor', ...args], { env: { ...env, ...more }, cwd: t.main, timeout: DEADLINE_MS });
  const notes = () => (existsSync(t.p('osascript.log')) ? readFileSync(t.p('osascript.log'), 'utf8').split('\n').filter(Boolean) : []);
  const log = () => (existsSync(t.p('state', 'janitor', 'janitor.log')) ? readFileSync(t.p('state', 'janitor', 'janitor.log'), 'utf8') : '');
  return { ...t, env, big, jan, notes, log, stub };
}
const withProject = (fn, opts) => {
  const t = project(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};
const worktreesBefore = (t) => t.names('main', '.worktrees');

// ------------------------------------------------------------------ the janitor

test('janitor: below min_gb every pass runs the safe sweep, notifies once, and the next pass inside 30 minutes only logs', () =>
  withProject((t) => {
    t.big();
    const wts = worktreesBefore(t);
    // not enabled, not --apply: the disk check still acts
    const r = t.jan();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(t.p('cache', 'dd-big')), 'the stale build folder is gone');
    assert.ok(!existsSync(t.p('cache', 'dd-stale1')));
    assert.ok(existsSync(t.p('cache', 'dd-app')), 'a keep-list folder stays');
    assert.deepEqual(t.names('tmp').includes('dd-old1'), false, 'old scratch goes too');
    assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['flags.png'], 'frames and clips go');
    assert.deepEqual(worktreesBefore(t), wts, 'never a worktree');
    assert.deepEqual(t.xcrunCalls(), [], 'never a simulator');
    assert.match(r.stdout, /janitor: apply disk low: 30 GB free on .*cache \| min 40 GB/);
    assert.match(r.stdout, /disk cleanup \(derived-data, tmp, frames, clips\) \| freed .*; 60 GB free now/);
    const notes = t.notes();
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Disk low: 60 GB free/);
    assert.match(notes[0], /Janitor freed \d/);
    assert.doesNotMatch(notes[0], /Basso/, 'the quiet one makes no sound');
    // again, still low: it cleans again but the notification is throttled
    t.big();
    const r2 = t.jan();
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!existsSync(t.p('cache', 'dd-big')));
    assert.equal(t.notes().length, 1);
    assert.match(r2.stdout, /notification \(min\) not sent \| one per 30 min/);
    // a day later it may speak again
    const f = t.p('state', 'janitor', 'disk-notify.json');
    writeFileSync(f, JSON.stringify({ min: Date.now() - 31 * 60000 }));
    t.big();
    assert.equal(t.jan().status, 0);
    assert.equal(t.notes().length, 2);
  }));

test('janitor: still under floor_gb after the sweep: a louder notification names the five biggest space users, throttled per level', () =>
  withProject((t) => {
    // nothing frees space (no dd-big): 10 GB stays 10 GB
    writeFileSync(t.p('cache', 'dd-app', 'a.bin'), Buffer.alloc(900 * 1024, 1));
    writeFileSync(t.p('cache', 'dd-test-kit', 'b.bin'), Buffer.alloc(500 * 1024, 1));
    mkdirSync(t.p('cache', 'dd-lane7-kit'));
    mkdirSync(t.p('cache', 'dd-lane7'));
    writeFileSync(t.p('cache', 'dd-lane7', 'c.bin'), Buffer.alloc(400 * 1024, 1));
    writeFileSync(t.p('cache', 'dd-lane7-kit', 'd.bin'), Buffer.alloc(400 * 1024, 1));
    t.ago(t.p('cache', 'dd-lane7'), 0);
    const r = t.jan({ DF_LOW: '10', DF_HIGH: '10' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const notes = t.notes();
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Disk critically low: 10 GB free/);
    assert.match(notes[0], /Under the 20 GB floor even after freeing/);
    assert.match(notes[0], /build folders of app \d/);
    assert.match(notes[0], /build folders of lane7 \(2\) \d/, 'dd-<name> and dd-<name>-kit are one entry');
    assert.match(notes[0], /sound name "Basso"/, 'loud');
    assert.match(notes[0], /factory cleanup/);
    const listed = notes[0].split('Biggest: ')[1].split('. Run')[0].split('; ');
    assert.ok(listed.length <= 5);
    assert.ok(listed.every((x) => /\d (KB|MB|GB)$/.test(x)), listed.join('|'));
    // inside the window: no second one; the min level has its own clock
    t.jan({ DF_LOW: '10', DF_HIGH: '10' });
    assert.equal(t.notes().length, 1);
    assert.match(t.log(), /notification \(floor\) not sent/);
    const state = JSON.parse(readFileSync(t.p('state', 'janitor', 'disk-notify.json'), 'utf8'));
    assert.deepEqual(Object.keys(state), ['floor']);
  }));

test('janitor: above min_gb nothing runs, nothing is logged, no notification', () =>
  withProject((t) => {
    t.big();
    const r = t.jan({ DF_LOW: '67', DF_HIGH: '67' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(t.p('cache', 'dd-big')), 'the folder is untouched');
    assert.deepEqual(t.notes(), []);
    assert.doesNotMatch(t.log(), /disk/);
  }));

test('janitor: [janitor] disk_act = false only warns; notify_every_min sets the throttle', () =>
  withProject(
    (t) => {
      t.big();
      const r = t.jan();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(existsSync(t.p('cache', 'dd-big')), 'nothing was removed');
      assert.match(r.stdout, /disk cleanup skipped \| \[janitor\] disk_act = false/);
      assert.equal(t.notes().length, 1);
      assert.match(t.notes()[0], /Disk low: 30 GB free/);
      assert.match(t.notes()[0], /disk_act is off/);
      // 5-minute throttle: 6 minutes later it speaks again
      writeFileSync(t.p('state', 'janitor', 'disk-notify.json'), JSON.stringify({ min: Date.now() - 6 * 60000 }));
      t.jan();
      assert.equal(t.notes().length, 2);
    },
    { janitor: 'disk_act = false\nnotify_every_min = 5' },
  ));

test('janitor: a missing osascript never fails the pass', () =>
  withProject((t) => {
    t.big();
    t.stub('osascript', 'exit 1');
    const r = t.jan();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /notification \(min, not shown\)/);
    assert.equal(notify('t', 'x', {}) === true || notify('t', 'x', {}) === false, true);
  }));

test('janitor from launchd (the config copy): the project folder is never read; keep names come from the record of a full run', () =>
  withProject((t) => {
    t.big();
    mkdirSync(t.p('state', 'janitor'), { recursive: true });
    const copy = t.p('state', 'janitor', 'factory.toml');
    writeFileSync(copy, readFileSync(t.p('factory.toml'), 'utf8'));
    // the main checkout is unreadable to launchd: make it so, and prove cleanup never enters it
    const guard = t.p('main-guard');
    const toml = readFileSync(copy, 'utf8').replace(`main_checkout = "${t.main}"`, `main_checkout = "${guard}"`);
    writeFileSync(copy, toml);
    // dd_keep_derive is set and no record exists: derived-data is skipped, never guessed
    let r = t.jan({ FACTORY_TOML: copy });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(t.p('cache', 'dd-big')), 'derived-data skipped without the keep record');
    assert.ok(!existsSync(t.p('cache', 'dd-stale1')) === false);
    assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['flags.png'], 'frames and clips still go');
    // a full run (the doctor's, cleanup by hand) records the derived keep names...
    const full = factory(['cleanup', '--apply', '--only', 'derived-data'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(readFileSync(t.p('state', 'janitor', 'dd-keep.txt'), 'utf8').split('\n').filter(Boolean), ['literal', 'scripted']);
    // ...and then the scheduled pass cleans derived-data too, still without entering the project
    t.big();
    mkdirSync(t.p('cache', 'dd-scripted'), { recursive: true });
    t.ago(t.p('cache', 'dd-scripted'), 48);
    rmSafe(t.p('state', 'janitor', 'disk-notify.json'));
    r = t.jan({ FACTORY_TOML: copy }, ['run', '--scheduled']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(t.p('cache', 'dd-big')));
    assert.ok(existsSync(t.p('cache', 'dd-scripted')), 'a name the project scripts use stays');
  }));

function rmSafe(p) {
  try {
    writeFileSync(p, '{}');
  } catch {}
}

test('diskPass: no reading, or enough space: no calls at all', () => {
  const cfg = { dir: '/nonexistent', stateDir: '/nonexistent', ddRoot: null, minGb: 40, floorGb: 20, diskAct: true, notifyEveryMin: 30 };
  const deps = { freeGb: () => null, cleanup: () => assert.fail('cleaned'), notify: () => assert.fail('notified'), topUsers: () => [], now: () => 0 };
  assert.deepEqual(diskPass(cfg, { deps }), []);
  assert.deepEqual(diskPass(cfg, { deps: { ...deps, freeGb: () => 40 } }), []);
});

test('topUsers: the five biggest of build folders (by worktree), state subfolders and simulators, named', () =>
  withProject((t) => {
    t.simData('SIM-A', 700);
    const cfg = { ddRoot: t.p('cache'), stateDir: t.p('state') };
    const sizes = { 'dd-app': 50, 'dd-w1': 10, 'dd-w1-kit': 30 };
    const top = topUsers(cfg, {
      size: (p) => sizes[p.split('/').pop()] ?? (p.includes('night-1') ? 900 : p.endsWith('SIM-A') ? 700 : 1),
      names: () => new Map([['SIM-A', 'Shooter Phone']]),
      coreSim: t.p('coresim'),
      ls: (d) => (d === t.p('cache') ? ['dd-app', 'dd-w1', 'dd-w1-kit'] : d === t.p('coresim') ? ['SIM-A'] : ['night-1', 'night-2']),
    });
    assert.deepEqual(top.map((x) => x.label), ['state/night-1', 'simulator Shooter Phone', 'build folders of app', 'build folders of w1 (2)', 'state/night-2']);
    assert.deepEqual(top.map((x) => x.kb), [900, 700, 50, 40, 1]);
  }));

// ------------------------------------------------------------------ jobs

test('run: a job is refused below the floor even after cleaning; nothing starts, and the message names the fix', () =>
  withProject((t) => {
    const marker = t.p('ran');
    const r = factory(['run', '--job', 'build', '--', 'touch', marker], { env: { ...t.env, DF_LOW: '12', DF_HIGH: '12' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(r.status, 74, r.stdout + r.stderr);
    assert.match(r.stderr, /disk: 12 GB free \(min 40\); cleaning/);
    assert.match(r.stderr, /not starting the build job: 12 GB free is under the 20 GB floor \(\[disk\] floor_gb\), even after cleaning\. Run `factory cleanup --apply`/);
    assert.ok(!existsSync(marker));
  }));

test('run: below min but cleaning gets it over the floor: the job is admitted; above min the sweep never runs', () =>
  withProject((t) => {
    t.big();
    const marker = t.p('ran');
    const r = factory(['run', '--job', 'build', '--', 'touch', marker], { env: { ...t.env, DF_LOW: '12', DF_HIGH: '45' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /disk: freed .*; 45 GB free now/);
    assert.ok(existsSync(marker));
    assert.ok(!existsSync(t.p('cache', 'dd-big')));
    // plenty of space: no sweep at all, and a job type that builds nothing is never checked
    t.big();
    const ok = factory(['run', '--job', 'build', '--', 'true'], { env: { ...t.env, DF_LOW: '67', DF_HIGH: '67' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(t.p('cache', 'dd-big')));
    const unit = factory(['run', '--job', 'unit', '--', 'true'], { env: { ...t.env, DF_LOW: '3', DF_HIGH: '3' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(unit.status, 0, unit.stderr);
  }));

test('run: a nested job inside a lease, and the other job types, go through diskGate as documented', () => {
  const cfg = { minGb: 40, floorGb: 20, ddRoot: null, stateDir: '/nonexistent' };
  const calls = [];
  const deps = { freeGb: () => 5, cleanup: (o) => (calls.push(o), { ok: true, freed: null }) };
  for (const job of ['build', 'test', 'release', 'proof', 'device', 'archive']) assert.equal(diskGate(cfg, job, { env: {}, deps }), 74, job);
  assert.equal(calls.length, 6);
  assert.equal(diskGate(cfg, 'build', { env: { FK_RUN_LEASE: 'x' }, deps }), 0, 'inside a lease: already admitted');
  for (const job of ['unit', 'tsc', 'vite', 'playwright', 'rules', 'install']) assert.equal(diskGate(cfg, job, { env: {}, deps }), 0, job);
  assert.equal(calls.length, 6);
});

// ------------------------------------------------------------------ worktree removal

test('cleanup: removing a merged worktree removes its build folders, but not one a live lease or a running process uses', async () =>
  withTempProcs(async (t, keep) => {
    const wts = ['dd-agent-merged', 'dd-agent-merged-kit', 'dd-agent-merged-lease', 'dd-agent-merged-proc', 'dd-agent-dirty-x', 'dd-unrelated'];
    for (const d of wts) mkdirSync(t.p('cache', d), { recursive: true });
    // a live `factory run --dd` lease names one, a running process's command line names another
    mkdirSync(t.p('state', 'slot'), { recursive: true });
    writeFileSync(t.p('state', 'slot', 'leases.json'), JSON.stringify({ leases: [{ id: 'L1', job: 'build', weight: 2, pid: process.pid, owner: 'agent', dd: 'dd-agent-merged-lease', cwd: t.main }], queue: [] }));
    keep(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', t.p('cache', 'dd-agent-merged-proc')], { stdio: 'ignore' }));
    await new Promise((ok) => setTimeout(ok, 300));
    const r = factory(['cleanup', '--apply', '--only', 'worktrees'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REMOVE agent-merged /);
    assert.match(t.clean(r.stdout), /KEPT {2}<root>\/cache\/dd-agent-merged-lease \(in use: lease L1 \(build, agent\)\)/);
    assert.match(r.stdout, /KEPT {2}.*dd-agent-merged-proc \(in use: pid \d+ \(/);
    assert.deepEqual(
      wts.map((d) => existsSync(t.p('cache', d))),
      [false, false, true, true, true, true],
    );
    assert.ok(!existsSync(join(t.wt, 'agent-merged')));
  }));

test('cleanup --worktree-caches: only that worktree\'s build folders, never simulators, never an in-use one', () =>
  withProject((t) => {
    for (const d of ['dd-lane-a', 'dd-lane-a-kit', 'dd-lane-b']) mkdirSync(t.p('cache', d));
    const r = factory(['cleanup', '--apply', '--worktree-caches', 'lane-a', '--branch', 'claude/lane-a'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /derived-data: 2 build folders of lane-a/);
    assert.deepEqual(['dd-lane-a', 'dd-lane-a-kit', 'dd-lane-b'].map((d) => existsSync(t.p('cache', d))), [false, false, true]);
    assert.deepEqual(t.xcrunCalls(), []);
    // a dry run lists and removes nothing
    mkdirSync(t.p('cache', 'dd-lane-a'));
    const dry = factory(['cleanup', '--worktree-caches', 'lane-a'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
    assert.match(dry.stdout, /reclaimable/);
    assert.ok(existsSync(t.p('cache', 'dd-lane-a')));
  }));

test('cleanup --no-project: only the safe categories; anything else exits 1', () =>
  withProject((t) => {
    for (const c of ['worktrees', 'sims', 'archives']) {
      const r = factory(['cleanup', '--no-project', '--only', c], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
      assert.equal(r.status, 1, c);
      assert.match(r.stderr, /--no-project allows only derived-data, tmp, frames and clips/);
    }
    assert.equal(factory(['cleanup', '--no-project'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS }).status, 1);
  }));

async function withTempProcs(fn) {
  const t = project();
  const kids = [];
  try {
    await fn(t, (c) => kids.push(c));
  } finally {
    for (const c of kids) c.kill('SIGKILL');
    t.cleanup();
  }
}
