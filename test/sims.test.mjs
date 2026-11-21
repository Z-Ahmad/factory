import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { etimeSeconds, simsInUse } from '../lib/sims.mjs';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

const SHOOTER = '11111111-0000-0000-0000-00000000000A';
const FACTORY1 = '11111111-0000-0000-0000-000000000002';
const KIT_SIM = '11111111-0000-0000-0000-000000000006';
const DEV = (u) => `/Users/x/Library/Developer/CoreSimulator/Devices/${u}`;

test('etimeSeconds reads every ps etime shape', () => {
  assert.equal(etimeSeconds('00:58'), 58);
  assert.equal(etimeSeconds('18:36'), 18 * 60 + 36);
  assert.equal(etimeSeconds('06:35:33'), 6 * 3600 + 35 * 60 + 33);
  assert.equal(etimeSeconds('03-04:46:42'), 3 * 86400 + 4 * 3600 + 46 * 60 + 42);
  assert.equal(etimeSeconds('soon'), null);
});

test('simsInUse: a process outside the simulator naming it; a young app or boot inside it; never an old one or a widget', () => {
  const ps = [
    `10 01:00:00 /bin/bash /kit/proof/ios/sim-proof-core.sh --udid ${FACTORY1} --dd /dd/x`,
    `11 02:00:00 xcrun simctl io ${SHOOTER} recordVideo --codec h264 /o/a.mp4`,
    `12 03-00:00:00 launchd_sim ${DEV(KIT_SIM)}/data/var/run/launchd_bootstrap.plist`,
    `13 05:00 ${DEV(KIT_SIM)}/data/Containers/Bundle/Application/AAAA/App.app/PlugIns/Widget.appex/Widget`,
    `14 2-00:00:00 ${DEV(KIT_SIM)}/data/Containers/Bundle/Application/AAAA/App.app/App`,
    `15 04:00 launchd_sim ${DEV('22222222-0000-0000-0000-000000000001')}/data/var/run/launchd_bootstrap.plist`,
    `16 12:00 ${DEV('22222222-0000-0000-0000-000000000002')}/data/Containers/Bundle/Application/BBBB/Seaglass.app/Seaglass`,
    `17 1:00:00 /usr/bin/xcodebuild -scheme App -destination id=22222222-0000-0000-0000-000000000003 build`,
  ].join('\n');
  const used = simsInUse(ps, { idleMin: 30 });
  assert.deepEqual([...used.entries()], [
    [FACTORY1, 'factory proof (pid 10)'],
    [SHOOTER, 'simctl recordVideo (pid 11)'],
    ['22222222-0000-0000-0000-000000000001', 'booted 4m ago'],
    ['22222222-0000-0000-0000-000000000002', 'Seaglass launched 12m ago'],
    ['22222222-0000-0000-0000-000000000003', 'xcodebuild (pid 17)'],
  ]);
  // idle_minutes 0: only processes outside a simulator count
  assert.equal(simsInUse(ps, { idleMin: 0 }).size, 3);
});

// factory sims idle on the fixture: Shooter Phone, box-factory-1 and box-test-kit are booted.
function project(simExtra = '') {
  const t = tree({ simExtra });
  writeFileSync(join(t.p('bin'), 'ps'), `#!/usr/bin/env bash\ncat '${t.p('ps.out')}' 2>/dev/null || true\n`);
  chmodSync(join(t.p('bin'), 'ps'), 0o755);
  const procs = (...lines) => writeFileSync(t.p('ps.out'), lines.map((l) => `${l}\n`).join(''));
  const run = (args, env = {}) => factory(['sims', ...args], { env: { ...t.env, FK_UNAME: 'Darwin', ...env }, cwd: t.main });
  return { ...t, procs, run };
}

test('sims idle: lists idle booted simulators and changes nothing; --shutdown shuts down only those', () => {
  const t = project('keep_booted = ["box-test-*"]');
  try {
    t.procs(`10 01:00:00 /bin/bash /kit/proof/ios/sim-proof-core.sh --udid ${FACTORY1} --dd /dd/x`);
    let r = t.run(['idle']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.clean(r.stdout), [
      `  idle:   Shooter Phone (${SHOOTER})`,
      `  in use: box-factory-1 (${FACTORY1}): factory proof (pid 10)`,
      `  kept:   box-test-kit (${KIT_SIM}): [sim] keep_booted`,
      'sims: 3 booted, 1 in use, 1 kept; 1 idle: Shooter Phone (--shutdown to stop them)',
      '',
    ].join('\n'));
    assert.deepEqual(t.xcrunCalls(), []);
    r = t.run(['idle', '--shutdown']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^sims: 3 booted, 1 in use, 1 kept; 1 idle shut down: Shooter Phone$/m);
    assert.deepEqual(t.xcrunCalls(), [`simctl shutdown ${SHOOTER}`]);
  } finally {
    t.cleanup();
  }
});

test('sims idle: off macOS it is skipped; bad arguments exit 1', () => {
  const t = project();
  try {
    const r = t.run(['idle', '--shutdown'], { FK_UNAME: 'Linux' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'sims: skipped: needs Xcode\n');
    assert.equal(t.run(['idle', '--frob']).status, 1);
    assert.equal(t.run(['busy']).status, 1);
  } finally {
    t.cleanup();
  }
});

test('doctor shuts idle simulators down once [sim] idle_minutes is set, and not before', () => {
  const t = project('idle_minutes = 20');
  try {
    t.procs();
    const tick = factory(['doctor'], {
      env: { ...t.env, FK_UNAME: 'Darwin', FK_NOW_HHMM: '01:00' },
      cwd: t.main,
    });
    assert.equal(tick.status, 0, tick.stderr);
    assert.match(tick.stdout, /; sims: 3 booted, 0 in use; 3 idle shut down: Shooter Phone, box-factory-1, box-test-kit; dev skipped/);
    assert.equal(t.xcrunCalls().filter((c) => c.startsWith('simctl shutdown')).length, 3);
  } finally {
    t.cleanup();
  }
  const off = project();
  try {
    off.procs();
    const tick = factory(['doctor'], {
      env: { ...off.env, FK_UNAME: 'Darwin', FK_NOW_HHMM: '01:00' },
      cwd: off.main,
    });
    assert.equal(tick.status, 0, tick.stderr);
    assert.doesNotMatch(tick.stdout, /sims:/);
    assert.match(tick.stdout, /^factory-doctor: ok/);
    assert.deepEqual(off.xcrunCalls(), []);
  } finally {
    off.cleanup();
  }
});
