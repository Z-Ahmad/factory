#!/usr/bin/env node
// Live agents' context size, from the same transcripts `factory stats` reads ([stats] transcripts).
//   node stats/context.mjs --wrap-k <K> [--within-min N]
// An agent is live when its transcript was written in the last N minutes (default 10). Its context is the last
// assistant message's input + cache read + cache write tokens. Prints one line per live agent past K thousand:
//   WRAP: <subagent <id> (<description>) | orchestrator> in <session> is at <n>k context, over [loop] wrap_context_k = K: ...
// and nothing otherwise. Exit 0 (2 on a bad argument). Reads only the tail of each live transcript.
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { expandDirs, listTranscripts } from './transcripts.mjs';

const TAIL = 512 * 1024;

/** The context (tokens) the last assistant message in the file carried, or null when the tail has none. */
export function lastContext(path) {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"') || !lines[i].includes('"usage"')) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; } // the first line of the tail is usually cut
      const u = o.type === 'assistant' ? o.message?.usage : null;
      if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** [{ who, session, tokens }] for transcripts written within `withinMin` minutes of `now`. */
export function liveContexts(dirs, { withinMin = 10, now = Date.now() } = {}) {
  const out = [];
  for (const f of listTranscripts(dirs)) {
    let st;
    try { st = statSync(f.path); } catch { continue; }
    if (now - st.mtimeMs > withinMin * 60e3) continue;
    const tokens = lastContext(f.path);
    if (tokens === null) continue;
    const desc = typeof f.meta?.description === 'string' ? ` (${f.meta.description})` : '';
    out.push({ who: f.role === 'subagent' ? `subagent ${f.agentId}${desc}` : 'orchestrator', session: f.session, tokens });
  }
  return out;
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const k = Number(opt('--wrap-k') ?? 400), within = Number(opt('--within-min') ?? 10);
  if (!(k > 0) || !(within > 0)) {
    console.error('usage: node stats/context.mjs --wrap-k <K> [--within-min N]');
    return 2;
  }
  const dirs = expandDirs((process.env.FK_STATS_TRANSCRIPTS ?? '').split('\n').filter(Boolean));
  for (const a of liveContexts(dirs, { withinMin: within })) {
    if (a.tokens <= k * 1000) continue;
    console.log(`WRAP: ${a.who} in ${a.session} is at ${Math.round(a.tokens / 1000)}k context, over [loop] wrap_context_k = ${k}: tell it to wrap up and hand back a patch`);
  }
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked) process.exitCode = main(process.argv.slice(2));
