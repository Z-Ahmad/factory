import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseToml } from '../cmd/config.mjs';
import { evaluate, guardConfig } from '../gates/hook-guard.mjs';
import { KIT, run, scratch } from './helpers.mjs';

// A synthetic project: a main checkout `proj` with a linked worktree `proj/.worktrees/wt`
// whose secrets file is a symlink back to the main checkout (like a cache symlink).
const TOML = `
[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.1.0"

[project]
name = "example-app"
main_checkout = "/tmp/example"
state_dir = "/tmp/example-factory"
night_file = "{state_dir}/night-{n}.md"

[git]
worktrees_dir = ".worktrees"
worktree_branch = "factory/{name}-wt"
push_branch = "factory/{name}"
never_push = ["main", "release/*"]

[[targets]]
name = "app"
base = "origin/dev"
pr_base = "dev"

[never_touch]
paths = ["app/Config/secrets.cfg", "site/.env*", "keys/**"]
never_run_in_worktree = ["app/scripts/setup.sh"]

[dev]
up = "npm run dev"
all_ports = [4100, 4101, 4102]
wait_ports = [4100]
agents_may_start = false
read_api = { cwd = "/tmp/example", cmd = "npm run dev -w api", port = 4103 }
`;

let t, main, wt, cfg, cfgMerge, cfgOpen;

before(() => {
  t = scratch();
  const root = realpathSync(t.dir);
  main = join(root, 'proj');
  wt = join(main, '.worktrees', 'wt');
  const gitdir = join(main, '.git');
  const wtGit = join(gitdir, 'worktrees', 'wt');
  mkdirSync(wtGit, { recursive: true });
  mkdirSync(join(main, 'app', 'Config'), { recursive: true });
  mkdirSync(join(main, 'app', 'scripts'), { recursive: true });
  mkdirSync(join(main, 'site'), { recursive: true });
  mkdirSync(join(wt, 'app', 'Config'), { recursive: true });
  writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(wtGit, 'HEAD'), 'ref: refs/heads/factory/x\n');
  writeFileSync(join(wtGit, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  writeFileSync(join(main, 'app', 'Config', 'secrets.cfg'), 'TOKEN=\n');
  symlinkSync(join(main, 'app', 'Config', 'secrets.cfg'), join(wt, 'app', 'Config', 'secrets.cfg'));
  writeFileSync(join(main, 'factory.toml'), TOML);
  const mk = (extra = '') => guardConfig(parseToml(TOML + extra).data, join(main, 'factory.toml'));
  cfg = mk();
  cfgMerge = mk('\n[loop]\nallow_merge = true\n');
  cfgOpen = guardConfig(parseToml(TOML.replace('agents_may_start = false', 'agents_may_start = true')).data, join(main, 'factory.toml'));
});
after(() => t.cleanup());

const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd: cwd ?? main });
const edit = (tool, file_path, cwd) => ({ tool_name: tool, tool_input: { file_path }, cwd: cwd ?? main });

// [label, payload builder, expected, optional reason regex]. Builders run after `before`, so paths are real.
const TABLE = [
  // ---- rule 1: never-touch paths
  ['Edit never-touch file', () => edit('Edit', join(main, 'app/Config/secrets.cfg')), 'deny', /never_touch\.paths/],
  ['Write never-touch file, relative path', () => edit('Write', 'app/Config/secrets.cfg'), 'deny', /never_touch\.paths/],
  ['MultiEdit .env glob', () => edit('MultiEdit', join(main, 'site/.env.local')), 'deny', /site\/\.env\*/],
  ['NotebookEdit under keys/**', () => ({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(main, 'keys/a/b.ipynb') }, cwd: main }), 'deny'],
  ['Edit through the worktree symlink', () => edit('Edit', join(wt, 'app/Config/secrets.cfg'), wt), 'deny'],
  ['Edit main checkout file from a worktree cwd', () => edit('Edit', join(main, 'app/Config/secrets.cfg'), wt), 'deny'],
  ['Edit never-touch name in different case', () => edit('Edit', join(main, 'site/.ENV')), 'deny'],
  ['Edit .env.example (a committed template)', () => edit('Edit', join(main, 'site/.env.example')), 'allow'],
  ['Edit ordinary source file', () => edit('Edit', join(main, 'app/Main.swift')), 'allow'],
  ['Edit a file that only shares a prefix with a pattern', () => edit('Edit', join(main, 'site/env.ts')), 'allow'],
  ['Edit a not-yet-existing file under a normal dir', () => edit('Write', join(wt, 'app/New.swift'), wt), 'allow'],
  ['Read of a never-touch file is not an edit', () => ({ tool_name: 'Read', tool_input: { file_path: join(main, 'app/Config/secrets.cfg') }, cwd: main }), 'allow'],
  ['Bash cat of a never-touch file', () => bash('cat app/Config/secrets.cfg'), 'allow'],
  ['Bash grep in .env files', () => bash('grep -n TOKEN site/.env site/.env.local'), 'allow'],
  ['Bash redirect into a never-touch file', () => bash('echo TOKEN=x > site/.env.local'), 'deny', /never_touch\.paths/],
  ['Bash tee -a into a never-touch file', () => bash('echo x | tee -a app/Config/secrets.cfg'), 'deny'],
  ['Bash redirect to /dev/null', () => bash('npm test > /dev/null 2>&1'), 'allow'],
  ['Bash redirect to .env.example', () => bash('echo A=1 >> site/.env.example'), 'allow'],

  // ---- rule 2: never run in a worktree
  ['bootstrap-like script from a worktree', () => bash('bash app/scripts/setup.sh', wt), 'deny', /never_run_in_worktree/],
  ['same script from the main checkout', () => bash('bash app/scripts/setup.sh', main), 'allow'],
  ['./path form from a worktree', () => bash('./app/scripts/setup.sh', wt), 'deny'],
  ['cd then relative script, in a worktree', () => bash('cd app && ./scripts/setup.sh', wt), 'deny'],
  ['sh -c wrapping it, in a worktree', () => bash('sh -c "bash app/scripts/setup.sh"', wt), 'deny'],
  ['main-checkout absolute path, from a worktree cwd', () => bash(`${join(main, 'app/scripts/setup.sh')}`, wt), 'deny'],
  ['cat/grep/edit of that script from a worktree', () => bash('cat app/scripts/setup.sh; grep -n x app/scripts/setup.sh', wt), 'allow'],
  ['a different script from a worktree', () => bash('bash app/scripts/build.sh', wt), 'allow'],

  // ---- rule 3: pushes and hook bypasses
  ['push to main', () => bash('git push origin main'), 'deny', /git\.never_push/],
  ['push HEAD:main', () => bash('git push origin HEAD:main'), 'deny'],
  ['push HEAD:refs/heads/main', () => bash('git push origin HEAD:refs/heads/main'), 'deny'],
  ['push a branch matching a glob (release/*)', () => bash('git push origin HEAD:release/1.2'), 'deny'],
  ['push -u origin main with git -C', () => bash(`git -C ${main} push -u origin main`), 'deny'],
  ['push delete main', () => bash('git push origin :main'), 'deny'],
  ['bare git push while on main', () => bash('git push', main), 'deny', /current branch 'main'/],
  ['push HEAD while on main', () => bash('git push origin HEAD', main), 'deny'],
  ['push a feature branch', () => bash('git push origin factory/x'), 'allow'],
  ['push -u origin a feature branch', () => bash('git push -u origin factory/night-1'), 'allow'],
  ['push HEAD:factory/x', () => bash('git push origin HEAD:factory/x'), 'allow'],
  ['push a branch whose name merely contains main', () => bash('git push origin feature/main-menu'), 'allow'],
  ['bare git push on a feature branch (worktree)', () => bash('git push', wt), 'allow'],
  ['push main:factory/x (main only as the source)', () => bash('git push origin main:factory/x'), 'allow'],
  ['push --force', () => bash('git push --force origin factory/x'), 'deny', /force/],
  ['push -f', () => bash('git push -f origin factory/x'), 'deny'],
  ['push -fu cluster', () => bash('git push -fu origin factory/x'), 'deny'],
  ['push --force-with-lease=ref', () => bash('git push --force-with-lease=factory/x origin factory/x'), 'deny'],
  ['push +refspec', () => bash('git push origin +HEAD:factory/x'), 'deny'],
  ['push --all', () => bash('git push --all origin'), 'deny'],
  ['push --no-verify', () => bash('git push --no-verify origin factory/x'), 'deny', /--no-verify/],
  ['commit --no-verify', () => bash('git commit --no-verify -m x'), 'deny', /--no-verify/],
  ['commit -m then --no-verify', () => bash('git commit -m "msg" --no-verify'), 'deny'],
  ['commit -n', () => bash('git commit -n -m x'), 'deny'],
  ['commit -nm cluster', () => bash('git commit -nm "x"'), 'deny'],
  ['HUSKY=0 commit', () => bash('HUSKY=0 git commit -m x'), 'deny'],
  ['core.hooksPath override on commit', () => bash('git -c core.hooksPath=/dev/null commit -m x'), 'deny'],
  ['chained: add && commit --no-verify', () => bash('git add -A && git commit --no-verify -m wip'), 'deny'],
  ['commit message that mentions --no-verify', () => bash('git commit -m "mention --no-verify in text"'), 'allow'],
  ['commit message that mentions git push origin main', () => bash('git commit -m "docs: never git push origin main"'), 'allow'],
  ['heredoc commit message mentioning pushes and dev', () => bash(`git commit -m "$(cat <<'EOF'\nfix: stop 'git push --force origin main' and npm run dev (it's fine)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`), 'allow'],
  ['commit -m "-n" (the message is -n)', () => bash('git commit -m -n'), 'allow'],
  ['plain commit and amend', () => bash('git commit --amend --no-edit'), 'allow'],
  ['git log --grep=--no-verify', () => bash('git log --grep=--no-verify'), 'allow'],
  ['echo of a forbidden command', () => bash('echo "git push --force origin main"'), 'allow'],
  ['a comment mentioning it', () => bash('git status # git push --force origin main'), 'allow'],
  ['git status / diff / fetch', () => bash('git status && git diff --stat && git fetch origin'), 'allow'],

  // ---- rule 4: gh pr merge
  ['gh pr merge', () => bash('gh pr merge 12 --squash'), 'deny', /loop\.allow_merge/],
  ['gh -R repo pr merge --auto', () => bash('gh -R o/r pr merge --auto 12'), 'deny'],
  ['gh api pulls merge', () => bash('gh api -X PUT repos/o/r/pulls/12/merge'), 'deny'],
  ['gh pr merge when allow_merge = true', () => bash('gh pr merge 12', main), 'allow', null, () => cfgMerge],
  ['gh pr create / view / checks', () => bash('gh pr create --title x --body "will gh pr merge later" && gh pr view 3 && gh pr checks 3'), 'allow'],

  // ---- rule 5: the dev stack
  ['npm run dev', () => bash('npm run dev'), 'deny', /factory dev-up/],
  ['npm run dev:local', () => bash('npm run dev:local'), 'deny'],
  ['npm run dev in the background after a cd', () => bash('cd proj && nohup npm run dev > /tmp/dev.log 2>&1 &'), 'deny'],
  ['npm run dev -w api (the read-api command)', () => bash('npm run dev -w api'), 'deny', /read-api/],
  ['npm --prefix x run dev', () => bash('npm --prefix web run dev'), 'deny'],
  ['pnpm dev', () => bash('pnpm dev'), 'deny'],
  ['env prefix and sh -c', () => bash('FORCE_COLOR=1 sh -c "npm run dev"'), 'deny'],
  ['npm run dev:stripe is a different script', () => bash('npm run dev:stripe'), 'allow'],
  ['npm run dev:app is a different script', () => bash('npm run dev:app'), 'allow'],
  ['npm run build / test / verify', () => bash('npm run build && npm run test && npm run verify:quick'), 'allow'],
  ['grep for the command in a file', () => bash('grep -rn "npm run dev" docs/'), 'allow'],
  ['factory dev-up', () => bash('factory dev-up'), 'allow'],
  ['the shim calling dev-up', () => bash('scripts/factory/factory dev-up --no-seed'), 'allow'],
  ['factory dev-status and read-api up', () => bash('scripts/factory/factory dev-status; scripts/factory/factory read-api up'), 'allow'],
  ['npm run dev when agents_may_start = true', () => bash('npm run dev'), 'allow', null, () => cfgOpen],
  ['lsof | xargs kill on a stack port', () => bash('lsof -ti :4101 | xargs kill -9'), 'deny', /agents_may_start/],
  ['lsof -ti:PORT attached form', () => bash('lsof -ti:4100 | xargs kill'), 'deny'],
  ['kill $(lsof ...)', () => bash('kill -9 $(lsof -t -i :4102)'), 'deny'],
  ['kill with backticks', () => bash('kill `lsof -ti tcp:4100`'), 'deny'],
  ['for loop killing a port holder', () => bash('for p in $(lsof -ti :4101); do kill $p; done'), 'deny'],
  ['fuser -k PORT/tcp', () => bash('fuser -k 4101/tcp'), 'deny'],
  ['npx kill-port', () => bash('npx kill-port 4100 4101'), 'deny'],
  ['pkill -f "npm run dev"', () => bash('pkill -f "npm run dev"'), 'deny'],
  ['pkill -f vite', () => bash('pkill -f vite'), 'deny'],
  ['killall node', () => bash('killall node'), 'deny'],
  ['lsof on a stack port without killing', () => bash('lsof -ti :4101'), 'allow'],
  ['lsof on a stack port, then kill of a literal pid', () => bash('lsof -ti :4101; kill 4242'), 'allow'],
  ['lsof | xargs kill on a port outside the stack', () => bash('lsof -ti :9999 | xargs kill'), 'allow'],
  ['kill of a literal pid', () => bash('kill -9 31337'), 'allow'],
  ['pkill of an unrelated process', () => bash('pkill -f my-own-helper'), 'allow'],

  // ---- other tools and shapes
  ['unknown tool', () => ({ tool_name: 'Glob', tool_input: { pattern: '**/*.env' }, cwd: main }), 'allow'],
  ['MCP tool', () => ({ tool_name: 'mcp__x__y', tool_input: { command: 'git push origin main' }, cwd: main }), 'allow'],
  ['Bash with an empty command', () => bash(''), 'allow'],
  ['Bash with an unterminated quote', () => bash('echo "unterminated'), 'allow'],
];

for (const [label, build, want, reasonRe, cfgOf] of TABLE) {
  test(`hook-guard: ${want} ${label}`, () => {
    const c = cfgOf ? cfgOf() : cfg;
    const reason = evaluate(build(), c);
    if (want === 'allow') assert.equal(reason, null, `expected allow, got: ${reason}`);
    else {
      assert.ok(reason, 'expected a deny reason');
      assert.match(reason, /^factory hook-guard: /);
      assert.ok(!reason.includes('\n'), 'the reason is one line');
      if (reasonRe) assert.match(reason, reasonRe);
    }
  });
}

test('hook-guard: the table has at least 30 payloads', () => {
  assert.ok(TABLE.length >= 30);
});

// ---- through the dispatcher: the documented JSON deny, silent allow, fail-open ----

const guard = (stdin, env = {}) =>
  run(join(KIT, 'bin', 'factory'), ['hook-guard'], {
    cwd: main,
    input: stdin,
    env: { ...process.env, FACTORY_TOML: join(main, 'factory.toml'), ...env },
  });

test('hook-guard CLI: a deny is exit 0 with the documented JSON on stdout', () => {
  const r = guard(JSON.stringify(bash('git push origin main')));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /git\.never_push/);
  assert.equal(r.stderr, '');
});

test('hook-guard CLI: an allow is silent', () => {
  const r = guard(JSON.stringify(bash('git push origin factory/x')));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('hook-guard CLI: fails open with a warning on bad stdin, a bad toml, or a missing toml', () => {
  for (const [stdin, env] of [
    ['not json', {}],
    ['', {}],
    [JSON.stringify(bash('git push origin main')), { FACTORY_TOML: join(main, 'app', 'Config', 'secrets.cfg') }],
  ]) {
    const r = guard(stdin, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /factory hook-guard: .*allowing the call/);
  }
});

test('config: [loop] allow_merge is a known optional bool', async () => {
  const { load } = await import('../cmd/config.mjs');
  assert.deepEqual(load(`${TOML}\n[loop]\nallow_merge = true\n`).errors, []);
  assert.equal(load(`${TOML}\n[loop]\nallow_merge = "yes"\n`).errors.length, 1);
});

test('hook-guard CLI: fails open when the payload shape is unexpected', () => {
  for (const payload of ['null', '[]', '{"tool_name":"Bash","tool_input":{"command":42}}', '{"tool_name":"Edit"}']) {
    const r = guard(payload);
    assert.equal(r.status, 0, payload);
    assert.equal(r.stdout, '', payload);
  }
});
