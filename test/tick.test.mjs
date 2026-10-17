import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, fixture, run, scratch } from './helpers.mjs';

const NIGHT = `# Night 3 (example-app)

## Backlog
- [x] A1. 1a2b3c4 Fix the login redirect
- [ ] B2. Add dark mode to settings
- [ ] C3. [blocked: waiting on design] Empty states
- [ ] D4. Trim the bundle

## Log
08:00 · A1 · 1a2b3c4 · shipped
`;

const BODY = `Night 3 checklist

- [x] A1. 1a2b3c4 Fix the login redirect
- [ ] B2. Add dark mode to settings
- [ ] C3. Empty states
`;

// A scratch project: factory.toml (from the synthetic valid.toml) with its state_dir in the scratch
// directory, night-3.md, a PR body, and a fake `gh` that logs its arguments and prints $GH_BODY.
function project({ github = 'acme/example-app', extraToml = (t) => t } = {}) {
  const s = scratch();
  const root = realpathSync(s.dir);
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  const main = join(root, 'main');
  mkdirSync(main);
  let toml = readFileSync(fixture('valid.toml'), 'utf8')
    .replace('~/example-factory', state)
    .replace('/tmp/example', main);
  if (github) toml = toml.replace('[git]\n', `[git]\ngithub = "${github}"\n`);
  toml = extraToml(toml);
  const tomlPath = join(root, 'factory.toml');
  writeFileSync(tomlPath, toml);
  const night = join(state, 'night-3.md');
  writeFileSync(night, NIGHT);
  const bodyFile = join(root, 'body.md');
  writeFileSync(bodyFile, BODY);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const ghLog = join(root, 'gh.log');
  const editedBody = join(root, 'edited-body.md');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr view") cat "$GH_BODY" ;;
  "pr edit") while [[ $# -gt 0 ]]; do [[ "$1" == --body-file ]] && cp "$2" "$GH_EDITED"; shift; done ;;
esac
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);

  const env = {
    FACTORY_TOML: tomlPath,
    FK_NOW_HHMM: '09:05',
    GH_LOG: ghLog,
    GH_BODY: bodyFile,
    GH_EDITED: editedBody,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const tick = (args, opts = {}) => factory(['tick', ...args], { env, cwd: root, ...opts });
  const read = (p) => readFileSync(p, 'utf8');
  return { ...s, root, state, main, night, bodyFile, ghLog, editedBody, env, tick, read, tomlPath };
}

const withProject = (opts, fn) => {
  const t = project(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
};

test('ticks an open item, records the sha, appends the log line', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 'abc1234', '--log', 'dark mode done']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `ticked B2 in ${t.night}\nlogged to ${t.night}\n`);
    assert.equal(
      t.read(t.night),
      NIGHT.replace('- [ ] B2. Add', '- [x] B2. abc1234 Add') + '09:05 · B2 · abc1234 · dark mode done\n',
    );
  }));

test('--file overrides the night file path', () =>
  withProject({}, (t) => {
    const other = join(t.root, 'other.md');
    writeFileSync(other, NIGHT);
    const r = t.tick(['--file', other, '--item', 'D4', '--sha', 'f00', '--log', 'trimmed']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(t.read(other), /^- \[x\] D4\. f00 Trim the bundle$/m);
    assert.equal(t.read(t.night), NIGHT);
  }));

test('--blocked keeps the box open and annotates the line', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'D4', '--sha', '-', '--log', 'stuck', '--blocked', 'needs a device']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      t.read(t.night),
      NIGHT.replace('- [ ] D4. Trim', '- [ ] D4. [blocked: needs a device] Trim') + '09:05 · D4 · - · stuck\n',
    );
  }));

test('an item with no open line: warns, still logs, exits 0', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'NOPE', '--sha', '0', '--log', 'x']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `logged to ${t.night}\n`);
    assert.ok(r.stderr.startsWith(`warning: no '- [ ] NOPE.' line in ${t.night} (log line still appended)\n`), r.stderr); // then the lint, see below
    assert.equal(t.read(t.night), NIGHT + '09:05 · NOPE · 0 · x\n');
  }));

// A night file in the shape night-new writes (the project is "example-app"), so the lint has nothing to say.
const CLEAN_NIGHT = `# example-app factory: night 3
- **Date:** 2026-10-17 · **Theme:** a test
- **Branch target:** \`factory/night-3\` → \`dev\` (app)
- **The human:** asleep
- **Rules:** load the factory-orchestrator skill. This file holds state, not rules.
- **Previous night:** none

## Backlog
- [ ] dark-mode. **Add dark mode to settings** · IDEATE

## With the user

## Needs the phone

## Log
`;

test('lint: tick prints what night-lint finds on stderr, and its own exit code and stdout are unchanged', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 'abc1234', '--log', 'dark mode done']);
    assert.equal(r.status, 0, r.stderr); // the fixture night file has lint ERRORS; tick still succeeds
    assert.equal(r.stdout, `ticked B2 in ${t.night}\nlogged to ${t.night}\n`);
    assert.match(r.stderr, new RegExp(`^night-lint: ${t.night.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
    assert.match(r.stderr, /\n {2}error {2}missing section "## With the user"\n/);
    assert.match(r.stderr, /\n {2}warn {3}line 1: header: missing "- \*\*Date:\*\*/);
    assert.match(r.stderr, /\nnight-lint: 3 errors, 5 warnings\n$/);
    // the file is only ever changed by tick itself
    assert.equal(t.read(t.night), NIGHT.replace('- [ ] B2. Add', '- [x] B2. abc1234 Add') + '09:05 · B2 · abc1234 · dark mode done\n');
  }));

test('lint: a clean night file makes tick print nothing extra; a stray line is only a warning', () =>
  withProject({}, (t) => {
    writeFileSync(t.night, CLEAN_NIGHT);
    let r = t.tick(['--night', '3', '--item', 'dark-mode', '--sha', 'abc1234', '--log', 'done']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, ''); // --quiet: silent when there is nothing to report
    assert.match(t.read(t.night), /^- \[x\] dark-mode\. abc1234 \*\*Add dark mode/m);

    writeFileSync(t.night, t.read(t.night).replace('## With the user', 'a stray sentence\n\n## With the user'));
    r = t.tick(['--night', '3', '--item', 'dark-mode', '--sha', 'abc1234', '--log', 'again']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /warn {3}line \d+: not an item line \(- \[ \] \{id\}\.\): a stray sentence/);
    assert.match(r.stderr, /night-lint: 0 errors, 1 warning\n$/);
  }));

test('lint: tick prints at most 12 findings and counts the rest', () =>
  withProject({}, (t) => {
    const many = Array.from({ length: 20 }, (_, i) => `- [ ] item-${i}. Title`).join('\n');
    const prose = Array.from({ length: 16 }, (_, i) => `prose ${i}`).join('\n'); // each a warning: not an item line
    writeFileSync(t.night, CLEAN_NIGHT.replace('- [ ] dark-mode. **Add dark mode to settings** · IDEATE', `${many}\n${prose}`));
    const r = t.tick(['--night', '3', '--item', 'item-1', '--sha', 'abc1234', '--log', 'x']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.split('\n').filter((l) => /^ {2}(warn|error)/.test(l)).length, 12);
    assert.match(r.stderr, /\n {2}\.\.\. 4 more \(factory night-lint --file /);
    assert.match(r.stderr, /night-lint: 0 errors, 16 warnings\n$/);
  }));

test('an already ticked item is left alone (and warns)', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'A1', '--sha', '9999999', '--log', 'again']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no '- \[ \] A1\.' line/);
    assert.equal(t.read(t.night), NIGHT + '09:05 · A1 · 9999999 · again\n');
  }));

test('special characters in the log line and sha stay literal', () =>
  withProject({}, (t) => {
    const log = `a · b → "q" 's' $HOME $(x) \`y\` \\n \\\\ & \\1 {id} {n} 100% %s *`;
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 'a&b\\1', '--log', log]);
    assert.equal(r.status, 0, r.stderr);
    const out = t.read(t.night);
    assert.ok(out.endsWith(`09:05 · B2 · a&b\\1 · ${log}\n`), out);
    assert.match(out, /^- \[x\] B2\. a&b\\1 Add dark mode/m);
  }));

test('item_line and log_line come from factory.toml; unknown {words} stay as written', () =>
  withProject(
    {
      extraToml: (t) =>
        t
          .replace('item_line     = "- [ ] {id}."', 'item_line     = "* [ ] #{id} -"')
          .replace('log_line      = "{hhmm} · {id} · {sha} · {note}"', 'log_line      = "[{hhmm}] {id}/{sha}: {note} {name}"'),
    },
    (t) => {
      writeFileSync(t.night, '## Backlog\n* [ ] #X1 - first\n* [ ] #X2 - second\n');
      const r = t.tick(['--night', '3', '--item', 'X2', '--sha', 's2', '--log', 'ok']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(t.read(t.night), '## Backlog\n* [ ] #X1 - first\n* [x] #X2 - s2 second\n[09:05] X2/s2: ok {name}\n');
    },
  ));

test('without FK_NOW_HHMM the log line carries the current HH:MM', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 's', '--log', 'now'], {
      env: { ...process.env, ...t.env, FK_NOW_HHMM: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(t.read(t.night), /\n\d\d:\d\d · B2 · s · now\n$/);
  }));

test('argument errors exit 1 with a message', () =>
  withProject({}, (t) => {
    let r = t.tick(['--bogus']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'unknown arg: --bogus\n');
    r = t.tick(['--night', '3', '--item', 'B2']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^usage: factory tick /);
    r = t.tick(['--item', 'B2', '--sha', 's', '--log', 'x']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, '--night or --file required\n');
    r = t.tick(['--night', '9', '--item', 'B2', '--sha', 's', '--log', 'x']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `no such file: ${join(t.state, 'night-9.md')}\n`);
    r = t.tick(['--night', '3', '--item', 'B2', '--sha', 's', '--log']);
    assert.equal(r.status, 1);
    assert.equal(t.read(t.night), NIGHT);
  }));

test('PR dry run: ticks the line, appends the sha, prints the diff and writes nothing', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 'abc1234', '--log', 'x', '--pr', '7', '--pr-body-file', t.bodyFile, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout.split('\n').slice(2).join('\n'),
      [
        '--- PR #7 body diff (dry run, nothing written) ---',
        '4c4',
        '< - [ ] B2. Add dark mode to settings',
        '---',
        '> - [x] B2. Add dark mode to settings — abc1234',
        '',
      ].join('\n'),
    );
    assert.equal(t.read(t.bodyFile), BODY);
  }));

test('PR dry run, blocked: the box stays open and the line gets the reason', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'C3', '--sha', '-', '--log', 'x', '--blocked', 'no access', '--pr', '7', '--pr-body-file', t.bodyFile, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^> - \[ \] C3\. Empty states — blocked: no access$/m);
    assert.doesNotMatch(r.stdout, /\[x\] C3/);
  }));

test('PR dry run: a missing line is added; an already ticked one is left', () =>
  withProject({}, (t) => {
    let r = t.tick(['--night', '3', '--item', 'NOPE', '--sha', 's9', '--log', 'x', '--pr', '7', '--pr-body-file', t.bodyFile, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^> $/m);
    assert.match(r.stdout, /^> - \[x\] NOPE\. — s9$/m);
    r = t.tick(['--night', '3', '--item', 'A1', '--sha', 's9', '--log', 'x', '--pr', '7', '--pr-body-file', t.bodyFile, '--dry-run']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /PR line for A1 already ticked; leaving it/);
    assert.ok(r.stdout.endsWith('--- PR #7 body diff (dry run, nothing written) ---\n'), r.stdout);
  }));

test('--pr reads and edits the PR with gh -R <[git] github>, from a directory that is not a repo', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 'abc1234', '--log', 'x', '--pr', '7']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split('\n').at(-2), 'updated PR #7 body');
    const calls = t.read(t.ghLog).trim().split('\n');
    assert.equal(calls[0], 'pr view 7 -R acme/example-app --json body -q .body');
    assert.match(calls[1], /^pr edit 7 -R acme\/example-app --body-file /);
    assert.equal(t.read(t.editedBody), BODY.replace('- [ ] B2. Add dark mode to settings', '- [x] B2. Add dark mode to settings — abc1234'));
  }));

test('--pr --dry-run reads through gh -R and does not edit', () =>
  withProject({}, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 'abc1234', '--log', 'x', '--pr', '7', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /body diff \(dry run, nothing written\)/);
    assert.equal(t.read(t.ghLog), 'pr view 7 -R acme/example-app --json body -q .body\n');
  }));

for (const [name, url, repo] of [
  ['ssh', 'git@github.com:acme/example-app.git', 'acme/example-app'],
  ['https', 'https://github.com/acme/example-app.git', 'acme/example-app'],
  ['https without .git', 'https://github.com/acme/other-app', 'acme/other-app'],
]) {
  test(`without [git] github, the repo comes from main_checkout's origin remote (${name})`, () =>
    withProject({ github: null }, (t) => {
      assert.equal(run('git', ['init', '-q', t.main]).status, 0);
      assert.equal(run('git', ['-C', t.main, 'remote', 'add', 'origin', url]).status, 0);
      const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 's', '--log', 'x', '--pr', '7', '--dry-run']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(t.read(t.ghLog), `pr view 7 -R ${repo} --json body -q .body\n`);
    }));
}

test('no [git] github and no origin remote: a clear error, nothing sent to gh', () =>
  withProject({ github: null }, (t) => {
    assert.equal(run('git', ['init', '-q', t.main]).status, 0);
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 's', '--log', 'x', '--pr', '7', '--dry-run']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /factory: cannot find the GitHub repo: no origin remote in .*main/);
    assert.match(r.stderr, /set \[git\] github/);
    assert.throws(() => readFileSync(t.ghLog));
  }));

test('--pr-body-file never needs the repo', () =>
  withProject({ github: null }, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 's', '--log', 'x', '--pr', '7', '--pr-body-file', t.bodyFile, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
  }));

test('a toml with [git] github passes factory config validate', () =>
  withProject({}, (t) => {
    const r = factory(['config', 'get', 'git.github'], { env: t.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'acme/example-app\n');
  }));

test('item_line without "[ ]" or {id} is rejected', () =>
  withProject({ extraToml: (x) => x.replace('item_line     = "- [ ] {id}."', 'item_line     = "- {id}."') }, (t) => {
    const r = t.tick(['--night', '3', '--item', 'B2', '--sha', 's', '--log', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /item_line must contain "\[ \]" and \{id\}/);
    assert.equal(t.read(t.night), NIGHT);
  }));

test('[loop] item_ids = "slug" (the default) refuses letter-number codes and ticks slugs', () =>
  withProject({ extraToml: (x) => x.replace('item_ids = "any"\n', '') }, (t) => {
    for (const code of ['B2', 'G3', 'H-web', 'footer', 'Lifetime-Globe', 'lifetime_globe']) {
      const r = t.tick(['--night', '3', '--item', code, '--sha', 's', '--log', 'x']);
      assert.equal(r.status, 1, `${code} should be refused`);
      assert.match(r.stderr, new RegExp(`item ID "${code}" is not a plain-English slug`));
    }
    assert.equal(t.read(t.night), NIGHT);
    writeFileSync(t.night, NIGHT.replace('- [ ] B2.', '- [ ] dark-mode.'));
    const ok = t.tick(['--night', '3', '--item', 'dark-mode', '--sha', 'abc1234', '--log', 'shipped']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(t.read(t.night), /- \[x\] dark-mode\. abc1234/);
  }));
