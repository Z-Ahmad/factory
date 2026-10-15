import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { addCommand, copyKit, factory, fixture, run, scratch } from './helpers.mjs';

// A scratch project: `<dir>/proj/factory.toml` plus `<dir>/proj/sub/deeper`.
function project() {
  const s = scratch();
  const root = realpathSync(s.dir);
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'sub', 'deeper'), { recursive: true });
  copyFileSync(fixture('valid.toml'), join(proj, 'factory.toml'));
  const kit = copyKit(root);
  addCommand(kit, 'probe', 'echo "$FK_PROJECT_NAME|$FK_ROOT|$FK_KIT_DIR|$FK_TARGETS_COUNT|$*"');
  return { ...s, root, proj, kit };
}

test('help lists the commands with their descriptions', () => {
  const r = factory(['help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\s+config\s+validate and query factory\.toml/m);
});

test('help needs no factory.toml', () => {
  const t = project();
  try {
    assert.equal(factory(['help'], { cwd: t.root }).status, 0);
    assert.equal(factory([], { cwd: t.root }).status, 0);
  } finally {
    t.cleanup();
  }
});

test('finds factory.toml by walking up from a subdirectory, exports FK_*, passes args', () => {
  const t = project();
  try {
    const r = factory(['probe', 'a', 'b c'], { kit: t.kit, cwd: join(t.proj, 'sub', 'deeper') });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `example-app|${t.proj}|${t.kit}|2|a b c\n`);
  } finally {
    t.cleanup();
  }
});

test('no factory.toml: a clear message, exit 1', () => {
  const t = project();
  try {
    const r = factory(['probe'], { kit: t.kit, cwd: t.root });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /factory: no factory\.toml found/);
    assert.equal(r.stdout, '');
  } finally {
    t.cleanup();
  }
});

test('FACTORY_TOML and --file override discovery', () => {
  const t = project();
  try {
    const viaEnv = factory(['probe'], { kit: t.kit, cwd: t.root, env: { FACTORY_TOML: join(t.proj, 'factory.toml') } });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    const viaFlag = factory(['--file', join(t.proj, 'factory.toml'), 'probe'], { kit: t.kit, cwd: t.root });
    assert.equal(viaFlag.status, 0, viaFlag.stderr);
    const bad = factory(['--file', join(t.root, 'missing.toml'), 'probe'], { kit: t.kit });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /no such file/);
  } finally {
    t.cleanup();
  }
});

test('falls back to the git common root from a worktree without factory.toml', () => {
  const t = project();
  try {
    const git = (...a) => run('git', ['-C', t.proj, ...a]);
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('add', 'factory.toml');
    git('commit', '-q', '-m', 'init');
    // The worktree lives outside the repo, so a walk up from it never reaches factory.toml.
    const wt = join(t.root, 'elsewhere');
    git('worktree', 'add', '-q', '-b', 'side', wt);
    // Remove the file from the worktree's branch so only the main checkout has it.
    run('git', ['-C', wt, 'rm', '-q', 'factory.toml']);
    const r = factory(['probe'], { kit: t.kit, cwd: wt });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^example-app\\|${t.proj}\\|`));
  } finally {
    t.cleanup();
  }
});

test('config validation runs before a command, so a broken file stops it', () => {
  const t = project();
  try {
    copyFileSync(fixture('wrong-type.toml'), join(t.proj, 'factory.toml'));
    const r = factory(['probe'], { kit: t.kit, cwd: t.proj });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dev\.timeout_s: expected int/);
    assert.equal(r.stdout, '');
    // ...but `config` itself still runs, to report the problem
    assert.equal(factory(['config', 'validate'], { kit: t.kit, cwd: t.proj }).status, 1);
  } finally {
    t.cleanup();
  }
});

test('unknown command: exit 2 and the command list', () => {
  const t = project();
  try {
    const r = factory(['nope'], { kit: t.kit, cwd: t.proj });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown command: nope/);
    assert.match(r.stderr, /commands:/);
  } finally {
    t.cleanup();
  }
});

test('command names cannot escape cmd/', () => {
  const r = factory(['../bin/factory']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad command name/);
});
