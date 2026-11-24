import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanEnv, factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

const ident = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: { ...cleanEnv(), ...ident }, stdio: 'pipe' }).toString().trim();

// A parent branch with a child on top of it (#7) and a second chain (#8, linked with `gh stack`). The
// parents are then "squash-merged": trunk gets a new commit and the parent branches are deleted on origin.
// gh is a stub: it answers the open-PR list, merged-PR lookups (none) and logs the rest. A GitHub stack link changes nothing:
// GitHub does not rebase the rest of a stack after a squash merge, so #8 is restacked like #7.
function setup() {
  const t = tree({});
  const m = t.main;
  for (const [parent, child, file] of [['parent', 'child', 'c.txt'], ['parent2', 'child2', 'c2.txt']]) {
    git(m, 'checkout', '-q', '-b', parent, 'trunk');
    writeFileSync(join(m, `${parent}.txt`), 'p');
    git(m, 'add', '.'); git(m, 'commit', '-q', '-m', parent);
    git(m, 'checkout', '-q', '-b', child);
    writeFileSync(join(m, file), 'c');
    git(m, 'add', '.'); git(m, 'commit', '-q', '-m', child);
    git(m, 'push', '-q', 'origin', parent, child);
  }
  git(m, 'checkout', '-q', 'trunk');
  writeFileSync(join(m, 'squashed.txt'), 'both parents, squashed');
  git(m, 'add', '.'); git(m, 'commit', '-q', '-m', 'squash of the parents');
  git(m, 'push', '-q', 'origin', 'trunk');
  git(m, 'push', '-q', 'origin', '--delete', 'parent', 'parent2');
  writeFileSync(t.p('bin', 'gh'), `#!/usr/bin/env bash
echo "$*" >> '${t.p('gh.log')}'
case "$*" in
  *"pr list --state open"*) printf '7\\tchild\\tparent\\n8\\tchild2\\tparent2\\n9\\tunrelated\\ttrunk\\n' ;;
  *"repo view"*) echo owner/repo ;;
esac
exit 0
`);
  chmodSync(t.p('bin', 'gh'), 0o755);
  return t;
}
const restack = (t, args = []) => factory(['restack', ...args], { env: t.env, cwd: t.main });
const ghLog = (t) => (existsSync(t.p('gh.log')) ? readFileSync(t.p('gh.log'), 'utf8') : '');

test('restack: a dry run says what it would do and changes nothing', () => {
  const t = setup();
  try {
    const before = git(t.root + '/origin.git', 'rev-parse', 'child');
    const r = restack(t);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run onto trunk/);
    assert.match(r.stdout, /WOULD #7 child: base parent is deleted -> retarget onto trunk, merge origin\/trunk into child, push/);
    assert.match(r.stdout, /WOULD #8 child2: base parent2 is deleted -> retarget onto trunk/);
    assert.ok(!/#9/.test(r.stdout), 'a PR already on the target is not touched');
    assert.match(r.stdout, /2 PRs with a merged or deleted base; 0 restacked, 0 need a human/);
    assert.ok(!ghLog(t).includes('pr edit'), 'no retarget in a dry run');
    assert.equal(git(t.root + '/origin.git', 'rev-parse', 'child'), before);
  } finally {
    t.cleanup();
  }
});

test('restack --apply: retargets, merges the target in, pushes without force, and leaves no worktree behind', () => {
  const t = setup();
  try {
    const r = restack(t, ['--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(ghLog(t), /pr edit 7 --base trunk/);
    assert.match(ghLog(t), /pr edit 8 --base trunk/, 'a PR in a GitHub stack is restacked too');
    assert.match(r.stdout, /pushed child \(no force\)/);
    assert.match(r.stdout, /2 restacked, 0 need a human/);
    const origin = join(t.root, 'origin.git');
    assert.equal(git(origin, 'show', 'child:squashed.txt'), 'both parents, squashed'); // the target is merged in
    assert.equal(git(origin, 'show', 'child:c.txt'), 'c'); // its own work stays
    assert.equal(git(origin, 'rev-list', '--merges', '--count', 'child', '--not', 'trunk'), '1');
    assert.equal(git(t.main, 'worktree', 'list').split('\n').filter((l) => l.includes('restack')).length, 0);
    assert.equal(git(t.main, 'branch', '--list', 'restack/*'), '');
    assert.ok(!/force/.test(ghLog(t)));
  } finally {
    t.cleanup();
  }
});

test('restack --apply: a conflict is aborted, reported, and exits 1 with nothing pushed', () => {
  const t = setup();
  try {
    // trunk and the child both add c.txt with different content
    const m = t.main;
    writeFileSync(join(m, 'c.txt'), 'trunk version');
    git(m, 'add', '.'); git(m, 'commit', '-q', '-m', 'trunk adds c.txt'); git(m, 'push', '-q', 'origin', 'trunk');
    const origin = join(t.root, 'origin.git');
    const before = git(origin, 'rev-parse', 'child');
    const r = restack(t, ['--apply', '--pr', '7']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CONFLICT merging origin\/trunk into child/);
    assert.match(r.stdout, /1 need a human/);
    assert.equal(git(origin, 'rev-parse', 'child'), before);
  } finally {
    t.cleanup();
  }
});

test('restack: bad arguments exit 2', () => {
  const t = setup();
  try {
    assert.equal(restack(t, ['--bogus']).status, 2);
  } finally {
    t.cleanup();
  }
});
