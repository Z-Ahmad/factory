// Turns a transcript scan into per-night numbers. A night is a time window; every event goes to
// the window its timestamp falls in, whichever session it came from. Events outside every window
// land in "unassigned" so nothing is silently dropped.
import { GAP_CAP_MS } from './transcripts.mjs';

export const UNASSIGNED = 'unassigned';

const ROLES = ['orchestrator', 'subagent'];
// Tools whose duration is not the machine's time: a person answering, or a subagent running (its own
// transcript carries that time).
const NOT_WALL = new Set(['AskUserQuestion', 'Agent', 'Task']);
// A tool call that takes longer than this is a stalled one (a sleeping machine, a lost process), not work:
// it is counted as a call but its time goes to long_calls, not to wall time.
const LONG_TOOL_MS = 60 * 60 * 1000;

const zeroTok = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0, messages: 0 });
const addTok = (a, b) => {
  a.input += b.input;
  a.output += b.output;
  a.cache_read += b.cache_read;
  a.cache_write += b.cache_write;
  a.cache_write_1h += b.cache_write_1h;
  a.messages += b.messages ?? 1;
};

function blank() {
  return {
    active_ms: 0,
    agent_calls: 0,
    agent_calls_by_requested_model: {},
    subagent_transcripts: 0,
    subagent_by_model: {},
    orchestrator_ids: new Set(),
    orchestrator_models: {},
    tools: { calls: 0, wall_ms: 0, byRole: {}, byName: {}, unmatched: 0, agent_wait_ms: 0, long_calls: 0, long_ms: 0 },
    api: { total_ms: 0, byModel: {}, byRole: {}, capped: 0 },
    tokens: { byModel: {}, byRole: {}, total: zeroTok() },
    user_questions: 0,
  };
}

export function makeWindows(nights, nowMs) {
  const list = Object.entries(nights).map(([night, w]) => {
    const start = Date.parse(w.start);
    if (!Number.isFinite(start)) throw new Error(`night ${night}: bad start ${JSON.stringify(w.start)}`);
    const open = w.end === undefined || w.end === null;
    const end = open ? nowMs : Date.parse(w.end);
    if (!Number.isFinite(end)) throw new Error(`night ${night}: bad end ${JSON.stringify(w.end)}`);
    if (end < start) throw new Error(`night ${night}: end is before start`);
    return { night, start, end, in_progress: open };
  });
  list.sort((a, b) => a.start - b.start);
  for (let i = 1; i < list.length; i++)
    if (list[i].start < list[i - 1].end)
      throw new Error(`nights ${list[i - 1].night} and ${list[i].night} overlap`);
  return list;
}

export function compute(acc, windows, { idleGapMs }) {
  const buckets = new Map([[UNASSIGNED, blank()]]);
  for (const w of windows) buckets.set(w.night, blank());
  const nightOf = (t) => {
    for (const w of windows) if (t >= w.start && t < w.end) return w.night;
    // the closing instant belongs to the last window that ends there
    for (const w of windows) if (t === w.end) return w.night;
    return UNASSIGNED;
  };
  const B = (t) => buckets.get(nightOf(t));

  // -- active time: gaps shorter than the idle limit between consecutive entries, all sessions merged
  const stamps = acc.files.flatMap((f) => f.stamps).sort((a, b) => a - b);
  for (let i = 1; i < stamps.length; i++) {
    const a = stamps[i - 1];
    const b = stamps[i];
    const gap = b - a;
    if (gap <= 0 || gap >= idleGapMs) continue;
    let inside = 0;
    for (const w of windows) {
      const ov = Math.min(b, w.end) - Math.max(a, w.start);
      if (ov > 0) {
        buckets.get(w.night).active_ms += ov;
        inside += ov;
      }
    }
    buckets.get(UNASSIGNED).active_ms += gap - inside;
  }

  // -- orchestrator sessions and subagent transcripts
  for (const f of acc.files) {
    if (f.role === 'orchestrator') {
      for (const t of f.stamps) B(t).orchestrator_ids.add(f.session);
    } else if (f.first !== null) {
      const b = B(f.first);
      b.subagent_transcripts++;
      const top = Object.entries(f.models).sort((x, y) => y[1] - x[1])[0]?.[0] ?? f.meta?.model ?? 'unknown';
      b.subagent_by_model[top] = (b.subagent_by_model[top] ?? 0) + 1;
    }
  }
  for (const c of acc.agentCalls) {
    const b = B(c.t);
    b.agent_calls++;
    const k = c.model ?? 'default';
    b.agent_calls_by_requested_model[k] = (b.agent_calls_by_requested_model[k] ?? 0) + 1;
  }
  for (const q of acc.asks) B(q.t).user_questions++;

  // -- model turns: tokens, and the time each one took
  for (const m of acc.messages.values()) {
    if (m.model === '<synthetic>') continue;
    const b = B(m.tLast);
    const tok = { ...m.usage, messages: 1 };
    addTok((b.tokens.byModel[m.model] ??= zeroTok()), tok);
    addTok((b.tokens.byRole[m.role] ??= zeroTok()), tok);
    addTok(b.tokens.total, tok);
    b.orchestrator_models[m.model] = (b.orchestrator_models[m.model] ?? 0) + (m.role === 'orchestrator' ? 1 : 0);
    let dt = m.prevT === null ? 0 : m.tLast - m.prevT;
    if (dt < 0) dt = 0;
    if (dt > GAP_CAP_MS) {
      dt = 0;
      b.api.capped++;
    }
    b.api.total_ms += dt;
    const bm = (b.api.byModel[m.model] ??= { total_ms: 0, orchestrator_ms: 0, subagent_ms: 0, turns: 0 });
    bm.total_ms += dt;
    bm[`${m.role}_ms`] += dt;
    bm.turns++;
    b.api.byRole[m.role] = (b.api.byRole[m.role] ?? 0) + dt;
  }

  // -- tool calls: use -> result
  for (const [id, u] of acc.toolUses) {
    const b = B(u.t);
    const r = acc.results.get(id);
    b.tools.calls++;
    const role = (b.tools.byRole[u.role] ??= { calls: 0, wall_ms: 0 });
    role.calls++;
    const nm = (b.tools.byName[u.name] ??= { calls: 0, wall_ms: 0, counted: !NOT_WALL.has(u.name) });
    nm.calls++;
    if (r === undefined) {
      b.tools.unmatched++;
      continue;
    }
    const dt = Math.max(0, r - u.t);
    if (dt > LONG_TOOL_MS && !NOT_WALL.has(u.name)) {
      b.tools.long_calls++;
      b.tools.long_ms += dt;
      continue;
    }
    nm.wall_ms += dt;
    if (NOT_WALL.has(u.name)) {
      if (u.name !== 'AskUserQuestion') b.tools.agent_wait_ms += dt;
    } else {
      b.tools.wall_ms += dt;
      role.wall_ms += dt;
    }
  }
  return buckets;
}

const sec = (ms) => Math.round(ms / 1000);
const hours = (ms) => Math.round((ms / 3_600_000) * 100) / 100;
const tokenObj = (t) => ({
  input: t.input,
  output: t.output,
  cache_read: t.cache_read,
  cache_write: t.cache_write,
  cache_write_1h: t.cache_write_1h,
  messages: t.messages,
});

/**
 * Parses prices into numbers; malformed entries are skipped. Dollars per million tokens:
 * "input,output,cache_read,cache_write[,cache_write_1h]" (cache_write is the 5-minute rate; without a
 * fifth number one-hour writes are priced like five-minute ones).
 */
export function parsePrices(map = {}) {
  const out = {};
  for (const [model, v] of Object.entries(map)) {
    const n = String(v).split(',').map((x) => Number(x.trim()));
    if ((n.length === 4 || n.length === 5) && n.every((x) => Number.isFinite(x) && x >= 0))
      out[model] = { input: n[0], output: n[1], cache_read: n[2], cache_write: n[3], cache_write_1h: n[4] ?? n[3] };
  }
  return out;
}

/** The JSON shape of one bucket. */
export function present(bucket, prices = {}) {
  const t = bucket.tools;
  const byModelTokens = Object.fromEntries(
    Object.entries(bucket.tokens.byModel)
      .sort()
      .map(([k, v]) => [k, tokenObj(v)]),
  );
  const out = {
    active_s: sec(bucket.active_ms),
    active_h: hours(bucket.active_ms),
    agents: {
      agent_tool_calls: bucket.agent_calls,
      agent_tool_calls_by_requested_model: bucket.agent_calls_by_requested_model,
      subagent_transcripts: bucket.subagent_transcripts,
      subagent_transcripts_by_model: Object.fromEntries(Object.entries(bucket.subagent_by_model).sort()),
      orchestrator_sessions: bucket.orchestrator_ids.size,
      orchestrator_session_ids: [...bucket.orchestrator_ids].sort(),
      orchestrator_turns_by_model: Object.fromEntries(
        Object.entries(bucket.orchestrator_models)
          .filter(([, n]) => n > 0)
          .sort(),
      ),
    },
    tools: {
      calls: t.calls,
      wall_s: sec(t.wall_ms),
      wall_h: hours(t.wall_ms),
      by_role: Object.fromEntries(
        ROLES.map((r) => [
          r === 'subagent' ? 'subagents' : r,
          { calls: t.byRole[r]?.calls ?? 0, wall_s: sec(t.byRole[r]?.wall_ms ?? 0) },
        ]),
      ),
      agent_wait_s: sec(t.agent_wait_ms),
      unmatched_calls: t.unmatched,
      calls_over_1h: t.long_calls,
      calls_over_1h_s: sec(t.long_ms),
      top: Object.entries(t.byName)
        .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
        .slice(0, 12)
        .map(([tool, v]) => ({ tool, calls: v.calls, wall_s: sec(v.wall_ms), counted_in_wall: v.counted })),
    },
    api: {
      total_s: sec(bucket.api.total_ms),
      total_h: hours(bucket.api.total_ms),
      by_role_s: Object.fromEntries(
        ROLES.map((r) => [r === 'subagent' ? 'subagents' : r, sec(bucket.api.byRole[r] ?? 0)]),
      ),
      by_model: Object.fromEntries(
        Object.entries(bucket.api.byModel)
          .sort()
          .map(([k, v]) => [
            k,
            {
              s: sec(v.total_ms),
              h: hours(v.total_ms),
              orchestrator_s: sec(v.orchestrator_ms),
              subagents_s: sec(v.subagent_ms),
              turns: v.turns,
            },
          ]),
      ),
      turns_over_cap: bucket.api.capped,
    },
    tokens: {
      total: tokenObj(bucket.tokens.total),
      by_model: byModelTokens,
      by_role: Object.fromEntries(
        ROLES.map((r) => [r === 'subagent' ? 'subagents' : r, tokenObj(bucket.tokens.byRole[r] ?? zeroTok())]),
      ),
    },
    user_questions: bucket.user_questions,
  };
  const priced = Object.entries(byModelTokens).filter(([m]) => prices[m]);
  if (priced.length) {
    const per = {};
    let total = 0;
    for (const [m, tk] of priced) {
      const p = prices[m];
      const w5 = tk.cache_write - tk.cache_write_1h;
      const usd =
        (tk.input * p.input + tk.output * p.output + tk.cache_read * p.cache_read + w5 * p.cache_write + tk.cache_write_1h * p.cache_write_1h) /
        1e6;
      per[m] = Math.round(usd * 100) / 100;
      total += usd;
    }
    out.cost_usd = {
      total: Math.round(total * 100) / 100,
      by_model: per,
      unpriced_models: Object.keys(byModelTokens).filter((m) => !prices[m]),
    };
  }
  return out;
}

export { hours, sec };
