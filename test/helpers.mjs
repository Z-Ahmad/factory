// Shared helpers for the test files. Zero dependencies: node:test and node:assert only.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(KIT, 'test', 'fixtures');
export const fixture = (name) => join(FIXTURES, name);

/** Run a program; returns { status, stdout, stderr }. */
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run bin/factory (from this kit, or from `kit` when a test copies it). */
export function factory(args, opts = {}) {
  const { kit = KIT, env = {}, ...rest } = opts;
  return run(join(kit, 'bin', 'factory'), args, {
    ...rest,
    env: { ...process.env, FACTORY_TOML: '', ...env },
  });
}

/** Make a scratch directory; returns { dir, cleanup }. */
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'fk-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Copy bin/, cmd/ and lib/ into `dir/kit` so a test can add its own command. */
export function copyKit(dir) {
  const kit = join(dir, 'kit');
  for (const part of ['bin', 'cmd', 'lib']) cpSync(join(KIT, part), join(kit, part), { recursive: true });
  return kit;
}

export function addCommand(kit, name, body) {
  mkdirSync(join(kit, 'cmd'), { recursive: true });
  const file = join(kit, 'cmd', name);
  writeFileSync(file, `#!/usr/bin/env bash\n# desc: test command\nset -euo pipefail\n${body}\n`);
  chmodSync(file, 0o755);
}
