// Reads agent session transcripts (JSON lines) into plain aggregates. Streams every file; nothing
// but small per-message records is kept in memory. Nothing here knows which project the sessions are from.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const TRACKED = new Set(['user', 'assistant', 'system', 'attachment']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const segRegex = (seg) =>
  new RegExp(
    `^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`,
  );

/** Expands patterns like /root/projects/name* into existing directories. A * or ? may stand in any segment. */
export function expandDirs(patterns) {
  const found = new Set();
  for (const pat of patterns) {
    let cur = [pat.startsWith('/') ? '/' : '.'];
    for (const seg of pat.split('/').filter(Boolean)) {
      const next = [];
      for (const base of cur) {
        if (/[*?]/.test(seg)) {
          const re = segRegex(seg);
          let entries = [];
          try {
            entries = readdirSync(base, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of entries) if (e.isDirectory() && re.test(e.name)) next.push(join(base, e.name));
        } else next.push(join(base, seg));
      }
      cur = next;
    }
    for (const d of cur) if (isDir(d)) found.add(d);
  }
  return [...found].sort();
}

/**
 * Lists transcripts under the directories: <session>.jsonl (orchestrator) and
 * <session>/subagents/agent-*.jsonl (subagent, with its .meta.json when present).
 * `sessions` (optional) keeps only sessions whose id starts with one of the given prefixes.
 */
export function listTranscripts(dirs, sessions = null) {
  const keep = (id) => !sessions || sessions.some((s) => id.startsWith(s));
  const files = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.jsonl')) {
        const session = name.slice(0, -'.jsonl'.length);
        if (keep(session))
          files.push({ role: 'orchestrator', session, agentId: null, path: join(dir, name), meta: null });
      } else if (isDir(join(dir, name, 'subagents')) && keep(name)) {
        const sub = join(dir, name, 'subagents');
        for (const f of readdirSync(sub).sort()) {
          if (!f.endsWith('.jsonl')) continue;
          let meta = null;
          const metaPath = join(sub, f.slice(0, -'.jsonl'.length) + '.meta.json');
          if (existsSync(metaPath)) {
            try {
              meta = JSON.parse(readFileSync(metaPath, 'utf8'));
            } catch {
              meta = null;
            }
          }
          files.push({
            role: 'subagent',
            session: name,
            agentId: f.slice(0, -'.jsonl'.length).replace(/^agent-/, ''),
            path: join(sub, f),
            meta,
          });
        }
      }
    }
  }
  return files;
}

const GAP_CAP_MS = 20 * 60 * 1000; // one model turn never takes longer; a larger gap is a pause, not generation

/**
 * Scans the files into one aggregate:
 *  files[]      per file: role, session, first/last timestamp (ms), stamps[], model counts, meta
 *  messages     assistant messages, once each (a message is written once per content block with the
 *               same id and usage): tLast, prevT (the entry just before the message), model, usage
 *  toolUses     tool_use id -> { t, name, role };  results: id -> t of the tool_result
 *  agentCalls   tool calls that spawn a subagent
 *  asks         calls that ask the user a question
 * Entries are deduplicated by uuid, so a session that carries a copy of earlier history counts it once.
 */
export async function scan(files) {
  const acc = {
    files: [],
    messages: new Map(),
    toolUses: new Map(),
    results: new Map(),
    agentCalls: [],
    asks: [],
    badLines: 0,
  };
  const seen = new Set();
  for (const info of files) {
    const rec = { ...info, first: null, last: null, stamps: [], models: {} };
    acc.files.push(rec);
    let prevT = null;
    const rl = createInterface({ input: createReadStream(info.path), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        acc.badLines++;
        continue;
      }
      if (!TRACKED.has(o.type)) continue;
      const t = Date.parse(o.timestamp);
      if (!Number.isFinite(t)) continue;
      if (o.uuid) {
        if (seen.has(o.uuid)) continue;
        seen.add(o.uuid);
      }
      rec.stamps.push(t);
      if (rec.first === null || t < rec.first) rec.first = t;
      if (rec.last === null || t > rec.last) rec.last = t;

      if (o.type === 'assistant') {
        const m = o.message ?? {};
        const id = m.id ?? o.uuid;
        let msg = acc.messages.get(id);
        if (!msg) {
          msg = {
            id,
            role: info.role,
            file: rec,
            model: m.model ?? 'unknown',
            tLast: t,
            prevT,
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 },
          };
          acc.messages.set(id, msg);
          if (msg.model !== '<synthetic>') rec.models[msg.model] = (rec.models[msg.model] ?? 0) + 1;
        }
        if (t > msg.tLast) msg.tLast = t;
        const u = m.usage;
        if (u) {
          msg.usage.input = Math.max(msg.usage.input, u.input_tokens ?? 0);
          msg.usage.output = Math.max(msg.usage.output, u.output_tokens ?? 0);
          msg.usage.cache_read = Math.max(msg.usage.cache_read, u.cache_read_input_tokens ?? 0);
          msg.usage.cache_write = Math.max(msg.usage.cache_write, u.cache_creation_input_tokens ?? 0);
          msg.usage.cache_write_1h = Math.max(
            msg.usage.cache_write_1h,
            u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          );
        }
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type !== 'tool_use') continue;
            acc.toolUses.set(b.id, { t, name: b.name, role: info.role });
            if (SPAWN_TOOLS.has(b.name))
              acc.agentCalls.push({
                t,
                role: info.role,
                model: typeof b.input?.model === 'string' ? b.input.model : null,
                type: typeof b.input?.subagent_type === 'string' ? b.input.subagent_type : null,
              });
            if (b.name === 'AskUserQuestion') acc.asks.push({ t, role: info.role });
          }
        }
      } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
        for (const b of o.message.content)
          if (b?.type === 'tool_result' && b.tool_use_id && !acc.results.has(b.tool_use_id))
            acc.results.set(b.tool_use_id, t);
      }
      prevT = t;
    }
  }
  return acc;
}

export { GAP_CAP_MS };
