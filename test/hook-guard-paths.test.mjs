import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseToml } from '../cmd/config.mjs';
import { evaluate, guardConfig } from '../gates/hook-guard.mjs';
import { scratch } from './helpers.mjs';

// never_touch globs that name an absolute path (a place outside the repository), and Windows path spellings:
// backslashes from node and Claude Code, /c/... from Git Bash.
const WIN = process.platform === 'win32';
const fwd = (p) => p.replace(/\\/g, '/');
const msys = (p) => fwd(p).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

let t, main, outside, cfg;

before(() => {
  t = scratch();
  const root = realpathSync(t.dir);
  main = join(root, 'proj');
  outside = join(root, 'game');
  mkdirSync(join(main, '.git'), { recursive: true });
  mkdirSync(join(main, 'build', 'extracted'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const toml = `
[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.1.0"

[project]
name = "example-game"
main_checkout = "/tmp/example"
state_dir = "/tmp/example-factory"
night_file = "{state_dir}/night-{n}.md"

[git]
worktrees_dir = ".worktrees"
worktree_branch = "factory/{name}-wt"
push_branch = "factory/{name}"

[[targets]]
name = "app"
base = "origin/dev"
pr_base = "dev"

[never_touch]
paths = ["build/extracted/**", "${fwd(outside)}/**"]
`;
  writeFileSync(join(main, 'factory.toml'), toml);
  cfg = guardConfig(parseToml(toml).data, join(main, 'factory.toml'));
});
after(() => t.cleanup());

const edit = (file_path) => ({ tool_name: 'Write', tool_input: { file_path }, cwd: main });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: main });

test('an absolute never_touch glob guards a path outside the repository', () => {
  assert.match(evaluate(edit(join(outside, 'save', 'progress.sav')), cfg) ?? '', /never_touch\.paths/);
  assert.equal(evaluate(edit(join(t.dir, 'elsewhere.txt')), cfg), null);
});

test('a relative glob still guards the repository', () => {
  assert.match(evaluate(edit(join(main, 'build', 'extracted', 'a.bin')), cfg) ?? '', /never_touch\.paths/);
  assert.match(evaluate(edit('build/extracted/a.bin'), cfg) ?? '', /never_touch\.paths/);
  assert.equal(evaluate(edit(join(main, 'build', 'other.bin')), cfg), null);
});

test('Bash redirects into an absolute glob are denied', () => {
  assert.match(evaluate(bash(`echo x > '${fwd(join(outside, 'a.txt'))}'`), cfg) ?? '', /never_touch\.paths/);
});

test('Windows spellings: backslashes and Git Bash /c/ paths', { skip: !WIN }, () => {
  assert.match(evaluate(edit(join(main, 'build', 'extracted', 'a.bin')), cfg) ?? '', /never_touch\.paths/);
  assert.match(evaluate(edit(fwd(join(outside, 'a.txt'))), cfg) ?? '', /never_touch\.paths/);
  assert.match(evaluate(bash(`echo x > ${msys(join(outside, 'a.txt'))}`), cfg) ?? '', /never_touch\.paths/);
  assert.match(evaluate(bash(`echo x > ${msys(join(main, 'build', 'extracted', 'a.bin'))}`), cfg) ?? '', /never_touch\.paths/);
  assert.match(evaluate(edit(join(main, 'BUILD', 'Extracted', 'a.bin')), cfg) ?? '', /never_touch\.paths/);
});
