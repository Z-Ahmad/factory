import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

// wip-save reads a worktree as plain files: its own .git is made unusable here, so any git call into it would fail.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function setup() {
  const t = tree({ extraToml: () => '\n[worktree]\ncache_symlinks = ["vendor/cache"]\ncopy_files = [".env.local"]\n' });
  const m = (...a) => execFileSync('git', ['-C', t.main, ...a], { env: GIT_ENV, encoding: 'utf8' }).trim();
  writeFileSync(join(t.main, 'keep.txt'), 'keep\n');
  writeFileSync(join(t.main, 'gone.txt'), 'gone\n');
  writeFileSync(join(t.main, 'logo.bin'), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(t.main, '.gitignore'), 'ignored.log\n');
  m('add', 'keep.txt', 'gone.txt', 'logo.bin', '.gitignore');
  m('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  const base = m('rev-parse', 'HEAD');
  // the "agent's" worktree: a plain copy of the checkout whose .git leads nowhere
  const wt = t.p('agent-copy');
  cpSync(t.main, wt, { recursive: true, filter: (src) => !/\/(\.git|\.worktrees|build)(\/|$)/.test(src.slice(t.main.length)) });
  writeFileSync(join(wt, '.git'), 'gitdir: /nonexistent\n');
  const save = (args) => factory(['wip-save', wt, '--base', base, ...args], { env: t.env, cwd: t.main });
  // apply patches in order onto a fresh export of base; returns the dir
  const applied = (...patches) => {
    const d = t.p(`check-${Math.random().toString(36).slice(2)}`);
    mkdirSync(d);
    execFileSync('bash', ['-c', `git -C '${t.main}' archive ${base} | tar -x -C '${d}'`]);
    execFileSync('git', ['init', '-q', d]);
    for (const p of patches) execFileSync('git', ['-C', d, 'apply', '--binary', p]);
    return d;
  };
  return { t, wt, base, save, applied };
}

test('wip-save: edits, new, deleted, binary and +x files; junk, cache links and copied env files stay out', () => {
  const { t, wt, save, applied } = setup();
  try {
    writeFileSync(join(wt, 'keep.txt'), 'keep\nmore\n');
    rmSync(join(wt, 'gone.txt'));
    writeFileSync(join(wt, 'logo.bin'), Buffer.from([9, 9, 0, 255]));
    mkdirSync(join(wt, 'scripts'));
    writeFileSync(join(wt, 'scripts', 'orient.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(wt, 'scripts', 'orient.sh'), 0o755);
    chmodSync(join(wt, 'ios', 'scripts', 'a.sh'), 0o755); // a mode-only change
    for (const junk of ['.build/x.o', 'App/xcuserdata/u.plist', 'ignored.log', '.env.local']) {
      mkdirSync(join(wt, junk, '..'), { recursive: true });
      writeFileSync(join(wt, junk), 'junk');
    }
    mkdirSync(join(wt, 'vendor'));
    symlinkSync('/nonexistent/cache', join(wt, 'vendor', 'cache'));
    const out = t.p('saved', 'r1.patch');
    const r = save(['--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^wip-save: .*r1\.patch: 5 files \(\+\d+ -\d+\), 2 made executable; applies on [0-9a-f]+\n$/);
    const patch = readFileSync(out, 'utf8');
    for (const junk of ['.build', 'xcuserdata', 'ignored.log', '.env.local', 'vendor/cache']) assert.ok(!patch.includes(junk), junk);
    const d = applied(out);
    assert.equal(readFileSync(join(d, 'keep.txt'), 'utf8'), 'keep\nmore\n');
    assert.ok(!existsSync(join(d, 'gone.txt')));
    assert.deepEqual([...readFileSync(join(d, 'logo.bin'))], [9, 9, 0, 255]);
    assert.ok(statSync(join(d, 'scripts', 'orient.sh')).mode & 0o100);
    assert.ok(statSync(join(d, 'ios', 'scripts', 'a.sh')).mode & 0o100);
  } finally {
    t.cleanup();
  }
});

test('wip-save --on: the patch is relative to base + the earlier patch, and the two apply in order', () => {
  const { t, wt, save, applied } = setup();
  try {
    writeFileSync(join(wt, 'keep.txt'), 'keep\nround1\n');
    const r1 = t.p('r1.patch');
    assert.equal(save(['--out', r1]).status, 0);
    writeFileSync(join(wt, 'keep.txt'), 'keep\nround1\nround2\n');
    writeFileSync(join(wt, 'new.txt'), 'new\n');
    const r2 = t.p('r2.patch');
    const r = save(['--on', r1, '--out', r2]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 files .*applies on \S+ \+ r1\.patch\n$/);
    assert.ok(!readFileSync(r2, 'utf8').includes('+round1'));
    const d = applied(r1, r2);
    assert.equal(readFileSync(join(d, 'keep.txt'), 'utf8'), 'keep\nround1\nround2\n');
    assert.equal(readFileSync(join(d, 'new.txt'), 'utf8'), 'new\n');
  } finally {
    t.cleanup();
  }
});

test('wip-save: no changes writes an empty patch and says so; a bad base or a missing worktree is refused', () => {
  const { t, wt, save } = setup();
  try {
    const out = t.p('none.patch');
    const r = save(['--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^wip-save: no changes in .* \(.*none\.patch is empty\)\n$/);
    assert.equal(readFileSync(out, 'utf8'), '');
    const bad = factory(['wip-save', wt, '--base', 'no-such-ref', '--out', out], { env: t.env, cwd: t.main });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--base no-such-ref is not a commit/);
    assert.equal(factory(['wip-save', t.p('nope'), '--base', 'HEAD', '--out', out], { env: t.env, cwd: t.main }).status, 1);
    assert.equal(factory(['wip-save', wt, '--out', out], { env: t.env, cwd: t.main }).status, 1);
  } finally {
    t.cleanup();
  }
});
