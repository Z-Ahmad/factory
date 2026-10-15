import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory, fixture, scratch } from './helpers.mjs';
import { alive, freePort, isUp, startServer, waitFor, writeServer } from './procs.mjs';

// A scratch project with a tiny node server standing in for the dev stack. `dev` and `seed`
// are TOML text for [dev] and [seed]; {server} is the server script, {marker} a file the
// commands append to.
async function project({ dev = '', seed = '' } = {}) {
  const s = scratch();
  const root = realpathSync(s.dir);
  const main = join(root, 'main');
  const state = join(root, 'state');
  mkdirSync(join(main, 'stack'), { recursive: true });
  mkdirSync(state);
  const server = writeServer(root);
  const marker = join(root, 'marker.txt');
  const [a, b, c] = [await freePort(), await freePort(), await freePort()];
  const fill = (t) => t.replaceAll('{server}', server).replaceAll('{marker}', marker).replaceAll('{a}', a).replaceAll('{b}', b).replaceAll('{c}', c);
  writeFileSync(
    join(root, 'factory.toml'),
    fill(`[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.0.0"

[project]
name          = "fixture"
main_checkout = "${main}"
state_dir     = "${state}"
night_file    = "{state_dir}/night-{n}.md"

[git]
worktrees_dir   = ".worktrees"
worktree_branch = "x/{name}-wt"
push_branch     = "nightly/{name}"

[[targets]]
name    = "app"
base    = "origin/trunk"
pr_base = "trunk"

[dev]
${dev}
${seed ? `\n[seed]\n${seed}` : ''}`),
  );
  const env = { FACTORY_TOML: join(root, 'factory.toml'), FK_DEV_POLL_S: '1', FK_READ_API_POLL_S: '1' };
  const run = (args) => factory(args, { env, cwd: root });
  const kids = [];
  const startKid = async (port) => { const k = await startServer(root, port); kids.push(k); return k; };
  const pids = [];
  const cleanup = () => {
    for (const k of kids) k.kill('SIGKILL');
    for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
    s.cleanup();
  };
  return { root, main, state, marker, ports: { a, b, c }, run, startKid, pids, cleanup, read: (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '') };
}

async function withProject(opts, fn) {
  const t = await project(opts);
  try {
    await fn(t);
  } finally {
    t.cleanup();
  }
}

test('dev-status: one line per port, exit 0 only when every wait port is up', () =>
  withProject({ dev: 'wait_ports = [{a}]\nall_ports = [{a}, {b}]' }, async (t) => {
    await t.startKid(t.ports.a);
    let r = t.run(['dev-status']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `:${t.ports.a} up\n:${t.ports.b} down\n`);
  }));

test('dev-status: exit 1 when a wait port is down; without all_ports it lists the wait ports', () =>
  withProject({ dev: 'wait_ports = [{a}, {b}]' }, async (t) => {
    await t.startKid(t.ports.a);
    const r = t.run(['dev-status']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, `:${t.ports.a} up\n:${t.ports.b} down\n`);
  }));

test('dev-status: exit 2 when no ports are configured', () =>
  withProject({ dev: 'up = "true"' }, (t) => {
    const r = t.run(['dev-status']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wait_ports are not set/);
  }));

test('dev-up: with the ports already up it starts nothing, and restores the seed', () =>
  withProject(
    { dev: 'up = "echo started >> {marker}"\nwait_ports = [{a}]', seed: 'restore = "echo seeded >> {marker}; echo All done."' },
    async (t) => {
      await t.startKid(t.ports.a);
      const r = t.run(['dev-up']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `factory-dev-up: ports already up (${t.ports.a}); nothing to start\nAll done.\n`);
      assert.equal(t.read(t.marker), 'seeded\n'); // the stack command never ran
      assert.equal(t.read(join(t.state, 'dev.log')), '');
    },
  ));

test('dev-up --no-seed leaves the seed alone', () =>
  withProject({ dev: 'wait_ports = [{a}]', seed: 'restore = "echo seeded >> {marker}"' }, async (t) => {
    await t.startKid(t.ports.a);
    const r = t.run(['dev-up', '--no-seed']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(t.read(t.marker), '');
  }));

test('dev-up: with the ports down it starts [dev] up detached in [dev] cwd, waits, then seeds', () =>
  withProject(
    {
      dev: 'up = "echo started-in-$(basename $PWD) >> {marker}; exec node {server} {a}"\ncwd = "stack"\nwait_ports = [{a}]\ntimeout_s = 30',
      seed: 'restore = "echo seeded >> {marker}"',
    },
    async (t) => {
      const r = t.run(['dev-up']);
      assert.equal(r.status, 0, r.stderr);
      const m = r.stdout.match(/^factory-dev-up: started .* \(pid (\d+)\) detached in (.*); log (.*)$/m);
      assert.ok(m, r.stdout);
      t.pids.push(Number(m[1]));
      assert.equal(m[2], join(t.main, 'stack'));
      assert.equal(m[3], join(t.state, 'dev.log'));
      assert.match(r.stdout, new RegExp(`factory-dev-up: ports up \\(${t.ports.a}\\)`));
      // it outlived the command, and the stack ran before the seed
      assert.equal(await isUp(t.ports.a), true);
      assert.equal(t.read(t.marker), 'started-in-stack\nseeded\n');
      // it has its own process group, so it is not tied to this command
      assert.ok(alive(Number(m[1])));
      assert.notEqual(Number(m[1]), process.pid);
    },
  ));

test('dev-up: a dir argument overrides [dev] cwd; a missing dir exits 1', () =>
  withProject({ dev: 'up = "true"\ncwd = "stack"\nwait_ports = [{a}]' }, (t) => {
    const r = t.run(['dev-up', join(t.root, 'nowhere')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no such dir .*nowhere/);
  }));

test('dev-up: ports that never come up exit 2 after timeout_s', () =>
  withProject({ dev: 'up = "true"\ncwd = "stack"\nwait_ports = [{a}]\ntimeout_s = 2' }, (t) => {
    const r = t.run(['dev-up']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /did not come up in 2s/);
  }));

test('dev-up: a failing seed restore exits 3 and says so', () =>
  withProject({ dev: 'wait_ports = [{a}]', seed: 'restore = "echo broken; exit 5"' }, async (t) => {
    await t.startKid(t.ports.a);
    const r = t.run(['dev-up']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /broken/);
    assert.match(r.stderr, /seed restore failed \(exit 5\)/);
  }));

test('dev-up: bad arguments exit 1', () =>
  withProject({ dev: 'wait_ports = [{a}]' }, (t) => {
    assert.equal(t.run(['dev-up', '--bogus']).status, 1);
    assert.equal(t.run(['dev-up', 'a', 'b']).status, 1);
  }));

// ---- read-api ----

const READ = 'read_api = { cwd = "stack", cmd = "node {server}", port = {c} }';

test('read-api up serves the command detached on its port; down stops it and frees the port', () =>
  withProject({ dev: READ }, async (t) => {
    let r = t.run(['read-api', 'up']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`started node .* on :${t.ports.c} detached in ${t.main}/stack; log ${t.state}/read-api.log`));
    assert.match(r.stdout, new RegExp(`up on :${t.ports.c}\\n$`));
    assert.equal(await isUp(t.ports.c), true);
    const pid = Number(t.read(join(t.state, 'read-api.pid')).split(' ')[0]);
    t.pids.push(pid);
    assert.ok(alive(pid));

    r = t.run(['read-api', 'up']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already up on :\d+ \(pid \d+\)/);

    r = t.run(['read-api', 'down']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`stopped group ${pid}; :${t.ports.c} is free`));
    assert.equal(await waitFor(async () => !(await isUp(t.ports.c))), true);
    assert.equal(alive(pid), false);
    assert.equal(existsSync(join(t.state, 'read-api.pid')), false);

    r = t.run(['read-api', 'down']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to stop/);
  }));

test('read-api passes the port as PORT and kills the whole group, children included', () =>
  withProject({ dev: `read_api = { cwd = "stack", cmd = "sh -c 'node {server} & wait'", port = {c} }` }, async (t) => {
    let r = t.run(['read-api', 'up']);
    assert.equal(r.status, 0, r.stderr);
    t.pids.push(Number(t.read(join(t.state, 'read-api.pid')).split(' ')[0]));
    assert.equal(await isUp(t.ports.c), true); // the grandchild is the listener
    r = t.run(['read-api', 'down']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await waitFor(async () => !(await isUp(t.ports.c))), true);
  }));

test('read-api refuses to start on a port something else holds, and down never kills it', () =>
  withProject({ dev: READ }, async (t) => {
    const foreign = await t.startKid(t.ports.c);
    let r = t.run(['read-api', 'up']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already in use by something this command did not start/);
    assert.equal(existsSync(join(t.state, 'read-api.pid')), false);

    r = t.run(['read-api', 'down']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /held by another process; not touching it/);
    assert.equal(alive(foreign.pid), true);
    assert.equal(await isUp(t.ports.c), true);
  }));

test('read-api down ignores a stale pid file that points at an unrelated process', () =>
  withProject({ dev: READ }, async (t) => {
    const other = await t.startKid(t.ports.a); // not on the read-api port
    writeFileSync(join(t.state, 'read-api.pid'), `${other.pid} Mon Jan  1 00:00:00 2001\n`);
    const r = t.run(['read-api', 'down']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to stop/);
    assert.equal(alive(other.pid), true);
    assert.equal(existsSync(join(t.state, 'read-api.pid')), false);
  }));

test('read-api down refuses when a listener on the port is not in our group', () =>
  withProject({ dev: READ }, async (t) => {
    let r = t.run(['read-api', 'up']);
    assert.equal(r.status, 0, r.stderr);
    const pid = Number(t.read(join(t.state, 'read-api.pid')).split(' ')[0]);
    t.pids.push(pid);
    // Our process is alive and ours, but pretend the port moved: point the config at a port held by a stranger.
    const stranger = await t.startKid(t.ports.b);
    const toml = readFileSync(join(t.root, 'factory.toml'), 'utf8').replace(`port = ${t.ports.c}`, `port = ${t.ports.b}`);
    writeFileSync(join(t.root, 'factory.toml'), toml);
    r = t.run(['read-api', 'down']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /held by pid \d+, which this command did not start/);
    assert.equal(alive(stranger.pid), true);
    assert.equal(alive(pid), true);
  }));

test('read-api: a command that dies at once exits 1; bad arguments exit 1; no config exits 1', () =>
  withProject({ dev: 'read_api = { cwd = "stack", cmd = "exit 3", port = {c} }' }, (t) => {
    let r = t.run(['read-api', 'up']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exited before :\d+ came up/);
    assert.equal(t.run(['read-api']).status, 1);
    assert.equal(t.run(['read-api', 'sideways']).status, 1);
  }));

test('read-api without [dev] read_api exits 1', () =>
  withProject({ dev: 'wait_ports = [{a}]' }, (t) => {
    const r = t.run(['read-api', 'up']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /read_api .* is not set/);
  }));

test('the valid.toml fixture still validates with the new commands around', () => {
  const r = factory(['config', 'validate'], { env: { FACTORY_TOML: fixture('valid.toml') } });
  assert.equal(r.status, 0, r.stderr);
});
