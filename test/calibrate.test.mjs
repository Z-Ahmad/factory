import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, run, scratch } from './helpers.mjs';
import { confusion, renderConfusion } from '../proof/verdict/calibrate.mjs';

const CALIBRATE = join(KIT, 'proof', 'verdict', 'calibrate.mjs');

// Two synthetic clips: moving content that is clean, and the same with one inverted frame (a flash).
function clips(dir) {
  const make = (name, vf) => {
    const out = join(dir, 'clips', `${name}.mp4`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=240x520:r=60:d=2', '-vf', `${vf},format=yuv420p`, '-c:v', 'libx264', '-crf', '12', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  mkdirSync(join(dir, 'clips'));
  make('clean', 'null');
  make('flash', 'negate=enable=eq(n\\,60)');
}

const calibrate = (args) => run('node', [CALIBRATE, ...args], { env: { ...process.env, FK_PROOF_IOS_BUDGETS: '' } });

test('calibrate: a confusion table over a manifest, per-clip verdict.json kept with --out, manifest-relative paths', () => {
  const t = scratch();
  try {
    clips(t.dir);
    writeFileSync(join(t.dir, 'manifest.json'), JSON.stringify({
      args: ['--skip-start', '0'], // judge from the first frame: these clips have no launch screen
      clips: [
        { name: 'clean', clip: 'clips/clean.mp4', expected: 'PASS', class: 'approved' },
        { name: 'flash', clip: 'clips/flash.mp4', expected: 'FAIL', class: 'known bad', note: 'one inverted frame' },
        { name: 'unlabelled', clip: 'clips/clean.mp4', scenario: 'unlabelled' },
      ],
    }));
    const out = join(t.dir, 'out');
    const r = calibrate([join(t.dir, 'manifest.json'), '--out', out, '--detail', '--jobs', '2']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\| FAIL \(1 clips\) \| 1 \| 0 \|/);
    assert.match(r.stdout, /\| PASS \(1 clips\) \| 0 \| 1 \|/);
    assert.match(r.stdout, /\| no expectation \(1 clips\) \| 0 \| 1 \|/);
    assert.match(r.stdout, /\| flash \| known bad \| FAIL \| \*\*FAIL\*\* \|/);
    assert.match(r.stdout, /one inverted frame/);
    assert.ok(existsSync(join(out, 'runs', 'flash', 'verdict.json')));
    assert.ok(existsSync(join(out, 'runs', 'flash', 'flags.png')));
    assert.equal(JSON.parse(readFileSync(join(out, 'runs', 'clean', 'verdict.json'), 'utf8')).verdict, 'PASS');
    assert.ok(existsSync(join(out, 'table.md')));
  } finally {
    t.cleanup();
  }
});

test('calibrate: a clip that did not get its expected verdict is named, and the exit code is 1', () => {
  const t = scratch();
  try {
    clips(t.dir);
    writeFileSync(join(t.dir, 'manifest.json'), JSON.stringify({
      args: ['--skip-start', '0'],
      clips: [{ name: 'clean-but-feared', clip: 'clips/clean.mp4', expected: 'FAIL' }],
    }));
    const r = calibrate([join(t.dir, 'manifest.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MISSED: clean-but-feared \(expected FAIL, got PASS\)/);
    assert.match(r.stdout, /\| FAIL \(1 clips\) \| 0 \| 1 \|/);
  } finally {
    t.cleanup();
  }
});

test('calibrate: a bad manifest is refused before anything runs', () => {
  const t = scratch();
  try {
    clips(t.dir);
    const refuse = (manifest, re) => {
      writeFileSync(join(t.dir, 'm.json'), JSON.stringify(manifest));
      const r = calibrate([join(t.dir, 'm.json')]);
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stderr, re);
    };
    refuse({ clips: [] }, /"clips" must be a non-empty array/);
    refuse({ clips: [{ name: 'a', clip: 'clips/clean.mp4' }, { name: 'a', clip: 'clips/clean.mp4' }] }, /duplicate clip name "a"/);
    refuse({ clips: [{ name: 'a', clip: 'clips/missing.mp4' }] }, /no clip at/);
    refuse({ clips: [{ name: 'a', clip: 'clips/clean.mp4', expected: 'MAYBE' }] }, /expected is PASS or FAIL/);
    refuse({ clips: [{ name: 'a/b', clip: 'clips/clean.mp4' }] }, /may only use letters/);
  } finally {
    t.cleanup();
  }
});

test('confusion groups the must-clips by expected verdict and counts what came out', () => {
  const results = [
    { name: 'a', must: true, expected: 'FAIL', verdict: 'FAIL' },
    { name: 'b', must: true, expected: 'PASS', verdict: 'PASS' },
    { name: 'c', must: true, expected: 'PASS', verdict: 'FAIL' },
    { name: 'd', must: false, expected: 'PASS', verdict: 'FAIL' },
    { name: 'e', must: true, expected: 'PASS', verdict: 'ERROR' },
  ];
  const rows = confusion(results);
  assert.deepEqual(rows.get('PASS'), { total: 3, got: { PASS: 1, FAIL: 1, ERROR: 1 } });
  assert.deepEqual(rows.get('FAIL'), { total: 1, got: { FAIL: 1 } });
  assert.match(renderConfusion(results), /\| PASS \(3 clips\) \| 1 \| 1 \| 1 \|/);
});
