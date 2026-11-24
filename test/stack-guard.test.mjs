// No base branch is deleted while an open PR targets it: hook-guard rule 9, `factory cleanup` and the janitor's housekeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseToml } from '../cmd/config.mjs';
import { evaluate, guardConfig } from '../gates/hook-guard.mjs';
import { housekeeping } from '../cmd/janitor.mjs';
import { KIT, cleanEnv, factory, run, scratch } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';
import { installGh } from './gh-stub.mjs';

const DEADLINE_MS = 120_000;

// ---------------------------------------------------------------- hook-guard, in process

const TOML = `
[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.1.0"
[project]
name = "x"
main_checkout = "/tmp/x"
state_dir = "/tmp/x-factory"
[git]
worktrees_dir = ".worktrees"
worktree_branch = "factory/{name}-wt"
push_branch = "factory/{name}"
never_push = ["main"]
`;
function guard(answer) {
  const calls = [];
  const warnings = [];
  const s = scratch();
  const cfg = {
    ...guardConfig(parseToml(TOML).data, join(s.dir, 'factory.toml')),
    openBasePrs: (branch) => (calls.push(branch), typeof answer === 'function' ? answer(branch) : answer),
    warn: (m) => warnings.push(m),
  };
  const bash = (command) => evaluate({ tool_name: 'Bash', tool_input: { command }, cwd: s.dir }, cfg);
  return { bash, calls, warnings, done: s.cleanup };
}

test('hook-guard: deleting a branch an open PR targets is denied, in every spelling', () => {
  const g = guard({ prs: [{ number: 7, head: 'child' }] });
  try {
    for (const cmd of ['git push origin --delete parent', 'git push origin :parent', 'git push -d origin parent', 'git push origin --delete refs/heads/parent', 'git push --delete origin other parent']) {
      const reason = g.bash(cmd);
      assert.match(reason ?? '', /deleting 'parent'|deleting 'other'/, cmd);
      assert.match(reason, /#7 still targets it/);
      assert.match(reason, /factory stack land/);
    }
    // it is a push like any other: chained commands are still seen
    assert.match(g.bash('echo done && git push origin --delete parent') ?? '', /#7/);
  } finally {
    g.done();
  }
});

test('hook-guard: a delete with no open PR on the branch passes, and so do pushes that delete nothing', () => {
  const g = guard({ prs: [] });
  try {
    assert.equal(g.bash('git push origin --delete parent'), null);
    assert.equal(g.bash('git push origin :parent'), null);
    assert.deepEqual(g.calls, ['parent', 'parent']);
    g.calls.length = 0;
    assert.equal(g.bash('git push origin parent'), null);
    assert.equal(g.bash('git push -u origin feature'), null);
    assert.equal(g.bash('git push origin HEAD:refs/heads/feature'), null);
    assert.equal(g.bash('git push origin --delete refs/tags/v1'), null);
    assert.deepEqual(g.calls, [], 'gh is not asked about a push that deletes nothing');
    assert.deepEqual(g.warnings, []);
  } finally {
    g.done();
  }
});

test('hook-guard: only the branches with an open PR are named', () => {
  const g = guard((b) => (b === 'parent' ? { prs: [{ number: 3, head: 'c' }, { number: 4, head: 'd' }] } : { prs: [] }));
  try {
    assert.equal(g.bash('git push origin --delete scratch'), null);
    const reason = g.bash('git push origin --delete parent');
    assert.match(reason, /#3, #4 still target it/);
  } finally {
    g.done();
  }
});

test('hook-guard: fails open when gh cannot answer, with a warning line naming why', () => {
  const g = guard({ error: 'gh is not installed' });
  try {
    assert.equal(g.bash('git push origin --delete parent'), null);
    assert.equal(g.warnings.length, 1);
    assert.match(g.warnings[0], /could not check whether an open PR targets 'parent' \(gh is not installed\); allowing the delete/);
  } finally {
    g.done();
  }
});

// ---------------------------------------------------------------- hook-guard, through bin/factory with a stub gh

function stubbed() {
  const t = tree({});
  const gh = installGh(t.p('bin'), t.p('gh-state.json'), t.p('gh.log'));
  gh.pr({ number: 9, headRefName: 'child', baseRefName: 'parent' });
  const env = { ...t.env, ...gh.env };
  const hook = (command, extra = {}) =>
    run(join(KIT, 'bin', 'factory'), ['hook-guard'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: t.main }),
      env: { ...cleanEnv(), ...env, ...extra },
      timeout: DEADLINE_MS,
    });
  return { ...t, gh, env, hook };
}

test('hook-guard (bin/factory): denies with gh answering, allows with gh offline and says so on stderr', () => {
  const t = stubbed();
  try {
    const deny = t.hook('git push origin --delete parent');
    assert.equal(deny.status, 0, deny.stderr);
    const out = JSON.parse(deny.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /#9 still targets it/);
    assert.match(t.gh.log(), /pr list --base parent --state open/);

    const free = t.hook('git push origin --delete unrelated');
    assert.equal(free.stdout, '', 'a branch nobody targets is allowed');

    const offline = t.hook('git push origin --delete parent', { GH_FAIL: '1' });
    assert.equal(offline.status, 0);
    assert.equal(offline.stdout, '', 'allowed');
    assert.match(offline.stderr, /factory hook-guard: could not check whether an open PR targets 'parent' \(gh exited 1: gh: could not connect \(offline\)\); allowing the delete/);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------- cleanup and the janitor

test('cleanup keeps a merged worktree and its branch while an open PR targets it, and says so', () => {
  const t = stubbed();
  try {
    t.gh.pr({ number: 12, title: 'on top of the agent branch', headRefName: 'stacked', baseRefName: 'agent-merged-b' });
    const dry = factory(['cleanup', '--only', 'worktrees'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /KEPT {2}agent-merged \(kept: base of #12\)/);
    assert.ok(!/REMOVE agent-merged /.test(dry.stdout));
    assert.match(dry.stdout, /REMOVE agent-symlink/, 'a merged worktree nobody builds on still goes');

    const applied = factory(['cleanup', '--only', 'worktrees', '--apply'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(applied.status, 0, applied.stderr);
    assert.ok(existsSync(join(t.wt, 'agent-merged')), 'the worktree stays');
    assert.equal(t.git(t.main, 'branch', '--list', 'agent-merged-b').length > 0, true, 'the branch stays');
    assert.ok(!existsSync(join(t.wt, 'agent-symlink')));

    // once the PR is retargeted, the next pass takes it
    t.gh.set(12, { baseRefName: 'trunk' });
    const next = factory(['cleanup', '--only', 'worktrees', '--apply'], { env: t.env, cwd: t.main, timeout: DEADLINE_MS });
    assert.match(next.stdout, /REMOVE agent-merged/);
    assert.ok(!existsSync(join(t.wt, 'agent-merged')));
  } finally {
    t.cleanup();
  }
});

test('the janitor housekeeping applies cleanup but never takes a base branch, and logs "kept: base of #N"', () => {
  const t = stubbed();
  try {
    t.gh.pr({ number: 12, headRefName: 'stacked', baseRefName: 'agent-merged-b' });
    const lines = [];
    const dir = t.p('state', 'janitor');
    const actions = housekeeping({ dir }, { apply: true, log: (l) => lines.push(l), env: { ...process.env, ...t.env, FK_JANITOR_CLEANUP: '' } });
    const text = lines.map((l) => `${l.what} | ${l.why}`).join('\n');
    assert.match(text, /kept agent-merged \| kept: base of #12/);
    assert.ok(!actions.some((a) => a.what.startsWith('agent-merged ')), text);
    assert.ok(existsSync(join(t.wt, 'agent-merged')), 'the base worktree is still there');
    assert.equal(t.git(t.main, 'branch', '--list', 'agent-merged-b').length > 0, true);
    assert.ok(!existsSync(join(t.wt, 'agent-symlink')), 'the rest of the housekeeping ran');
  } finally {
    t.cleanup();
  }
});

test('cleanup treats gh being offline as no answer: nothing is held back for it', () => {
  const t = stubbed();
  try {
    const r = factory(['cleanup', '--only', 'worktrees'], { env: { ...t.env, GH_FAIL: '1' }, cwd: t.main, timeout: DEADLINE_MS });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REMOVE agent-merged /);
  } finally {
    t.cleanup();
  }
});
