import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, fixture, scratch } from './helpers.mjs';

// proof-matrix with a fake `factory proof` (FK_PROOF_CORE) and fake xcrun, ps and sysctl: the shooter
// (00000000-...) starts shut down, the slot is always free. The fake core logs its args and the two env flags the
// matrix hands its cells, and writes the verdict VERDICT_<cell> says (default PASS).
const SHOOTER = '00000000-0000-0000-0000-000000000000';
function project() {
  const s = scratch();
  const dir = realpathSync(s.dir);
  const p = (...a) => join(dir, ...a);
  mkdirSync(p('tools'));
  writeFileSync(p('tools', 'accounts.mjs'), "const SECRET = 'pw';\n");
  writeFileSync(p('factory.toml'), readFileSync(fixture('valid.toml'), 'utf8')
    .replace('"~/example-factory"', JSON.stringify(p('state'))) // run leases and swap samples stay in the scratch dir
    .replace('fail_markers  = ["LAYOUT-LOOP"]\n', `fail_markers  = ["LAYOUT-LOOP"]\nbefore        = "echo seeded >> ${p('before.log')}"\n`));
  mkdirSync(p('dd', 'Build', 'Example.app'), { recursive: true });
  writeFileSync(p('dd', 'Build', 'Example.app', 'Example'), 'bin');
  mkdirSync(p('bin'));
  const stub = (name, body) => { writeFileSync(p('bin', name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(p('bin', name), 0o755); };
  stub('xcrun', `echo "$*" >> '${p('xcrun.log')}'
case "$*" in
  "simctl list devices -j") echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{"udid":"${SHOOTER}","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}]}}' ;;
  "simctl list devicetypes -j") echo '{"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","name":"iPhone 17"}]}' ;;
  "simctl list devices"*) echo "    Example Phone (${SHOOTER}) (Shutdown)" ;;
  *" appearance") echo light ;;
esac`);
  stub('ps', 'exit 0');
  stub('vm_stat', 'exit 1');
  stub('sysctl', 'case "$2" in vm.loadavg) echo "{ 1.00 1.00 1.00 }" ;; hw.ncpu) echo 8 ;; *) exit 1 ;; esac');
  stub('ffmpeg', 'exit 0');
  stub('ffprobe', 'exit 0');
  stub('swift', 'exit 0');
  writeFileSync(p('core.sh'), `#!/usr/bin/env bash
echo "SLOT_HELD=$FK_SLOT_HELD BEFORE_DONE=$FK_PROOF_BEFORE_DONE $*" >> '${p('core.log')}'
while [[ $# -gt 0 ]]; do case "$1" in --out) out="$2"; shift 2 ;; *) shift ;; esac; done
cell="\${out##*/}"; v="VERDICT_$cell"; v="\${!v:-PASS}"
echo "VERDICT: $v"
echo "{\\"verdict\\":\\"$v\\",\\"hold\\":{\\"worstMs\\":10},\\"flash\\":{\\"worstScore\\":0.1},\\"bounce\\":{\\"worstScore\\":0},\\"layoutLoop\\":{\\"count\\":0}}" > "$out/verdict.json"
`);
  chmodSync(p('core.sh'), 0o755);
  const run = (args, env = {}) => factory(['proof-matrix', '--scenario', 'scrub', '--dd', p('dd'), ...args], {
    cwd: dir,
    env: { FACTORY_TOML: p('factory.toml'), FK_UNAME: 'Darwin', PATH: `${p('bin')}:${process.env.PATH}`, FK_PROOF_CORE: p('core.sh'), ...env },
  });
  const lines = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8').trim().split('\n') : []);
  return { ...s, p, run, lines };
}

test('proof-matrix --cells: only those cells run; the shooter is booted for them and shut down after; before runs once', () => {
  const t = project();
  try {
    const r = t.run(['--cells', 'light,dark', '--out', t.p('out')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^MATRIX: PASS \(2\/2 cells; launches: light warm, dark warm\)$/m);
    const core = t.lines('core.log');
    assert.equal(core.length, 2);
    // the cells neither wait for a slot nor seed again: the matrix did both
    for (const l of core) assert.match(l, /^SLOT_HELD=1 BEFORE_DONE=1 /);
    assert.deepEqual(t.lines('before.log'), ['seeded']);
    const xc = t.lines('xcrun.log');
    assert.ok(xc.includes(`simctl boot ${SHOOTER}`), xc.join('\n'));
    assert.equal(xc.at(-1), `simctl shutdown ${SHOOTER}`);
    assert.match(r.stdout, /shut down the shooter .* \(this run booted it\)/);
    assert.ok(!existsSync(t.p('out', 'small')));
    const bad = t.run(['--cells', 'light,nope', '--out', t.p('out2')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--cells: matrix default has no cell "nope" \(have: light dark small\)/);
  } finally {
    t.cleanup();
  }
});

test('proof-matrix --rerun-failed: PASS cells are kept from the previous run, the rest run again; all kept boots nothing', () => {
  const t = project();
  try {
    let r = t.run(['--cells', 'light,dark', '--out', t.p('first')], { VERDICT_dark: 'FAIL' });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    const plan = t.run(['--cells', 'light,dark', '--rerun-failed', t.p('first'), '--plan']);
    assert.match(plan.stdout, /^\s+light .*\(kept: PASS in .*first\)$/m);
    assert.doesNotMatch(plan.stdout, /^\s+dark .*kept/m);
    writeFileSync(t.p('core.log'), '');
    r = t.run(['--cells', 'light,dark', '--rerun-failed', t.p('first'), '--out', t.p('second')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^MATRIX: PASS \(2\/2 cells; launches: light kept, dark warm\)$/m);
    assert.deepEqual(t.lines('core.log').map((l) => /--out (\S+)/.exec(l)[1]), [t.p('second', 'dark')]);
    assert.ok(existsSync(t.p('second', 'light', 'verdict.json')));
    assert.match(readFileSync(t.p('second', 'matrix.md'), 'utf8'), /^\| light \| .* \| kept \| light \| bright \| \*\*PASS\*\* /m);
    // every cell kept: no shooter boot, no seed, no proof
    writeFileSync(t.p('xcrun.log'), '');
    writeFileSync(t.p('before.log'), '');
    writeFileSync(t.p('core.log'), '');
    r = t.run(['--cells', 'light', '--rerun-failed', t.p('second'), '--out', t.p('second')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!t.lines('xcrun.log').some((l) => /simctl (boot|shutdown)/.test(l)), t.lines('xcrun.log').join('\n'));
    assert.deepEqual(t.lines('before.log').filter(Boolean), []);
    assert.deepEqual(t.lines('core.log').filter(Boolean), []);
  } finally {
    t.cleanup();
  }
});
