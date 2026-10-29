import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveContexts } from '../stats/context.mjs';
import { factory, scratch } from './helpers.mjs';
import { tree } from './fixture-tree.mjs';

const msg = (tokens) => JSON.stringify({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  message: { id: `m${tokens}`, model: 'm', usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10 - 5, cache_creation_input_tokens: 5, output_tokens: 99 } },
});

// a project with two live transcripts (an orchestrator at 120k, a subagent at 450k) and one at 900k last written an hour ago
function transcripts(dir) {
  mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'sess.jsonl'), `${msg(100000)}\n${msg(120000)}\n`);
  writeFileSync(join(dir, 'sess', 'subagents', 'agent-abc.jsonl'), `${msg(450000)}\n{"type":"user","timestamp":"${new Date().toISOString()}"}\n`);
  writeFileSync(join(dir, 'sess', 'subagents', 'agent-abc.meta.json'), '{"description":"globe fix"}');
  writeFileSync(join(dir, 'old.jsonl'), `${msg(900000)}\n`);
  const hourAgo = new Date(Date.now() - 3600e3);
  utimesSync(join(dir, 'old.jsonl'), hourAgo, hourAgo);
}

test('liveContexts: the last assistant message of each recently written transcript', () => {
  const s = scratch();
  try {
    transcripts(s.dir);
    assert.deepEqual(liveContexts([s.dir]).sort((a, b) => a.tokens - b.tokens), [
      { who: 'orchestrator', session: 'sess', tokens: 120000 },
      { who: 'subagent abc (globe fix)', session: 'sess', tokens: 450000 },
    ]);
  } finally {
    s.cleanup();
  }
});

test('tick prints a WRAP line for each live agent past [loop] wrap_context_k, and none below it', () => {
  const t = tree({ extraToml: (p) => `\n[stats]\ntranscripts = ["${p('tx')}"]\n\n[loop]\nwrap_context_k = 400\n` });
  try {
    mkdirSync(t.p('tx'));
    transcripts(t.p('tx'));
    writeFileSync(t.p('state', 'night-9.md'), '# night 9\n\n- [ ] lifetime-globe.\n\n## Log\n');
    const tick = (env = {}) => factory(['tick', '--night', '9', '--item', 'lifetime-globe', '--sha', 'abc1234', '--log', 'done'], { env: { ...t.env, FK_NOW_HHMM: '01:00', ...env }, cwd: t.main });
    const r = tick();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^WRAP: subagent abc \(globe fix\) in sess is at 450k context, over \[loop\] wrap_context_k = 400: tell it to wrap up and hand back a patch$/m);
    assert.equal(r.stdout.match(/^WRAP:/gm).length, 1);
  } finally {
    t.cleanup();
  }
});

test('config validate warns when [slot] max_load is over 4 x the CPUs (the gate never trips)', () => {
  const t = tree({ extraToml: () => '\n[slot]\nmax_load = 120\n' });
  try {
    let r = factory(['config', 'validate'], { env: { ...t.env, FK_NCPU: '8' }, cwd: t.main });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^warning: slot\.max_load = 120 is over 4 x this Mac's 8 CPUs: the gate never trips and no proof is marked unreliable \(the default is 16\)$/m);
    r = factory(['config', 'validate'], { env: { ...t.env, FK_NCPU: '32' }, cwd: t.main });
    assert.doesNotMatch(r.stdout, /warning/);
  } finally {
    t.cleanup();
  }
});
