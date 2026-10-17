import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, fixture, scratch } from './helpers.mjs';

// A night file in exactly the shape night-new writes ("example-app" is the fixture project's name).
const CLEAN = `# example-app factory: night 4
- **Date:** 2026-10-17 · **Theme:** speed
- **Branch target:** \`factory/night-4\` → \`dev\` (app)
- **The human:** away until 08:00
- **Rules:** load the factory-orchestrator skill, then \`docs/rules.md\` (from the repo root). This file holds state, not rules.
- **Previous night:** night 3 (2 open items carried: dark-mode, empty-states)

## Backlog
<!-- one line per item, in order: - [ ] <id>. **Title** · notes. Tags: [needs-user] IDEATE TASTE "no test" [blocked: why] -->
- [x] login-redirect. 1a2b3c4 **Fix the login redirect** · IDEATE TASTE [night 4, live] notes
  - an indented continuation line
- [ ] dark-mode. **Add dark mode to settings**
- [ ] empty-states. [blocked: waiting on design] "no test" Empty states
- [ ] trim-bundle. [needs-user] **Trim the bundle**

## With the user
<!-- pinned -->
- Disk choices.

## Needs the phone
- Install beta 12.

## Log
<!-- one line per iteration: <hh:mm> · <id> · <sha|running|blocked> · <note> (factory tick appends). A line STOP on its own ends the night. -->
15:33 · plan · — · — · Synced; theme 'speed'.
15:34 · login-redirect · running · night-4/login.md · Sonnet implementer · with dots
16:24 · login-redirect · 1a2b3c4d · Fixed the redirect · shots/login · phone: check it
16:30 · TF 431 · running · night-4/tf.log · uploading
16:31 · TF 431 · 58c6c344 · #483 · uploaded
17:02 · empty-states · blocked · waiting on design
17:03 · kit · v0.11.0 · factory#3 · note
17:04 · lesson · — · — · One thing.
FINAL (night 4) · 1a2b3c4d · PR #9 · Theme: speed. SHIPPED: login-redirect.
01:39 · end-night · 1a2b3c4d · — · disk 29 GB free; clips 1.0G freed; dirty worktrees: none
STOP
`;

// A scratch project from the synthetic valid.toml, with the night file text given.
function project({ text = CLEAN, toml = (t) => t, slugs = true } = {}) {
  const s = scratch();
  const root = realpathSync(s.dir);
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  let conf = readFileSync(fixture('valid.toml'), 'utf8').replace('~/example-factory', state);
  if (slugs) conf = conf.replace('item_ids = "any"\n', '');
  const tomlPath = join(root, 'factory.toml');
  writeFileSync(tomlPath, toml(conf));
  const file = join(state, 'night-4.md');
  writeFileSync(file, text);
  const lint = (args = ['--night', '4'], env = {}) => factory(['night-lint', ...args], { cwd: root, env: { FACTORY_TOML: tomlPath, ...env } });
  return { ...s, root, state, file, tomlPath, lint, write: (txt) => writeFileSync(file, txt) };
}

const withProject = (opts, fn) => {
  const p = project(opts);
  try {
    return fn(p);
  } finally {
    p.cleanup();
  }
};
// the findings only: "error line 9: msg" / "warn line 3: msg", paths and the summary dropped
const findings = (r) =>
  r.stdout
    .split('\n')
    .filter((l) => /^ {2}(error|warn) /.test(l))
    .map((l) => l.trim().replace(/\s+/g, ' '));
const edit = (...pairs) => {
  let t = CLEAN;
  for (let i = 0; i < pairs.length; i += 2) {
    assert.ok(t.includes(pairs[i]), `fixture has no "${pairs[i]}"`);
    t = t.replace(pairs[i], pairs[i + 1]);
  }
  return t;
};

test('a file in the shape night-new writes lints clean: exit 0, one line', () =>
  withProject({}, (p) => {
    const r = p.lint();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, `night-lint: ${p.file}\nnight-lint: clean\n`);
    assert.equal(r.stderr, '');
  }));

test('--quiet prints nothing when clean, and everything when not; --file works without a config night_file', () =>
  withProject({}, (p) => {
    let r = p.lint(['--file', p.file, '--quiet']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    p.write(edit('## With the user', '## With the users'));
    r = p.lint(['--file', p.file, '--quiet']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /night-lint: 1 error, 1 warning\n$/);
  }));

test('night-new output lints clean, fresh and with items carried from the previous night', () => {
  const p = project({ text: CLEAN.replace('night 4', 'night 3').replace(/^- \[x\] .*\n.*\n/m, '') });
  try {
    const fresh = factory(['night-new', '1', '--theme', 'first run'], { cwd: p.root, env: { FACTORY_TOML: p.tomlPath, FK_NOW_DATE: '2030-01-02' } });
    assert.equal(fresh.status, 0, fresh.stderr);
    let r = p.lint(['--night', '1']);
    assert.equal(r.stdout, `night-lint: ${join(p.state, 'night-1.md')}\nnight-lint: clean\n`);
    assert.equal(r.status, 0);

    // night 4's file (CLEAN) carried into night 5: open items, With the user, Needs the phone
    const next = factory(['night-new', '5', '--from', '4', '--theme', 'carry', '--human', 'live'], { cwd: p.root, env: { FACTORY_TOML: p.tomlPath, FK_NOW_DATE: '2030-01-03' } });
    assert.equal(next.status, 0, next.stderr);
    const out = readFileSync(join(p.state, 'night-5.md'), 'utf8');
    assert.match(out, /- \[ \] dark-mode\./);
    assert.match(out, /- Install beta 12\./);
    r = p.lint(['--night', '5']);
    assert.equal(r.stdout, `night-lint: ${join(p.state, 'night-5.md')}\nnight-lint: clean\n`);
    assert.equal(r.status, 0);
    // and the line tick appends and the line end-night appends keep it clean
    const tk = factory(['tick', '--night', '5', '--item', 'dark-mode', '--sha', 'abcdef1', '--log', 'dark mode done · shots/x'], { cwd: p.root, env: { FACTORY_TOML: p.tomlPath, FK_NOW_HHMM: '02:03' } });
    assert.equal(tk.status, 0, tk.stderr);
    assert.equal(tk.stderr, '');
  } finally {
    p.cleanup();
  }
});

test('ERRORS (exit 1): no title, wrong night, a missing/repeated/out-of-order section, an item with no ID, a done item with no sha, a duplicate ID', () =>
  withProject({}, (p) => {
    const cases = [
      [edit('# example-app factory: night 4', '# Night 4'), /error line 1: first line must be "# <name> factory: night N"/],
      [edit('night 4\n- **Date', 'night 3\n- **Date'), /error line 1: title says night 3 but this is night 4/],
      [edit('## Needs the phone\n- Install beta 12.\n\n', ''), /error missing section "## Needs the phone"/],
      [edit('## Log\n', '## Log\n\n## Log\n'), /error line \d+: section "## Log" appears twice \(first on line \d+\)/],
      [edit('## With the user', '## Needs the phone\n\n## With the user').replace(/## Needs the phone\n- Install beta 12\.\n\n/, ''), /error line \d+: section "## With the user" is out of order/],
      [edit('- [ ] dark-mode. **Add', '- [ ] **Add'), /error line \d+: item line has no ID in the item_line shape "- \[ \] \{id\}\."/],
      [edit('- [x] login-redirect. 1a2b3c4 ', '- [x] login-redirect. user-verified '), /error line \d+: done item "login-redirect" has no sha right after the ID/],
      [edit('- [x] login-redirect. 1a2b3c4 ', '- [x] login-redirect. abc12 '), /error line \d+: done item "login-redirect" has no sha/],
      [edit('- [ ] trim-bundle.', '- [ ] dark-mode.'), /error line \d+: duplicate backlog ID "dark-mode" \(first on line \d+\)/],
    ];
    for (const [text, pattern] of cases) {
      p.write(text);
      const r = p.lint();
      assert.equal(r.status, 1, `${pattern}\n${r.stdout}`);
      assert.match(findings(r).join("\n"), pattern);
      assert.match(r.stdout, /night-lint: \d+ errors?, \d+ warnings?\n$/);
    }
  }));

test('WARNINGS (exit 0): header bullets, extra sections, IDs, tags, log lines', () =>
  withProject({}, (p) => {
    const cases = [
      [edit('- **The human:** away until 08:00\n', ''), /warn line 1: header: missing "- \*\*The human:\*\* \.\.\."/],
      [edit('- **Previous night:** night 3 (2 open items carried: dark-mode, empty-states)\n', ''), /warn line 1: header: missing "- \*\*Previous night:\*\*/],
      [edit('2026-10-17 · **Theme:** speed', '17 Oct · **Theme:** speed'), /warn line 2: header: Date is not YYYY-MM-DD/],
      [edit('2026-10-17 · **Theme:** speed', '2026-10-17'), /warn line 2: header: Date line has no "\*\*Theme:\*\*/],
      [edit('## With the user', '## Ideas\n\n## With the user'), /warn line \d+: extra section "## Ideas"/],
      [edit('- [ ] dark-mode.', '- [ ] G3.'), /warn line \d+: ID "G3" is not a plain-English slug .* factory tick refuses it/],
      [edit('- [ ] dark-mode.', '- [~] dark-mode.'), /warn line \d+: mark "\[~\]" is not "\[ \]" or "\[x\]"/],
      [edit('- [ ] dark-mode. **Add', '- [ ] dark-mode. 1a2b3c4 **Add'), /warn line \d+: open item "dark-mode" carries a sha/],
      [edit('[needs-user] **Trim', '[needs-user **Trim'), /warn line \d+: tag "\[" has no closing "\]"/],
      [edit('[needs-user] **Trim', 'needs-user **Trim'), /warn line \d+: tag "needs-user" is not in the template's tag form/],
      [edit('1a2b3c4 **Fix', '1a2b3c4 [blocked: x] **Fix'), /warn line \d+: a done item \(\[x\]\) carries a \[blocked: \.\.\.\] tag/],
      [edit('- [ ] trim-bundle.', 'Trim the bundle\n- [ ] trim-bundle.'), /warn line \d+: not an item line \(- \[ \] \{id\}\.\): Trim the bundle/],
      [edit('15:34 · login-redirect', '25:34 · login-redirect'), /warn line \d+: time "25:34" is not hh:mm/],
      [edit('15:34 · login-redirect', '15:34 · G3'), /warn line \d+: log ID "G3" is not a slug, a backlog ID or "TF <n>"/],
      [edit('16:24 · login-redirect · 1a2b3c4d', '16:24 · login-redirect · 1a2b3'), /warn line \d+: "1a2b3" looks like a short sha/],
      [edit('17:02 · empty-states · blocked ·', '17:02 · empty-states · Opus: it was a long night and nothing ·'), /warn line \d+: third field "Opus: it was a long night and " is neither a sha nor a short status word/],
      [edit('17:04 · lesson', '17:04 lesson'), /warn line \d+: not a log line \(hh:mm · <id> · <sha\|status> · <note>\) and not STOP or FINAL: 17:04 lesson/],
      [edit('\nSTOP\n', '\nFINAL (night 4) · second\n'), /warn line \d+: a second FINAL line/],
      [edit('FINAL (night 4)', 'FINAL (night 9)'), /warn line \d+: FINAL says night 9, the title says night 4/],
      [edit('FINAL (night 4) ·', 'FINAL night 4 ·'), /warn line \d+: FINAL line should read/],
    ];
    for (const [text, pattern] of cases) {
      p.write(text);
      const r = p.lint();
      assert.equal(r.status, 0, `${pattern}\n${r.stdout}`);
      assert.match(findings(r).join("\n"), pattern);
      assert.match(r.stdout, / 0 errors?, [1-9]\d* warnings?\n$/, `${pattern}\n${r.stdout}`);
    }
  }));

test('log notes may contain " · "; free log IDs are fine; STOP and one FINAL line are allowed; comments are ignored', () =>
  withProject({}, (p) => {
    p.write(
      edit('STOP\n', 'STOP\n<!--\nmulti-line comment 99:99 not a log line\n-->\n') +
        '09:00 · some-free-slug · running · a · b · c\n09:01 · plan · - · -\n',
    );
    const r = p.lint();
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(findings(r), []);
  }));

test('[loop] item_ids = "any" allows letter-number codes', () =>
  withProject({ slugs: false }, (p) => {
    p.write(edit('login-redirect', 'G3').replace('15:34 · G3', '15:34 · G3').replace(/dark-mode/g, 'F1'));
    const r = p.lint();
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(findings(r), []);
  }));

test('item_line and log_line come from [project]', () =>
  withProject({
    toml: (t) => t.replace('item_line     = "- [ ] {id}."', 'item_line     = "* [ ] {id}:"').replace('log_line      = "{hhmm} · {id} · {sha} · {note}"', 'log_line      = "{hhmm} | {id} | {sha} | {note}"'),
    text: `# example-app factory: night 4
- **Date:** 2026-10-17 · **Theme:** t
- **Branch target:** a
- **The human:** b
- **Rules:** c
- **Previous night:** none

## Backlog
* [x] login-redirect: 1a2b3c4 **Fix**
* [ ] dark-mode: **Dark**
- [ ] not-mine. a dash line is prose here

## With the user

## Needs the phone

## Log
09:00 | login-redirect | 1a2b3c4 | fixed | with a bar
09:01 · login-redirect · 1a2b3c4 · wrong separator
`,
  }, (p) => {
    const r = p.lint();
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(findings(r), [
      'warn line 11: not an item line (* [ ] {id}:): - [ ] not-mine. a dash line is prose here',
      'warn line 19: not a log line (hh:mm | <id> | <sha|status> | <note>) and not STOP or FINAL: 09:01 · login-redirect · 1a2b3c4 · wrong separator',
    ]);
  }));

test('findings are sorted errors first; --limit prints the first K and counts the rest', () =>
  withProject({}, (p) => {
    p.write(edit('## Needs the phone\n- Install beta 12.\n\n', '').replace('- **Rules:**', '- **Rule:**').replace('- [ ] dark-mode.', '- [ ] G3.'));
    let r = p.lint();
    assert.deepEqual(findings(r).map((l) => l.split(' ')[0]), ['error', 'warn', 'warn']);
    r = p.lint(['--night', '4', '--limit', '2']);
    assert.equal(findings(r).length, 2);
    assert.match(r.stdout, /\n {2}\.\.\. 1 more \(factory night-lint --file .*night-4\.md\)\nnight-lint: 1 error, 2 warnings\n$/);
  }));

test('it never writes: the file is byte-identical and untouched after a lint, errors or not', () =>
  withProject({}, (p) => {
    const bad = edit('# example-app factory: night 4', '# oops').replace('## Log', '## Extras');
    p.write(bad);
    const before = statSync(p.file);
    for (const args of [['--night', '4'], ['--file', p.file, '--quiet'], ['--night', '4', '--limit', '1']]) p.lint(args);
    assert.equal(readFileSync(p.file, 'utf8'), bad);
    assert.equal(statSync(p.file).mtimeMs, before.mtimeMs);
  }));

test('bad arguments and a missing file exit 2', () =>
  withProject({}, (p) => {
    let r = p.lint([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^usage: factory night-lint /);
    r = p.lint(['--night', 'x']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--night wants a night number/);
    r = p.lint(['--night', '9']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no such file: .*night-9\.md/);
    r = p.lint(['--file', p.file, '--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown arg: --bogus/);
    r = p.lint(['--file', p.file, '--limit', '0']);
    assert.equal(r.status, 2);
  }));

test('help lists night-lint', () => {
  const r = factory(['help'], { env: { FACTORY_TOML: fixture('valid.toml') } });
  assert.match(r.stdout, /^ {2}night-lint {4,}check a night file against the shape night-new writes/m);
});
