import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { factory } from './helpers.mjs';
import { idleWorktree, tree } from './fixture-tree.mjs';

// Stale derived-data pruning: the age rule, keep lists, extra roots, symlink safety, worktree-linked cleanup.
const withTree = (fn, opts) => {
  const t = tree(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};
const cleanup = (t, args = [], env = {}) =>
  factory(['cleanup', ...args], { env: { ...t.env, HOME: t.p('home'), ...env }, cwd: t.main });
// a build folder holding one file last written `hours` ago
const build = (t, dir, hours, file = 'obj.o') => {
  mkdirSync(dir, { recursive: true });
  const f = `${dir}/${file}`;
  writeFileSync(f, 'x');
  t.ago(f, hours);
  t.ago(dir, hours);
};
const DD = ['--only', 'derived-data'];

test('age rule: stale after dd_stale_hours (default 6), a build still being written is left alone', () =>
  withTree((t) => {
    build(t, t.p('cache', 'dd-day-old'), 14);
    build(t, t.p('cache', 'dd-five-hours'), 5);
    build(t, t.p('cache', 'dd-busy'), 0);
    // a stale dir with one fresh file deep inside is in use
    build(t, t.p('cache', 'dd-deep', 'a', 'b'), 20);
    writeFileSync(t.p('cache', 'dd-deep', 'a', 'fresh.o'), 'x');
    t.ago(t.p('cache', 'dd-deep', 'a', 'b'), 20);
    t.ago(t.p('cache', 'dd-deep', 'a'), 0);
    const r = cleanup(t, DD);
    assert.equal(r.status, 0, r.stderr);
    const out = t.clean(r.stdout);
    assert.match(out, /<root>\/cache\/dd-day-old {2}\(stale 14h\)\n/);
    assert.match(out, /<root>\/cache\/dd-stale1 {2}\(stale \d+h\)\n/);
    for (const kept of ['dd-five-hours', 'dd-busy', 'dd-deep']) assert.ok(!out.includes(`/cache/${kept}`), kept);
    assert.match(out, /\nderived-data: 3 stale build folders, \S+ reclaimable \(3 in use or newer than 6h, left alone\)\n/);
    assert.ok(existsSync(t.p('cache', 'dd-day-old'))); // dry run
  }));

test('dd_stale_hours moves the cutoff', () =>
  withTree(
    (t) => {
      build(t, t.p('cache', 'dd-five-hours'), 5);
      build(t, t.p('cache', 'dd-one-hour'), 1);
      const r = cleanup(t, [...DD, '--apply']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(t.clean(r.stdout), /dd-five-hours {2}\(stale 5h\)/);
      assert.ok(!existsSync(t.p('cache', 'dd-five-hours')));
      assert.ok(existsSync(t.p('cache', 'dd-one-hour')));
    },
    { diskExtra: 'dd_stale_hours = 2' },
  ));

test('keep list still wins over age; --dd-all drops the age rule for dd_root only', () =>
  withTree((t) => {
    build(t, t.p('cache', 'dd-app'), 300); // dd_keep name
    build(t, t.p('cache', 'dd-test-Foo'), 300); // dd_keep glob
    build(t, t.p('cache', 'dd-busy'), 0);
    let r = cleanup(t, [...DD, '--apply']);
    assert.ok(existsSync(t.p('cache', 'dd-app')) && existsSync(t.p('cache', 'dd-test-Foo')) && existsSync(t.p('cache', 'dd-busy')));
    r = cleanup(t, [...DD, '--apply', '--dd-all']);
    assert.match(t.clean(r.stdout), /dd-busy {2}\(not in keep list\)/);
    assert.ok(!existsSync(t.p('cache', 'dd-busy')));
    assert.ok(existsSync(t.p('cache', 'dd-app')) && existsSync(t.p('cache', 'dd-test-Foo')));
  }));

test('extra roots: ~ expands, stale children go, in-use and default-keep children stay', () =>
  withTree(
    (t) => {
      const x = t.p('home', 'DerivedData');
      build(t, `${x}/SampleApp-abc`, 30);
      build(t, `${x}/SampleApp-active`, 0);
      for (const k of ['ModuleCache.noindex', 'SDKStatCaches.noindex', 'SymbolCache.noindex', 'CompilationCache.noindex', 'SDKExplicitPrecompiledModules'])
        build(t, `${x}/${k}`, 500);
      writeFileSync(`${x}/loose-file`, 'x');
      let r = cleanup(t, DD);
      assert.match(t.clean(r.stdout), /<root>\/home\/DerivedData\/SampleApp-abc {2}\(stale 30h\)\n/);
      r = cleanup(t, [...DD, '--apply']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(t.names('home', 'DerivedData'), [
        'CompilationCache.noindex', 'ModuleCache.noindex', 'SDKExplicitPrecompiledModules', 'SDKStatCaches.noindex',
        'SampleApp-active', 'SymbolCache.noindex', 'loose-file',
      ]);
    },
    { diskExtra: 'dd_roots_extra = ["~/DerivedData"]' },
  ));

test('dd_extra_keep replaces the default keep list', () =>
  withTree(
    (t) => {
      const x = t.p('home', 'DerivedData');
      build(t, `${x}/ModuleCache.noindex`, 500);
      build(t, `${x}/Pinned-1`, 500);
      build(t, `${x}/Other-1`, 500);
      cleanup(t, [...DD, '--apply']);
      assert.deepEqual(t.names('home', 'DerivedData'), ['Pinned-1']);
    },
    { diskExtra: 'dd_roots_extra = ["~/DerivedData"]\ndd_extra_keep = ["Pinned-*"]' },
  ));

test('never deletes through a symlink, and never outside the configured roots', () =>
  withTree(
    (t) => {
      const x = t.p('home', 'DerivedData');
      const outside = t.p('outside');
      build(t, outside, 900, 'precious.txt');
      mkdirSync(x, { recursive: true });
      symlinkSync(outside, `${x}/Linked-old`);
      symlinkSync(outside, t.p('cache', 'dd-linked'));
      // a stale real dir that itself holds a symlink to the outside: the link goes, the target stays
      build(t, `${x}/Real-old`, 100);
      symlinkSync(outside, `${x}/Real-old/inner-link`);
      execFileSync('touch', ['-h', '-t', '200101010000', `${x}/Real-old/inner-link`]); // the link itself is old too
      t.ago(`${x}/Real-old`, 100);
      const r = cleanup(t, [...DD, '--apply']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!t.clean(r.stdout).includes('Linked-old') && !r.stdout.includes('dd-linked'));
      assert.ok(lstatSync(`${x}/Linked-old`).isSymbolicLink());
      assert.ok(lstatSync(t.p('cache', 'dd-linked')).isSymbolicLink());
      assert.deepEqual(t.names('outside'), ['precious.txt']);
      assert.ok(!existsSync(`${x}/Real-old`));
      assert.ok(existsSync(t.p('state')) && existsSync(t.main)); // nothing else was touched
    },
    { diskExtra: 'dd_roots_extra = ["~/DerivedData"]' },
  ));

test('a root that is the home folder or / is refused', () =>
  withTree(
    (t) => {
      build(t, t.p('home', 'Documents-old'), 900);
      const r = cleanup(t, [...DD, '--apply']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(t.p('home', 'Documents-old')));
    },
    { diskExtra: 'dd_roots_extra = ["~", "/"]' },
  ));

test('removing an agent worktree also removes its dd_root derived data and ephemeral simulators, and says why', () =>
  withTree(
    (t) => {
      const x = t.p('home', 'DerivedData');
      build(t, t.p('cache', 'dd-agent-merged-1'), 0); // in use by age, but its worktree is going: lane slug + id
      build(t, t.p('cache', 'dd-merged'), 0);
      build(t, t.p('cache', 'dd-test-merged'), 0); // kept by the dd_keep glob test-*
      build(t, t.p('cache', 'dd-ahead-x'), 0); // another lane: stays
      // extra roots are shared with other projects: only the age rule applies there, never a name match
      build(t, `${x}/SampleApp-agent-symlink-zz`, 0);
      build(t, `${x}/SampleApp-other`, 0);
      const dry = cleanup(t, ['--only', 'worktrees']);
      const out = t.clean(dry.stdout);
      assert.match(out, /REMOVE agent-merged /);
      assert.match(out, /dd-agent-merged-1 {2}\(worktree gone: agent-merged\)\n/);
      assert.match(out, /dd-merged {2}\(worktree gone: agent-merged\)\n/);
      assert.match(out, /sim box-factory-agent-merged-1 \(11111111-0000-0000-0000-0000000000B1, Booted\) {2}\(worktree gone: agent-merged\)/);
      for (const kept of ['dd-test-merged', 'dd-ahead-x', 'SampleApp-', 'box-opus-keepme', 'Plain merged'])
        assert.ok(!out.includes(kept), kept);
      assert.deepEqual(t.xcrunCalls(), []);
      assert.ok(existsSync(t.p('cache', 'dd-merged')));

      const r = cleanup(t, ['--only', 'worktrees', '--apply']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(t.names('cache').filter((n) => /merged|ahead/.test(n)), ['dd-ahead-x', 'dd-test-merged']);
      assert.deepEqual(t.names('home', 'DerivedData'), ['SampleApp-agent-symlink-zz', 'SampleApp-other']);
      assert.deepEqual(t.xcrunCalls(), [
        'simctl shutdown 11111111-0000-0000-0000-0000000000B1',
        'simctl delete 11111111-0000-0000-0000-0000000000B1',
        'simctl delete 11111111-0000-0000-0000-0000000000B2',
      ]);
    },
    {
      diskExtra: 'dd_roots_extra = ["~/DerivedData"]',
      simsExtra: [
        ['box-factory-agent-merged-1', '11111111-0000-0000-0000-0000000000B1', 'Booted'], // [sim] ephemeral, named for it
        ['box-opus-symlink-9', '11111111-0000-0000-0000-0000000000B2', 'Shutdown'],
        ['box-opus-keepme', '11111111-0000-0000-0000-0000000000B3', 'Shutdown'], // ephemeral, but no worktree's name
        ['Plain merged', '11111111-0000-0000-0000-0000000000B4', 'Shutdown'], // named for it, but not ephemeral
      ],
    },
  ));

test('[git] agent_branches: the branch minus its literal prefix is the slug builds and sims are named for', () =>
  withTree(
    (t) => {
      t.git(t.p('main', '.worktrees', 'agent-merged'), 'branch', '-m', 'nightly/lane-sweeper');
      idleWorktree(t.p('main', '.worktrees', 'agent-merged')); // the rename wrote its HEAD log
      build(t, t.p('cache', 'dd-sweeper-unit'), 0);
      build(t, t.p('cache', 'dd-other-lane'), 0);
      const r = cleanup(t, ['--only', 'worktrees', '--apply']);
      assert.equal(r.status, 0, r.stderr);
      const out = t.clean(r.stdout);
      assert.match(out, /dd-sweeper-unit {2}\(worktree gone: agent-merged\)\n/);
      assert.ok(!existsSync(t.p('cache', 'dd-sweeper-unit')) && existsSync(t.p('cache', 'dd-other-lane')));
      assert.deepEqual(t.xcrunCalls(), ['simctl delete 11111111-0000-0000-0000-0000000000C1']);
    },
    {
      gitExtra: 'agent_branches = "nightly/lane-*"',
      simsExtra: [
        ['box-opus-sweeper', '11111111-0000-0000-0000-0000000000C1', 'Shutdown'],
        ['box-opus-otherlane', '11111111-0000-0000-0000-0000000000C2', 'Shutdown'],
      ],
    },
  ));

test('a worktree that is kept keeps its derived data', () =>
  withTree((t) => {
    build(t, t.p('cache', 'dd-agent-dirty-1'), 0);
    build(t, t.p('cache', 'dd-ahead'), 0);
    const r = cleanup(t, ['--only', 'worktrees', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(t.p('cache', 'dd-agent-dirty-1')) && existsSync(t.p('cache', 'dd-ahead')));
  }));
