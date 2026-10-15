import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, factory, fixture, scratch } from './helpers.mjs';

const SRC = join(realpathSync(KIT), 'skill', 'factory-orchestrator');

// HOME points at a scratch dir, so nothing touches the real ~/.claude.
function home() {
  const s = scratch();
  const root = realpathSync(s.dir);
  const run = (args = [], env = {}) =>
    factory(['install-skill', ...args], {
      cwd: root,
      env: { FACTORY_TOML: fixture('valid.toml'), HOME: root, CLAUDE_SKILLS_DIR: '', ...env },
    });
  return { ...s, root, run, dst: join(root, '.claude', 'skills', 'factory-orchestrator') };
}

test('the kit ships the skill: SKILL.md with name and description frontmatter, and its references', () => {
  const md = readFileSync(join(SRC, 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: factory-orchestrator\ndescription: .+\n---\n/);
  assert.ok(md.split('\n').length < 250, 'SKILL.md stays under 250 lines');
  for (const ref of ['briefs.md', 'classifier.md', 'phone-triage.md', 'review.md']) {
    assert.ok(existsSync(join(SRC, 'references', ref)), ref);
    assert.match(md, new RegExp(`references/${ref.replace('.', '\\.')}`), `SKILL.md points at ${ref}`);
  }
});

test('install-skill links, is idempotent, relinks a stale link, and uninstalls', () => {
  const h = home();
  try {
    let r = h.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^linked: .*factory-orchestrator -> /);
    assert.ok(lstatSync(h.dst).isSymbolicLink());
    assert.equal(readlinkSync(h.dst), SRC);
    assert.ok(existsSync(join(h.dst, 'SKILL.md')));

    r = h.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ok: /);

    const other = join(h.root, 'old-kit', 'skill', 'factory-orchestrator');
    mkdirSync(other, { recursive: true });
    r = h.run(['--uninstall']);
    assert.match(r.stdout, /^removed: /);
    symlinkSync(other, h.dst);
    r = h.run(['--dry-run']);
    assert.match(r.stdout, /^would be relinked: .*\(was -> .*old-kit/);
    assert.equal(readlinkSync(h.dst), other, 'dry run changes nothing');
    r = h.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^relinked: .*\(was -> .*old-kit/);
    assert.equal(readlinkSync(h.dst), SRC);

    r = h.run(['--uninstall']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^removed: .*\(was -> /);
    assert.equal(existsSync(h.dst), false);
    assert.ok(existsSync(join(SRC, 'SKILL.md')), 'the kit copy is untouched');
    r = h.run(['--uninstall']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^nothing to remove/);
  } finally {
    h.cleanup();
  }
});

test('install-skill never touches a real directory in its place', () => {
  const h = home();
  try {
    mkdirSync(h.dst, { recursive: true });
    writeFileSync(join(h.dst, 'SKILL.md'), 'hand-written\n');
    let r = h.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a symlink; move it away first/);
    r = h.run(['--uninstall']);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(join(h.dst, 'SKILL.md'), 'utf8'), 'hand-written\n');
  } finally {
    h.cleanup();
  }
});

test('install-skill honours CLAUDE_SKILLS_DIR and rejects unknown args', () => {
  const h = home();
  try {
    const dir = join(h.root, 'elsewhere');
    let r = h.run([], { CLAUDE_SKILLS_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readlinkSync(join(dir, 'factory-orchestrator')), SRC);
    assert.equal(existsSync(h.dst), false);
    r = h.run(['--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: factory install-skill/);
  } finally {
    h.cleanup();
  }
});
