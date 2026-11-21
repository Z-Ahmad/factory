import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, factory } from './helpers.mjs';
import { idleWorktree, tree } from './fixture-tree.mjs';

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
    for (const gone of ['cache/dd-stale1', 'cache/dd-stale2']) assert.match(out, new RegExp(`<root>/${gone} {2}\\(stale \\d+h\\)\n`), gone);
    for (const gone of ['tmp/dd-old1', 'tmp/dd-fresh']) assert.ok(out.includes(`<root>/${gone}\n`), gone);
    for (const kept of ['dd-app', 'dd-test-Foo', 'dd-test-kit', 'dd-scripted', 'dd-literal', 'notes', 'dd-sim'])
      assert.ok(!out.includes(`/${kept}\n`), kept);
    // sims: only ephemeral names, never a protected name or id
    for (const sim of ['box-factory-1', 'box-opus-2', 'box-test-123']) assert.match(out, new RegExp(`  ${sim} \\(`));
    for (const sim of ['box-test-abc', 'box-test-kit', 'box-factory-prot', 'Shooter Phone', 'Plain Phone'])
      assert.ok(!out.includes(`  ${sim} (`), sim);
    // worktrees
    assert.match(out, /REMOVE agent-merged {2}\(branch agent-merged-b, contained in origin\/trunk\)/);
    assert.match(out, /REMOVE agent-symlink /);
    assert.match(out, /KEPT {2}agent-ahead \(not merged; 1 unpushed commit\)/);
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

test('sims: a simulator a running proof (or recordVideo, or xcodebuild) names is never deleted, even when low disk asks', () =>
  withTree((t) => {
    writeFileSync(t.p('bin', 'ps'), `#!/usr/bin/env bash\necho "  41 01:00:00 /bin/bash /kit/proof/ios/sim-proof-core.sh --udid 11111111-0000-0000-0000-000000000002 --dd /dd/x"\n`);
    chmodSync(t.p('bin', 'ps'), 0o755);
    const r = cleanup(t, ['--apply', '--only', 'sims']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}KEPT {2}box-factory-1 \(11111111-0000-0000-0000-000000000002, Booted\): in use by factory proof \(pid 41\)$/m);
    assert.deepEqual(t.xcrunCalls(), ['simctl delete 11111111-0000-0000-0000-000000000003', 'simctl delete 11111111-0000-0000-0000-000000000004']);
    const g = factory(['cleanup', '--apply', '--if-below', '40', '--floor', '20'], { env: { ...t.env, DF_GB: '10' }, cwd: t.main });
    assert.equal(g.status, 2);
    assert.ok(!t.xcrunCalls().some((c) => c.includes('000000000002')), t.xcrunCalls().join('\n'));
  }));

test('worktrees: a proof-compare base checkout goes once its dd-compare-* build is gone, and stays while the build does', () =>
  withTree((t) => {
    for (const n of ['compare-aaaa1111', 'compare-bbbb2222', 'compare-cccc3333'])
      execFileSync('git', ['-C', t.main, 'worktree', 'add', '-q', '--detach', join(t.wt, n), 'trunk']);
    mkdirSync(t.p('cache', 'dd-compare-bbbb2222'));
    writeFileSync(join(t.wt, 'compare-cccc3333', 'local.txt'), 'x');
    let r = cleanup(t, ['--only', 'derived-data', '--only', 'worktrees']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}REMOVE compare-aaaa1111 {2}\(proof-compare base; its build dd-compare-aaaa1111 is gone\)$/m);
    assert.match(r.stdout, /^ {2}KEPT {2}compare-cccc3333 \(its build is gone, but it has changes\)$/m);
    assert.doesNotMatch(r.stdout, /compare-bbbb2222/);
    // the build goes stale and is pruned in the same run: its checkout goes with it
    utimesSync(t.p('cache', 'dd-compare-bbbb2222'), new Date('2001-01-01'), new Date('2001-01-01'));
    r = cleanup(t, ['--apply', '--only', 'derived-data', '--only', 'worktrees']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REMOVE compare-bbbb2222/);
    assert.deepEqual(t.names('main', '.worktrees').filter((n) => n.startsWith('compare-')), ['compare-cccc3333']);
  }));

// ---- agent worktrees on [git] agent_branches (claude/*, cyrus/*), judged by their PR ----

const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const sh = (cwd, args, env = {}) =>
  execFileSync('git', args, { cwd, env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...identity, ...env }, stdio: 'pipe' }).toString().trim();

/** A worktree outside the project's worktrees dir (as Claude Code and Cyrus make them) on a new branch with one commit. */
function lane(t, branch, { commit = true, date } = {}) {
  const dir = t.p('elsewhere', branch.replace('/', '-'));
  sh(t.main, ['worktree', 'add', '-q', dir, '-b', branch, 'trunk']);
  if (commit) {
    writeFileSync(join(dir, `${branch.replace('/', '-')}.txt`), 'work');
    sh(dir, ['add', '.']);
    sh(dir, ['commit', '-q', '-m', `work on ${branch}`], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {});
  }
  idleWorktree(dir);
  return { dir, head: sh(dir, ['rev-parse', 'HEAD']) };
}
const AGENTS = { gitExtra: 'agent_branches = ["factory/lane-*", "claude/*", "cyrus/*"]' };

test('worktrees: a claude/* or cyrus/* worktree goes once its PR merged (checked with gh), anywhere on disk', () =>
  withTree((t) => {
    const done = lane(t, 'claude/shipped-feature');
    const cy = lane(t, 'cyrus/ee-123');
    const open = lane(t, 'claude/still-open');
    const other = lane(t, 'feature/not-an-agent');
    t.ghMerged(`claude/shipped-feature 12 ${done.head}`, `cyrus/ee-123 13 ${cy.head}`, `feature/not-an-agent 14 ${other.head}`);
    mkdirSync(t.p('cache', 'dd-shipped-feature'));
    let r = cleanup(t, ['--only', 'worktrees', '--only', 'derived-data']);
    assert.equal(r.status, 0, r.stderr);
    let out = t.clean(r.stdout);
    assert.match(out, /REMOVE claude-shipped-feature {2}\(branch claude\/shipped-feature, PR #12 merged\)/);
    assert.match(out, /REMOVE cyrus-ee-123 {2}\(branch cyrus\/ee-123, PR #13 merged\)/);
    assert.match(out, /KEPT {2}claude-still-open \(not merged; 1 unpushed commit\)/);
    assert.doesNotMatch(out, /feature-not-an-agent/); // not on an agent pattern: not ours to judge
    assert.match(out, /dd-shipped-feature {2}\(worktree gone: claude-shipped-feature\)/); // its build cache goes with it
    assert.ok(existsSync(done.dir) && existsSync(t.p('cache', 'dd-shipped-feature')), 'a dry run removes nothing');
    assert.ok(readFileSync(t.p('gh.log'), 'utf8').includes('--state merged --head claude/shipped-feature'));

    r = cleanup(t, ['--only', 'worktrees', '--only', 'derived-data', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(done.dir) && !existsSync(cy.dir) && existsSync(open.dir) && existsSync(other.dir));
    assert.ok(!existsSync(t.p('cache', 'dd-shipped-feature')));
    assert.equal(sh(t.main, ['branch', '--list', 'claude/shipped-feature']), '');
    assert.match(sh(t.main, ['branch', '--list', 'claude/still-open']), /still-open/);
  }, AGENTS));

test('worktrees: a branch fully contained in the target goes without asking gh', () =>
  withTree((t) => {
    const fresh = lane(t, 'claude/nothing-new', { commit: false });
    const r = cleanup(t, ['--only', 'worktrees', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REMOVE claude-nothing-new {2}\(branch claude\/nothing-new, contained in origin\/trunk\)/);
    assert.ok(!existsSync(fresh.dir));
  }, AGENTS));

test('worktrees: dirty, locked, protected, newer-than-the-PR and just-touched worktrees are all kept', () =>
  withTree((t) => {
    const dirty = lane(t, 'claude/dirty');
    writeFileSync(join(dirty.dir, 'stray.txt'), 'x');
    const locked = lane(t, 'claude/locked');
    sh(t.main, ['worktree', 'lock', '--reason', 'agent running', locked.dir]);
    const newer = lane(t, 'claude/newer');
    const merged = newer.head;
    writeFileSync(join(newer.dir, 'after.txt'), 'x');
    sh(newer.dir, ['add', '.']);
    sh(newer.dir, ['commit', '-q', '-m', 'after the merge']);
    idleWorktree(newer.dir);
    const busy = lane(t, 'claude/busy');
    sh(busy.dir, ['commit', '-q', '--allow-empty', '-m', 'just now']); // HEAD log written now: an agent may be working
    const guarded = lane(t, 'claude/guarded');
    t.ghMerged(...[dirty, locked, busy, guarded].map((l, i) => `${['claude/dirty', 'claude/locked', 'claude/busy', 'claude/guarded'][i]} ${20 + i} ${sh(l.dir, ['rev-parse', 'HEAD'])}`), `claude/newer 30 ${merged}`);
    const gd = { gitExtra: 'agent_branches = ["claude/*"]\nprotected_worktrees = ["night-*", "phone", "claude-guarded"]' };
    writeFileSync(t.p('factory.toml'), readFileSync(t.p('factory.toml'), 'utf8').replace('protected_worktrees = ["night-*", "phone"]', gd.gitExtra.split('\n')[1]));
    const r = cleanup(t, ['--only', 'worktrees', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    const out = t.clean(r.stdout);
    assert.match(out, /KEPT {2}claude-dirty \(untracked non-symlink: stray\.txt\)/);
    assert.match(out, /KEPT {2}claude-locked \(locked\)/);
    assert.match(out, /KEPT {2}claude-newer \(PR #30 merged, but the branch has newer commits; 2 unpushed commits\)/);
    assert.match(out, /KEPT {2}claude-busy \(in use: git touched it \d+ min ago\)/);
    assert.match(out, /SKIP {2}claude-guarded \(active factory worktree/);
    for (const l of [dirty, locked, newer, busy, guarded]) assert.ok(existsSync(l.dir), l.dir);
  }, AGENTS));

test('worktrees: unpushed commits older than 7 days are flagged, never removed; recent ones are just kept', () =>
  withTree((t) => {
    const old = lane(t, 'claude/forgotten', { date: '2026-01-02T10:00:00Z' });
    const recent = lane(t, 'claude/recent');
    const r = cleanup(t, ['--only', 'worktrees', '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FLAG {2}claude-forgotten \(1 unpushed commit, newest \d+ days old; not removed\)/);
    assert.match(r.stdout, /KEPT {2}claude-recent \(not merged; 1 unpushed commit\)/);
    assert.ok(existsSync(old.dir) && existsSync(recent.dir));
  }, AGENTS));

test('worktrees: the worktree you run from and the [dev] cwd worktree are never removed', () =>
  withTree((t) => {
    const here = lane(t, 'claude/mine', { commit: false });
    const dev = lane(t, 'claude/devstack', { commit: false });
    writeFileSync(t.p('factory.toml'), readFileSync(t.p('factory.toml'), 'utf8') + `\n[dev]\nup = "true"\ncwd = "${dev.dir}"\n`);
    const r = factory(['cleanup', '--only', 'worktrees', '--apply'], { env: t.env, cwd: here.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SKIP {2}claude-mine \(the worktree you run from\)/);
    assert.match(r.stdout, /SKIP {2}claude-devstack \(the \[dev\] cwd worktree\)/);
    assert.ok(existsSync(here.dir) && existsSync(dev.dir));
  }, AGENTS));
