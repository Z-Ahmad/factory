import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

// factory slot with a fake ps (the running processes), sysctl (the load) and the fixture's xcrun, whose booted sims are
// Shooter Phone and box-test-kit (both protected) and box-factory-1 (not).
function project(slot = '') {
  const t = tree({ extraToml: () => (slot ? `\n[slot]\n${slot}\n` : '') });
  const stub = (name, body) => {
    writeFileSync(join(t.p('bin'), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(t.p('bin'), name), 0o755);
  };
  stub('ps', `cat '${t.p('ps.out')}' 2>/dev/null || true`);
  stub('sysctl', 'echo "{ ${LOAD:-10.00} 9.00 8.00 }"');
  const procs = (...lines) => writeFileSync(t.p('ps.out'), lines.map((l) => `${l}\n`).join(''));
  const run = (args, env = {}) => factory(['slot', ...args], { env: { ...t.env, FK_UNAME: 'Darwin', ...env }, cwd: t.main });
  return { ...t, procs, run };
}
const XB = (pid, dd) => `${pid} /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme App -derivedDataPath /dd/${dd} build`;
const PROOF = (pid, dd) => `${pid} /bin/bash /kit/proof/ios/sim-proof-core.sh --udid X --scenario s --out /o --dd /dd/${dd} --no-gate`;

test('slot status: other builders by derived-data folder, never yours; xcodebuildmcp and the like are not builds', () => {
  const t = project();
  try {
    t.procs(XB(11, 'dd-mine'), '12 node /x/xcodebuildmcp mcp', PROOF(13, 'dd-other'), XB(14, 'dd-other'));
    const r = t.run(['status', '--dd', 'dd-mine']);
    // dd-other (one builder, counted once) + nothing left over: box-factory-1 is the one sim the running proof uses
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, 'slot: free (1 other builder: dd-other (pid 13); load 10.00 (slots: 2))\n');
  } finally {
    t.cleanup();
  }
});

test('slot status: a booted simulator no proof is using counts as a builder; yours (--udid) does not', () => {
  const t = project();
  try {
    t.procs(XB(14, 'dd-other'));
    let r = t.run(['status', '--dd', 'mine']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'slot: busy (1 other builder: dd-other (pid 14); 1 booted simulator no proof is using: box-factory-1; load 10.00 (slots: 2))\n');
    r = t.run(['status', '--dd', 'mine', '--udid', '11111111-0000-0000-0000-000000000002']);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    t.cleanup();
  }
});

test('slot: [slot] max_load holds the slot; wait prints why once, then go; a timeout exits 2', () => {
  const t = project('builders = 3\nmax_load = 120\npoll_s = 1');
  try {
    t.procs();
    let r = t.run(['status'], { LOAD: '150.5' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^slot: busy \(0 other builders; 1 booted simulator no proof is using: box-factory-1; load 150\.5 > 120 \(slots: 3\)\)\n$/);
    r = t.run(['wait', '--dd', 'mine', '--timeout', '2'], { LOAD: '150.5' });
    assert.equal(r.status, 2);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.filter((l) => l.startsWith('slot: waiting')).length, 1);
    assert.match(lines.at(-1), /^slot: gave up after 2s/);
    r = t.run(['wait', '--dd', 'mine'], { LOAD: '80' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^slot: go \(0 other builders; .*load 80 \(slots: 3\)\)\n$/);
  } finally {
    t.cleanup();
  }
});

test('slot: wait needs --dd; unknown subcommands are refused', () => {
  const t = project();
  try {
    assert.equal(t.run(['wait']).status, 1);
    assert.equal(t.run(['frob']).status, 1);
  } finally {
    t.cleanup();
  }
});
