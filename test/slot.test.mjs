import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

// factory slot with a fake ps (the running processes), sysctl (load, CPUs, swap, free memory) and the fixture's xcrun,
// whose booted sims are Shooter Phone and box-test-kit (both [sim] protected) and box-factory-1 (not).
function project(slot = '') {
  const t = tree({ extraToml: () => (slot ? `\n[slot]\n${slot}\n` : '') });
  const stub = (name, body) => {
    writeFileSync(join(t.p('bin'), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(t.p('bin'), name), 0o755);
  };
  stub('ps', `cat '${t.p('ps.out')}' 2>/dev/null || true`);
  stub('sysctl', `case "$2" in
  vm.loadavg) echo "{ \${LOAD:-10.00} 9.00 8.00 }" ;;
  hw.ncpu) echo "\${NCPU:-8}" ;;
  vm.swapusage) echo "total = 11264.00M  used = \${SWAP_M:-1024.00M}  free = 1.00M  (encrypted)" ;;
  kern.memorystatus_level) echo "\${MEM_FREE:-46}" ;;
  *) exit 1 ;;
esac`);
  const procs = (...lines) => writeFileSync(t.p('ps.out'), lines.map((l) => `${l}\n`).join(''));
  const run = (args, env = {}) => factory(['slot', ...args], { env: { ...t.env, FK_UNAME: 'Darwin', ...env }, cwd: t.main });
  return { ...t, procs, run };
}
const XB = (pid, dd) => `${pid} /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -scheme App -derivedDataPath /dd/${dd} build`;
const PROOF = (pid, dd) => `${pid} /bin/bash /kit/proof/ios/sim-proof-core.sh --udid X --scenario s --out /o --dd /dd/${dd} --no-gate`;
const SHOOTER = '11111111-0000-0000-0000-00000000000A';
const FACTORY1 = '11111111-0000-0000-0000-000000000002';

test('slot status: other builders by derived-data folder, never yours; xcodebuildmcp and the like are not builds', () => {
  const t = project('builders = 4');
  try {
    t.procs(XB(11, 'dd-mine'), '12 node /x/xcodebuildmcp mcp', PROOF(13, 'dd-other'), XB(14, 'dd-other'));
    const r = t.run(['status', '--dd', 'dd-mine', '--udid', SHOOTER]);
    // dd-other (one builder, counted once); of the two other booted sims the running proof uses one, one is left over
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, 'slot: free (1 other builder: dd-other (pid 13); 1 booted simulator no proof is using: box-factory-1; load 10.00)\n');
  } finally {
    t.cleanup();
  }
});

test('slot status: every booted simulator no proof is using counts, [sim] protected ones too; yours (--udid) does not', () => {
  const t = project();
  try {
    t.procs(XB(14, 'dd-other'));
    let r = t.run(['status', '--dd', 'mine']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'slot: busy (1 other builder: dd-other (pid 14); 3 booted simulators no proof is using: Shooter Phone, box-factory-1, box-test-kit ([slot] builders = 2); load 10.00)\n');
    r = t.run(['status', '--dd', 'mine', '--udid', FACTORY1]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /2 booted simulators no proof is using: Shooter Phone, box-test-kit/);
    // the hook's view when it cannot tell which simulator is the caller's: leftovers are not counted
    r = t.run(['status', '--dd', 'mine', '--ignore-leftovers']);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.stdout, 'slot: free (1 other builder: dd-other (pid 14); load 10.00)\n');
  } finally {
    t.cleanup();
  }
});

test('slot status: your own running proof does not hide a leftover simulator', () => {
  const t = project();
  try {
    t.procs(PROOF(13, 'dd-mine'));
    const r = t.run(['status', '--dd', 'mine', '--udid', SHOOTER]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^slot: busy \(0 other builders; 2 booted simulators no proof is using: box-factory-1, box-test-kit /);
  } finally {
    t.cleanup();
  }
});

test('slot: max_load defaults to 2 x the CPU count; [slot] max_load overrides it; wait prints why once, then go; a timeout exits 2', () => {
  const t = project('builders = 9\npoll_s = 1');
  try {
    t.procs();
    let r = t.run(['status'], { LOAD: '16.5' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /; load 16\.5 > 16 \(\[slot\] max_load\)\)\n$/);
    assert.equal(t.run(['status'], { LOAD: '16.5', NCPU: '10' }).status, 0);
    r = t.run(['wait', '--dd', 'mine', '--timeout', '2'], { LOAD: '30.5' });
    assert.equal(r.status, 2);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.filter((l) => l.startsWith('slot: waiting')).length, 1);
    assert.match(lines.at(-1), /^slot: gave up after 2s/);
    r = t.run(['wait', '--dd', 'mine'], { LOAD: '8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^slot: go \(0 other builders; .*load 8\)\n$/);
  } finally {
    t.cleanup();
  }
  const set = project('builders = 9\nmax_load = 40');
  try {
    set.procs();
    assert.equal(set.run(['status'], { LOAD: '30' }).status, 0);
    assert.match(set.run(['status'], { LOAD: '41' }).stdout, /load 41 > 40 \(\[slot\] max_load\)/);
  } finally {
    set.cleanup();
  }
});

test('slot: max_swap_gb and min_free_pct hold the slot on memory, each naming its key', () => {
  const t = project('builders = 9\nmax_swap_gb = 8\nmin_free_pct = 15');
  try {
    t.procs();
    let r = t.run(['status']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /; swap 1\.0 GB; memory 46% free\)\n$/);
    r = t.run(['status'], { SWAP_M: '9907.25M' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /swap 9\.7 GB > 8 \(\[slot\] max_swap_gb\)/);
    r = t.run(['status'], { MEM_FREE: '9' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /memory 9% free < 15% \(\[slot\] min_free_pct\)/);
  } finally {
    t.cleanup();
  }
});

test('slot: max_booted_sims counts every booted simulator besides yours', () => {
  const t = project('builders = 9\nmax_booted_sims = 3');
  try {
    t.procs();
    // yours plus two others makes three: free; a new one besides the three booted would make four
    assert.equal(t.run(['status', '--udid', SHOOTER]).status, 0);
    const r = t.run(['status']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /; 3 other booted simulators \(\[slot\] max_booted_sims = 3\)\)\n$/);
    // not even the hook's --ignore-leftovers lifts it
    assert.equal(t.run(['status', '--ignore-leftovers']).status, 1);
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

test('hook-guard asks factory slot itself: a build is denied while the slot is busy, allowed once it frees', () => {
  const t = project('builders = 2');
  try {
    t.procs(XB(14, 'dd-other'), XB(15, 'dd-third'));
    const hook = (env = {}) => factory(['hook-guard'], {
      env: { ...t.env, FK_UNAME: 'Darwin', ...env },
      cwd: t.main,
      input: JSON.stringify({ tool_name: 'mcp__XcodeBuildMCP__build_run_sim', tool_input: {}, cwd: t.main }),
    });
    let r = hook();
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /XcodeBuildMCP build_run_sim would start a build while the builder slot is busy: slot: busy \(2 other builders: dd-other \(pid 14\), dd-third \(pid 15\) \(\[slot\] builders = 2\)/);
    t.procs(XB(14, 'dd-other'));
    r = hook();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  } finally {
    t.cleanup();
  }
});
