import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';
import { alive, freePort, isUp, startServer, waitFor } from './procs.mjs';

const SECRET_VALUE = 'zz-not-a-real-secret-9f3';

// The synthetic tree plus: [dev] ports, [seed], a secret file with a checked key, a night file,
// a fake `gh`, an upstream night branch one commit ahead of the phone worktree, and (with `clean`)
// none of the leftover dirt the base tree has.
async function night({ clean = false, secret = `API_TOKEN = ${SECRET_VALUE}\n`, prAnswer = '[{"number":7,"state":"OPEN","isDraft":true}]' } = {}) {
  const [a, b, c] = [await freePort(), await freePort(), await freePort()];
  const t = tree({
    gitExtra: 'phone_worktree     = "phone"',
    extraToml: (p) => `
[worktree]
cache_symlinks = ["cache-link"]

[never_touch]
never_run_in_worktree = ["tools/bootstrap.sh"]
secret_nonempty = { "cfg/secrets.cfg" = "API_TOKEN" }

[dev]
wait_ports = [${a}, ${b}]
all_ports  = [${a}, ${b}, ${c}]

[seed]
restore = "echo seeded >> ${p('seed.log')}; echo Restore done."
`,
  });
  mkdirSync(join(t.main, 'cfg'));
  if (secret !== null) writeFileSync(join(t.main, 'cfg', 'secrets.cfg'), secret);
  writeFileSync(join(t.state ?? t.p('state'), 'night-1.md'), '# Night 1\n\n## Log\n');
  // an upstream night branch one commit past what the worktrees were cut from
  writeFileSync(join(t.main, 'next.txt'), 'next');
  t.git(t.main, 'add', 'next.txt');
  t.git(t.main, 'commit', '-q', '-m', 'next');
  t.git(t.main, 'push', '-q', 'origin', 'trunk:refs/heads/nightly/night-1');
  t.git(t.main, 'fetch', '-q', 'origin');
  if (clean) {
    rmSync(join(t.wt, 'agent-dirty', 'stray.txt'));
    rmSync(join(t.wt, 'night-1', 'build'), { recursive: true });
    rmSync(join(t.wt, 'phone', 'build'), { recursive: true });
  }
  writeFileSync(
    join(t.p('bin'), 'gh'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${t.p('gh.log')}'
if [[ "$1 $2" == "pr list" ]]; then echo '${prAnswer}'; else exit 1; fi
`,
  );
  chmodSync(join(t.p('bin'), 'gh'), 0o755);
  const env = { ...t.env, FK_NOW_HHMM: '03:21' };
  const end = (args = []) => factory(['end-night', '--night', '1', ...args], { env, cwd: t.main });
  const kids = [];
  const up = async (...ports) => { for (const p of ports) kids.push(await startServer(t.root, p)); };
  const done = () => { for (const k of kids) k.kill('SIGKILL'); t.cleanup(); };
  return { ...t, ports: { a, b, c }, end, up, kids, done, seedLog: t.p('seed.log'), nightFile: t.p('state', 'night-1.md'), read: (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '') };
}

async function withNight(opts, fn) {
  const t = await night(opts);
  try {
    await fn(t);
  } finally {
    t.done();
  }
}

test('dry run: every step reports, nothing is done, dirty worktrees give exit 3', () =>
  withNight({}, async (t) => {
    await t.up(t.ports.a, t.ports.b);
    const phoneBefore = t.git(join(t.wt, 'phone'), 'rev-parse', 'HEAD');
    const r = t.end();
    assert.equal(r.status, 3, r.stderr);
    const out = t.clean(r.stdout);
    assert.match(out, /^factory-end-night: dry run \(night 1; pass --apply to act\)\n/);
    for (const h of ['1 disk', '2 simulators', '3 emulator seed', '4 secrets', '5 worktrees', '6 branch / PR', '7 log']) assert.match(out, new RegExp(`== ${h} ==`));
    assert.match(out, /disk: 67 GB free on \//);
    // sims: cleanup's three, plus the one [sim] sweep match that is neither ephemeral nor protected
    assert.match(out, /sims: 3 via factory-cleanup \+ 1 other box-\* = 4 would be removed \(kept .*box-test-kit/);
    assert.match(out, /^ {2}box-test-abc \(/m);
    assert.match(out, /would run: echo seeded .*seed\.log; echo Restore done\. \(from <root>\/main\)/);
    assert.match(out, /seed: would seed/);
    assert.match(out, /token: ok/);
    assert.match(out, /phone {2}branch phone-b {2}HEAD \w{8} {2}DIRTY {2}ahead-of-origin\/nightly\/night-1: 0\n.*\n {4}phone not fast-forwarded \(dirty\)/);
    assert.match(out, /agent-dirty .* DIRTY/);
    assert.match(out, /\?\? stray\.txt/);
    assert.match(out, /dirty worktrees: agent-dirty,night-1,phone\n/);
    assert.match(out, /origin\/nightly\/night-1 tip: \w{8} {2}next/);
    assert.match(out, /pr: PR #7 OPEN \(draft\)/);
    assert.match(out, /would append to <root>\/state\/night-1\.md:\n {2}03:21 · end-night · \w{8} · — · disk 67 GB free; sims removed 4; seed would seed; token ok; dirty worktrees: agent-dirty,night-1,phone; PR #7 OPEN \(draft\)/);
    assert.match(out, /factory-end-night: done \(exit 3: token empty or dirty worktree\)\n$/);
    assert.ok(!r.stdout.includes(SECRET_VALUE));
    // nothing happened
    assert.deepEqual(t.xcrunCalls(), []);
    assert.equal(t.read(t.seedLog), '');
    assert.equal(t.git(join(t.wt, 'phone'), 'rev-parse', 'HEAD'), phoneBefore);
    assert.equal(t.read(t.nightFile), '# Night 1\n\n## Log\n');
    assert.deepEqual(t.names('tmp'), ['dd-fresh', 'dd-old1', 'dd-sim', 'ee1-new', 'ee1-old', 'sg-abc', 'theme-x', 'tmp.zzz', 'unrelated']);
  }));

test('clean tree, secret set: exit 0', () =>
  withNight({ clean: true }, async (t) => {
    await t.up(t.ports.a, t.ports.b);
    const r = t.end();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /dirty worktrees: none/);
    assert.match(r.stdout, /factory-end-night: done \(exit 0\)\n$/);
  }));

test('--apply: removes the sims, seeds, fast-forwards phone, logs one line; exits 0 on a clean tree', () =>
  withNight({ clean: true }, async (t) => {
    await t.up(t.ports.a, t.ports.b);
    const upstream = t.git(t.main, 'rev-parse', 'origin/nightly/night-1');
    // with the old tip gone, clean worktrees sitting on its commit are behind the night branch: "safe to remove"
    t.git(t.main, 'push', '-q', 'origin', '--delete', 'nightly/up');
    t.git(t.main, 'fetch', '-q', '--prune', 'origin');
    const r = t.end(['--apply']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = t.clean(r.stdout);
    assert.match(out, /^factory-end-night: APPLY \(night 1\)\n/);
    assert.match(out, /sims: 3 via factory-cleanup \+ 1 other box-\* = 4 removed/);
    assert.deepEqual(t.xcrunCalls(), [
      'simctl shutdown 11111111-0000-0000-0000-000000000002',
      'simctl delete 11111111-0000-0000-0000-000000000002',
      'simctl delete 11111111-0000-0000-0000-000000000003',
      'simctl delete 11111111-0000-0000-0000-000000000004',
      'simctl delete 11111111-0000-0000-0000-000000000005',
    ]);
    assert.equal(t.read(t.seedLog), 'seeded\n');
    assert.match(out, /last line: Restore done\./);
    assert.match(out, /seed: ok/);
    assert.match(out, /phone fast-forwarded to \w{8}/);
    assert.match(out, /safe to remove: git worktree remove <root>\/main\/\.worktrees\/agent-merged\n/);
    assert.ok(!/safe to remove: .*agent-ahead/.test(out)); // it has a commit of its own
    assert.equal(t.git(join(t.wt, 'phone'), 'rev-parse', 'HEAD'), upstream);
    assert.equal(t.read(t.nightFile), `# Night 1\n\n## Log\n03:21 · end-night · ${upstream.slice(0, 8)} · — · disk 67 GB free; sims removed 4; seed ok; token ok; dirty worktrees: none; PR #7 OPEN (draft)\n`);
    assert.match(out, /appended to <root>\/state\/night-1\.md/);
    assert.deepEqual(t.names('tmp'), ['dd-fresh', 'dd-sim', 'ee1-new', 'unrelated']); // cleanup frames+tmp ran too
    // a second run changes nothing more about phone
    const again = t.end(['--apply']);
    assert.match(again.stdout, /phone already at origin\/nightly\/night-1/);
  }));

test('apply never fast-forwards a dirty phone worktree, and leaves a diverged one alone', () =>
  withNight({ clean: true }, async (t) => {
    await t.up(t.ports.a, t.ports.b);
    const phone = join(t.wt, 'phone');
    writeFileSync(join(phone, 'mine.txt'), 'uncommitted');
    let r = t.end(['--apply']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /phone not fast-forwarded \(dirty\)/);
    assert.notEqual(t.git(phone, 'rev-parse', 'HEAD'), t.git(t.main, 'rev-parse', 'origin/nightly/night-1'));
    rmSync(join(phone, 'mine.txt'));
    writeFileSync(join(phone, 'diverged.txt'), 'x');
    t.git(phone, 'add', 'diverged.txt');
    t.git(phone, 'commit', '-q', '-m', 'diverged');
    const head = t.git(phone, 'rev-parse', 'HEAD');
    r = t.end(['--apply']);
    assert.match(r.stdout, /phone ff-only merge refused \(diverged\); left alone/);
    assert.equal(t.git(phone, 'rev-parse', 'HEAD'), head);
  }));

test('an empty secret exits 3, names the key and file, never prints the value', () =>
  withNight({ clean: true, secret: 'OTHER = 1\nAPI_TOKEN =   \n' }, async (t) => {
    await t.up(t.ports.a, t.ports.b);
    const r = t.end();
    assert.equal(r.status, 3);
    assert.match(r.stdout, /!!!! API_TOKEN IS EMPTY in cfg\/secrets\.cfg\n/);
    assert.match(r.stdout, /!!!! fix: you run tools\/bootstrap\.sh from the main checkout \(/);
    assert.match(r.stdout, /token: EMPTY/);
    assert.match(r.stdout, /token EMPTY; dirty worktrees: none/);
    assert.match(r.stdout, /factory-end-night: done \(exit 3: token empty or dirty worktree\)/);
  }));

test('a missing secret file exits 3; a missing key exits 3; the last assignment decides', () => {
  const cases = [
    [{ clean: true, secret: null }, 3, /!! secrets\.cfg missing/],
    [{ clean: true, secret: 'SOMETHING_ELSE = 1\n' }, 3, /API_TOKEN IS EMPTY/],
    [{ clean: true, secret: `API_TOKEN = ${SECRET_VALUE}\nAPI_TOKEN =\n` }, 3, /API_TOKEN IS EMPTY/],
    [{ clean: true, secret: `API_TOKEN =\nAPI_TOKEN = ${SECRET_VALUE}\n` }, 0, /token: ok/],
    [{ clean: true, secret: `  API_TOKEN=${SECRET_VALUE}  \n` }, 0, /token: ok/],
  ];
  return Promise.all(
    cases.map(([opts, status, pattern]) =>
      withNight(opts, async (t) => {
        await t.up(t.ports.a, t.ports.b);
        const r = t.end();
        assert.equal(r.status, status, r.stdout);
        assert.match(r.stdout, pattern);
        assert.ok(!r.stdout.includes(SECRET_VALUE) && !r.stderr.includes(SECRET_VALUE));
      }),
    ),
  );
});

test('emulators not all listening: the seed is skipped, not failed', () =>
  withNight({ clean: true }, async (t) => {
    await t.up(t.ports.a); // b is down
    const r = t.end(['--apply']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, new RegExp(`emulators not all listening \\(down: ${t.ports.b}\\); skipping seed`));
    assert.match(r.stdout, /seed: no emulators/);
    assert.equal(t.read(t.seedLog), '');
  }));

test('a failing seed restore is reported, and the other steps still run', () =>
  withNight({ clean: true }, async (t) => {
    await t.up(t.ports.a, t.ports.b);
    const toml = readFileSync(t.p('factory.toml'), 'utf8').replace(/^restore = .*$/m, 'restore = "echo no good; exit 4"');
    writeFileSync(t.p('factory.toml'), toml);
    const r = t.end(['--apply']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /last line: no good/);
    assert.match(r.stdout, /seed: FAILED rc=4/);
    assert.match(r.stdout, /== 7 log ==/);
  }));

test('--stop-emulators: dry run only names the PIDs; --apply SIGTERMs the all_ports listeners and nothing else', () =>
  withNight({ clean: true }, async (t) => {
    await t.up(t.ports.a, t.ports.b, t.ports.c);
    const [ka, kb, kc] = t.kids;
    let r = t.end(['--stop-emulators']);
    assert.equal(r.status, 0, r.stdout);
    for (const [port, k] of [[t.ports.a, ka], [t.ports.b, kb], [t.ports.c, kc]]) assert.match(r.stdout, new RegExp(`:${port} would SIGTERM ${k.pid} `));
    assert.ok(alive(ka.pid) && alive(kb.pid) && alive(kc.pid));

    // a bystander on a port that is not in all_ports survives
    const bystanderPort = await freePort();
    await t.up(bystanderPort);
    const bystander = t.kids[3];
    r = t.end(['--apply', '--stop-emulators']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, new RegExp(`:${t.ports.a} SIGTERM ${ka.pid} `));
    assert.equal(await waitFor(async () => !(await isUp(t.ports.a)) && !(await isUp(t.ports.b)) && !(await isUp(t.ports.c))), true);
    assert.equal(alive(bystander.pid), true);
    assert.equal(await isUp(bystanderPort), true);
    // seed ran before the stop
    assert.equal(t.read(t.seedLog), 'seeded\n');
  }));

test('apply with no night file warns on stderr and still finishes', () =>
  withNight({ clean: true }, async (t) => {
    rmSync(t.nightFile);
    await t.up(t.ports.a, t.ports.b);
    const r = t.end(['--apply']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no such file: .*night-1\.md \(not logged\)/);
  }));

test('gh failing is reported as PR unknown, not as a failure', () =>
  withNight({ clean: true }, async (t) => {
    writeFileSync(join(t.p('bin'), 'gh'), '#!/usr/bin/env bash\nexit 1\n');
    const r = t.end();
    assert.match(r.stdout, /pr: PR unknown \(gh failed\)/);
  }));

test('bad arguments exit 1', () =>
  withNight({}, (t) => {
    assert.equal(factory(['end-night'], { env: t.env, cwd: t.main }).status, 1);
    assert.equal(factory(['end-night', '--night', 'x'], { env: t.env, cwd: t.main }).status, 1);
    const r = t.end(['--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown arg: --bogus/);
  }));
