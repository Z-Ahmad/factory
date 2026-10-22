import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

// proof-compare with a fake `factory proof` (FK_PROOF_CORE): it logs its args and writes a verdict whose hold depends on
// which app it ran (base 100 ms, patch 130 ms) and a load that the test sets per side.
function project() {
  const t = tree({
    extraToml: (p) => `
[proof.ios]
build     = "mkdir -p {dd}/Build/App.app && pwd > {dd}/built-from && echo built >> ${p('builds.log')}"
dd        = "app"
app       = "{dd}/Build/App.app"
bundle_id = "invalid.example.app"
process   = "App"
`,
  });
  const core = t.p('core.sh');
  writeFileSync(core, `#!/usr/bin/env bash
echo "$*" >> '${t.p('core.log')}'
while [[ $# -gt 0 ]]; do case "$1" in --out) out="$2"; shift 2 ;; --dd) dd="$2"; shift 2 ;; *) shift ;; esac; done
if [[ "$dd" == *compare* || "$dd" == *base* ]]; then hold=100 load="\${BASE_LOAD:-50}"; else hold=130 load="\${PATCH_LOAD:-52}"; fi
[[ -n "\${CORE_FAIL:-}" && "$dd" != *compare* && "$dd" != *base* ]] && { echo boom >&2; exit 1; }
echo "VERDICT: PASS"
echo "{\\"verdict\\":\\"PASS\\",\\"hold\\":{\\"worstMs\\":$hold},\\"flash\\":{\\"worstScore\\":0.1,\\"status\\":\\"PASS\\"},\\"bounce\\":{\\"worstScore\\":0},\\"load\\":{\\"start\\":$load,\\"end\\":$load}}" > "$out/verdict.json"
`);
  chmodSync(core, 0o755);
  const run = (args, env = {}) =>
    factory(['proof-compare', '--scenario', 'scrub', '--udid', 'SIM', '--out', t.p('cmp'), ...args], {
      env: { ...t.env, FK_UNAME: 'Darwin', FK_PROOF_CORE: core, ...env },
      cwd: t.main,
    });
  const coreCalls = () => readFileSync(t.p('core.log'), 'utf8').trim().split('\n');
  return { ...t, run, coreCalls };
}

test('proof-compare --base: builds the base once in its own worktree, alternates base/patch, and reports both sides', () => {
  const t = project();
  try {
    let r = t.run(['--base', 'trunk', '--build', '--runs', '2']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const sha = t.git(t.main, 'rev-parse', 'trunk').slice(0, 8);
    const baseWt = join(t.main, '.worktrees', `compare-${sha}`);
    assert.ok(existsSync(baseWt));
    assert.equal(readFileSync(t.p('cache', `dd-compare-${sha}`, 'built-from'), 'utf8').trim(), baseWt);
    // base, patch, then patch, base; the base runs check staleness against the base worktree
    const calls = t.coreCalls();
    assert.deepEqual(calls.map((c) => (c.includes(`dd-compare-${sha}`) ? 'base' : 'patch')), ['base', 'patch', 'patch', 'base']);
    assert.ok(calls[0].includes(`--source-root ${baseWt}`) && calls[0].includes('--no-gate'));
    assert.match(r.stdout, /^COMPARE: base hold 100 ms at load 50 vs patch 130 ms at load 52 \(\+30 ms\); flash base 0\.1 \(FAIL 0\/2\) vs patch 0\.1 \(FAIL 0\/2\); PASS base 2\/2, patch 2\/2$/m);
    const md = readFileSync(t.p('cmp', 'compare.md'), 'utf8');
    assert.match(md, /^\| 2 \| patch \| \*\*PASS\*\* \| 130 \| 0\.1 \| 0 \| 52→52 \|$/m);
    assert.ok(existsSync(t.p('cmp', 'base-1', 'verdict.json')) && existsSync(t.p('cmp', 'patch-2', 'verdict.json')));
    // a second compare reuses the base build
    r = t.run(['--base', 'trunk', '--runs', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(t.p('builds.log'), 'utf8'), 'built\nbuilt\n'); // the patch once, the base once
  } finally {
    t.cleanup();
  }
});

test('proof-compare: loads a quarter apart are called out; a failed run exits 1 and is marked ERROR', () => {
  const t = project();
  try {
    mkdirSync(t.p('cache', 'dd-app', 'Build', 'App.app'), { recursive: true });
    mkdirSync(t.p('basedd', 'Build', 'App.app'), { recursive: true });
    let r = t.run(['--base-dd', t.p('basedd'), '--runs', '1'], { BASE_LOAD: '40', PATCH_LOAD: '160' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^warning: the two sides ran at loads more than a quarter apart/m);
    assert.ok(t.coreCalls()[0].includes('--source-root none'));
    r = t.run(['--base-dd', t.p('basedd'), '--runs', '1'], { CORE_FAIL: '1' });
    assert.equal(r.status, 1);
    assert.match(readFileSync(t.p('cmp', 'compare.md'), 'utf8'), /\| 1 \| patch \| \*\*ERROR\*\* \|/);
  } finally {
    t.cleanup();
  }
});

test('proof-compare: needs exactly one base, a scenario and an out dir', () => {
  const t = project();
  try {
    assert.match(t.run(['--runs', '1']).stderr, /pass one of --base <ref> or --base-dd <dd>/);
    assert.equal(t.run(['--base', 'trunk', '--base-dd', '/x']).status, 1);
    assert.equal(t.run(['--base', 'no-such-ref', '--build']).status, 1);
  } finally {
    t.cleanup();
  }
});
