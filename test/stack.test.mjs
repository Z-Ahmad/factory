import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';
import { installGh } from './gh-stub.mjs';

const IDENT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const DEADLINE_MS = 120_000; // every call to the kit has one

// A project with a bare origin (trunk), a stub gh, a commit-msg hook that logs, and a parent branch p1 (PR #1: adds a.txt).
function project({ maxDepth } = {}) {
  const t = tree({ extraToml: () => `\n[stack]\ntarget = "trunk"\n${maxDepth ? `max_depth = ${maxDepth}\n` : ''}` });
  const gh = installGh(t.p('bin'), t.p('gh-state.json'), t.p('gh.log'));
  const NOW = '2026-11-23T12:00:00Z'; // fake time: every closedAt in these tests is measured against it
  const env = { ...t.env, ...gh.env, ...IDENT, FK_NOW: NOW };
  const m = t.main;
  const g = (cwd, ...a) => t.git(cwd, ...a);
  const write = (dir, f, text) => writeFileSync(join(dir, f), text);
  // the repo's own hook: every commit message passes through it, merge commits included
  writeFileSync(join(m, '.git', 'hooks', 'commit-msg'), `#!/bin/sh\necho "commit-msg $(git rev-parse --abbrev-ref HEAD)" >> '${t.p('hook.log')}'\n`);
  chmodSync(join(m, '.git', 'hooks', 'commit-msg'), 0o755);
  const run = (args) => factory(['stack', ...args], { env, cwd: m, timeout: DEADLINE_MS });
  const origin = t.p('origin.git');
  const remoteHas = (b) => g(m, 'ls-remote', '--heads', 'origin', b) !== '';
  const stacks = () => JSON.parse(readFileSync(t.p('state', 'stacks.json'), 'utf8'));
  const hookLog = () => (existsSync(t.p('hook.log')) ? readFileSync(t.p('hook.log'), 'utf8') : '');

  // parent p1: adds a.txt = P
  g(m, 'checkout', '-q', '-b', 'p1', 'trunk');
  write(m, 'a.txt', 'P\n');
  g(m, 'add', '.');
  g(m, 'commit', '-q', '-m', 'parent');
  g(m, 'push', '-q', 'origin', 'p1');
  const p1Head = g(m, 'rev-parse', 'p1');
  g(m, 'checkout', '-q', 'trunk');
  gh.pr({ number: 1, title: 'Parent', headRefName: 'p1', baseRefName: 'trunk', headRefOid: p1Head });

  /** A child of p1 made with `factory stack new`, with its own work (a.txt gets C on top of P, plus <name>.txt) pushed. */
  const child = (name, number, { touchA = true } = {}) => {
    const r = run(['new', '1', '--name', name]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const dir = join(m, '.worktrees', name);
    const branch = `x/${name}-wt`;
    if (touchA) write(dir, 'a.txt', `P+${name}\n`);
    write(dir, `${name}.txt`, `${name}\n`);
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', name);
    g(dir, 'push', '-q', '-u', 'origin', branch);
    gh.pr({ number, title: `Child ${name}`, headRefName: branch, baseRefName: 'p1', headRefOid: g(dir, 'rev-parse', 'HEAD') });
    return { dir, branch, number };
  };
  /** The owner squash-merges #1: trunk gets one commit with the parent's files, the PR is MERGED, its branch still exists. */
  const squash = () => {
    g(m, 'checkout', '-q', 'trunk');
    g(m, 'checkout', 'p1', '--', 'a.txt');
    g(m, 'commit', '-q', '-m', 'Parent (#1)');
    g(m, 'push', '-q', 'origin', 'trunk');
    gh.set(1, { state: 'MERGED', mergeCommit: { oid: g(m, 'rev-parse', 'HEAD') } });
  };
  const mainEdits = (text) => {
    write(m, 'a.txt', text);
    g(m, 'commit', '-qam', 'someone else edits a.txt');
    g(m, 'push', '-q', 'origin', 'trunk');
  };
  const show = (rev, file) => g(m, 'show', `${rev}:${file}`);
  return { ...t, gh, env, g, write, run, remoteHas, stacks, hookLog, child, squash, mainEdits, show, origin };
}
const withProject = (fn, opts) => {
  const t = project(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};

// ------------------------------------------------------------------ new

test('stack new: cuts a worktree from the parent head, records the link, prints the gh pr create line', () =>
  withProject((t) => {
    const r = t.run(['new', '1', '--name', 'second']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const dir = join(t.main, '.worktrees', 'second');
    assert.equal(t.g(dir, 'rev-parse', 'HEAD'), t.g(t.main, 'rev-parse', 'origin/p1'));
    assert.equal(t.g(dir, 'branch', '--show-current'), 'x/second-wt');
    const link = t.stacks().links[0];
    assert.equal(link.child, 'x/second-wt');
    assert.equal(link.parentPr, 1);
    assert.equal(link.parentBranch, 'p1');
    assert.equal(link.parentHead, t.g(t.main, 'rev-parse', 'origin/p1'));
    assert.match(r.stdout, /gh pr create --base p1 --head x\/second-wt/);
    assert.match(r.stdout, /factory stack land 1/);
    assert.ok(!/gh stack/.test(t.gh.log()), 'gh stack is never called');
  }));

test('stack new: a branch works as the parent, and a dry run changes nothing', () =>
  withProject((t) => {
    const d = t.run(['new', 'p1', '--dry-run']);
    assert.equal(d.status, 0, d.stderr);
    assert.match(d.stdout, /dry run: would cut x\/p1-next-wt from origin\/p1/);
    assert.ok(!existsSync(t.p('state', 'stacks.json')));
    const r = t.run(['new', 'p1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(t.stacks().links[0].parentPr, 1);
  }));

test('stack new: refuses past [stack] max_depth, and a merged parent', () =>
  withProject((t) => {
    assert.equal(t.run(['new', '1', '--name', 'two']).status, 0);
    t.gh.pr({ number: 2, headRefName: 'x/two-wt', baseRefName: 'p1' });
    t.g(join(t.main, '.worktrees', 'two'), 'push', '-q', '-u', 'origin', 'x/two-wt');
    const r = t.run(['new', 'x/two-wt', '--name', 'three']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /3 PRs deep; \[stack\] max_depth is 2/);
    assert.ok(!existsSync(join(t.main, '.worktrees', 'three')), 'no worktree was made');
    assert.equal(t.stacks().links.length, 1);
    t.gh.set(1, { state: 'MERGED' });
    const m = t.run(['new', '1', '--name', 'four']);
    assert.equal(m.status, 1);
    assert.match(m.stderr, /PR #1 is merged/);
  }, { maxDepth: 2 }));

test('stack: bad arguments exit 2', () =>
  withProject((t) => {
    assert.equal(t.run([]).status, 2);
    assert.equal(t.run(['bogus']).status, 2);
    assert.equal(t.run(['land']).status, 2);
    assert.equal(t.run(['land', '1', '--bogus']).status, 2);
  }));

// ------------------------------------------------------------------ land

test('stack land: a squash-merged parent: conflicts resolved with the child (main equals the parent tip), pushed, parent deleted last', () =>
  withProject((t) => {
    const c = t.child('one', 2);
    const wtP = join(t.main, '.worktrees', 'p1wt');
    t.g(t.main, 'worktree', 'add', '-q', wtP, 'p1');
    // the removed worktree's two iOS build folders (dd-<name> and dd-<name>-kit) go with it; another worktree's stay
    for (const d of ['dd-p1wt', 'dd-p1wt-kit', 'dd-otherwt']) mkdirSync(t.p('cache', d));
    t.squash();
    const r = t.run(['land', '1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /removed 2 derived-data folders of p1wt/);
    assert.deepEqual(['dd-p1wt', 'dd-p1wt-kit', 'dd-otherwt'].map((d) => existsSync(t.p('cache', d))), [false, false, true]);
    assert.match(t.gh.log(), /pr edit 2 --base trunk/);
    assert.match(r.stdout, /resolved 1 conflicted file with the child's side/);
    // the child on origin: its own file content, main merged in, one merge commit
    assert.equal(t.show(`origin/${c.branch}`, 'a.txt'), 'P+one');
    assert.equal(t.show(`origin/${c.branch}`, 'one.txt'), 'one');
    t.g(t.main, 'fetch', '-q', 'origin');
    t.g(t.main, 'merge-base', '--is-ancestor', 'origin/trunk', `origin/${c.branch}`);
    assert.equal(t.g(t.main, 'rev-list', '--merges', '--count', `origin/${c.branch}`, '--not', 'origin/trunk'), '1');
    assert.match(t.hookLog(), /commit-msg x\/one-wt/, "the merge commit went through the repo's own hook");
    assert.equal(t.g(c.dir, 'status', '--porcelain'), '');
    // the parent is gone: remote, local branch, worktree
    assert.equal(t.remoteHas('p1'), false);
    assert.equal(t.g(t.main, 'branch', '--list', 'p1'), '');
    assert.ok(!existsSync(wtP));
    // the link now points at trunk
    const link = t.stacks().links.find((l) => l.child === c.branch);
    assert.equal(link.parentBranch, 'trunk');
    assert.equal(link.parentPr, null);
    assert.equal(link.landedFrom, 1);
    assert.ok(!/--force|force-with-lease| -f /.test(t.gh.log()));
  }));

test('stack land: a child with no worktree gets a temporary one, removed afterwards', () =>
  withProject((t) => {
    const c = t.child('solo', 2);
    t.g(t.main, 'worktree', 'remove', '--force', c.dir);
    t.g(t.main, 'branch', '-D', c.branch);
    t.squash();
    const r = t.run(['land', '1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(t.show(`origin/${c.branch}`, 'a.txt'), 'P+solo');
    assert.ok(!existsSync(join(t.main, '.worktrees', 'stack-land-2')));
    assert.equal(t.g(t.main, 'branch', '--list', c.branch), '');
    assert.equal(t.remoteHas('p1'), false);
  }));

test('stack land: a real conflict stops with exit 3, names the file, leaves the merge in progress and deletes nothing', () =>
  withProject((t) => {
    const c = t.child('one', 2);
    t.squash();
    t.mainEdits('main moved on\n'); // main no longer equals the parent's final a.txt
    const before = t.g(t.main, 'rev-parse', `origin/${c.branch}`);
    const r = t.run(['land', '1']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /CONFLICT merging origin\/trunk into x\/one-wt/);
    assert.match(r.stdout, /^ {4}a\.txt$/m);
    assert.match(r.stdout, /was NOT deleted/);
    assert.ok(existsSync(join(c.dir, '.git')) && t.g(c.dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'merge in progress');
    assert.equal(t.remoteHas('p1'), true, 'the parent branch stays');
    assert.equal(t.g(t.main, 'branch', '--list', 'p1') !== '', true);
    assert.equal(t.g(t.main, 'ls-remote', 'origin', c.branch).split('\t')[0], before, 'nothing pushed');
  }));

test('stack land: two children; one conflicts, the parent stays until a person finishes it and land is run again', () =>
  withProject((t) => {
    const a = t.child('alpha', 2);
    const b = t.child('beta', 3);
    t.squash();
    // beta also touches a file main will change on its own
    t.write(b.dir, 'shared.txt', 'beta\n');
    t.g(b.dir, 'add', '.');
    t.g(b.dir, 'commit', '-q', '-m', 'beta shared');
    t.g(b.dir, 'push', '-q', 'origin', b.branch);
    t.write(t.main, 'shared.txt', 'main\n');
    t.g(t.main, 'add', '.');
    t.g(t.main, 'commit', '-q', '-m', 'main adds shared.txt');
    t.g(t.main, 'push', '-q', 'origin', 'trunk');
    const r = t.run(['land', '1']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /1 of 2 children landed/);
    assert.match(r.stdout, /^ {4}shared\.txt$/m);
    assert.equal(t.show(`origin/${a.branch}`, 'a.txt'), 'P+alpha', 'alpha is through');
    assert.equal(t.remoteHas('p1'), true, 'parent not deleted while beta is open');
    assert.match(t.gh.log(), /pr edit 3 --base trunk/, 'both were retargeted');
    // a person resolves beta and commits
    t.write(b.dir, 'shared.txt', 'beta and main\n');
    t.g(b.dir, 'checkout', '--ours', '--', 'a.txt');
    t.g(b.dir, 'add', '.');
    t.g(b.dir, 'commit', '-q', '--no-edit');
    const again = t.run(['land', '1']);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(t.show(`origin/${b.branch}`, 'shared.txt'), 'beta and main');
    assert.equal(t.remoteHas('p1'), false, 'now the parent goes');
    assert.equal(t.stacks().links.filter((l) => l.landedFrom === 1).length, 2);
  }));

test('stack land: --dry-run prints the plan and changes nothing', () =>
  withProject((t) => {
    const c = t.child('one', 2);
    t.squash();
    const logBefore = t.gh.log();
    const r = t.run(['land', '1', '--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dry run: #1 p1 merged/);
    assert.match(r.stdout, /gh pr edit 2 --base trunk/);
    assert.match(r.stdout, /git merge --no-edit origin\/trunk/);
    assert.match(r.stdout, /delete remote p1/);
    assert.ok(!t.gh.log().slice(logBefore.length).includes('pr edit'));
    assert.equal(t.remoteHas('p1'), true);
    assert.equal(t.gh.state().prs.find((p) => p.number === 2).baseRefName, 'p1');
    assert.equal(t.g(c.dir, 'status', '--porcelain'), '');
    assert.ok(!existsSync(t.p('state', 'stacks.json')) || t.stacks().links.every((l) => !l.landedFrom));
  }));

test('stack land: refuses a PR that is not merged', () =>
  withProject((t) => {
    t.child('one', 2);
    const r = t.run(['land', '1']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PR #1 is open, not merged/);
    assert.ok(!t.gh.log().includes('pr edit'));
    assert.equal(t.remoteHas('p1'), true);
  }));

test('stack land: with no children it only tidies the merged branch', () =>
  withProject((t) => {
    t.squash();
    const r = t.run(['land', '1']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /no open PR is based on it/);
    assert.equal(t.remoteHas('p1'), false);
  }));

test('stack land: will not delete the parent when gh cannot say whether anything still targets it', () =>
  withProject((t) => {
    t.squash();
    // gh answers the children lookup, then goes offline for the safety check before the delete (the 2nd `pr list --base`)
    const r = factory(['stack', 'land', '1'], { env: { ...t.env, GH_FAIL_NTH_BASE_LIST: '2' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /kept: remote p1 \(could not confirm no open PR targets it/);
    assert.equal(t.remoteHas('p1'), true);
  }));

// ------------------------------------------------------------------ status

test('stack status: a tree with number, title, state, base, mergeable and whether the base exists', () =>
  withProject((t) => {
    const c = t.child('one', 2);
    t.gh.pr({ number: 3, title: 'Grandchild', headRefName: 'grand', baseRefName: c.branch, mergeable: 'CONFLICTING' });
    t.g(t.main, 'push', '-q', 'origin', `origin/${c.branch}:refs/heads/grand`);
    t.gh.pr({ number: 4, title: 'Alone on trunk', headRefName: 'alone', baseRefName: 'trunk' });
    const r = t.run(['status']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = r.stdout;
    assert.match(out, /^#1 Parent {2}\[open\] base trunk, mergeable: MERGEABLE$/m);
    assert.match(out, /^└─ #2 Child one {2}\[open\] base p1 \(exists\), mergeable: MERGEABLE$/m);
    assert.match(out, /^ {3}└─ #3 Grandchild {2}\[open\] base x\/one-wt \(exists\), mergeable: CONFLICTING$/m);
    assert.ok(!out.includes('#4'), 'a PR on the target alone is not a stack');
    assert.ok(!out.includes('WARN'));
  }));

test('stack status: warns when a base is merged but the child was not landed', () =>
  withProject((t) => {
    t.child('one', 2);
    t.squash();
    const r = t.run(['status']);
    assert.match(r.stdout, /#1 Parent {2}\[merged\]/);
    assert.match(r.stdout, /WARN #2: its base #1 \(p1\) is merged but #2 was not landed; run: factory stack land 1/);
  }));

test('stack status: a base branch that is gone: "will be closed by GitHub", then "closed"', () =>
  withProject((t) => {
    t.child('one', 2);
    t.squash();
    t.g(t.main, 'push', '-q', 'origin', '--delete', 'p1');
    let r = t.run(['status']);
    assert.match(r.stdout, /base p1 \(GONE\)/);
    assert.match(r.stdout, /WARN #2: its base branch p1 is gone; GitHub will close #2/);
    t.gh.set(2, { state: 'CLOSED', closedAt: '2026-11-22T12:00:00Z' });
    r = t.run(['status']);
    assert.match(r.stdout, /WARN #2: closed, its base branch p1 is gone/);
    assert.ok(!/will close/.test(r.stdout));
  }));

// an old closed PR whose base branch is gone, next to a live stack (#1 parent, #2 child)
const oldClosed = (t) => {
  t.gh.pr({ number: 9, title: 'Old port', state: 'CLOSED', headRefName: 'old-port', baseRefName: 'long-gone', closedAt: '2026-08-01T00:00:00Z' });
};

test('stack status: an old closed PR with a gone base is hidden, with no WARN; the live stack stays', () =>
  withProject((t) => {
    t.child('one', 2);
    oldClosed(t);
    const r = t.run(['status']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /#2 Child one/);
    assert.ok(!r.stdout.includes('#9') && !r.stdout.includes('WARN'), r.stdout);
    assert.match(r.stdout, /1 older stack hidden/);
  }));

test('stack status: the same PR closed inside the window warns', () =>
  withProject((t) => {
    oldClosed(t);
    t.gh.set(9, { closedAt: '2026-11-20T12:00:00Z' });
    const r = t.run(['status']);
    assert.match(r.stdout, /WARN #9: closed, its base branch long-gone is gone/);
    assert.match(r.stdout, /#9 Old port/);
  }));

test('stack status: an open PR with a gone base always warns, however old', () =>
  withProject((t) => {
    t.gh.pr({ number: 8, title: 'Stranded', headRefName: 'stranded', baseRefName: 'long-gone', createdAt: '2026-01-01T00:00:00Z' });
    const r = t.run(['status']);
    assert.match(r.stdout, /WARN #8: its base branch long-gone is gone; GitHub will close #8/);
  }));

test('stack status: --all shows everything, as before', () =>
  withProject((t) => {
    oldClosed(t);
    const r = t.run(['status', '--all']);
    assert.match(r.stdout, /#9 Old port/);
    assert.match(r.stdout, /WARN #9: closed, its base branch long-gone is gone/);
    assert.ok(!/hidden/.test(r.stdout));
  }));

test('stack status: [stack] recent_days is respected', () =>
  withProject((t) => {
    oldClosed(t);
    t.gh.set(9, { closedAt: '2026-11-20T12:00:00Z' }); // 3 days old
    const wide = factory(['stack', 'status'], { env: { ...t.env, FK_STACK_RECENT_DAYS: '2' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.ok(!wide.stdout.includes('#9'), 'a 2-day window hides a 3-day-old close');
    const zero = factory(['stack', 'status'], { env: { ...t.env, FK_STACK_RECENT_DAYS: '0' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.ok(!zero.stdout.includes('#9'));
    const ok = factory(['stack', 'status'], { env: { ...t.env, FK_STACK_RECENT_DAYS: '30' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.match(ok.stdout, /#9 Old port/);
  }));

test('stack status: no stacks says so', () =>
  withProject((t) => {
    const r = t.run(['status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no stacks/);
  }));

test('stack bases: lists the open PRs that target a branch (exit 0), none (1), or cannot tell (2)', () =>
  withProject((t) => {
    t.child('one', 2);
    const yes = t.run(['bases', 'p1']);
    assert.equal(yes.status, 0);
    assert.equal(yes.stdout.trim(), '#2');
    assert.equal(t.run(['bases', 'nothing-here']).status, 1);
    const offline = factory(['stack', 'bases', 'nothing-here'], { env: { ...t.env, GH_FAIL: '1' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(offline.status, 2);
    // gh offline, but the recorded stack still names the child: p1 stays a base
    t.g(t.main, 'fetch', '-q', 'origin');
    const rec = factory(['stack', 'bases', 'p1'], { env: { ...t.env, GH_FAIL: '1' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(rec.status, 0);
    assert.match(rec.stdout, /x\/one-wt/);
  }));

test('stack status: forgets a link whose branch is gone everywhere and has no PR, in one line', () =>
  withProject((t) => {
    assert.equal(t.run(['new', '1']).status, 0);
    const link = t.stacks().links[0];
    const dir = join(t.main, '.worktrees', link.worktree);
    // the agent removes the duplicate: worktree and branch
    t.g(t.main, 'worktree', 'remove', '--force', dir);
    t.g(t.main, 'branch', '-D', link.child);
    const r = t.run(['status']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^stack: forgot ${link.child.replace(/[/.]/g, '\\$&')} \\(branch gone, no PR\\)$`, 'm'));
    assert.ok(!/no open PR yet/.test(r.stdout));
    assert.deepEqual(t.stacks().links, []);
    assert.match(t.run(['status']).stdout, /no stacks/);
  }));

test('stack status: keeps a link whose branch exists, and one that has a PR even with the branch gone', () =>
  withProject((t) => {
    assert.equal(t.run(['new', '1', '--name', 'alive']).status, 0);
    const c = t.child('prd', 2);
    t.g(t.main, 'worktree', 'remove', '--force', c.dir);
    t.g(t.main, 'branch', '-D', c.branch);
    t.g(t.main, 'push', '-q', 'origin', '--delete', c.branch);
    const r = t.run(['status']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!/forgot/.test(r.stdout), r.stdout);
    assert.match(r.stdout, /x\/alive-wt: cut from p1 \(#1\), no open PR yet/);
    assert.deepEqual(t.stacks().links.map((l) => l.child).sort(), ['x/alive-wt', 'x/prd-wt']);
  }));

test('stack new: a second run for the same parent refuses while the first child has no PR, and --name still works', () =>
  withProject((t) => {
    assert.equal(t.run(['new', '1']).status, 0);
    const again = t.run(['new', '1']);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already cut from p1.*no PR yet.*--name/);
    assert.equal(t.stacks().links.length, 1);
    const o = t.run(['new', '1', '--name', 'second']);
    assert.equal(o.status, 0, o.stdout + o.stderr);
    assert.equal(t.stacks().links.length, 2);
  }));
