import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, run, scratch } from './helpers.mjs';

// proof/ios/app-fresh.mjs: which build a proof installs, and whether the source moved on since.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const ago = (p, hours) => { const d = new Date(Date.now() - hours * 3600e3); utimesSync(p, d, d); };

function project() {
  const s = scratch();
  const root = join(s.dir, 'repo'), dd = join(s.dir, 'dd'), app = join(dd, 'Build', 'App.app');
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { env: GIT_ENV, encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'ios'), { recursive: true });
  mkdirSync(join(root, 'web'), { recursive: true });
  mkdirSync(app, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'ios', 'View.swift'), 'a');
  writeFileSync(join(root, 'web', 'page.ts'), 'a');
  git('add', '.');
  const fiveHoursAgo = new Date(Date.now() - 5 * 3600e3).toISOString();
  execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one'], {
    env: { ...GIT_ENV, GIT_AUTHOR_DATE: fiveHoursAgo, GIT_COMMITTER_DATE: fiveHoursAgo },
  });
  for (const f of ['App', 'Info.plist']) writeFileSync(join(app, f), 'bin');
  const fresh = (args = [], env = {}) =>
    run(process.execPath, [join(KIT, 'proof', 'ios', 'app-fresh.mjs'), '--app', app, '--dd', dd, '--root', root, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  const appAge = (hours) => { for (const f of ['App', 'Info.plist']) ago(join(app, f), hours); };
  return { ...s, root, dd, app, git, fresh, appAge };
}

test('app-fresh: a build newer than the source prints its line and no warning', () => {
  const t = project();
  try {
    const r = t.fresh();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^app: .*App\.app built \d{4}-\d\d-\d\d \d\d:\d\d from unknown \(built outside --build\)\n$/);
    assert.equal(r.stderr, '');
  } finally { t.cleanup(); }
});

test('app-fresh: --built stamps the sha; a later commit or an uncommitted edit makes the app stale', () => {
  const t = project();
  try {
    const head = t.git('rev-parse', '--short=10', 'HEAD');
    let r = t.fresh(['--built']);
    assert.match(r.stdout, new RegExp(`from ${head}\\n$`));
    t.appAge(2);
    writeFileSync(join(t.root, 'ios', 'View.swift'), 'b'); // uncommitted, written now
    r = t.fresh();
    assert.equal(r.status, 0);
    assert.match(r.stderr, /^WARNING: the installed app is older than the source \(uncommitted ios\/View\.swift at .*\)\. Pass --build/);
    t.git('-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'two');
    r = t.fresh();
    assert.match(r.stderr, /commit \w+ at .*; built from \w+, HEAD is \w+/);
    r = t.fresh([], { FK_PROOF_IOS_STALE_APP: 'refuse' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /^REFUSED: /);
  } finally { t.cleanup(); }
});

test('app-fresh: [proof.ios] sources limits which changes count', () => {
  const t = project();
  try {
    t.appAge(2);
    writeFileSync(join(t.root, 'web', 'page.ts'), 'b');
    assert.match(t.fresh().stderr, /uncommitted web\/page\.ts/);
    const r = t.fresh([], { FK_PROOF_IOS_SOURCES: 'ios' });
    assert.equal(r.stderr, '');
  } finally { t.cleanup(); }
});

test('app-fresh: derived data inside the checkout is not dirt, a staged new file is, and a huge status still reads', () => {
  const t = project();
  try {
    // the dd inside the tree, untracked and big; the app inside it
    const dd = join(t.root, 'app'), app = join(dd, 'Build', 'App.app');
    mkdirSync(app, { recursive: true });
    for (const f of ['App', 'Info.plist']) writeFileSync(join(app, f), 'bin');
    const fresh = (args = []) => run(process.execPath, [join(KIT, 'proof', 'ios', 'app-fresh.mjs'), '--app', app, '--dd', dd, '--root', t.root, ...args], { encoding: 'utf8' });
    mkdirSync(join(dd, 'Index.noindex'));
    for (let i = 0; i < 400; i++) writeFileSync(join(dd, 'Index.noindex', `record-${i}.idx`), 'x');
    let r = fresh(['--built']);
    assert.equal(JSON.parse(readFileSync(join(dd, 'factory-build.json'), 'utf8')).dirty, false, r.stderr);
    // more than 1 MB of `git status` output outside the dd: still read, so the staged file below is seen
    const junk = join(t.root, 'scratch-with-a-rather-long-directory-name-for-status-output');
    mkdirSync(junk);
    for (let i = 0; i < 16000; i++) writeFileSync(join(junk, `untracked-file-number-${String(i).padStart(6, '0')}.tmp`), '');
    writeFileSync(join(t.root, 'ios', 'New.swift'), 'new');
    t.git('add', 'ios/New.swift');
    r = fresh(['--built']);
    assert.equal(r.stderr, '');
    assert.equal(JSON.parse(readFileSync(join(dd, 'factory-build.json'), 'utf8')).dirty, true);
    assert.match(r.stdout, /from \w+\+dirty\n$/);
  } finally { t.cleanup(); }
});

test('app-fresh: when git cannot read the tree, the stamp says dirty unknown and a warning says so', () => {
  const t = project();
  try {
    const notRepo = join(t.dir, 'plain');
    mkdirSync(notRepo);
    const r = run(process.execPath, [join(KIT, 'proof', 'ios', 'app-fresh.mjs'), '--app', t.app, '--dd', t.dd, '--root', notRepo, '--built'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /WARNING: could not read `git status`/);
    assert.equal(JSON.parse(readFileSync(join(t.dd, 'factory-build.json'), 'utf8')).dirty, null);
    assert.match(r.stdout, /\(dirty unknown\)\n$/);
  } finally { t.cleanup(); }
});
