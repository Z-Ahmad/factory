import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

// The fake `df` in the fixture reports DF_GB free, then DF_GB_AFTER (if set) after the first call.
const withTree = (fn, opts) => {
  const t = tree(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};
const guard = (t, args = [], env = {}) => factory(['disk-guard', ...args], { env: { ...t.env, ...env }, cwd: t.main });
const SCRATCH_AT_START = ['dd-fresh', 'dd-old1', 'dd-sim', 'ee1-new', 'ee1-old', 'sg-abc', 'theme-x', 'tmp.zzz', 'unrelated'];

test('enough space: prints free GB, exits 0, cleans nothing', () =>
  withTree((t) => {
    const r = guard(t, [], { DF_GB: '67' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'factory-disk-guard: 67 GB free on / (min 40, floor 20)\n');
    assert.deepEqual(t.names('tmp'), SCRATCH_AT_START);
  }));

test('below min: runs the [disk] low_cleanup categories, reports again, exits 0 when it recovered', () =>
  withTree((t) => {
    const r = guard(t, [], { DF_GB: '30', DF_GB_AFTER: '45' });
    assert.equal(r.status, 0, r.stderr);
    const out = t.clean(r.stdout);
    assert.match(out, /^factory-disk-guard: 30 GB free on \/ \(min 40, floor 20\)\nfactory-cleanup: APPLY\n/);
    assert.match(out, /== frames \(older than 0 days\) ==/);
    assert.match(out, /== tmp /);
    assert.match(out, /== sims ==/);
    assert.ok(!/== derived-data ==/.test(out) && !/== archives/.test(out) && !/== worktrees/.test(out));
    assert.match(out, /factory-disk-guard: 45 GB free after cleanup\n$/);
    assert.deepEqual(t.names('tmp'), ['dd-fresh', 'dd-sim', 'ee1-new', 'unrelated']);
    assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['c.mp4', 'flags.png']); // frames-age 0 takes the new dump too; clips are not in the default low_cleanup
    assert.equal(t.xcrunCalls().length, 4);
  }));

test('still below floor after cleanup: exits 2 and says to stop', () =>
  withTree((t) => {
    const r = guard(t, [], { DF_GB: '30', DF_GB_AFTER: '12' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /12 GB free after cleanup/);
    assert.match(r.stderr, /factory-disk-guard: BELOW FLOOR \(20 GB\), stop/);
  }));

test('the bands come from [disk] min_gb and floor_gb; --min and --floor override them', () => {
  withTree(
    (t) => {
      const r = guard(t, [], { DF_GB: '67' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /\(min 100, floor 20\)/);
      assert.match(r.stdout, /factory-cleanup: APPLY/); // 67 < 100
    },
    { diskOverrides: { min_gb: 100 } },
  );
  withTree(
    (t) => {
      const r = guard(t, [], { DF_GB: '67' });
      assert.equal(r.status, 2); // 67 < floor 90 even after cleanup
    },
    { diskOverrides: { min_gb: 100, floor_gb: 90 } },
  );
  withTree((t) => {
    const r = guard(t, ['--min', '10', '--floor', '5'], { DF_GB: '67' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\(min 10, floor 5\)/);
    assert.deepEqual(t.names('tmp'), SCRATCH_AT_START);
  });
});

test('low_cleanup chooses the categories', () =>
  withTree(
    (t) => {
      const r = guard(t, [], { DF_GB: '30', DF_GB_AFTER: '45' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /== frames/);
      assert.ok(!/== tmp/.test(r.stdout) && !/== sims/.test(r.stdout));
      assert.deepEqual(t.names('tmp'), SCRATCH_AT_START);
      assert.deepEqual(t.xcrunCalls(), []);
    },
    { diskOverrides: { low_cleanup: ['frames'] } },
  ));

test('bad arguments exit 1', () =>
  withTree((t) => {
    const r = guard(t, ['--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown arg: --bogus/);
  }));

test('without [disk] min_gb and floor_gb it defaults to 40 and 20', () =>
  withTree((t) => {
    const toml = readFileSync(t.p('factory.toml'), 'utf8').replace(/^(min_gb|floor_gb) .*\n/gm, '');
    writeFileSync(t.p('factory.toml'), toml);
    const r = guard(t, [], { DF_GB: '67' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(min 40, floor 20\)/);
  }));
