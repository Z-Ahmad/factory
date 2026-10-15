import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';
import { freePort, isUp, startServer, writeServer } from './procs.mjs';

// The tree's main checkout gets three cache dirs: node_modules and app/.build exist, nothing/ does not.
function wtTree(opts = {}) {
  const t = tree({
    extraToml: () => `
[worktree]
cache_symlinks = ["node_modules", "app/.build", "missing/dir", "app/Config/secrets.cfg"]
`,
    ...opts,
  });
  mkdirSync(join(t.main, 'node_modules'));
  mkdirSync(join(t.main, 'app', '.build'), { recursive: true });
  mkdirSync(join(t.main, 'app', 'Config'), { recursive: true });
  writeFileSync(join(t.main, 'app', 'Config', 'secrets.cfg'), 'placeholder\n');
  const wtree = (name, args = []) => factory(['worktree', name, ...args], { env: t.env, cwd: t.main });
  return { ...t, wtree };
}

const withTree = (fn, opts) => {
  const t = wtTree(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};

test('creates the worktree on [git] worktree_branch from the default target, and links the caches', () =>
  withTree((t) => {
    const r = t.wtree('kit-probe');
    assert.equal(r.status, 0, r.stderr);
    const dir = join(t.main, '.worktrees', 'kit-probe');
    assert.match(r.stderr, /origin\/nightly\/kit-probe not found, falling back to origin\/trunk/);
    assert.equal(t.clean(r.stdout).slice(t.clean(r.stdout).indexOf('symlinking')), [
      'symlinking caches from <root>/main',
      '  link node_modules',
      '  link app/.build',
      '  skip missing/dir (missing in main checkout)',
      '  link app/Config/secrets.cfg',
      '',
      'worktree: <root>/main/.worktrees/kit-probe  (branch x/kit-probe-wt)',
      'push:     git push origin HEAD:nightly/kit-probe',
      "reminder: the symlinks are untracked. Never 'git add .' or 'git add -A'; commit explicit paths.",
      '',
    ].join('\n'));
    assert.equal(t.git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'x/kit-probe-wt');
    assert.equal(t.git(dir, 'rev-parse', 'HEAD'), t.git(t.main, 'rev-parse', 'origin/trunk'));
    for (const rel of ['node_modules', 'app/.build', 'app/Config/secrets.cfg']) {
      assert.equal(lstatSync(join(dir, rel)).isSymbolicLink(), true, rel);
      assert.equal(readlinkSync(join(dir, rel)), join(t.main, rel));
    }
    assert.equal(existsSync(join(dir, 'missing')), false);
    // the secret file is only linked, never copied or read into the output
    assert.ok(!r.stdout.includes('placeholder'));
  }));

test('re-running reuses the worktree and reports ok / keep', () =>
  withTree((t) => {
    t.wtree('again');
    const dir = join(t.main, '.worktrees', 'again');
    // a real directory where a link would go stays as it is
    mkdirSync(join(dir, 'app', '.build'), { recursive: true }); // replaced below
    const r = t.wtree('again');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^reusing worktree .*again\n/);
    assert.match(r.stdout, /ok {3}node_modules/);
    assert.match(r.stdout, /ok {3}app\/\.build/); // it was already a symlink
    assert.equal(lstatSync(join(dir, 'app', '.build')).isSymbolicLink(), true);
  }));

test('a real path already in the worktree is kept, not replaced', () =>
  withTree((t) => {
    const r1 = t.wtree('real');
    assert.equal(r1.status, 0);
    const dir = join(t.main, '.worktrees', 'real');
    writeFileSync(join(t.main, 'extra.txt'), 'x');
    const toml = readFileSync(t.p('factory.toml'), 'utf8').replace('"missing/dir"', '"extra.txt"');
    writeFileSync(t.p('factory.toml'), toml);
    writeFileSync(join(dir, 'extra.txt'), 'mine');
    const r = t.wtree('real');
    assert.match(r.stdout, /keep extra\.txt \(real path already exists in worktree\)/);
    assert.equal(readFileSync(join(dir, 'extra.txt'), 'utf8'), 'mine');
  }));

test('cuts from origin/<push_branch> when it exists; --base wins over both', () =>
  withTree((t) => {
    writeFileSync(join(t.main, 'later.txt'), 'later');
    t.git(t.main, 'add', 'later.txt');
    t.git(t.main, 'commit', '-q', '-m', 'later');
    t.git(t.main, 'push', '-q', 'origin', 'trunk:refs/heads/nightly/has-up');
    const later = t.git(t.main, 'rev-parse', 'HEAD');
    const first = t.git(t.main, 'rev-parse', 'HEAD~1');

    let r = t.wtree('has-up');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes('falling back'));
    assert.equal(t.git(join(t.main, '.worktrees', 'has-up'), 'rev-parse', 'HEAD'), later);

    r = t.wtree('based', ['--base', first]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.git(join(t.main, '.worktrees', 'based'), 'rev-parse', 'HEAD'), first);
  }));

test('reuses an existing branch of that name', () =>
  withTree((t) => {
    t.git(t.main, 'branch', 'x/old-wt', 'origin/trunk');
    const r = t.wtree('old');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.git(join(t.main, '.worktrees', 'old'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'x/old-wt');
  }));

test('without a default target and without --base it exits 1 and creates nothing', () =>
  withTree((t) => {
    writeFileSync(t.p('factory.toml'), readFileSync(t.p('factory.toml'), 'utf8').replace('default = true\n', ''));
    const r = t.wtree('nowhere');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no \[\[targets\]\] entry has default = true; pass --base/);
    assert.equal(existsSync(join(t.main, '.worktrees', 'nowhere')), false);
  }));

test('bad arguments exit 1', () =>
  withTree((t) => {
    assert.equal(t.wtree('').status, 1);
    assert.equal(factory(['worktree'], { env: t.env, cwd: t.main }).status, 1);
    assert.equal(t.wtree('--base').status, 1);
    assert.equal(t.wtree('../escape').status, 1);
    assert.equal(t.wtree('ok', ['--bogus']).status, 1);
    assert.match(t.wtree('ok', ['--bogus']).stderr, /unknown arg: --bogus/);
  }));

test('works from inside another worktree, because the main checkout comes from factory.toml', () =>
  withTree((t) => {
    const r = factory(['worktree', 'from-inside'], { env: t.env, cwd: join(t.main, '.worktrees', 'night-1') });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(t.main, '.worktrees', 'from-inside')), true);
  }));

// ---- preflight ----

async function preflightProject({ restore = 'echo seeded >> {seedlog}; echo All matches.', up = () => 'true', timeout = 2 } = {}) {
  const a = await freePort();
  const t = tree({
    extraToml: (p) => `
[dev]
up         = "${up(p, a)}"
cwd        = ".worktrees/night-1"
wait_ports = [${a}]
timeout_s  = ${timeout}

[seed]
restore = "${restore.replaceAll('{seedlog}', p('seed.log'))}"
`,
  });
  const kids = [];
  const groups = [];
  const run = (args = [], env = {}) => factory(['preflight', ...args], { env: { ...t.env, FK_DEV_POLL_S: '1', ...env }, cwd: t.main });
  const done = () => {
    for (const k of kids) k.kill('SIGKILL');
    for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* already gone */ } }
    t.cleanup();
  };
  return { ...t, port: a, run, kids, groups, seedLog: t.p('seed.log'), done };
}

async function withPreflight(opts, fn) {
  const t = await preflightProject(opts);
  try {
    await fn(t);
  } finally {
    t.done();
  }
}

test('preflight: all good prints one line and exits 0', () =>
  withPreflight({}, async (t) => {
    t.kids.push(await startServer(t.root, t.port));
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'factory-preflight: ok - disk 67 GB free; dev up (no-op); seed ok (All matches.)\n');
    assert.equal(r.stderr, '');
    assert.equal(readFileSync(t.seedLog, 'utf8'), 'seeded\n'); // once, not twice
  }));

test('preflight: starts the stack when it is down, and says so', () =>
  withPreflight({ up: (p, port) => `echo $$ > ${p('dev.pid')}; exec node ${p('server.mjs')} ${port}`, timeout: 30 }, async (t) => {
    writeServer(t.root);
    const r = t.run();
    if (existsSync(t.p('dev.pid'))) t.groups.push(Number(readFileSync(t.p('dev.pid'), 'utf8')));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^factory-preflight: ok - disk 67 GB free; dev started; seed ok/);
    assert.equal(await isUp(t.port), true);
  }));

test('preflight: disk below the floor stops at disk-guard with its exit code, and starts nothing', () =>
  withPreflight({}, async (t) => {
    const r = t.run([], { DF_GB: '12' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /^factory-preflight: FAILED at disk-guard \(exit 2\)\n$/);
    assert.match(r.stderr, /BELOW FLOOR/);
    assert.equal(existsSync(t.seedLog), false);
  }));

test('preflight: a stack that does not come up fails at dev-up (exit 2), before the seed', () =>
  withPreflight({}, (t) => {
    const r = t.run();
    assert.equal(r.status, 2);
    assert.equal(r.stdout, 'factory-preflight: FAILED at dev-up (exit 2)\n');
    assert.match(r.stderr, /did not come up/);
    assert.equal(existsSync(t.seedLog), false);
  }));

test('preflight: a failing seed restore fails at seed with that exit code', () =>
  withPreflight({ restore: 'echo it broke; exit 7' }, async (t) => {
    t.kids.push(await startServer(t.root, t.port));
    const r = t.run();
    assert.equal(r.status, 7);
    assert.equal(r.stdout, 'factory-preflight: FAILED at seed (exit 7)\n');
    assert.match(r.stderr, /it broke/);
  }));

test('preflight touches no git state and takes no arguments', () =>
  withPreflight({}, async (t) => {
    t.kids.push(await startServer(t.root, t.port));
    const before = t.git(t.main, 'for-each-ref');
    const worktrees = t.git(t.main, 'worktree', 'list');
    assert.equal(t.run().status, 0);
    assert.equal(t.git(t.main, 'for-each-ref'), before);
    assert.equal(t.git(t.main, 'worktree', 'list'), worktrees);
    assert.equal(t.run(['--now']).status, 1);
  }));
