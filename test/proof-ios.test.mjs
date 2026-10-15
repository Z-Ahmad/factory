import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, fixture, scratch } from './helpers.mjs';

// A scratch project: factory.toml (from the synthetic valid.toml, so no real project values) plus the file the
// password is read from. FK_UNAME=Darwin lets the plan modes run anywhere: they touch no simulator.
function project(edit = (s) => s) {
  const s = scratch();
  const dir = realpathSync(s.dir);
  mkdirSync(join(dir, 'tools'));
  writeFileSync(join(dir, 'tools', 'accounts.mjs'), "const OTHER = 'no';\nconst SECRET = 'pw-123';\n");
  writeFileSync(join(dir, 'factory.toml'), edit(readFileSync(fixture('valid.toml'), 'utf8')));
  const run = (cmd, args, env = {}) => factory([cmd, ...args], { cwd: dir, env: { FACTORY_TOML: join(dir, 'factory.toml'), FK_UNAME: 'Darwin', ...env } });
  return { ...s, dir, run };
}
const envLines = (stdout) => stdout.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.slice(2));

test('proof --plan: launch_env is filled ({trip} from [seed], {password} read from its file and never printed), then the scenario', () => {
  const t = project();
  try {
    const r = t.run('proof', ['scrub', '--plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^bundle: {3}invalid\.example\.app \(process Example\)$/m);
    assert.match(r.stdout, /^scenario: scrub on 00000000-0000-0000-0000-000000000000 for 20s @ 20fps$/m);
    assert.deepEqual(envLines(r.stdout), ['EXAMPLE_MODE\tdemo', 'EXAMPLE_SIGNIN\tdemo:<password>', 'EXAMPLE_OPEN\texample-trip', 'EXAMPLE_SCENARIO\tscrub']);
    assert.doesNotMatch(r.stdout, /pw-123/);
  } finally {
    t.cleanup();
  }
});

test('proof --plan: --trip replaces the {trip} default, flag_env flags and --env come after, an empty flag value is not exported', () => {
  const t = project();
  try {
    const r = t.run('proof', ['--scenario', 'scrub', '--trip', 'other-trip', '--appearance', 'night', '--detent', '', '--env', 'EXAMPLE_OPEN=', '--env', 'RAW_KEY=1', '--udid', 'ABC', '--seconds', '9', '--plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^scenario: scrub on ABC for 9s @ 20fps$/m);
    assert.deepEqual(envLines(r.stdout), ['EXAMPLE_MODE\tdemo', 'EXAMPLE_SIGNIN\tdemo:<password>', 'EXAMPLE_OPEN\tother-trip', 'EXAMPLE_SCENARIO\tscrub', 'EXAMPLE_LOOK\tnight', 'EXAMPLE_OPEN\t', 'RAW_KEY\t1']);
  } finally {
    t.cleanup();
  }
});

test('proof: unknown flags are refused; a missing scenario or password file is a clear error', () => {
  const t = project();
  try {
    const unknown = t.run('proof', ['scrub', '--frobnicate', 'x', '--plan']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown arg: --frobnicate/);
    const noScenario = t.run('proof', ['--out', 'x']);
    assert.equal(noScenario.status, 1);
    assert.match(noScenario.stderr, /usage: factory proof <scenario>/);
    writeFileSync(join(t.dir, 'tools', 'accounts.mjs'), 'nothing here\n');
    const noPassword = t.run('proof', ['scrub', '--plan']);
    assert.equal(noPassword.status, 1);
    assert.match(noPassword.stderr, /could not read SECRET from tools\/accounts\.mjs/);
  } finally {
    t.cleanup();
  }
});

test('proof: {password} needs password_from; a launch_env without it (or without {trip}) needs neither', () => {
  const t = project((s) => s.replace('password_from = "tools/accounts.mjs:SECRET"\n', ''));
  try {
    const missing = t.run('proof', ['scrub', '--plan']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /launch_env uses \{password\}: set \[proof\.ios\] password_from/);
  } finally {
    t.cleanup();
  }
  const plain = project((s) => s
    .replace('launch_env    = { MODE = "demo", SIGNIN = "demo:{password}", OPEN = "{trip}" }', 'launch_env    = { MODE = "demo" }')
    .replace('password_from = "tools/accounts.mjs:SECRET"\n', ''));
  try {
    const r = plain.run('proof', ['scrub', '--plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(envLines(r.stdout), ['EXAMPLE_MODE\tdemo', 'EXAMPLE_SCENARIO\tscrub']);
    assert.equal(plain.run('proof', ['scrub', '--trip', 'x', '--plan']).status, 1); // no {trip} in launch_env: there is no --trip
  } finally {
    plain.cleanup();
  }
});

test('proof and proof-matrix skip with exit 0 off macOS, touching nothing', () => {
  const t = project();
  try {
    for (const cmd of ['proof', 'proof-matrix']) {
      const r = t.run(cmd, ['--scenario', 'x', '--out', join(t.dir, 'out')], { FK_UNAME: 'Linux' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'skipped: needs Xcode\n');
    }
  } finally {
    t.cleanup();
  }
});

test('proof-matrix --plan: the cells of a matrix with their sim kind, appearance and device types; options add args', () => {
  const t = project();
  try {
    const r = t.run('proof-matrix', ['--scenario', 'scrub', '--plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^matrix default: scrub on shooter 00000000-0000-0000-0000-000000000000 \(warm launch on fresh sims: yes\)$/m);
    assert.match(r.stdout, /^\s+light\s+sim shooter\s+system light\s+app bright\s+device types -$/m);
    assert.match(r.stdout, /^\s+dark\s+sim shooter\s+system dark\s+app night\s+device types -$/m);
    assert.match(r.stdout, /^\s+small\s+sim fresh\s+system light\s+app bright\s+device types iPhone-SE-3rd-generation,iPhone-16e$/m);
    assert.doesNotMatch(r.stdout, /proof args/);

    const first = t.run('proof-matrix', ['--scenario', 'scrub', '--matrix', 'first-launch', '--detent', 'mid', '--plan']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /warm launch on fresh sims: no/);
    assert.match(first.stdout, /^ {2}proof args: --detent mid --seconds 30 --verdict-arg --launch-search$/m);
    // a seconds value the caller passed is kept
    const mine = t.run('proof-matrix', ['--scenario', 'scrub', '--matrix', 'first-launch', '--seconds', '12', '--plan']);
    assert.match(mine.stdout, /proof args: --seconds 12 --verdict-arg --launch-search$/m);
  } finally {
    t.cleanup();
  }
});

test('proof-matrix: an unknown matrix, an undefined cell and per-cell flags are refused with a reason', () => {
  const t = project((s) => s.replace('cells = ["light", "dark", "small"]', 'cells = ["light", "ghost"]'));
  try {
    const unknown = t.run('proof-matrix', ['--scenario', 's', '--matrix', 'nope', '--plan']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown matrix "nope" \(have: default, first-launch\)/);
    const undefinedCell = t.run('proof-matrix', ['--scenario', 's', '--plan']);
    assert.equal(undefinedCell.status, 1);
    assert.match(undefinedCell.stderr, /names an undefined cell: ghost \(define \[proof\.cell\.ghost\]\)/);
    for (const flag of ['--appearance', '--system-appearance', '--no-gate', '--no-install']) {
      const r = t.run('proof-matrix', ['--scenario', 's', flag, 'x', '--plan']);
      assert.equal(r.status, 1, flag);
      assert.match(r.stderr, /is set per cell by the matrix/);
    }
  } finally {
    t.cleanup();
  }
});

test('proof-matrix: a cell with a bad sim kind or system is refused', () => {
  const t = project((s) => s.replace('sim          = "fresh"', 'sim          = "cloud"'));
  try {
    const r = t.run('proof-matrix', ['--scenario', 's', '--plan']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cell small: sim must be "shooter" or "fresh", got "cloud"/);
  } finally {
    t.cleanup();
  }
});

test('the proof commands are listed by help, with their descriptions', () => {
  const r = factory(['help']);
  for (const name of ['proof', 'proof-matrix', 'proof-verdict', 'proof-calibrate', 'clip-frames']) assert.match(r.stdout, new RegExp(`^ {2}${name} +\\S`, 'm'), name);
});

test('proof-verdict and clip-frames run through the dispatcher', () => {
  const t = project();
  try {
    copyFileSync(fixture('valid.toml'), join(t.dir, 'other.toml'));
    const usage = t.run('proof-verdict', []);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: factory proof-verdict <clip\.mp4>/);
    const frames = t.run('clip-frames', ['/nonexistent.mp4', '--at', '1', join(t.dir, 'x.png')]);
    assert.equal(frames.status, 1);
    assert.match(frames.stderr, /no such clip/);
  } finally {
    t.cleanup();
  }
});
