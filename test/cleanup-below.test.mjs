import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

// `cleanup --if-below <GB> [--floor <GB>]` (what disk-guard used to be). The fake `df` in the fixture reports DF_GB
// free, then DF_GB_AFTER (if set) after the first call.
const withTree = (fn, opts) => {
  const t = tree(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};
const guard = (t, args = ['--apply', '--if-below', '40', '--floor', '20'], env = {}) =>
  factory(['cleanup', ...args], { env: { ...t.env, ...env }, cwd: t.main });
const SCRATCH_AT_START = ['dd-fresh', 'dd-old1', 'dd-sim', 'ee1-new', 'ee1-old', 'sg-abc', 'theme-x', 'tmp.zzz', 'unrelated'];

test('enough space: prints free GB, exits 0, cleans nothing', () =>
  withTree((t) => {
    const r = guard(t, undefined, { DF_GB: '67' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'factory-cleanup: 67 GB free on / (min 40, floor 20)\n');
    assert.deepEqual(t.names('tmp'), SCRATCH_AT_START);
  }));

test('below the minimum: runs the [disk] low_cleanup categories, reports again, exits 0 when it recovered', () =>
  withTree((t) => {
    const r = guard(t, undefined, { DF_GB: '30', DF_GB_AFTER: '45' });
    assert.equal(r.status, 0, r.stderr);
    const out = t.clean(r.stdout);
    assert.match(out, /^factory-cleanup: 30 GB free on \/ \(min 40, floor 20\)\nfactory-cleanup: APPLY\n/);
    assert.match(out, /== frames \(older than 0 days\) ==/);
    assert.match(out, /== tmp /);
    assert.match(out, /== sims ==/);
    assert.ok(!/== derived-data ==/.test(out) && !/== archives/.test(out) && !/== worktrees/.test(out));
    assert.match(out, /factory-cleanup: 45 GB free after cleanup\n$/);
    assert.deepEqual(t.names('tmp'), ['dd-fresh', 'dd-sim', 'ee1-new', 'unrelated']);
    assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['c.mp4', 'flags.png']); // frames-age 0 takes the new dump too; clips are not in low_cleanup
    assert.equal(t.xcrunCalls().length, 4);
  }));

test('with no [disk] low_cleanup, merged agent worktrees are in the sweep', () =>
  withTree(
    (t) => {
      const r = guard(t, undefined, { DF_GB: '30', DF_GB_AFTER: '45' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /== worktrees ==/);
      assert.deepEqual(t.names('main', '.worktrees').includes('agent-merged'), false);
    },
    { diskOverrides: { low_cleanup: undefined } },
  ));

test('a dry run below the minimum lists the sweep and changes nothing', () =>
  withTree((t) => {
    const r = guard(t, ['--if-below', '40'], { DF_GB: '30' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /factory-cleanup: dry run/);
    assert.deepEqual(t.names('tmp'), SCRATCH_AT_START);
    assert.deepEqual(t.xcrunCalls(), []);
  }));

test('still below the floor after the sweep: exits 2 and says to stop', () =>
  withTree((t) => {
    const r = guard(t, undefined, { DF_GB: '30', DF_GB_AFTER: '12' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /12 GB free after cleanup/);
    assert.match(r.stderr, /factory-cleanup: BELOW FLOOR \(20 GB\), stop/);
  }));

test('--only picks the categories', () =>
  withTree((t) => {
    const r = guard(t, ['--apply', '--if-below', '40', '--only', 'frames'], { DF_GB: '30', DF_GB_AFTER: '45' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /== frames/);
    assert.ok(!/== tmp/.test(r.stdout) && !/== sims/.test(r.stdout));
    assert.deepEqual(t.names('tmp'), SCRATCH_AT_START);
    assert.deepEqual(t.xcrunCalls(), []);
  }));

test('bad arguments exit 1', () =>
  withTree((t) => {
    let r = guard(t, ['--if-below', 'lots']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--if-below wants GB/);
    r = guard(t, ['--floor', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--floor wants GB/);
  }));
