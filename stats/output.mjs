// Output: a flat CSV (one row per night) and the compact table printed to the terminal.

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

/** Flattens one night's JSON to a { column: value } row. Per-model and per-area columns are added as found. */
export function flatRow(night, n) {
  const row = {
    night,
    start: n.window.start,
    end: n.window.end,
    in_progress: n.window.in_progress,
    wall_h: n.window.wall_h,
    active_h: n.active_h,
    orchestrator_sessions: n.agents.orchestrator_sessions,
    agent_tool_calls: n.agents.agent_tool_calls,
    subagent_transcripts: n.agents.subagent_transcripts,
    tool_calls: n.tools.calls,
    tool_wall_h: n.tools.wall_h,
    tool_calls_orchestrator: n.tools.by_role.orchestrator.calls,
    tool_calls_subagents: n.tools.by_role.subagents.calls,
    tool_wall_s_orchestrator: n.tools.by_role.orchestrator.wall_s,
    tool_wall_s_subagents: n.tools.by_role.subagents.wall_s,
    api_h: n.api.total_h,
    api_s_orchestrator: n.api.by_role_s.orchestrator,
    api_s_subagents: n.api.by_role_s.subagents,
    input_tokens: n.tokens.total.input,
    output_tokens: n.tokens.total.output,
    cache_read_tokens: n.tokens.total.cache_read,
    cache_write_tokens: n.tokens.total.cache_write,
    cache_write_1h_tokens: n.tokens.total.cache_write_1h,
    user_questions: n.user_questions,
  };
  if (n.cost_usd) row.cost_usd = n.cost_usd.total;
  if (n.code) {
    row.prs = n.code.prs.map((p) => p.number).join(' ');
    row.additions = n.code.additions;
    row.deletions = n.code.deletions;
    row.files = n.code.files;
    row.commits = n.code.commits;
    for (const [a, v] of Object.entries(n.code.areas)) {
      row[`additions_${slug(a)}`] = v.additions;
      row[`deletions_${slug(a)}`] = v.deletions;
    }
  }
  if (n.outputs) {
    row.builds = n.outputs.builds.join(' ');
    row.builds_count = n.outputs.builds.length;
    row.items_shipped = n.outputs.items.shipped;
    row.items_blocked = n.outputs.items.blocked;
    row.items_open = n.outputs.items.open;
    row.blocked_log_lines = n.outputs.blocked_log_lines;
  }
  for (const [m, v] of Object.entries(n.api.by_model)) row[`api_h_${slug(m)}`] = v.h;
  for (const [m, v] of Object.entries(n.tokens.by_model)) {
    row[`output_tokens_${slug(m)}`] = v.output;
    row[`input_tokens_${slug(m)}`] = v.input;
    row[`cache_read_tokens_${slug(m)}`] = v.cache_read;
    row[`cache_write_tokens_${slug(m)}`] = v.cache_write;
  }
  for (const [m, c] of Object.entries(n.agents.subagent_transcripts_by_model)) row[`subagents_${slug(m)}`] = c;
  return row;
}

export function toCsv(rows) {
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

const pad = (s, w, left = false) => (left ? String(s).padEnd(w) : String(s).padStart(w));
const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const stamp = (iso) => iso.slice(5, 16).replace('T', ' ') + 'Z';

/** A compact fixed-width table, one row per night. */
export function table(nights) {
  const head = ['night', 'start (UTC)', 'wall h', 'active h', 'agents', 'tools', 'api h', 'out tok', '+lines', '-lines', 'builds', 'ship/blk', 'asks'];
  const rows = Object.entries(nights).map(([k, n]) => [
    k + (n.window.in_progress ? '*' : ''),
    stamp(n.window.start),
    n.window.wall_h.toFixed(1),
    n.active_h.toFixed(1),
    `${n.agents.subagent_transcripts}/${n.agents.agent_tool_calls}`,
    kfmt(n.tools.calls),
    n.api.total_h.toFixed(1),
    kfmt(n.tokens.total.output),
    n.code ? kfmt(n.code.additions) : '-',
    n.code ? kfmt(n.code.deletions) : '-',
    n.outputs ? String(n.outputs.builds.length) : '-',
    n.outputs ? `${n.outputs.items.shipped}/${n.outputs.items.blocked}` : '-',
    String(n.user_questions),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => pad(c, w[i], i === 1)).join('  ');
  return [line(head), line(w.map((x) => '-'.repeat(x))), ...rows.map(line)].join('\n');
}
