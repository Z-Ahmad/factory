import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { KIT, run, scratch } from './helpers.mjs';

const COMMON = join(KIT, 'lib', 'sh', 'common.sh');
const DARWIN = join(KIT, 'lib', 'darwin.sh');
const bash = (script, opts) => run('bash', ['-c', `set -euo pipefail; ${script}`], opts);

test('fk_human formats kilobytes', () => {
  const r = bash(`. ${COMMON}; fk_human 512; echo; fk_human 2048; echo; fk_human 3145728`);
  assert.equal(r.stdout, '512K\n2M\n3.0G');
});

test('fk_free_gb prints a whole number', () => {
  const r = bash(`. ${COMMON}; fk_free_gb /`);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+$/);
});

test('fk_port_up: true for a listening port, false for a closed one', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((ok) => server.once('listening', ok));
  const { port } = server.address();
  try {
    const up = await new Promise((ok) => {
      execFile('bash', ['-c', `. ${COMMON}; fk_port_up ${port} 127.0.0.1`], (err) => ok(!err));
    });
    assert.equal(up, true);
  } finally {
    server.close();
  }
  const down = bash(`. ${COMMON}; fk_port_up ${port} 127.0.0.1`);
  assert.equal(down.status, 1);
});

test('fk_worktrees and fk_dirt: parse worktrees, hide cache symlinks', () => {
  const s = scratch();
  try {
    const repo = join(realpathSync(s.dir), 'repo');
    mkdirSync(repo);
    const git = (...a) => run('git', ['-C', repo, ...a]);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    git('worktree', 'add', '-q', '-b', 'side', join(s.dir, 'wt'));

    const list = bash(`. ${COMMON}; fk_worktrees ${repo}`);
    const rows = list.stdout.trim().split('\n').map((l) => l.split('\t'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0][0], repo);
    assert.equal(rows[0][2], 'main');
    assert.equal(rows[1][2], 'side');

    symlinkSync('/tmp', join(repo, 'node_modules'));
    writeFileSync(join(repo, 'real-change.txt'), 'x');
    const dirt = bash(`. ${COMMON}; FK_WORKTREE_CACHE_SYMLINKS=$'node_modules\\napp/.build' fk_dirt ${repo}`);
    assert.equal(dirt.stdout.trim(), '?? real-change.txt');
    const unfiltered = bash(`. ${COMMON}; fk_dirt ${repo}`);
    assert.match(unfiltered.stdout, /node_modules/);
  } finally {
    s.cleanup();
  }
});

test('fk_require_darwin: skips with exit 0 elsewhere, continues on Darwin', () => {
  const other = bash(`. ${DARWIN}; FK_UNAME=Linux fk_require_darwin; echo reached`);
  assert.equal(other.status, 0);
  assert.equal(other.stdout, 'skipped: needs Xcode\n');
  const mac = bash(`. ${DARWIN}; FK_UNAME=Darwin fk_require_darwin; echo reached`);
  assert.equal(mac.stdout, 'reached\n');
});
