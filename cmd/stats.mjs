#!/usr/bin/env node
// desc: per-night statistics from agent session transcripts plus GitHub: time, agents, tools, tokens, code, outputs
// usage: factory stats [--nights <nights.json>] [--out <dir>] [--night N] [--no-gh]
//
// Reads [stats] in factory.toml (transcripts, nights, out, ...; see cmd/config.mjs). The windows file:
//   { "sessions": ["a1b2c3d4", ...],            optional: only these sessions (id prefixes) are counted
//     "nights": { "1": { "start": "<ISO UTC>", "end": "<ISO UTC>" | null, "prs": [12], "notes": "..." } } }
// A night with no end is in progress: it runs to now. Events outside every window are totalled under "unassigned".
// Writes nights-stats.json and nights-stats.csv to --out (nights-stats.night-N.* with --night) and prints a table.
// Transcripts and the windows file are only read. GitHub is read through `gh` (PR totals and per-file lines);
// --no-gh skips it. FK_NOW (an ISO time) replaces the clock, for tests.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from './config.mjs';
import { UNASSIGNED, compute, hours, makeWindows, parsePrices, present, sec } from '../stats/compute.mjs';
import { flatRow, table, toCsv } from '../stats/output.mjs';
import { compileAreas, fetchPr, readNightFile } from '../stats/sources.mjs';
import { expandDirs, listTranscripts, scan } from '../stats/transcripts.mjs';

const die = (msg, code = 1) => {
  console.error(`factory stats: ${msg}`);
  process.exit(code);
};

const METHOD = {
  window: 'Each night is the time window in the windows file. Every event is assigned by its own timestamp, not by session.',
  active:
    'Sum of the gaps between consecutive transcript entries (orchestrator and subagents merged, any session) that are shorter than idle_gap_s, clipped to the window.',
  agents:
    'agent_tool_calls = Agent/Task tool calls by timestamp; subagent_transcripts = subagent transcript files whose first entry is in the window, by their dominant model.',
  tools:
    'Tool wall time = tool_result timestamp minus tool_use timestamp. Parallel calls overlap, so the sum can exceed wall time. AskUserQuestion (a person answering) and Agent (the subagent runs in its own transcript) are counted as calls but left out of wall_s; Agent waits are in agent_wait_s. Calls with no result are in unmatched_calls. A call that took over an hour is a stall, not work: counted as a call, its time is in calls_over_1h_s instead of wall_s.',
  api:
    'Estimate of model hours: for each assistant message, the time from the entry just before it (a prompt or a tool result) to its last content block, assigned to the message timestamp and its model. That is generation plus API latency, as the transcript clock sees it. A turn longer than 20 minutes is treated as a pause and counted as 0 (turns_over_cap).',
  tokens:
    'Per model, from message usage, once per message (a message is logged once per content block with the same usage). cache_write = cache_creation_input_tokens, of which cache_write_1h were one-hour writes.',
  cost: 'List-price equivalent, only for models listed in [stats.prices] (dollars per million tokens); the kit ships no prices. Not what a subscription plan bills.',
};

function parseArgs(argv) {
  const a = { nights: null, out: null, night: null, gh: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) die(`${x} needs a value`, 2);
      return argv[++i];
    };
    if (x === '--nights') a.nights = val();
    else if (x === '--out') a.out = val();
    else if (x === '--night') a.night = String(val());
    else if (x === '--no-gh') a.gh = false;
    else if (x === '-h' || x === '--help') {
      console.log('usage: factory stats [--nights <nights.json>] [--out <dir>] [--night N] [--no-gh]');
      process.exit(0);
    } else die(`unknown argument: ${x}`, 2);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const tomlPath = process.env.FACTORY_TOML;
if (!tomlPath) die('run this through bin/factory (FACTORY_TOML is not set)', 2);
const cfg = load(readFileSync(tomlPath, 'utf8'));
if (cfg.errors.length) die(`${tomlPath} does not validate (run: factory config validate)`);
const stats = cfg.resolved.stats ?? {};
const project = cfg.resolved.project;

const nightsPath = args.nights ?? stats.nights;
if (!nightsPath) die('no windows file: pass --nights or set [stats] nights', 2);
const outDir = resolve(args.out ?? stats.out ?? join(project.state_dir, 'stats'));
if (!stats.transcripts?.length) die('[stats] transcripts is not set', 2);

let spec;
try {
  spec = JSON.parse(readFileSync(resolve(nightsPath), 'utf8'));
} catch (e) {
  die(`cannot read ${nightsPath}: ${e.code ?? e.message}`, 2);
}
if (!spec.nights || typeof spec.nights !== 'object') die(`${nightsPath}: "nights" is missing`, 2);

const now = process.env.FK_NOW ? Date.parse(process.env.FK_NOW) : Date.now();
let windows;
try {
  windows = makeWindows(spec.nights, now);
} catch (e) {
  die(`${nightsPath}: ${e.message}`, 2);
}
if (args.night && !spec.nights[args.night]) die(`no night ${args.night} in ${nightsPath}`, 2);

const dirs = expandDirs(stats.transcripts);
if (!dirs.length) die(`no transcript directory matches: ${stats.transcripts.join(', ')}`);
const files = listTranscripts(dirs, Array.isArray(spec.sessions) && spec.sessions.length ? spec.sessions : null);
if (!files.length) die('no transcripts found');

const acc = await scan(files);
const buckets = compute(acc, windows, { idleGapMs: (stats.idle_gap_s ?? 600) * 1000 });
const prices = parsePrices(stats.prices);
const areas = compileAreas(stats.areas);
const repo = cfg.resolved.git?.github;
const warnings = [];
if (args.gh && !repo) warnings.push('[git] github is not set: no code numbers');

const nights = {};
for (const w of windows) {
  const key = w.night;
  if (args.night && key !== args.night) continue;
  const n = present(buckets.get(key), prices);
  const def = spec.nights[key];
  n.window = {
    start: new Date(w.start).toISOString(),
    end: new Date(w.end).toISOString(),
    in_progress: w.in_progress,
    wall_s: sec(w.end - w.start),
    wall_h: hours(w.end - w.start),
  };
  if (def.notes) n.notes = def.notes;

  if (args.gh && repo && Array.isArray(def.prs) && def.prs.length) {
    const prs = [];
    for (const num of def.prs) {
      try {
        prs.push(fetchPr(repo, num, areas));
      } catch (e) {
        warnings.push(`night ${key} PR #${num}: ${e.message}`);
      }
    }
    if (prs.length) {
      const sum = (f) => prs.reduce((acc, p) => acc + f(p), 0);
      const byArea = {};
      for (const p of prs)
        for (const [a, v] of Object.entries(p.areas)) {
          const t = (byArea[a] ??= { additions: 0, deletions: 0, files: 0 });
          t.additions += v.additions;
          t.deletions += v.deletions;
          t.files += v.files;
        }
      n.code = {
        prs,
        additions: sum((p) => p.additions),
        deletions: sum((p) => p.deletions),
        files: sum((p) => p.files),
        commits: sum((p) => p.commits),
        areas: Object.fromEntries(Object.entries(byArea).sort()),
      };
    }
  }

  const nf = readNightFile(project.night_file.replace('{n}', key), stats.build_pattern);
  if (nf) {
    n.outputs = {
      builds: nf.builds,
      items: nf.items,
      blocked_log_lines: nf.blocked_log_lines,
      log_lines: nf.log_lines,
      user_decisions: n.user_questions,
    };
  } else warnings.push(`night ${key}: no night file at ${project.night_file.replace('{n}', key)}`);
  nights[key] = n;
}

const ranked = (f) =>
  Object.entries(nights)
    .sort((a, b) => f(b[1]) - f(a[1]))
    .map(([k]) => k)[0] ?? null;
const un = present(buckets.get(UNASSIGNED), prices);
const result = {
  generated_at: new Date(now).toISOString(),
  windows_file: resolve(nightsPath),
  idle_gap_s: stats.idle_gap_s ?? 600,
  transcripts: {
    directories: dirs.length,
    orchestrator_files: files.filter((f) => f.role === 'orchestrator').length,
    subagent_files: files.filter((f) => f.role === 'subagent').length,
    unparsable_lines: acc.badLines,
    session_filter: Array.isArray(spec.sessions) ? spec.sessions : null,
  },
  method: METHOD,
  longest_night: args.night ? null : { by_wall_clock: ranked((n) => n.window.wall_s), by_active_time: ranked((n) => n.active_s) },
  nights,
  unassigned: {
    note: 'Events in the scanned sessions that fall outside every night window.',
    active_h: un.active_h,
    tool_calls: un.tools.calls,
    api_h: un.api.total_h,
    output_tokens: un.tokens.total.output,
    subagent_transcripts: un.agents.subagent_transcripts,
  },
  warnings,
};

mkdirSync(outDir, { recursive: true });
const suffix = args.night ? `.night-${args.night}` : '';
writeFileSync(join(outDir, `nights-stats${suffix}.json`), JSON.stringify(result, null, 2) + '\n');
writeFileSync(join(outDir, `nights-stats${suffix}.csv`), toCsv(Object.entries(nights).map(([k, n]) => flatRow(k, n))));

console.log(table(nights));
if (Object.values(nights).some((n) => n.window.in_progress)) console.log('* in progress (window runs to now)');
if (result.longest_night)
  console.log(
    `longest: night ${result.longest_night.by_wall_clock} by wall clock, night ${result.longest_night.by_active_time} by active time`,
  );
for (const w of warnings) console.error(`warning: ${w}`);
console.error(`wrote ${join(outDir, `nights-stats${suffix}.json`)} and .csv`);
