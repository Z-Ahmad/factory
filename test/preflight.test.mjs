import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';
import { alive, freePort, startServer, waitFor } from './procs.mjs';

// preflight's xcode and keep-awake steps, with fake xcodebuild, defaults, plutil and caffeinate first on PATH.
const stub = (t, name, body) => {
  const f = join(t.p('bin'), name);
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(f, 0o755);
};

async function withProject({ preflight = '', toml = '' }, fn) {
  const port = await freePort();
  const t = tree({
    preflightExtra: preflight,
    extraToml: () => `
[dev]
up         = "true"
wait_ports = [${port}]
timeout_s  = 2
${toml}`,
  });
  stub(t, 'xcodebuild', `case "$1" in
  -checkFirstLaunchStatus) [[ -n "\${XCB_FL_OUT:-}" ]] && echo "$XCB_FL_OUT"; exit "\${XCB_FL_RC:-0}" ;;
  -version) echo "Xcode \${XCB_VER:-27.1}"; echo "Build version 27A1" ;;
  *) echo "$*" >> '${t.p('xcodebuild.log')}' ;;
esac`);
  stub(t, 'defaults', 'echo "${AUTOUPDATE:-0}"');
  stub(t, 'plutil', 'echo "${CORESIM_VER:-1174.9}"');
  stub(t, 'caffeinate', `echo "$*" >> '${t.p('caffeinate.log')}'; while :; do sleep 1; done`);
  const server = await startServer(t.root, port);
  const run = (env = {}) => factory(['preflight'], { env: { ...t.env, ...env }, cwd: t.main });
  const pidFile = t.p('state', 'caffeinate.pid');
  try {
    await fn({ ...t, run, pidFile });
  } finally {
    server.kill('SIGKILL');
    if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    t.cleanup();
  }
}
const XCODE_ON = 'xcode = true';

test('xcode: off by default without [proof.ios]; on with it, and ok adds one segment', () =>
  withProject({}, async (t) => {
    const r = t.run({ XCB_FL_RC: '69' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('xcode'));
  }).then(() =>
    withProject({ toml: '[proof.ios]\nseconds = 5' }, async (t) => {
      const r = t.run();
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^factory-preflight: ok - disk 67 GB free; xcode ok; dev up \(no-op\); seed skipped/);
    })));

test('xcode: a first-launch failure exits 4, names the fix and says to stop the night', () =>
  withProject({ preflight: XCODE_ON }, async (t) => {
    const r = t.run({ XCB_FL_RC: '69', XCB_FL_OUT: 'Authorization is required' });
    assert.equal(r.status, 4);
    assert.equal(r.stdout, 'factory-preflight: FAILED at xcode (exit 4)\n');
    assert.match(r.stderr, /checkFirstLaunchStatus failed \(exit 69\)/);
    assert.match(r.stderr, /sudo xcodebuild -runFirstLaunch/);
    assert.match(r.stderr, /Stop the night and notify the human/);
    assert.match(r.stderr, /Authorization is required/);
  }));

test('xcode: no available iOS simulator, or simctl failing, exits 4', () =>
  withProject({ preflight: XCODE_ON }, async (t) => {
    stub(t, 'xcrun', 'echo "== Devices =="; echo "-- watchOS 12.0 --"; echo "    Watch (11111111-0000-0000-0000-0000000000F1) (Shutdown) "');
    let r = t.run();
    assert.equal(r.status, 4);
    assert.match(r.stderr, /no available iOS simulator/);
    stub(t, 'xcrun', 'echo "CoreSimulator is out of date 1171.7 < 1174.9" >&2; exit 1');
    r = t.run();
    assert.equal(r.status, 4);
    assert.match(r.stderr, /CoreSimulator is out of date/);
  }));

test('xcode: App Store auto-update on is noted in the line, and is not a failure', () =>
  withProject({ preflight: XCODE_ON }, async (t) => {
    const r = t.run({ AUTOUPDATE: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /; xcode ok \(App Store auto-update on: it can break Xcode overnight\); dev up/);
  }));

test('xcode_probe: must list an iOS Simulator; runs again only when Xcode or CoreSimulator changes', () =>
  withProject(
    { preflight: `${XCODE_ON}\nxcode_probe = "echo run >> probe.log; cat probe.out"` },
    async (t) => {
      const says = (text) => writeFileSync(join(t.main, 'probe.out'), `${text}\n`);
      says('platform:iOS Simulator, id:X, OS:99.0, name:iPhone');
      const runs = () => readFileSync(join(t.main, 'probe.log'), 'utf8').split('\n').filter(Boolean).length;
      assert.equal(t.run().status, 0);
      assert.equal(t.run().status, 0);
      assert.equal(runs(), 1);
      assert.equal(t.run({ XCB_VER: '27.2' }).status, 0);
      assert.equal(runs(), 2);
      assert.equal(t.run({ XCB_VER: '27.2', CORESIM_VER: '1180' }).status, 0);
      assert.equal(runs(), 3);
      says('platform:macOS, arch:arm64');
      const r = t.run({ XCB_VER: '28.0' });
      assert.equal(r.status, 4);
      assert.match(r.stderr, /xcode_probe lists no iOS Simulator destination/);
      says('platform:iOS Simulator, id:X');
      assert.equal(t.run({ XCB_VER: '28.0' }).status, 0, 'a failed probe is not cached');
      assert.equal(runs(), 5);
    },
  ));

test('keep-awake: starts one caffeinate, reuses it while it runs, and end-night --apply stops it', () =>
  withProject({ preflight: 'keep_awake = true\nkeep_awake_hours = 2' }, async (t) => {
    let r = t.run();
    assert.equal(r.status, 0, r.stderr);
    const m = r.stdout.match(/; awake \(started, pid (\d+)\); dev up/);
    assert.ok(m, r.stdout);
    const pid = Number(m[1]);
    assert.equal(Number(readFileSync(t.pidFile, 'utf8')), pid);
    assert.ok(await waitFor(() => existsSync(t.p('caffeinate.log'))));
    assert.equal(readFileSync(t.p('caffeinate.log'), 'utf8'), '-dimsu -t 7200\n');
    r = t.run();
    assert.match(r.stdout, new RegExp(`; awake \\(pid ${pid}\\); dev up`));

    let e = factory(['end-night', '--night', '1'], { env: t.env, cwd: t.main });
    assert.match(e.stdout, new RegExp(`would stop caffeinate \\(pid ${pid}\\)`));
    assert.ok(alive(pid));
    e = factory(['end-night', '--night', '1', '--apply'], { env: t.env, cwd: t.main });
    assert.match(e.stdout, new RegExp(`stopped caffeinate \\(pid ${pid}\\)`));
    assert.ok(await waitFor(() => !alive(pid)));
    assert.ok(!existsSync(t.pidFile));

    // a dead or reused PID in the file is never trusted: a new one starts
    writeFileSync(t.pidFile, `${process.pid}\n`);
    r = t.run();
    assert.match(r.stdout, /; awake \(started, pid \d+\); dev up/);
  }));

test('keep-awake: skipped off macOS', () =>
  withProject({ preflight: 'keep_awake = true' }, async (t) => {
    const r = t.run({ FK_UNAME: 'Linux' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('awake'));
    assert.ok(!existsSync(t.pidFile));
  }));

test('git: a shared repo with core.bare = true fails preflight with exit 5 and the fix', () =>
  withProject({}, async (t) => {
    t.git(t.main, 'config', 'core.bare', 'true');
    const r = t.run();
    assert.equal(r.status, 5);
    assert.equal(r.stdout, 'factory-preflight: FAILED at git (exit 5)\n');
    assert.match(r.stderr, /is not a working tree \(core\.bare = true/);
    assert.match(r.stderr, /config --unset core\.bare/);
    t.git(t.main, 'config', '--unset', 'core.bare');
    assert.equal(t.run().status, 0);
  }));

test('[sim] runtime: preflight names booted simulators on another runtime, never protected ones', () =>
  withProject({ preflight: XCODE_ON, toml: '' }, async (t) => {
    writeFileSync(t.p('factory.toml'), readFileSync(t.p('factory.toml'), 'utf8').replace('[sim]\n', '[sim]\nruntime = "iOS-26-5"\n'));
    const devices = {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'box-factory-1', udid: 'U1', state: 'Booted' }],
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
        { name: 'box-opus-9', udid: 'U2', state: 'Booted' },
        { name: 'box-test-kit', udid: 'U3', state: 'Booted' }, // protected
        { name: 'box-opus-off', udid: 'U4', state: 'Shutdown' },
      ],
    };
    writeFileSync(t.p('devices.json'), JSON.stringify({ devices }));
    stub(t, 'xcrun', `if [[ "$*" == *-j* ]]; then cat '${t.p('devices.json')}'; else echo "-- iOS 26.5 --"; echo "    P (11111111-0000-0000-0000-000000000009) (Booted) "; fi`);
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /; xcode ok; booted off \[sim\] runtime: box-opus-9 \(iOS-27-0\); dev up/);
  }));
