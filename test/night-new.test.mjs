import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, fixture, scratch } from './helpers.mjs';

// A made-up previous night in the old long form: rules prose on top, then the state sections.
const NIGHT3 = `# Example factory: night 3

You are the orchestrator. One firing = one item.

## Hard gates (they override round limits)
- Zero flash frames in any transition.

## Guardrails (paste into every implementer brief)
- One surface that morphs.

## Lessons from night 2 (they bind)
- Never run the setup script from a worktree.

## Backlog (picked by the human)
- [x] A1. 1a2b3c4 Fix the login redirect
- [ ] B2. Add dark mode to settings
  - sub-note: the toggle lives in Profile
- [ ] C3. [blocked: waiting on design] Empty states
Some prose between items.
- [x] E5. 9f8e7d6 Shipped thing
  - its own sub-note
- [ ] D4. [needs-user] **Trim the bundle** · IDEATE

## With the user (pinned; don't do these, log when done)
<!-- an old comment -->
- Disk choices: the old shots folder.

- Beta build 12 is out.

## Needs the phone (for the human)
- Install beta 12, check the splash on a cold launch.

## Log
<!-- one line per iteration -->
08:00 · A1 · 1a2b3c4 · shipped
STOP
`;

function project({ toml = (t) => t } = {}) {
  const s = scratch();
  const root = realpathSync(s.dir);
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  let text = readFileSync(fixture('valid.toml'), 'utf8').replace('~/example-factory', state);
  text = toml(text);
  const tomlPath = join(root, 'factory.toml');
  writeFileSync(tomlPath, text);
  writeFileSync(join(state, 'night-3.md'), NIGHT3);
  const run = (args, env = {}) =>
    factory(['night-new', ...args], { cwd: root, env: { FACTORY_TOML: tomlPath, FK_NOW_DATE: '2030-01-02', ...env } });
  return { ...s, root, state, tomlPath, run, night: (n) => join(state, `night-${n}.md`) };
}

const withRules = (t) => t.replace('[loop]\n', '[loop]\nrules = "docs/example-rules.md"\n');

test('night-new --from carries open and blocked items, With the user and Needs the phone; no rules prose', () => {
  const p = project({ toml: withRules });
  try {
    const r = p.run(['4', '--from', '3', '--theme', 'speed', '--human', 'away until 08:00']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote .*night-4\.md/);
    assert.match(r.stdout, /3 open item\(s\)/);
    const out = readFileSync(p.night(4), 'utf8');

    // header: at most 10 lines before the first section
    const header = out.slice(0, out.indexOf('## Backlog')).trimEnd().split('\n');
    assert.ok(header.length <= 10, `header is ${header.length} lines`);
    assert.match(out, /^# example-app factory: night 4\n/);
    assert.match(out, /\*\*Date:\*\* 2030-01-02 · \*\*Theme:\*\* speed/);
    assert.match(out, /\*\*Branch target:\*\* `factory\/night-4` → `dev` \(app\)/);
    assert.match(out, /\*\*The human:\*\* away until 08:00/);
    assert.match(out, /`docs\/example-rules\.md`/);
    assert.match(out, /night 3 \(3 open items carried: B2, C3, D4\)/);

    // carried items, in order, with continuation lines; done items (and their sub-notes) stay behind
    assert.match(out, /- \[ \] B2\. Add dark mode to settings\n {2}- sub-note: the toggle lives in Profile\n- \[ \] C3\. \[blocked: waiting on design\] Empty states\n- \[ \] D4\. \[needs-user\]/);
    assert.doesNotMatch(out, /A1|E5|its own sub-note|Some prose between/);

    // sections carried verbatim, old comments dropped
    assert.match(out, /## With the user\n<!--.*-->\n- Disk choices: the old shots folder\.\n\n- Beta build 12 is out\.\n/);
    assert.match(out, /## Needs the phone\n<!--.*-->\n- Install beta 12, check the splash on a cold launch\.\n/);
    assert.doesNotMatch(out, /an old comment/);

    // no rules prose, no old log, no STOP line
    assert.doesNotMatch(out, /Hard gates|Guardrails|Lessons|You are the orchestrator|Zero flash|08:00 · A1/);
    assert.doesNotMatch(out, /^STOP$/m);
    assert.deepEqual(
      out.split('\n').filter((l) => l.startsWith('## ')),
      ['## Backlog', '## With the user', '## Needs the phone', '## Log'],
    );
    assert.ok(out.trimEnd().endsWith('-->'), 'the Log ends the file, empty');
  } finally {
    p.cleanup();
  }
});

test('night-new refuses to overwrite an existing night file', () => {
  const p = project();
  try {
    writeFileSync(p.night(4), 'mine\n');
    const r = p.run(['4', '--from', '3']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists; refusing to overwrite/);
    assert.equal(readFileSync(p.night(4), 'utf8'), 'mine\n');
  } finally {
    p.cleanup();
  }
});

test('night-new without --from renders empty sections; defaults name what is unset', () => {
  const p = project();
  try {
    const r = p.run(['1']);
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(p.night(1), 'utf8');
    assert.match(out, /\*\*Previous night:\*\* none/);
    assert.match(out, /Theme:\*\* \(not set/);
    assert.match(out, /add \[loop\] rules to factory\.toml/);
    assert.doesNotMatch(out, /^- \[ \]/m);
    assert.doesNotMatch(out, /\n{3,}/);
  } finally {
    p.cleanup();
  }
});

test('night-new: a missing previous night and bad arguments exit 1 with a message', () => {
  const p = project();
  try {
    let r = p.run(['4', '--from', '2']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no night 2 file at/);
    assert.equal(existsSync(p.night(4)), false);
    r = p.run(['four']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: factory night-new/);
    r = p.run(['4', '--from', '4']);
    assert.equal(r.status, 1);
    r = p.run(['4', '--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown arg: --bogus/);
    r = p.run(['4', '--target', 'nope']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no \[\[targets\]\] entry named nope \(have: app, site\)/);
  } finally {
    p.cleanup();
  }
});

test('night-new --stdout writes nothing; --target picks another target and says when it deploys production', () => {
  const p = project();
  try {
    const r = p.run(['4', '--from', '3', '--target', 'site', '--stdout']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /`factory\/night-4` → `main` \(site; merging deploys production\)/);
    assert.equal(existsSync(p.night(4)), false);
  } finally {
    p.cleanup();
  }
});

test('a rendered night carries again, and factory tick still ticks its items', () => {
  const p = project();
  try {
    assert.equal(p.run(['4', '--from', '3']).status, 0);
    const r = p.run(['5', '--from', '4']);
    assert.equal(r.status, 0, r.stderr);
    const five = readFileSync(p.night(5), 'utf8');
    assert.equal((five.match(/<!--/g) ?? []).length, 4, 'one comment per section, none carried twice');
    assert.match(five, /night 4 \(3 open items carried: B2, C3, D4\)/);
    const t = factory(['tick', '--night', '5', '--item', 'B2', '--sha', 'abc1234', '--log', 'dark mode'], {
      cwd: p.root,
      env: { FACTORY_TOML: p.tomlPath, FK_NOW_HHMM: '09:00' },
    });
    assert.equal(t.status, 0, t.stderr);
    const after = readFileSync(p.night(5), 'utf8');
    assert.match(after, /- \[x\] B2\. abc1234 Add dark mode/);
    assert.ok(after.trimEnd().endsWith('09:00 · B2 · abc1234 · dark mode'));
  } finally {
    p.cleanup();
  }
});

test('night-new follows a custom [project] item_line', () => {
  const p = project({ toml: (t) => t.replace('item_line     = "- [ ] {id}."', 'item_line     = "* [ ] {id}:"') });
  try {
    writeFileSync(
      join(p.state, 'night-3.md'),
      '## Backlog\n* [ ] X1: open one\n* [x] X2: done\n- [ ] X3. other format\n\n## Log\n',
    );
    const r = p.run(['4', '--from', '3', '--stdout']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\* \[ \] X1: open one/);
    assert.doesNotMatch(r.stdout, /X2|X3/);
    assert.match(r.stdout, /1 open item carried: X1/);
    assert.match(r.stdout, /in order: \* \[ \] <id>: \*\*Title\*\*/);
  } finally {
    p.cleanup();
  }
});

test('night-new warns about carried item IDs that are not plain-English slugs (item_ids = "slug", the default)', () => {
  const p = project({ toml: (t) => t.replace('item_ids = "any"\n', '') });
  try {
    writeFileSync(join(p.state, 'night-3.md'), '## Backlog\n- [ ] G3. a code\n- [ ] lifetime-globe. a slug\n\n## Log\n');
    const r = p.run(['4', '--from', '3', '--stdout']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /- \[ \] G3\. a code\n- \[ \] lifetime-globe\. a slug/);
    assert.match(r.stderr, /not plain-English slugs \(factory tick refuses them\): G3\. Rename/);
    const quiet = project({});
    try {
      writeFileSync(join(quiet.state, 'night-3.md'), '## Backlog\n- [ ] G3. a code\n\n## Log\n');
      assert.doesNotMatch(quiet.run(['4', '--from', '3', '--stdout']).stderr, /slug/);
    } finally {
      quiet.cleanup();
    }
  } finally {
    p.cleanup();
  }
});

test('config: [loop] rules is a known optional string, read by config get', async () => {
  const { load } = await import('../cmd/config.mjs');
  const base = readFileSync(fixture('valid.toml'), 'utf8');
  assert.deepEqual(load(withRules(base)).errors, []);
  assert.equal(load(base.replace('[loop]\n', '[loop]\nrules = 3\n')).errors.length, 1);
  const p = project({ toml: withRules });
  try {
    const r = factory(['config', 'get', 'loop.rules'], { cwd: p.root, env: { FACTORY_TOML: p.tomlPath } });
    assert.equal(r.stdout.trim(), 'docs/example-rules.md');
  } finally {
    p.cleanup();
  }
});

test('night-new is listed by factory help', () => {
  const r = factory(['help']);
  assert.match(r.stdout, /night-new\s+start night N's file/);
  assert.match(r.stdout, /install-skill\s+link ~\/\.claude\/skills\/factory-orchestrator/);
});
