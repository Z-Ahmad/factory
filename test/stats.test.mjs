import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileAreas, areaOf } from '../stats/sources.mjs';
import { expandDirs } from '../stats/transcripts.mjs';
import { factory, scratch } from './helpers.mjs';

// Everything here is made up: session ids, timestamps, models, tool names and numbers.
//
// One project, two "nights" (windows) and a third still in progress:
//   night 1  10:00 - 11:00   orchestrator "sess-a" + one subagent
//   night 2  12:00 - 13:00
//   night 3  14:00 - (now = 14:30)
// Orchestrator timeline (UTC, 2030-01-01):
//   10:00:00 user prompt
//   10:00:10 assistant m1 (model-big): three entries with the same id and usage -> one message, tool_use T1 (Bash)
//   10:00:40 tool_result T1                       tool wall 30 s
//   10:00:50 assistant m2: tool_use T2 (Agent), tool_use T3 (AskUserQuestion)
//   10:01:20 tool_result T2 (subagent done)       10:05:00 tool_result T3 (a person answered)
//   10:05:30 assistant m3 (model-big): text
//   10:30:00 user prompt   (a 25 minute pause: idle)
//   10:30:20 assistant m4 (model-big)             -> night 1 ends 11:00
//   11:30:00 user prompt, 11:30:30 assistant m5   -> outside every window (unassigned)
//   12:10:00 user prompt, 12:10:45 assistant m6   -> night 2
//   14:10:00 user prompt, 14:10:12 assistant m7 (model-small) -> night 3
const D = '2030-01-01T';
const t = (hms) => `${D}${hms}.000Z`;
let uid = 0;
const line = (o) => JSON.stringify({ uuid: `u${++uid}`, ...o });
const user = (hms, content = 'go') => line({ type: 'user', timestamp: t(hms), message: { role: 'user', content } });
const result = (hms, id) =>
  line({ type: 'user', timestamp: t(hms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const asst = (hms, msgId, model, usage, content) =>
  line({ type: 'assistant', timestamp: t(hms), message: { id: msgId, role: 'assistant', model, usage, content } });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const usage = (i, o, cr, cw, w1h = 0) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
  cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: cw - w1h },
});

function project({ withGh = true } = {}) {
  const s = scratch();
  const root = realpathSync(s.dir);
  const p = (...a) => join(root, ...a);
  mkdirSync(p('state'), { recursive: true });

  // transcripts: two project directories matching one pattern, plus one that must not match
  const proj = p('tx', 'proj-main');
  const other = p('tx', 'proj-main-wt');
  mkdirSync(join(proj, 'sess-a', 'subagents'), { recursive: true });
  mkdirSync(other, { recursive: true });
  mkdirSync(p('tx', 'unrelated'), { recursive: true });
  writeFileSync(join(p('tx', 'unrelated'), 'sess-zzz.jsonl'), user('10:10:00') + '\n');

  const big = 'model-big';
  const small = 'model-small';
  const m1 = usage(10, 100, 1000, 500, 200);
  writeFileSync(
    join(proj, 'sess-a.jsonl'),
    [
      user('10:00:00'),
      asst('10:00:10', 'm1', big, m1, [{ type: 'thinking', thinking: '' }]),
      asst('10:00:10', 'm1', big, m1, [{ type: 'text', text: 'hi' }]),
      asst('10:00:10', 'm1', big, m1, [use('T1', 'Bash')]),
      result('10:00:40', 'T1'),
      asst('10:00:50', 'm2', big, usage(5, 50, 2000, 0), [use('T2', 'Agent', { model: 'small' }), use('T3', 'AskUserQuestion')]),
      result('10:01:20', 'T2'),
      result('10:05:00', 'T3'),
      asst('10:05:30', 'm3', big, usage(5, 25, 2000, 0), [{ type: 'text', text: 'done' }]),
      user('10:30:00'),
      asst('10:30:20', 'm4', big, usage(1, 10, 100, 0), [{ type: 'text', text: 'x' }]),
      user('11:30:00'),
      asst('11:30:30', 'm5', big, usage(1, 10, 100, 0), [{ type: 'text', text: 'x' }]),
      user('12:10:00'),
      asst('12:10:45', 'm6', big, usage(2, 20, 300, 0), [use('T4', 'Bash')]),
      result('12:12:45', 'T4'),
      user('14:10:00'),
      asst('14:10:12', 'm7', small, usage(3, 30, 0, 0), [{ type: 'text', text: 'x' }]),
      // a copy of an earlier entry (same uuid) must count once
      JSON.stringify({ ...JSON.parse(asst('10:05:30', 'm3', big, usage(5, 25, 2000, 0), [{ type: 'text', text: 'done' }])), uuid: 'dup' }),
      JSON.stringify({ ...JSON.parse(asst('10:05:30', 'm3', big, usage(5, 25, 2000, 0), [{ type: 'text', text: 'done' }])), uuid: 'dup' }),
      'not json at all',
    ].join('\n') + '\n',
  );
  // the subagent: 10:00:55 - 10:01:15, one tool call
  writeFileSync(
    join(proj, 'sess-a', 'subagents', 'agent-s1.jsonl'),
    [
      user('10:00:55', 'sub task'),
      asst('10:01:05', 's-m1', small, usage(7, 70, 500, 0), [use('S1', 'Read')]),
      result('10:01:08', 'S1'),
      asst('10:01:15', 's-m2', small, usage(7, 30, 500, 0), [{ type: 'text', text: 'ok' }]),
    ].join('\n') + '\n',
  );
  writeFileSync(join(proj, 'sess-a', 'subagents', 'agent-s1.meta.json'), JSON.stringify({ model: 'small', agentType: 'worker' }));
  // a second orchestrator session in the other directory, in night 2
  writeFileSync(
    join(other, 'sess-b.jsonl'),
    [user('12:30:00'), asst('12:30:05', 'b1', big, usage(1, 5, 10, 0), [{ type: 'text', text: 'x' }])].join('\n') + '\n',
  );

  writeFileSync(
    p('nights.json'),
    JSON.stringify({
      sessions: ['sess-a', 'sess-b'],
      nights: {
        1: { start: t('10:00:00'), end: t('11:00:00'), prs: [11], notes: 'first' },
        2: { start: t('12:00:00'), end: t('13:00:00'), prs: [12, 13] },
        10: { start: t('14:00:00'), end: null, prs: [] },
      },
    }),
  );

  writeFileSync(
    p('state', 'night-1.md'),
    `# Night 1

## Backlog
- [x] 1. aaa1111 first
- [x] 2. bbb2222 second
- [ ] 3. third [blocked: needs a person]
- [ ] 4. fourth
  - [x] a nested box that is not an item

## Log
10:10 · 1 · aaa1111 · done · Build 701 uploaded
10:20 · 3 · BLOCKED on a person
10:30 · wrap · Build 701 uploaded again, then Build 702 uploading
`,
  );

  mkdirSync(p('bin'), { recursive: true });
  if (withGh) {
    // a stand-in for `gh`: answers the two read-only calls the command makes
    writeFileSync(
      p('bin', 'gh'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${p('gh.log')}'
if [[ "$1 $2" == "pr view" ]]; then
  case "$3" in
    11) echo '{"number":11,"title":"night one","state":"MERGED","baseRefName":"main","createdAt":"2030-01-01T10:00:00Z","mergedAt":"2030-01-01T11:00:00Z","additions":30,"deletions":5,"changedFiles":3,"commits":[{},{}]}' ;;
    12) echo '{"number":12,"title":"two a","state":"OPEN","baseRefName":"main","createdAt":"2030-01-01T12:00:00Z","mergedAt":null,"additions":4,"deletions":1,"changedFiles":1,"commits":[{}]}' ;;
    13) echo '{"number":13,"title":"two b","state":"OPEN","baseRefName":"main","createdAt":"2030-01-01T12:00:00Z","mergedAt":null,"additions":6,"deletions":2,"changedFiles":2,"commits":[{},{},{}]}' ;;
    *) exit 1 ;;
  esac
elif [[ "$1" == "api" ]]; then
  case "$2" in
    */pulls/11/files) printf '%s\\n' '{"f":"app/a.swift","a":20,"d":3}' '{"f":"web/b.ts","a":5,"d":1}' '{"f":"docs/guide/c.md","a":5,"d":1}' ;;
    */pulls/12/files) printf '%s\\n' '{"f":"app/x.swift","a":4,"d":1}' ;;
    */pulls/13/files) printf '%s\\n' '{"f":"README.md","a":1,"d":0}' '{"f":"web/deep/y.ts","a":5,"d":2}' ;;
  esac
else exit 1; fi
`,
    );
    chmodSync(p('bin', 'gh'), 0o755);
  }

  writeFileSync(
    p('factory.toml'),
    `[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.0.0"

[project]
name          = "example-app"
main_checkout = "${p('main')}"
state_dir     = "${p('state')}"
night_file    = "{state_dir}/night-{n}.md"

[git]
github          = "example/app"
worktrees_dir   = ".worktrees"
worktree_branch = "factory/{name}-wt"
push_branch     = "factory/{name}"

[[targets]]
name    = "app"
base    = "origin/main"
pr_base = "main"

[stats]
transcripts   = ["${p('tx')}/proj-main*"]
nights        = "${p('nights.json')}"
out           = "${p('out')}"
build_pattern = '(?:Build) (\\d{3}) upload'
areas         = { ios = "app/**", web = "web/**", docs = "docs/**,*.md" }

[stats.prices]
model-big = "10,50,1,12.5,20"
`,
  );

  const env = { PATH: `${p('bin')}:${process.env.PATH}`, FK_NOW: t('14:30:00') };
  const run = (args = []) => factory(['stats', ...args], { cwd: root, env, encoding: 'utf8' });
  const json = (name = 'nights-stats.json') => JSON.parse(readFileSync(p('out', name), 'utf8'));
  return { ...s, root, p, run, json, env };
}

test('stats: windows, active time, agents, tools, tokens, outputs', () => {
  const x = project();
  try {
    const r = x.run();
    assert.equal(r.status, 0, r.stderr);
    const j = x.json();
    assert.equal(j.transcripts.orchestrator_files, 2);
    assert.equal(j.transcripts.subagent_files, 1);
    assert.equal(j.transcripts.unparsable_lines, 1);

    const n1 = j.nights['1'];
    assert.equal(n1.window.wall_s, 3600);
    assert.equal(n1.window.in_progress, false);
    assert.equal(n1.notes, 'first');
    // active: entries 10:00:00 .. 10:05:30 are all <10 min apart (sub entries inside), then a 25 min pause,
    // then 10:30:00 -> 10:30:20. = 330 s + 20 s
    assert.equal(n1.active_s, 350);

    // agents: one Agent call, one subagent transcript (model-small), one orchestrator session
    assert.equal(n1.agents.agent_tool_calls, 1);
    assert.deepEqual(n1.agents.agent_tool_calls_by_requested_model, { small: 1 });
    assert.equal(n1.agents.subagent_transcripts, 1);
    assert.deepEqual(n1.agents.subagent_transcripts_by_model, { 'model-small': 1 });
    assert.equal(n1.agents.orchestrator_sessions, 1);
    assert.deepEqual(n1.agents.orchestrator_turns_by_model, { 'model-big': 4 });
    assert.equal(n1.user_questions, 1);

    // tools: Bash (orchestrator) 30 s, Read (subagent) 3 s, Agent and AskUserQuestion are calls but not wall time
    assert.equal(n1.tools.calls, 4);
    assert.equal(n1.tools.wall_s, 33);
    assert.equal(n1.tools.by_role.orchestrator.calls, 3);
    assert.equal(n1.tools.by_role.orchestrator.wall_s, 30);
    assert.equal(n1.tools.by_role.subagents.calls, 1);
    assert.equal(n1.tools.by_role.subagents.wall_s, 3);
    assert.equal(n1.tools.agent_wait_s, 30);
    const bash = n1.tools.top.find((e) => e.tool === 'Bash');
    assert.deepEqual([bash.calls, bash.wall_s, bash.counted_in_wall], [1, 30, true]);
    assert.equal(n1.tools.top.find((e) => e.tool === 'AskUserQuestion').counted_in_wall, false);

    // api time: m1 10 s (prompt 10:00:00 -> 10:00:10), m2 10 s (after tool result 10:00:40), m3 30 s (after
    // the 10:05:00 answer), m4 20 s; subagent: s-m1 10 s, s-m2 7 s
    assert.equal(n1.api.by_model['model-big'].s, 10 + 10 + 30 + 20);
    assert.equal(n1.api.by_model['model-small'].s, 10 + 7);
    assert.equal(n1.api.by_role_s.subagents, 17);

    // tokens: m1 counted once although it was written three times; the duplicate m3 entries once
    const big = n1.tokens.by_model['model-big'];
    assert.deepEqual(
      [big.input, big.output, big.cache_read, big.cache_write, big.cache_write_1h, big.messages],
      [10 + 5 + 5 + 1, 100 + 50 + 25 + 10, 1000 + 2000 + 2000 + 100, 500, 200, 4],
    );
    // cost at 10/50/1/12.5/20 per million: input 21*10 + output 185*50 + read 5100*1 + 300 write5m*12.5 + 200 write1h*20
    assert.equal(n1.cost_usd.by_model['model-big'], Math.round(((21 * 10 + 185 * 50 + 5100 * 1 + 300 * 12.5 + 200 * 20) / 1e6) * 100) / 100);
    assert.deepEqual(n1.cost_usd.unpriced_models, ['model-small']);

    // outputs from the night file
    assert.deepEqual(n1.outputs.items, { shipped: 2, blocked: 1, open: 1 });
    assert.deepEqual(n1.outputs.builds, ['701', '702']); // 702 only "uploading": counted, and 701 twice counts once
    assert.equal(n1.outputs.blocked_log_lines, 1);

    // night 2 spans two project directories (both match the pattern); no night file for it
    const n2 = j.nights['2'];
    assert.equal(n2.agents.orchestrator_sessions, 2);
    assert.equal(n2.tools.wall_s, 120);
    assert.equal(n2.outputs, undefined);
    // night 10 is in progress: it runs to FK_NOW
    const n10 = j.nights['10'];
    assert.equal(n10.window.in_progress, true);
    assert.equal(n10.window.end, '2030-01-01T14:30:00.000Z');
    assert.equal(n10.window.wall_s, 1800);
    assert.deepEqual(Object.keys(n10.tokens.by_model), ['model-small']);

    // 11:30 falls between windows: unassigned, not dropped
    assert.equal(j.unassigned.output_tokens, 10);
    assert.deepEqual(j.longest_night, { by_wall_clock: '1', by_active_time: '1' });
    assert.ok(j.method.api.includes('Estimate'));
    assert.match(r.stdout, /\* in progress/);
    assert.match(r.stdout, /longest: night 1/);
  } finally {
    x.cleanup();
  }
});

test('stats: code numbers from the pull requests, split by area', () => {
  const x = project();
  try {
    assert.equal(x.run().status, 0);
    const j = x.json();
    const c1 = j.nights['1'].code;
    assert.equal(c1.additions, 30);
    assert.equal(c1.deletions, 5);
    assert.equal(c1.files, 3);
    assert.equal(c1.commits, 2);
    assert.deepEqual(c1.areas, {
      docs: { additions: 5, deletions: 1, files: 1 },
      ios: { additions: 20, deletions: 3, files: 1 },
      web: { additions: 5, deletions: 1, files: 1 },
    });
    const c2 = j.nights['2'].code;
    assert.deepEqual(c2.prs.map((p) => p.number), [12, 13]);
    assert.equal(c2.additions, 10);
    assert.equal(c2.commits, 4);
    assert.equal(c2.areas.docs.files, 1); // README.md matches *.md
    assert.equal(c2.areas.web.additions, 5); // web/deep/y.ts matches web/**
    assert.equal(j.nights['10'].code, undefined);
    const log = readFileSync(x.p('gh.log'), 'utf8');
    assert.match(log, /pr view 11 -R example\/app/);
    assert.doesNotMatch(log, /\b(create|merge|edit|comment|close)\b/); // read-only
  } finally {
    x.cleanup();
  }
});

test('stats: --no-gh skips GitHub; a missing PR is a warning, not a failure', () => {
  const a = project();
  try {
    const r = a.run(['--no-gh']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(a.json().nights['1'].code, undefined);
  } finally {
    a.cleanup();
  }
  const b = project({ withGh: false });
  try {
    const r = b.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning: night 1 PR #11: gh/);
    assert.equal(b.json().nights['1'].code, undefined);
  } finally {
    b.cleanup();
  }
});

test('stats: CSV has one row per night and per-model columns', () => {
  const x = project();
  try {
    assert.equal(x.run().status, 0);
    const [head, ...rows] = readFileSync(x.p('out', 'nights-stats.csv'), 'utf8').trim().split('\n');
    const cols = head.split(',');
    assert.equal(rows.length, 3);
    for (const c of ['night', 'wall_h', 'active_h', 'tool_calls', 'api_h', 'output_tokens', 'additions', 'builds', 'api_h_model_big', 'output_tokens_model_small', 'additions_ios'])
      assert.ok(cols.includes(c), `missing column ${c}`);
    const row = Object.fromEntries(rows[0].split(',').map((v, i) => [cols[i], v]));
    assert.equal(row.night, '1');
    assert.equal(row.tool_calls, '4');
    assert.equal(row.builds, '701 702');
    assert.equal(row.in_progress, 'false');
  } finally {
    x.cleanup();
  }
});

test('stats: --night N writes only that night, to its own files', () => {
  const x = project();
  try {
    const r = x.run(['--night', '2', '--no-gh']);
    assert.equal(r.status, 0, r.stderr);
    const j = x.json('nights-stats.night-2.json');
    assert.deepEqual(Object.keys(j.nights), ['2']);
    assert.equal(j.longest_night, null);
    assert.equal(x.run(['--night', '9']).status, 2);
  } finally {
    x.cleanup();
  }
});

test('stats: --nights and --out override the config; the transcripts are not touched', () => {
  const x = project();
  try {
    const before = readFileSync(x.p('tx', 'proj-main', 'sess-a.jsonl'), 'utf8');
    writeFileSync(x.p('only2.json'), JSON.stringify({ nights: { 2: { start: t('12:00:00'), end: t('13:00:00') } } }));
    const r = x.run(['--nights', x.p('only2.json'), '--out', x.p('elsewhere'), '--no-gh']);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(readFileSync(x.p('elsewhere', 'nights-stats.json'), 'utf8'));
    assert.deepEqual(Object.keys(j.nights), ['2']);
    // no "sessions" list: every session under the pattern counts, and the 14:10 and 10:xx work is unassigned
    assert.equal(j.transcripts.session_filter, null);
    assert.ok(j.unassigned.output_tokens > 0);
    assert.equal(readFileSync(x.p('tx', 'proj-main', 'sess-a.jsonl'), 'utf8'), before);
  } finally {
    x.cleanup();
  }
});

test('stats: bad input is a clear error', () => {
  const x = project();
  try {
    writeFileSync(x.p('overlap.json'), JSON.stringify({ nights: { 1: { start: t('10:00:00'), end: t('11:00:00') }, 2: { start: t('10:30:00'), end: t('12:00:00') } } }));
    let r = x.run(['--nights', x.p('overlap.json')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /nights 1 and 2 overlap/);
    r = x.run(['--nights', x.p('missing.json')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read/);
    r = x.run(['--bogus']);
    assert.equal(r.status, 2);
  } finally {
    x.cleanup();
  }
});

test('stats: area globs and directory patterns', () => {
  const areas = compileAreas({ one: 'a/**', two: 'b/*.txt, docs/**/*.md', rest: '*.md' });
  assert.equal(areaOf('a/x/y.swift', areas), 'one');
  assert.equal(areaOf('b/f.txt', areas), 'two');
  assert.equal(areaOf('b/sub/f.txt', areas), 'other');
  assert.equal(areaOf('docs/a/b/c.md', areas), 'two');
  assert.equal(areaOf('docs/c.md', areas), 'two');
  assert.equal(areaOf('README.md', areas), 'rest');
  assert.equal(areaOf('sub/README.md', areas), 'other');

  const s = scratch();
  try {
    const root = realpathSync(s.dir);
    for (const d of ['p-main', 'p-main-wt1', 'p-main-wt2', 'p-other']) mkdirSync(join(root, d));
    writeFileSync(join(root, 'p-file'), 'x');
    assert.deepEqual(expandDirs([join(root, 'p-main*')]).map((d) => d.slice(root.length + 1)), ['p-main', 'p-main-wt1', 'p-main-wt2']);
    assert.deepEqual(expandDirs([join(root, 'p-other'), join(root, 'nope*'), join(root, 'p-file')]).map((d) => d.slice(root.length + 1)), ['p-other']);
  } finally {
    s.cleanup();
  }
});

test('config: [stats] validates, resolves {state_dir} and rejects unknown keys', () => {
  const x = project();
  try {
    let r = factory(['config', 'validate'], { cwd: x.root, env: x.env });
    assert.equal(r.status, 0, r.stderr);
    r = factory(['config', 'get', 'stats.transcripts'], { cwd: x.root, env: x.env });
    assert.equal(r.stdout.trim(), `${x.p('tx')}/proj-main*`);
    writeFileSync(x.p('factory.toml'), readFileSync(x.p('factory.toml'), 'utf8').replace('[stats.prices]', 'bogus_key = 1\n\n[stats.prices]'));
    r = factory(['config', 'validate'], { cwd: x.root, env: x.env });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown key 'bogus_key' in \[stats\]/);
  } finally {
    x.cleanup();
  }
});
