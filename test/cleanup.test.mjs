import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

const withTree = (fn, opts) => {
  const t = tree(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};
const cleanup = (t, args = [], env = {}) => factory(['cleanup', ...args], { env: { ...t.env, ...env }, cwd: t.main });

// every path under a directory, for "nothing was touched" checks (the .git dirs are skipped)
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue;
    const full = join(dir, name);
    out.push(full);
    if (lstatSync(full).isDirectory()) walk(full, out);
  }
  return out;
};

test('dry run decides per category and deletes nothing', () =>
  withTree((t) => {
    const all = () => [...walk(t.p('state')), ...walk(t.p('cache')), ...walk(t.p('tmp')), ...walk(t.p('utmp')), ...walk(t.main)];
    const before = all();
    const r = cleanup(t);
    assert.equal(r.status, 0, r.stderr);
    const out = t.clean(r.stdout);
    assert.match(out, /^factory-cleanup: dry run \(pass --apply to delete\)/);
    // derived-data: stale dd dirs go, kept names (listed, matched by glob, found in scripts) stay; dd-* scratch is theirs too
    assert.match(out, /keep list \(derived from scripts \+ base\):  app test-kit scripted literal  and test-\*/);
    for (const gone of ['cache/dd-stale1', 'cache/dd-stale2', 'tmp/dd-old1', 'tmp/dd-fresh']) assert.ok(out.includes(`<root>/${gone}\n`), gone);
    for (const kept of ['dd-app', 'dd-test-Foo', 'dd-test-kit', 'dd-scripted', 'dd-literal', 'notes', 'dd-sim'])
      assert.ok(!out.includes(`/${kept}\n`), kept);
    // sims: only ephemeral names, never a protected name or id
    for (const sim of ['box-factory-1', 'box-opus-2', 'box-test-123']) assert.match(out, new RegExp(`  ${sim} \\(`));
    for (const sim of ['box-test-abc', 'box-test-kit', 'box-factory-prot', 'Shooter Phone', 'Plain Phone'])
      assert.ok(!out.includes(`  ${sim} (`), sim);
    // worktrees
    assert.match(out, /REMOVE agent-merged {2}\(branch agent-merged-b, upstream: origin\/nightly\/up\)/);
    assert.match(out, /REMOVE agent-symlink /);
    assert.match(out, /KEPT {2}agent-ahead \(commits not all upstream on any origin\/nightly\/\*\)/);
    assert.match(out, /KEPT {2}agent-dirty \(untracked non-symlink: stray\.txt\)/);
    assert.match(out, /SKIP {2}night-1 \(active factory worktree; --include-night night-1 to allow\)/);
    assert.match(out, /SKIP {2}phone /);
    assert.ok(!/other/.test(out.split('== worktrees ==')[1].split('==')[0]));
    // frames: old dirs only
    assert.ok(out.includes('<root>/state/night-1/shots/a/frames\n') && out.includes('<root>/state/night-1/shots/b/frames\n'));
    assert.ok(!out.includes('night-2/shots/c/frames'));
    // tmp: old, matching names only, not ee1-new / unrelated / the keep entry
    for (const gone of ['ee1-old', 'sg-abc', 'theme-x', 'tmp.zzz']) assert.ok(out.includes(`<root>/tmp/${gone}\n`), gone);
    for (const kept of ['ee1-new', 'unrelated']) assert.ok(!out.includes(`/tmp/${kept}\n`), kept);
    // clips: every mp4 (nested and upper-case too) of every night, one line per directory; nothing else is listed
    for (const d of ['night-1/shots/a/', 'night-1/shots/a/sub/', 'night-1/shots/b/', 'night-2/shots/c/'])
      assert.match(out, new RegExp(`<root>/state/${d} \\(1 clip\\)\\n`), d);
    assert.match(out, /\nclips: 4 files, \S+ reclaimable /);
    assert.ok(!/verdict\.json|flags\.png|contact\.png/.test(out));
    // $TMPDIR: only the trace/upload names, old enough; notes.txt, other-dir, dd-old1 and the fresh ones stay
    for (const gone of ['XcodeDistPipeline.old', 'instruments-run', 'Run.trace', 'big.ktrace']) assert.ok(out.includes(`<root>/utmp/${gone}\n`), gone);
    for (const kept of ['XcodeDistPipeline.new', 'fresh.ktrace', 'notes.txt', 'my-instruments.log', 'other-dir', 'dd-old1'])
      assert.ok(!out.includes(`/utmp/${kept}\n`), kept);
    // archives: 3 highest build numbers across checkout and worktrees
    assert.match(out, /keep {3}build 10 /);
    assert.match(out, /keep {3}build 9 /);
    assert.match(out, /keep {3}build 8 /);
    assert.ok(out.includes('App-7.xcarchive\n') && out.includes('App-6.xcarchive\n'));
    assert.match(out, /total reclaimable: /);
    assert.deepEqual(all(), before);
    assert.deepEqual(t.xcrunCalls(), []);
  }));

test('--apply removes what the dry run listed and nothing else', () =>
  withTree((t) => {
    const r = cleanup(t, ['--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^factory-cleanup: APPLY/);
    assert.match(r.stdout, /total removed: /);
    assert.deepEqual(t.names('cache'), ['dd-app', 'dd-literal', 'dd-scripted', 'dd-test-Foo', 'dd-test-kit', 'notes']);
    assert.deepEqual(t.names('tmp'), ['dd-sim', 'ee1-new', 'unrelated']);
    assert.deepEqual(t.names('state', 'night-1', 'shots', 'a'), ['contact.png', 'sub']);
    assert.deepEqual(t.names('state', 'night-1', 'shots', 'a', 'sub'), ['verdict.json']);
    assert.deepEqual(t.names('state', 'night-1', 'shots', 'b'), ['verdict.json']);
    assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['flags.png', 'frames']);
    assert.deepEqual(t.names('utmp'), ['XcodeDistPipeline.new', 'dd-old1', 'fresh.ktrace', 'my-instruments.log', 'notes.txt', 'other-dir']);
    assert.deepEqual(t.names('main', 'build'), ['App-10.xcarchive', 'App-9.xcarchive']);
    assert.deepEqual(t.names('main', '.worktrees', 'night-1', 'build'), ['App-8.xcarchive']);
    assert.deepEqual(t.names('main', '.worktrees', 'phone', 'build'), []);
    assert.deepEqual(t.names('main', '.worktrees'), ['agent-ahead', 'agent-dirty', 'night-1', 'other', 'phone']);
    assert.deepEqual(t.xcrunCalls(), [
      'simctl shutdown 11111111-0000-0000-0000-000000000002',
      'simctl delete 11111111-0000-0000-0000-000000000002',
      'simctl delete 11111111-0000-0000-0000-000000000003',
      'simctl delete 11111111-0000-0000-0000-000000000004',
    ]);
  }));

test('--only limits categories; dd-* scratch moves to tmp when derived-data is not running', () =>
  withTree((t) => {
    const r = cleanup(t, ['--apply', '--only', 'tmp']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(t.names('tmp'), ['dd-fresh', 'dd-sim', 'ee1-new', 'unrelated']); // dd-fresh is new; dd-old1 is old
    assert.deepEqual(t.names('cache').includes('dd-stale1'), true);
    assert.deepEqual(t.xcrunCalls(), []);
  }));

test('--frames-age 0 takes every frames dir; the default age comes from [disk] frames_age_days', () =>
  withTree((t) => {
    let r = cleanup(t, ['--only', 'frames', '--frames-age', '0']);
    assert.match(r.stdout, /frames \(older than 0 days\)/);
    assert.ok(r.stdout.includes('night-2/shots/c/frames'));
    r = cleanup(t, ['--only', 'frames']);
    assert.match(r.stdout, /frames \(older than 2 days\)/);
    assert.ok(!r.stdout.includes('night-2/shots/c/frames'));
  }));

test('--include-night lets a protected worktree through the same checks', () =>
  withTree((t) => {
    const r = cleanup(t, ['--only', 'worktrees', '--include-night', 'night-1']);
    assert.match(r.stdout, /KEPT {2}night-1 \(untracked non-symlink: build\)/); // judged like any other worktree
    assert.match(r.stdout, /SKIP {2}phone /);
  }));

test('bad arguments exit 1', () =>
  withTree((t) => {
    let r = cleanup(t, ['--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown arg: --bogus/);
    r = cleanup(t, ['--frames-age', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--frames-age wants days/);
  }));

test('off macOS the Xcode categories are skipped and the rest still runs', () =>
  withTree((t) => {
    const r = cleanup(t, ['--apply'], { FK_UNAME: 'Linux' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/skipped: needs Xcode/g) ?? []).length, 2);
    assert.deepEqual(t.xcrunCalls(), []);
    assert.ok(t.names('cache').includes('dd-stale1'), 'derived-data untouched');
    // dd-* scratch is now the tmp category's job
    assert.deepEqual(t.names('tmp'), ['dd-fresh', 'dd-sim', 'ee1-new', 'unrelated']);
    assert.deepEqual(t.names('main', 'build'), ['App-10.xcarchive', 'App-9.xcarchive']);
  }));

const UTMP_AT_START = ['Run.trace', 'XcodeDistPipeline.new', 'XcodeDistPipeline.old', 'big.ktrace', 'dd-old1', 'fresh.ktrace', 'instruments-run', 'my-instruments.log', 'notes.txt', 'other-dir'];
const UTMP_AFTER = ['XcodeDistPipeline.new', 'dd-old1', 'fresh.ktrace', 'my-instruments.log', 'notes.txt', 'other-dir'];

test('clips: --apply removes every mp4 and nothing else; --night limits it to that night', () =>
  withTree((t) => {
    let r = cleanup(t, ['--only', 'clips', '--night', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /== clips \(\*\.mp4 under the shots dir, night 1\) ==/);
    assert.match(r.stdout, /\nclips: 3 files, \S+ reclaimable /);
    assert.ok(!r.stdout.includes('night-2'));
    assert.deepEqual(t.names('state', 'night-1', 'shots', 'b'), ['frames', 'verdict.json', 'x.MP4']); // a dry run

    r = cleanup(t, ['--only', 'clips', '--night', '1', '--apply']);
    assert.match(r.stdout, /\nclips: 3 files, \S+ removed /);
    assert.deepEqual(t.names('state', 'night-1', 'shots', 'a'), ['contact.png', 'frames', 'sub']);
    assert.deepEqual(t.names('state', 'night-1', 'shots', 'a', 'sub'), ['verdict.json']);
    assert.deepEqual(t.names('state', 'night-1', 'shots', 'b'), ['frames', 'verdict.json']);
    assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['c.mp4', 'flags.png', 'frames']); // another night: untouched

    r = cleanup(t, ['--only', 'clips', '--apply']); // bare: every night
    assert.match(r.stdout, /night all\) ==/);
    assert.match(r.stdout, /\nclips: 1 file, \S+ removed /);
    assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['flags.png', 'frames']);
  }));

test('clips: [disk] clips = "keep" leaves every video; a bad value exits 1', () => {
  withTree(
    (t) => {
      const r = cleanup(t, ['--apply', '--only', 'clips']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /kept: \[disk\] clips = "keep"/);
      assert.deepEqual(t.names('state', 'night-2', 'shots', 'c'), ['c.mp4', 'flags.png', 'frames']);
    },
    { diskExtra: 'clips = "keep"' },
  );
  withTree(
    (t) => {
      const r = cleanup(t, ['--only', 'clips']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /\[disk\] clips must be "delete" or "keep" \(got: shred\)/);
    },
    { diskExtra: 'clips = "shred"' },
  );
});

test('--night wants a number', () =>
  withTree((t) => {
    const r = cleanup(t, ['--night', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--night wants a night number/);
  }));

test('$TMPDIR: only the trace and upload names go, from that dir alone', () =>
  withTree((t) => {
    const r = cleanup(t, ['--apply', '--only', 'tmp']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(t.names('utmp'), UTMP_AFTER);
    // the [disk] tmp_globs sweep of /tmp is unchanged and does not reach into $TMPDIR (dd-old1 is old, and dd-*, there)
    assert.deepEqual(t.names('tmp'), ['dd-fresh', 'dd-sim', 'ee1-new', 'unrelated']);
  }));

test('$TMPDIR: tmp_dirs_globs picks the names; [] for tmp_dirs, or an unset $TMPDIR, sweeps nothing', () => {
  withTree(
    (t) => {
      const r = cleanup(t, ['--apply', '--only', 'tmp']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(t.names('utmp'), UTMP_AT_START.filter((n) => n !== 'notes.txt'));
    },
    { diskExtra: 'tmp_dirs_globs = ["notes.*"]' },
  );
  withTree((t) => {
    const r = cleanup(t, ['--apply', '--only', 'tmp'], { TMPDIR: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(t.names('utmp'), UTMP_AT_START);
  });
  withTree(
    (t) => {
      const r = cleanup(t, ['--apply', '--only', 'tmp']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(t.names('utmp'), UTMP_AT_START);
    },
    { diskExtra: 'tmp_dirs = []' },
  );
});

test('$TMPDIR: a tmp_dirs entry may be $TMPDIR/<sub>', () =>
  withTree(
    (t) => {
      mkdirSync(t.p('utmp', 'sub'));
      writeFileSync(t.p('utmp', 'sub', 'inner.ktrace'), 'x');
      utimesSync(t.p('utmp', 'sub', 'inner.ktrace'), new Date('2001-01-01'), new Date('2001-01-01'));
      const r = cleanup(t, ['--apply', '--only', 'tmp']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(t.names('utmp', 'sub'), []); // swept via $TMPDIR/sub
      assert.deepEqual(t.names('utmp'), [...UTMP_AT_START, 'sub'].sort()); // the parent dir itself was not on the list
    },
    { diskExtra: `tmp_dirs = ["$TMPDIR/sub"]` },
  ));
