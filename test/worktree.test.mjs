import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  // app/ is tracked (on origin/trunk), so the worktree has it; missing/ exists nowhere
  mkdirSync(join(t.main, 'app', '.build'), { recursive: true });
  mkdirSync(join(t.main, 'app', 'Config'), { recursive: true });
  writeFileSync(join(t.main, 'app', 'README'), 'app\n');
  t.git(t.main, 'add', 'app/README');
  t.git(t.main, 'commit', '-q', '-m', 'app');
  t.git(t.main, 'push', '-q', 'origin', 'trunk');
  mkdirSync(join(t.main, 'node_modules'));
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
      '  overlay node_modules (0 links, 0 workspace packages -> this worktree)',
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
    // node_modules is not a whole-directory link any more: a real directory (here empty, as the fixture's is)
    assert.equal(lstatSync(join(dir, 'node_modules')).isDirectory(), true);
    for (const rel of ['app/.build', 'app/Config/secrets.cfg']) {
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
    assert.match(r.stdout, /ok {3}node_modules \(overlay\)/);
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

// ---- workspace-aware node_modules, derived outputs, copy_files ----

// The main checkout sits on branch `other` while worktrees are cut from origin/trunk, and @sg/core's source differs
// between the two: the situation where a whole-directory node_modules link made the worktree import the wrong
// branch's workspace package. Layout: workspaces packages/* = @sg/core (differs), sg-app (identical), and @sg/extra
// (only on `other`); the main node_modules has real packages, a real scope dir and npm's workspace links.
const WS_TOML = `
[worktree]
cache_symlinks = ["node_modules", "gone/cache"]
copy_files     = ["web/.env.local", "web/.env.keep", "gone/.env", "web/.env.absent"]

[[worktree.derived]]
path   = "packages/core/dist"
source = "packages/core/src"
build  = "mkdir -p packages/core/dist && echo built-in-worktree > packages/core/dist/marker && cat node_modules/@sg/core/src/index.js > packages/core/dist/seen && echo run >> ${'$'}{BUILD_LOG:-/dev/null}"

[[worktree.derived]]
path   = "packages/app/dist"
source = "packages/app/src"
build  = "mkdir -p packages/app/dist && echo unexpected > packages/app/dist/marker"
`;

function wsTree(toml = WS_TOML) {
  const t = tree({ extraToml: () => toml });
  const w = (rel, text) => {
    mkdirSync(join(t.main, rel, '..'), { recursive: true });
    writeFileSync(join(t.main, rel), text);
  };
  w('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }));
  w('packages/core/package.json', JSON.stringify({ name: '@sg/core' }));
  w('packages/core/src/index.js', 'core-v1\n');
  w('packages/app/package.json', JSON.stringify({ name: 'sg-app' }));
  w('packages/app/src/main.js', 'app\n');
  w('web/README', 'web\n');
  t.git(t.main, 'add', '.');
  t.git(t.main, 'commit', '-q', '-m', 'workspaces');
  t.git(t.main, 'push', '-q', 'origin', 'trunk');
  // the main checkout moves to another branch: core's source changes and a package appears that trunk lacks
  t.git(t.main, 'checkout', '-q', '-b', 'other');
  w('packages/core/src/index.js', 'core-v2-other-branch\n');
  w('packages/extra/package.json', JSON.stringify({ name: '@sg/extra' }));
  t.git(t.main, 'add', '.');
  t.git(t.main, 'commit', '-q', '-m', 'other');
  // untracked: installs, build outputs, env files
  const nm = join(t.main, 'node_modules');
  for (const d of ['.bin', 'left-pad', '@sg/lib']) mkdirSync(join(nm, d), { recursive: true });
  writeFileSync(join(nm, '.bin', 'tool'), 'tool');
  writeFileSync(join(nm, '.package-lock.json'), '{}');
  writeFileSync(join(nm, 'left-pad', 'index.js'), 'pad');
  writeFileSync(join(nm, '@sg', 'lib', 'index.js'), 'lib');
  symlinkSync('../../packages/core', join(nm, '@sg', 'core'));
  symlinkSync('../../packages/extra', join(nm, '@sg', 'extra'));
  symlinkSync('../packages/app', join(nm, 'sg-app'));
  w('packages/core/dist/marker', 'main-built\n');
  w('packages/app/dist/marker', 'main-app-built\n');
  w('web/.env.local', 'PUBLIC=main\n');
  w('web/.env.keep', 'theirs\n');
  w('gone/.env', 'x\n');
  mkdirSync(join(t.main, 'gone', 'cache'), { recursive: true });
  const wtree = (name, args = [], env = {}) => factory(['worktree', name, ...args], { env: { ...t.env, ...env }, cwd: t.main });
  const dir = (name) => join(t.main, '.worktrees', name);
  const ls = (d) => readdirSync(d).sort();
  return { ...t, wtree, dir, ls, nm };
}

const withWs = (fn, toml) => {
  const t = wsTree(toml);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};
const isLink = (p) => lstatSync(p).isSymbolicLink();
const isRealDir = (p) => lstatSync(p).isDirectory();

test('node_modules is a real directory; a workspace package links into the worktree, everything else into main', () =>
  withWs((t) => {
    const r = t.wtree('ws');
    assert.equal(r.status, 0, r.stderr);
    const d = t.dir('ws');
    const nm = join(d, 'node_modules');
    assert.equal(isRealDir(nm), true);
    assert.equal(isLink(nm), false);
    // (2) workspace links: relative, as npm makes them, resolving to the WORKTREE's package
    assert.equal(isRealDir(join(nm, '@sg')), true);
    assert.equal(readlinkSync(join(nm, '@sg', 'core')), '../../packages/core');
    assert.equal(realpathSync(join(nm, '@sg', 'core')), realpathSync(join(d, 'packages', 'core')));
    assert.equal(readFileSync(join(nm, '@sg', 'core', 'src', 'index.js'), 'utf8'), 'core-v1\n');
    assert.equal(readlinkSync(join(nm, 'sg-app')), '../packages/app');
    // a main-only workspace package (@sg/extra) is not carried over, and no link points into main's sources
    assert.equal(existsSync(join(nm, '@sg', 'extra')), false);
    assert.deepEqual(t.ls(join(nm, '@sg')), ['core', 'lib']);
    // (3) every other entry, dot entries included, links to main's
    assert.equal(readlinkSync(join(nm, '.bin')), join(t.main, 'node_modules', '.bin'));
    assert.equal(readlinkSync(join(nm, '.package-lock.json')), join(t.main, 'node_modules', '.package-lock.json'));
    assert.equal(readlinkSync(join(nm, 'left-pad')), join(t.main, 'node_modules', 'left-pad'));
    assert.equal(readlinkSync(join(nm, '@sg', 'lib')), join(t.main, 'node_modules', '@sg', 'lib'));
    assert.deepEqual(t.ls(nm), ['.bin', '.package-lock.json', '@sg', 'left-pad', 'sg-app']);
    assert.match(r.stdout, /overlay node_modules \(\d+ links, 2 workspace packages -> this worktree\)/);
    // main's node_modules is untouched
    assert.deepEqual(t.ls(join(t.main, 'node_modules', '@sg')), ['core', 'extra', 'lib']);
    assert.equal(readlinkSync(join(t.main, 'node_modules', '@sg', 'core')), '../../packages/core');
  }));

test('packages only the worktree branch installs are fetched at their locked version into real directories', () =>
  withWs((t) => {
    // trunk (the worktree's branch) locks packages the main checkout (on "other") never installed
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'node_modules/left-pad': { version: '1.0.0' }, // installed in main: linked, not fetched
        'node_modules/only-here': { version: '1.2.3' },
        'node_modules/only-here/node_modules/inner': { version: '0.1.0' }, // under a fetched package
        'node_modules/@sg/new': { version: '2.0.0' }, // in a scope the overlay makes real
        'node_modules/left-pad/node_modules/under-link': { version: '9.9.9' }, // under a link to main: left alone
        'node_modules/@sg/core': { resolved: 'packages/core', link: true }, // workspace link
        'node_modules/elsewhere': { version: '1.0.0', os: ['win32'] }, // another platform
      },
    };
    t.git(t.main, 'checkout', '-q', 'trunk');
    writeFileSync(join(t.main, 'package-lock.json'), JSON.stringify(lock));
    t.git(t.main, 'add', 'package-lock.json');
    t.git(t.main, 'commit', '-q', '-m', 'lock');
    t.git(t.main, 'push', '-q', 'origin', 'trunk');
    t.git(t.main, 'checkout', '-q', 'other');
    // a stand-in npm: `npm pack <name>@<version> --pack-destination <dir>` writes a tarball and prints its name
    const bin = join(t.main, '..', 'fake-npm');
    mkdirSync(bin, { recursive: true });
    const npm = join(bin, 'npm');
    writeFileSync(npm, `#!/usr/bin/env bash
spec="$2"; dest="$4"; name="\${spec%@*}"; version="\${spec##*@}"
work="$(mktemp -d)"; mkdir -p "$work/package"
printf '{"name":"%s","version":"%s"}' "$name" "$version" > "$work/package/package.json"
file="$(echo "$name" | tr -d @ | tr / -)-$version.tgz"
tar -czf "$dest/$file" -C "$work" package && rm -rf "$work"
echo "$file"
`);
    chmodSync(npm, 0o755);
    const r = t.wtree('fetch', [], { FK_NPM: npm });
    assert.equal(r.status, 0, r.stderr);
    const nm = join(t.dir('fetch'), 'node_modules');
    const version = (p) => JSON.parse(readFileSync(join(nm, p, 'package.json'), 'utf8')).version;
    assert.equal(isRealDir(join(nm, 'only-here')), true);
    assert.equal(version('only-here'), '1.2.3');
    assert.equal(version('only-here/node_modules/inner'), '0.1.0');
    assert.equal(isRealDir(join(nm, '@sg', 'new')), true);
    assert.equal(version('@sg/new'), '2.0.0');
    assert.match(r.stdout, /fetch node_modules\/only-here \(only-here@1\.2\.3\)/);
    // nothing was written into the main checkout, nor fetched for a linked, workspace or foreign-platform entry
    assert.equal(existsSync(join(t.main, 'node_modules', 'left-pad', 'node_modules')), false);
    assert.equal(existsSync(join(t.main, 'node_modules', 'only-here')), false);
    assert.equal(existsSync(join(nm, 'elsewhere')), false);
    assert.equal(readlinkSync(join(nm, 'left-pad')), join(t.main, 'node_modules', 'left-pad'));
    assert.doesNotMatch(r.stdout, /under-link|elsewhere|@sg\/core/);
    // a re-run fetches nothing new
    const again = t.wtree('fetch', [], { FK_NPM: npm });
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /fetch node_modules/);
  }));

test('a derived output is built when its source differs, and symlinked when identical', () =>
  withWs((t) => {
    const r = t.wtree('der');
    assert.equal(r.status, 0, r.stderr);
    const d = t.dir('der');
    // (4) core's source differs between the HEADs: built in the worktree, after the overlay existed
    assert.match(r.stdout, /build packages\/core\/dist \(packages\/core\/src differs from the main checkout's HEAD\)/);
    assert.equal(isLink(join(d, 'packages', 'core', 'dist')), false);
    assert.equal(readFileSync(join(d, 'packages', 'core', 'dist', 'marker'), 'utf8'), 'built-in-worktree\n');
    assert.equal(readFileSync(join(d, 'packages', 'core', 'dist', 'seen'), 'utf8'), 'core-v1\n');
    assert.equal(readFileSync(join(t.main, 'packages', 'core', 'dist', 'marker'), 'utf8'), 'main-built\n');
    // app's source is identical: linked, not built
    assert.equal(readlinkSync(join(d, 'packages', 'app', 'dist')), join(t.main, 'packages', 'app', 'dist'));
    assert.match(r.stdout, /link packages\/app\/dist/);
    assert.ok(!r.stdout.includes('build packages/app/dist'));
  }));

test('a derived symlink from an older run is replaced by a build, never writing through to main', () =>
  withWs((t) => {
    t.wtree('stale');
    const d = t.dir('stale');
    const dist = join(d, 'packages', 'core', 'dist');
    rmSync(dist, { recursive: true });
    symlinkSync(join(t.main, 'packages', 'core', 'dist'), dist);
    const r = t.wtree('stale');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /drop packages\/core\/dist/);
    assert.equal(isLink(dist), false);
    assert.equal(readFileSync(join(dist, 'marker'), 'utf8'), 'built-in-worktree\n');
    assert.equal(readFileSync(join(t.main, 'packages', 'core', 'dist', 'marker'), 'utf8'), 'main-built\n');
    assert.deepEqual(t.ls(join(t.main, 'packages', 'core', 'dist')), ['marker']);
  }));

test('a failing derived build is reported on stderr and exits 1, after the rest finished', () =>
  withWs(
    (t) => {
      const r = t.wtree('bad');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /FAIL build packages\/core\/dist \(exit 3\)/);
      assert.match(r.stderr, /boom/);
      assert.match(r.stdout, /worktree: .*bad/);
    },
    WS_TOML.replace(/build {2}= "mkdir -p packages\/core\/dist.*"/, 'build  = "echo boom; exit 3"'),
  ));

test('copy_files copies what is missing and never overwrites', () =>
  withWs((t) => {
    let r = t.wtree('cp');
    assert.equal(r.status, 0, r.stderr);
    const d = t.dir('cp');
    // (5)
    assert.match(r.stdout, /copy web\/\.env\.local/);
    assert.match(r.stdout, /skip web\/\.env\.absent \(missing in main checkout\)/);
    assert.equal(isLink(join(d, 'web', '.env.local')), false);
    assert.equal(readFileSync(join(d, 'web', '.env.local'), 'utf8'), 'PUBLIC=main\n');
    writeFileSync(join(d, 'web', '.env.keep'), 'mine\n');
    writeFileSync(join(t.main, 'web', '.env.local'), 'PUBLIC=changed\n');
    r = t.wtree('cp');
    assert.match(r.stdout, /ok {3}web\/\.env\.keep \(already here, not overwritten\)/);
    assert.equal(readFileSync(join(d, 'web', '.env.keep'), 'utf8'), 'mine\n');
    assert.equal(readFileSync(join(d, 'web', '.env.local'), 'utf8'), 'PUBLIC=main\n'); // copies do not follow edits
    assert.ok(!r.stdout.includes('PUBLIC='));
  }));

test('an entry whose top folder is not on the branch is skipped, leaving no stray tree', () =>
  withWs((t) => {
    const r = t.wtree('top');
    assert.equal(r.status, 0, r.stderr);
    const d = t.dir('top');
    // (6) gone/ exists in main (untracked) but not on origin/trunk
    assert.match(r.stdout, /^ {2}skip gone\/cache \(gone not on this branch\)$/m);
    assert.match(r.stdout, /^ {2}skip gone\/\.env \(gone not on this branch\)$/m);
    assert.equal(existsSync(join(d, 'gone')), false);
    assert.equal(t.git(d, 'status', '--porcelain', '--untracked-files=all').includes('gone'), false);
  }));

test('re-running is idempotent; a re-run refreshes new entries and corrects workspace links', () =>
  withWs((t) => {
    const log = t.p('build.log');
    const env = { BUILD_LOG: log };
    let r = t.wtree('idem', [], env);
    assert.equal(r.status, 0, r.stderr);
    const d = t.dir('idem');
    const snap = () => [
      t.ls(join(d, 'node_modules')).join(),
      ...t.ls(join(d, 'node_modules')).map((e) => (isLink(join(d, 'node_modules', e)) ? readlinkSync(join(d, 'node_modules', e)) : 'dir')),
      readlinkSync(join(d, 'packages', 'app', 'dist')),
    ].join('|');
    const before = snap();
    // (7)
    r = t.wtree('idem', [], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^reusing worktree/);
    assert.match(r.stdout, /ok {3}node_modules \(overlay\)/);
    assert.match(r.stdout, /keep packages\/core\/dist \(already built in this worktree/);
    assert.equal(snap(), before);
    assert.equal(readFileSync(log, 'utf8'), 'run\n'); // built once
    // refresh: a new entry appears in main, and a workspace link is pointed back at main's source
    mkdirSync(join(t.main, 'node_modules', 'new-pkg'));
    rmSync(join(d, 'node_modules', '@sg', 'core'));
    symlinkSync(join(t.main, 'packages', 'core'), join(d, 'node_modules', '@sg', 'core'));
    r = t.wtree('idem', [], env);
    assert.match(r.stdout, /fresh node_modules \(overlay refreshed: 1 added, 1 corrected\)/);
    assert.equal(readlinkSync(join(d, 'node_modules', 'new-pkg')), join(t.main, 'node_modules', 'new-pkg'));
    assert.equal(readlinkSync(join(d, 'node_modules', '@sg', 'core')), '../../packages/core');
  }));

test('an old whole-directory node_modules link is replaced by an overlay; its target is left alone', () =>
  withWs((t) => {
    t.wtree('mig');
    const d = t.dir('mig');
    const nm = join(d, 'node_modules');
    rmSync(nm, { recursive: true });
    symlinkSync(join(t.main, 'node_modules'), nm); // what the previous kit version left behind
    const mainBefore = readdirSync(join(t.main, 'node_modules'), { recursive: true }).sort();
    // (8)
    const r = t.wtree('mig');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /drop node_modules \(old whole-directory link/);
    assert.equal(isLink(nm), false);
    assert.equal(isRealDir(nm), true);
    assert.equal(realpathSync(join(nm, '@sg', 'core')), realpathSync(join(d, 'packages', 'core')));
    assert.deepEqual(readdirSync(join(t.main, 'node_modules'), { recursive: true }).sort(), mainBefore);
    assert.equal(readFileSync(join(t.main, 'node_modules', 'left-pad', 'index.js'), 'utf8'), 'pad');
  }));

test('[worktree] node_modules = "link" keeps the old whole-directory symlink', () =>
  withWs((t) => {
    writeFileSync(t.p('factory.toml'), readFileSync(t.p('factory.toml'), 'utf8').replace('[worktree]\n', '[worktree]\nnode_modules = "link"\n'));
    const r = t.wtree('lnk');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}link node_modules$/m);
    assert.equal(readlinkSync(join(t.dir('lnk'), 'node_modules')), join(t.main, 'node_modules'));
  }));

test('workspaces as an object, with ** and ! patterns, are read from the worktree', () =>
  withWs((t) => {
    t.wtree('globs');
    const d = t.dir('globs');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ workspaces: { packages: ['packages/**', '!packages/app'] } }));
    const r = t.wtree('globs');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readlinkSync(join(d, 'node_modules', '@sg', 'core')), '../../packages/core');
    // packages/app is excluded, so sg-app is main's entry again... which is a workspace link into main: left out
    assert.equal(existsSync(join(d, 'node_modules', 'sg-app')), false);
  }));

test('fk_dirt hides copied files and derived outputs along with the cache symlinks', () =>
  withWs((t) => {
    t.wtree('dirt');
    const d = t.dir('dirt');
    const out = factory(['config', 'env', '--sh'], { env: t.env, cwd: t.main }).stdout;
    const COMMON = join(import.meta.dirname, '..', 'lib', 'sh', 'common.sh');
    const r = spawnSync('bash', ['-c', `${out}\n. ${COMMON}; fk_dirt ${d}`], { encoding: 'utf8' });
    assert.equal(r.stdout, '', r.stdout);
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
