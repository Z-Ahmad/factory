import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanEnv, factory, scratch } from './helpers.mjs';
import { freePort, isUp, writeServer } from './procs.mjs';

// `factory dev switch`, and `dev up` / `restart` following origin/main or a switched ref.
// Nothing here touches the real machine: a temp git repo with a bare "origin", a dev worktree cloned from it, a stub `gh`
// first on PATH, and a tiny node server standing in for the stack ([dev] up appends to a marker file and serves one port).

const git = (dir, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

async function project({ dev = '' } = {}) {
  const s = scratch();
  const root = realpathSync(s.dir);
  const main = join(root, 'main');
  const state = join(root, 'state');
  mkdirSync(main);
  mkdirSync(state);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const wt = join(root, 'devwt');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '-b', 'main', seed);
  git(seed, 'remote', 'add', 'origin', origin);
  // commit(file, content, message, branch?): a commit on the seed clone's current branch, pushed to origin; returns its sha
  const commit = (file, content, message, branch = 'main') => {
    writeFileSync(join(seed, file), content);
    git(seed, 'add', file);
    git(seed, 'commit', '-m', message);
    git(seed, 'push', 'origin', `HEAD:${branch}`);
    return git(seed, 'rev-parse', 'HEAD');
  };
  const c1 = commit('app.txt', 'one\n', 'first');
  git(root, 'clone', origin, wt);
  const server = writeServer(root);
  const marker = join(root, 'marker.txt');
  const port = await freePort();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n# stub: gh pr view <n> --json ...\n[ "$1 $2" = "pr view" ] && [ -f "${root}/pr-$3.json" ] && exec cat "${root}/pr-$3.json"\necho "no pull request found for $3" >&2\nexit 1\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const fill = (t) => t.replaceAll('{server}', server).replaceAll('{marker}', marker).replaceAll('{port}', port).replaceAll('{wt}', wt);
  writeFileSync(
    join(root, 'factory.toml'),
    fill(`[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.0.0"

[project]
name          = "fixture"
main_checkout = "${main}"
state_dir     = "${state}"

[git]
worktrees_dir   = ".worktrees"
worktree_branch = "x/{name}-wt"
push_branch     = "nightly/{name}"

[[targets]]
name    = "app"
base    = "origin/main"
pr_base = "main"

[dev]
cwd = "{wt}"
wait_ports = [{port}]
timeout_s = 30
up = "echo started-at-$(git rev-parse --short HEAD) >> {marker}; exec node {server} {port}"
${dev}
`),
  );
  const env = { FACTORY_TOML: join(root, 'factory.toml'), FK_DEV_POLL_S: '1', FK_DEV_NET_TIMEOUT_S: '30', PATH: `${bin}:${process.env.PATH}` };
  const pids = [];
  const run = (args) => {
    const r = factory(args, { env, cwd: root });
    for (const m of r.stdout.matchAll(/\(pid (\d+)\)/g)) pids.push(Number(m[1]));
    return r;
  };
  const cleanup = () => {
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
    s.cleanup();
  };
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const short = (sha) => git(wt, 'rev-parse', '--short', sha);
  const head = () => git(wt, 'rev-parse', 'HEAD');
  const detached = () => spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: wt, env: cleanEnv() }).status !== 0;
  const refFile = () => read(join(state, 'dev.ref'));
  const pr = (n, headRefName, headRefOid) => writeFileSync(join(root, `pr-${n}.json`), JSON.stringify({ headRefName, headRefOid }));
  return { root, state, wt, port, marker, c1, commit, seed, run, cleanup, read, short, head, detached, refFile, pr, git };
}

async function withProject(opts, fn) {
  const t = await project(opts);
  try {
    await fn(t);
  } finally {
    t.cleanup();
  }
}

const PREP = 'prep = "echo prep-$(git rev-parse --short HEAD) >> {marker}"';

test('dev switch <branch>: detaches the worktree at origin/<branch>, preps, restarts, records the ref', () =>
  withProject({ dev: PREP }, async (t) => {
    const f1 = t.commit('feat.txt', 'f\n', 'feature work', 'feat');
    const r = t.run(['dev', 'switch', 'feat']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), f1);
    assert.ok(t.detached());
    assert.match(r.stdout, new RegExp(`factory-dev-switch: feat -> ${t.short(f1)} feature work`));
    assert.match(r.stdout, new RegExp(`factory-dev: on feat at ${t.short(f1)} feature work`));
    // prep ran in the worktree after the move, before the stack started
    assert.equal(t.read(t.marker), `prep-${t.short(f1)}\nstarted-at-${t.short(f1)}\n`);
    assert.equal(await isUp(t.port), true);
    const file = t.refFile();
    assert.match(file, new RegExp(`^ref=feat\\nsha=${f1}\\ntime=\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z\\n$`));
  }));

test('dev switch <pr>: 123 and #123 resolve through gh to the PR head, even one that is on no branch of origin', () =>
  withProject({ dev: PREP }, async (t) => {
    const f1 = t.commit('feat.txt', 'f\n', 'feature work', 'feat');
    t.pr(7, 'feat', f1);
    let r = t.run(['dev', 'switch', '#7', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), f1);
    assert.match(t.refFile(), /^ref=#7\n/);

    // a fork's PR: headRefName is not on origin, only refs/pull/9/head is
    t.git(t.seed, 'checkout', '-q', '-b', 'fork-work');
    writeFileSync(join(t.seed, 'fork.txt'), 'x\n');
    t.git(t.seed, 'add', 'fork.txt');
    t.git(t.seed, 'commit', '-m', 'from a fork');
    const f2 = t.git(t.seed, 'rev-parse', 'HEAD');
    t.git(t.seed, 'push', 'origin', 'HEAD:refs/pull/9/head');
    t.pr(9, 'someone:fork-work', f2);
    r = t.run(['dev', 'switch', '9']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), f2);
    assert.match(t.refFile(), /^ref=9\n/);

    r = t.run(['dev', 'switch', '404']);
    assert.equal(r.status, 9);
    assert.match(r.stderr, /cannot read PR #404/);
    assert.equal(t.head(), f2);
  }));

test('dev switch refuses a worktree with uncommitted tracked changes; untracked build output is fine', () =>
  withProject({ dev: PREP }, async (t) => {
    const f1 = t.commit('feat.txt', 'f\n', 'feature work', 'feat');
    writeFileSync(join(t.wt, 'app.txt'), 'edited\n');
    let r = t.run(['dev', 'switch', 'feat']);
    assert.equal(r.status, 5);
    assert.match(r.stderr, /uncommitted tracked changes/);
    assert.equal(t.head(), t.c1);
    assert.equal(t.refFile(), '');
    assert.equal(t.read(t.marker), '');
    t.git(t.wt, 'checkout', '--', 'app.txt');
    writeFileSync(join(t.wt, 'dist.js'), 'build output\n');
    r = t.run(['dev', 'switch', 'feat']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), f1);
  }));

test('dev switch: an unknown branch exits 9, --dry-run changes nothing, a bad call exits 1', () =>
  withProject({ dev: PREP }, (t) => {
    t.commit('feat.txt', 'f\n', 'feature work', 'feat');
    let r = t.run(['dev', 'switch', 'nope']);
    assert.equal(r.status, 9);
    assert.match(r.stderr, /no branch origin\/nope/);
    r = t.run(['dev', 'switch', 'feat', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would switch .* to feat -> .* feature work, run prep/);
    assert.equal(t.head(), t.c1);
    assert.equal(t.refFile(), '');
    assert.equal(t.run(['dev', 'switch']).status, 1);
    assert.equal(t.run(['dev', 'switch', 'a', 'b']).status, 1);
    assert.equal(t.run(['dev', 'switch', 'feat', '--nope']).status, 1);
  }));

test('dev up while following main fast-forwards the worktree to origin/main, preps, then starts', () =>
  withProject({ dev: PREP }, async (t) => {
    const c2 = t.commit('app.txt', 'two\n', 'second');
    assert.equal(t.head(), t.c1);
    const r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), c2);
    assert.match(r.stdout, new RegExp(`factory-dev: following origin/main at ${t.short(c2)} second`));
    assert.equal(t.read(t.marker), `prep-${t.short(c2)}\nstarted-at-${t.short(c2)}\n`);
    assert.equal(t.refFile(), '');
  }));

test('dev up with the stack already up fetches and reports, but does not move the worktree under it', () =>
  withProject({ dev: PREP }, async (t) => {
    let r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    t.commit('app.txt', 'two\n', 'second');
    r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to start/);
    assert.match(r.stdout, /following origin\/main at .* first; 1 behind origin\/main; `factory dev restart` moves it/);
    assert.equal(t.head(), t.c1);
  }));

test('dev restart stays on a switched ref and pulls its newest commits; main moving does not matter', () =>
  withProject({ dev: PREP }, async (t) => {
    const f1 = t.commit('feat.txt', 'f\n', 'feature work', 'feat');
    let r = t.run(['dev', 'switch', 'feat', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), f1);
    const f2 = t.commit('feat.txt', 'f2\n', 'more feature work', 'feat');
    t.commit('app.txt', 'two\n', 'main moved');
    r = t.run(['dev', 'restart', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), f2);
    assert.match(r.stdout, new RegExp(`factory-dev: on feat at ${t.short(f2)} more feature work`));
    assert.match(t.refFile(), new RegExp(`^ref=feat\\nsha=${f2}\\n`));
    assert.equal(await isUp(t.port), true);
    // and with the stack down, plain `up` does the same
    const f3 = t.commit('feat.txt', 'f3\n', 'even more', 'feat');
    r = t.run(['dev', 'restart', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), f3);
  }));

test('dev switch main goes back to following origin/main', () =>
  withProject({ dev: PREP }, async (t) => {
    t.commit('feat.txt', 'f\n', 'feature work', 'feat');
    let r = t.run(['dev', 'switch', 'feat', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    const c2 = t.commit('app.txt', 'two\n', 'main moved');
    r = t.run(['dev', 'switch', 'main', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), c2);
    assert.match(r.stdout, /factory-dev: following origin\/main at /);
    assert.match(t.refFile(), /^ref=main\n/);
    // from here `up` follows main again
    const c3 = t.commit('app.txt', 'three\n', 'main moved again');
    r = t.run(['dev', 'restart', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), c3);
  }));

test('dev: [dev] follow names the branch followed instead of main', () =>
  withProject({ dev: `${PREP}\nfollow = "develop"` }, async (t) => {
    t.git(t.seed, 'checkout', '-q', '-b', 'develop');
    const d1 = t.commit('dev.txt', 'd\n', 'on develop', 'develop');
    t.commit('app.txt', 'two\n', 'main moved');
    const r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), d1);
    assert.match(r.stdout, /following origin\/develop/);
  }));

test('dev up with a failing prep exits 8 and does not start the stack', () =>
  withProject({ dev: 'prep = "echo no luck; exit 3"' }, async (t) => {
    t.commit('app.txt', 'two\n', 'second');
    const r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 8);
    assert.match(r.stderr, /no luck/);
    assert.match(r.stderr, /prep \(echo no luck; exit 3\) failed \(exit 3\)/);
    assert.equal(await isUp(t.port), false);
  }));

test('dev up with uncommitted tracked changes warns and starts what is checked out', () =>
  withProject({ dev: PREP }, async (t) => {
    t.commit('app.txt', 'two\n', 'second');
    writeFileSync(join(t.wt, 'app.txt'), 'edited\n');
    const r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /uncommitted tracked changes/);
    assert.match(r.stderr, /starting what is checked out/);
    assert.equal(t.head(), t.c1);
    assert.equal(t.read(t.marker), `started-at-${t.short(t.c1)}\n`);
  }));

test('dev up with no [dev] prep just moves and starts', () =>
  withProject({}, async (t) => {
    const c2 = t.commit('app.txt', 'two\n', 'second');
    const r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), c2);
    assert.equal(t.read(t.marker), `started-at-${t.short(c2)}\n`);
  }));

test('dev status prints the ref, sha and subject, and says plainly when following main and behind', () =>
  withProject({ dev: PREP }, async (t) => {
    let r = t.run(['dev', 'status']);
    assert.equal(r.status, 1); // ports down
    assert.equal(r.stdout, `ref: main (following origin/main) ${t.short(t.c1)} first\nbehind origin/main: 0\n:${t.port} down\n`);

    t.commit('app.txt', 'two\n', 'second');
    t.commit('app.txt', 'three\n', 'third');
    t.git(t.wt, 'fetch', 'origin');
    r = t.run(['dev', 'status']);
    assert.match(r.stdout, /^behind origin\/main: 2 commits; the stack is serving old code, run `factory dev restart`$/m);

    const f1 = t.commit('feat.txt', 'f\n', 'feature work', 'feat');
    r = t.run(['dev', 'switch', 'feat', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    r = t.run(['dev', 'status']);
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[0], `ref: feat (switched) ${t.short(f1)} feature work`);
    assert.match(lines[1], /^behind origin\/main: 0; `factory dev switch main` follows main again$/);
    assert.equal(lines[2], `:${t.port} up`);
  }));

test('dev: a dev cwd that is only a folder inside another checkout is never moved', () =>
  withProject({}, async (t) => {
    mkdirSync(join(t.wt, 'sub'));
    const sub = join(t.wt, 'sub');
    const toml = readFileSync(join(t.root, 'factory.toml'), 'utf8').replace(`cwd = "${t.wt}"`, `cwd = "${sub}"`);
    writeFileSync(join(t.root, 'factory.toml'), toml);
    t.commit('app.txt', 'two\n', 'second');
    const r = t.run(['dev', 'up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.head(), t.c1);
    assert.doesNotMatch(r.stdout, /factory-dev:/);
    assert.equal(t.run(['dev', 'status']).stdout, `:${t.port} up\n`);
  }));

test('config validate accepts [dev] prep and follow, and rejects other types', () =>
  withProject({ dev: 'prep = "node scripts/wt-prep.mjs"\nfollow = "main"' }, (t) => {
    const toml = join(t.root, 'factory.toml');
    const r = factory(['--file', toml, 'config', 'validate']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    writeFileSync(toml, readFileSync(toml, 'utf8').replace('follow = "main"', 'follow = 3'));
    const bad = factory(['--file', toml, 'config', 'validate']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /dev\.follow/);
  }));

test('lib/deadline.mjs, which bounds the git, gh and prep calls, kills at the deadline and passes the status through', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'lib', 'deadline.mjs'), '1', 'sleep', '30'], { encoding: 'utf8' });
  assert.equal(r.status, 124);
  const ok = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'lib', 'deadline.mjs'), '5', 'sh', '-c', 'echo hi; exit 3'], { encoding: 'utf8' });
  assert.equal(ok.status, 3);
  assert.equal(ok.stdout, 'hi\n');
});
