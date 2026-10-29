import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT, factory, fixture, scratch } from './helpers.mjs';

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

test('proof --plan --orientation: orientation_env hands it to the app; portrait needs nothing; neither key is an error', () => {
  const t = project((s) => s.replace('env_prefix    = "EXAMPLE_"\n', 'env_prefix    = "EXAMPLE_"\norientation_env = "ORIENTATION"\n'));
  try {
    const r = t.run('proof', ['scrub', '--orientation', 'landscape', '--plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^orientation: landscape \(launch env only\)$/m);
    assert.deepEqual(envLines(r.stdout).slice(-2), ['EXAMPLE_SCENARIO\tscrub', 'EXAMPLE_ORIENTATION\tlandscape']);
    const portrait = t.run('proof', ['scrub', '--orientation', 'portrait', '--plan']);
    assert.ok(!portrait.stdout.includes('ORIENTATION') && !portrait.stdout.includes('orientation:'));
    assert.equal(t.run('proof', ['scrub', '--orientation', 'Side ways', '--plan']).status, 1);
  } finally {
    t.cleanup();
  }
  const bare = project();
  try {
    const r = bare.run('proof', ['scrub', '--orientation', 'landscape', '--plan']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /set \[proof\.ios\] orientation_cmd .* and\/or orientation_env/);
    assert.equal(bare.run('proof', ['scrub', '--orientation', 'portrait', '--plan']).status, 0);
  } finally {
    bare.cleanup();
  }
  const turned = project((s) => s.replace('env_prefix    = "EXAMPLE_"\n', 'env_prefix    = "EXAMPLE_"\norientation_cmd = "scripts/turn.sh {udid} {orientation} {dd}"\n'));
  try {
    const r = turned.run('proof', ['scrub', '--orientation', 'landscape', '--plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^orientation: landscape, turned by: scripts\/turn\.sh \{udid\} \{orientation\} \{dd\} \(and back to portrait after\)$/m);
    assert.ok(!r.stdout.includes('ORIENTATION'));
  } finally {
    turned.cleanup();
  }
});

test('proof --orientation: orientation_cmd turns the sim before install, and back to portrait when the run fails', () => {
  const t = project((s) => s.replace('env_prefix    = "EXAMPLE_"\n', 'env_prefix    = "EXAMPLE_"\norientation_cmd = "echo {udid} {orientation} {dd} >> turns.log"\n'));
  try {
    const bin = join(t.dir, 'bin');
    mkdirSync(bin);
    const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    // simctl knows the sim, installs nothing, and records no video: the run fails after the turn
    stub('xcrun', `echo "$*" >> '${join(t.dir, 'xcrun.log')}'
case "$*" in "simctl list devices") echo "    Phone (ABC) (Booted)" ;; *recordVideo*) sleep 3 ;; esac`);
    stub('ffmpeg', 'exit 0');
    stub('ffprobe', 'exit 0');
    const dd = join(t.dir, 'dd');
    mkdirSync(join(dd, 'Build', 'Example.app'), { recursive: true });
    writeFileSync(join(dd, 'Build', 'Example.app', 'Example'), 'bin');
    const r = t.run('proof', ['scrub', '--udid', 'ABC', '--dd', dd, '--out', join(t.dir, 'out'), '--seconds', '0', '--orientation', 'landscape', '--no-slot'], {
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no video written/);
    assert.equal(readFileSync(join(t.dir, 'turns.log'), 'utf8'), `ABC landscape ${dd}\nABC portrait ${dd}\n`);
    // --build with a turn uses orientation_build; a failed turn is not "turned back"
    writeFileSync(join(t.dir, 'factory.toml'), readFileSync(join(t.dir, 'factory.toml'), 'utf8')
      .replace('orientation_cmd = "echo {udid} {orientation} {dd} >> turns.log"', 'orientation_cmd = "exit 1"\norientation_build = "echo for-testing >> builds.log"')
      .replace('build         = "scripts/build.sh {dd}"', 'build         = "echo app-only >> builds.log"'));
    const b = t.run('proof', ['scrub', '--udid', 'ABC', '--dd', dd, '--out', join(t.dir, 'out2'), '--seconds', '0', '--build', '--orientation', 'landscape', '--no-slot'], {
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(b.status, 1);
    assert.match(b.stderr, /orientation_cmd failed for landscape/);
    assert.doesNotMatch(b.stderr, /back to portrait/);
    assert.equal(readFileSync(join(t.dir, 'builds.log'), 'utf8'), 'for-testing\n');
    const calls = readFileSync(join(t.dir, 'xcrun.log'), 'utf8');
    assert.ok(calls.indexOf('simctl install') > 0, calls); // turned first, then installed
  } finally {
    t.cleanup();
  }
});

test('proof-matrix --plan: a cell orientation, and --orientation as the default for cells without one', () => {
  const t = project((s) => s.replace('[proof.cell.dark]\n', '[proof.cell.dark]\norientation = "landscape"\n'));
  try {
    let r = t.run('proof-matrix', ['--scenario', 'scrub', '--plan']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\s+dark\s+sim shooter\s+system dark\s+app night\s+device types -  orientation landscape$/m);
    assert.match(r.stdout, /^\s+light\s+sim shooter\s+system light\s+app bright\s+device types -$/m);
    r = t.run('proof-matrix', ['--scenario', 'scrub', '--orientation', 'portrait', '--plan']);
    assert.match(r.stdout, /^\s+light\s+.*device types -  orientation portrait$/m);
    assert.match(r.stdout, /^\s+dark\s+.*orientation landscape$/m);
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

test('fk_proof_dd: the default is per worktree, and every dd gets a .metadata_never_index', () => {
  const s = scratch();
  try {
    const main = join(s.dir, 'main'), wt = join(s.dir, 'main', '.worktrees', 'night-9'), ddRoot = join(s.dir, 'cache');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /x/.git/worktrees/night-9\n'); // a worktree's .git is a file
    mkdirSync(join(main, '.git'));
    const dd = (root, arg = '') => execFileSync('bash', ['-c', `. "$FK_KIT_DIR/lib/sh/common.sh"; . "$FK_KIT_DIR/proof/ios/common.sh"; fk_proof_dd ${arg}`], {
      env: { ...process.env, FK_KIT_DIR: KIT, FK_DISK_DD_ROOT: ddRoot, FK_PROOF_IOS_DD: 'app', FK_ROOT: root, FK_PROJECT_MAIN_CHECKOUT: main },
      encoding: 'utf8',
    }).trim();
    assert.equal(dd(main), join(ddRoot, 'dd-app'));
    assert.equal(dd(wt), join(ddRoot, 'dd-app-night-9'));
    assert.equal(dd(wt, 'build/dd'), join(wt, 'build', 'dd'));
    for (const d of [join(ddRoot, 'dd-app'), join(ddRoot, 'dd-app-night-9'), join(wt, 'build', 'dd')]) assert.ok(existsSync(join(d, '.metadata_never_index')), d);
  } finally {
    s.cleanup();
  }
});

test('proof: waits for a slot before the build and the boot, runs [proof.ios] before, skips a no-op build, shuts down a sim it booted', () => {
  const t = project((s) => s
    .replace('build         = "scripts/build.sh {dd}"', 'build         = "echo built >> builds.log"')
    .replace('fail_markers  = ["LAYOUT-LOOP"]\n', 'fail_markers  = ["LAYOUT-LOOP"]\nsources       = ["src"]\nbefore        = "echo seeded >> before.log"\n'));
  try {
    const bin = join(t.dir, 'bin');
    mkdirSync(bin);
    const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    // the sim starts shut down; no video is ever written, so each run fails after the launch, as a stopped proof does
    stub('xcrun', `echo "$*" >> '${join(t.dir, 'xcrun.log')}'
case "$*" in "simctl list devices"*) echo "    Phone (ABC) (Shutdown)" ;; *recordVideo*) sleep 3 ;; esac`);
    stub('ffmpeg', 'exit 0');
    stub('ffprobe', 'exit 0');
    stub('ps', 'exit 0');
    stub('sysctl', 'case "$2" in vm.loadavg) echo "{ 1.00 1.00 1.00 }" ;; hw.ncpu) echo 8 ;; *) exit 1 ;; esac');
    const git = (...a) => execFileSync('git', ['-C', t.dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    mkdirSync(join(t.dir, 'src'));
    writeFileSync(join(t.dir, 'src', 'a.swift'), 'a');
    git('init', '-q');
    git('add', 'src');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
    const dd = join(t.dir, 'dd');
    mkdirSync(join(dd, 'Build', 'Example.app'), { recursive: true });
    writeFileSync(join(dd, 'Build', 'Example.app', 'Example'), 'bin');
    const proof = (out) => t.run('proof', ['scrub', '--udid', 'ABC', '--dd', dd, '--out', join(t.dir, out), '--seconds', '0', '--build'], { PATH: `${bin}:${process.env.PATH}` });
    let r = proof('o1');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no video written/);
    assert.equal(r.stdout.match(/^slot: go /gm)?.length, 2, r.stdout);
    assert.equal(readFileSync(join(t.dir, 'builds.log'), 'utf8'), 'built\n');
    assert.equal(readFileSync(join(t.dir, 'before.log'), 'utf8'), 'seeded\n');
    const calls = readFileSync(join(t.dir, 'xcrun.log'), 'utf8').trim().split('\n');
    assert.equal(calls.at(-1), 'simctl shutdown ABC');
    assert.ok(calls.indexOf('simctl boot ABC') < calls.findIndex((c) => c.startsWith('simctl install')));
    // the same tree again: no build, one slot wait (the boot)
    r = proof('o2');
    assert.match(r.stdout, /^build skipped: .*Example\.app is already a build of [0-9a-f]+ with nothing uncommitted under src/m);
    assert.equal(r.stdout.match(/^slot: go /gm)?.length, 1, r.stdout);
    assert.equal(readFileSync(join(t.dir, 'builds.log'), 'utf8'), 'built\n');
    // --keep-booted leaves it up
    writeFileSync(join(t.dir, 'xcrun.log'), '');
    t.run('proof', ['scrub', '--udid', 'ABC', '--dd', dd, '--out', join(t.dir, 'o3'), '--seconds', '0', '--keep-booted', '--no-slot'], { PATH: `${bin}:${process.env.PATH}` });
    assert.ok(!readFileSync(join(t.dir, 'xcrun.log'), 'utf8').includes('simctl shutdown'));
  } finally {
    t.cleanup();
  }
});
