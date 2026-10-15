// Claude Code PreToolUse hook: blocks the actions a project's factory.toml forbids.
//
// Reads the hook JSON on stdin ({ tool_name, tool_input, cwd, ... }). To deny it prints
// { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } }
// on stdout and exits 0 (the documented JSON form; exit 2 + stderr is the simple alternative, but the two
// must not be mixed). To allow it prints nothing and exits 0. It never crashes closed: any internal error
// allows the call and warns on stderr.
//
// Rules (every value comes from factory.toml; nothing project-specific lives here):
//   1. Edit/Write/MultiEdit/NotebookEdit (and Bash redirects / tee) to a [never_touch] paths glob.
//   2. Bash running a [never_touch] never_run_in_worktree script from inside a linked worktree.
//   3. Bash: pushing to a [git] never_push branch, any forced push, --no-verify (and its bypasses).
//   4. Bash: `gh pr merge`, unless [loop] allow_merge = true.
//   5. Bash: starting the dev stack, or killing it by port or name, when [dev] agents_may_start = false.
//
// The Bash command is tokenized by a small quote-aware shell scanner, so text inside a quoted string,
// a heredoc or a comment is never mistaken for a command.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseToml } from '../cmd/config.mjs';

class Deny extends Error {}
const deny = (msg) => {
  throw new Deny(msg);
};

// ---------------------------------------------------------------- globs

const globToRe = (g) => {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i'); // macOS volumes are case-insensitive
};
const globs = (list) => (list ?? []).map((src) => ({ src, re: globToRe(src.replace(/^\.\//, '')) }));
const anyGlob = (gs, text) => gs.find((g) => g.re.test(text))?.src ?? null;

// Template files (".env.example") hold no secrets and are meant to be committed and edited.
const TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist|tpl)$/i;

// ------------------------------------------------------------ filesystem

const expandTilde = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p);

/** realpath of the deepest existing ancestor, plus the (not yet existing) rest. */
function realish(p) {
  let cur = p;
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Cheap, git-free repo facts for the directory `dir`: { top, gitdir, common, linked } or null. */
function gitInfo(dir) {
  let d = dir;
  for (;;) {
    const g = join(d, '.git');
    let st = null;
    try {
      st = statSync(g);
    } catch {
      /* none here */
    }
    if (st) {
      if (st.isDirectory()) return { top: d, gitdir: g, common: g, linked: false };
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
      if (!m) return null;
      const gitdir = resolve(d, m[1].trim());
      let common = gitdir;
      try {
        common = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
      } catch {
        /* a submodule or a plain gitdir: not a linked worktree */
      }
      return { top: d, gitdir, common, linked: common !== gitdir };
    }
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

const currentBranch = (info) => {
  try {
    return /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(info.gitdir, 'HEAD'), 'utf8'))?.[1].trim() ?? null;
  } catch {
    return null;
  }
};

// ----------------------------------------------------------- shell scanner

// Splits a Bash command into simple-command segments of words. Handles single/double quotes, backslashes,
// comments, heredocs (bodies dropped), redirects (collected apart), `$( )` / backtick / `( )` substitutions
// (their commands become segments too), and ; & | && || newline separators. Not a full shell: just enough that
// quoted text, heredoc bodies and comments never look like commands.
const OP_WORD = /^(?:\d*|&)(>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)([\s\S]*)$/;

function scan(src, start, mode, out) {
  let i = start;
  let words = [];
  let redirs = [];
  let cur = null; // { v, fu } : value, first char unquoted
  let pending = null; // { kind: 'out' | 'skip' | 'heredoc', strip }
  let depth = 0;
  const heredocs = [];

  const endSeg = () => {
    if (words.length || redirs.length) out.push({ words, redirs });
    words = [];
    redirs = [];
    pending = null;
  };
  const endWord = () => {
    if (!cur) return;
    const w = cur;
    cur = null;
    if (pending) {
      const p = pending;
      pending = null;
      if (p.kind === 'out') redirs.push(w.v);
      else if (p.kind === 'heredoc') heredocs.push({ delim: w.v, strip: p.strip });
      return;
    }
    const m = w.fu ? OP_WORD.exec(w.v) : null;
    if (!m) {
      words.push(w.v);
      return;
    }
    const [, op, rest] = m;
    const kind = op === '>' || op === '>>' || op === '>|' ? 'out' : op === '<<' || op === '<<-' ? 'heredoc' : 'skip';
    if (rest) {
      if (kind === 'out') redirs.push(rest);
      else if (kind === 'heredoc') heredocs.push({ delim: rest, strip: op === '<<-' });
    } else pending = { kind, strip: op === '<<-' };
  };
  const add = (text, fu) => {
    if (!cur) cur = { v: '', fu };
    cur.v += text;
  };
  const readHeredocs = () => {
    for (const h of heredocs) {
      for (;;) {
        if (i >= src.length) break;
        let e = src.indexOf('\n', i);
        if (e === -1) e = src.length;
        const line = src.slice(i, e);
        i = Math.min(e + 1, src.length);
        if ((h.strip ? line.replace(/^\t+/, '') : line).trimEnd() === h.delim) break;
      }
    }
    heredocs.length = 0;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '\n') {
      endWord();
      endSeg();
      i++;
      if (heredocs.length) readHeredocs();
    } else if (c === ';' || c === '|') {
      endWord();
      endSeg();
      i++;
    } else if (c === '&') {
      if (src[i - 1] === '>' || src[i - 1] === '<' || src[i + 1] === '>') {
        add('&', !cur);
        i++;
      } else {
        endWord();
        endSeg();
        i++;
      }
    } else if (c === '(') {
      // `$(` leaves a marker word so a command can tell its argument is a substitution; `<(` / `>(` leave nothing.
      let marker = false;
      if (cur?.v.endsWith('$')) {
        const before = cur.v.slice(0, -1);
        if (before) words.push(before);
        marker = true;
      }
      cur = null;
      pending = null;
      if (marker) words.push('$(');
      endSeg();
      depth++;
      i++;
    } else if (c === ')') {
      endWord();
      endSeg();
      i++;
      if (depth === 0 && mode === 'paren') return i;
      if (depth > 0) depth--;
    } else if (c === '`') {
      endWord();
      if (mode === 'tick') {
        endSeg();
        return i + 1;
      }
      words.push('`');
      endSeg();
      i = scan(src, i + 1, 'tick', out);
    } else if (c === '#' && !cur) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      const end = e === -1 ? src.length : e;
      add(src.slice(i + 1, end), false);
      i = end + 1;
    } else if (c === '"') {
      if (!cur) cur = { v: '', fu: false };
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i];
        if (d === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          if (n === '\n') {
            /* continuation */
          } else if ('$"\\`'.includes(n)) cur.v += n;
          else cur.v += d + n;
          i += 2;
        } else if (d === '$' && src[i + 1] === '(') {
          const from = i;
          i = scan(src, i + 2, 'paren', out);
          cur.v += src.slice(from, i);
        } else if (d === '`') {
          const from = i;
          i = scan(src, i + 1, 'tick', out);
          cur.v += src.slice(from, i);
        } else {
          cur.v += d;
          i++;
        }
      }
      i++;
    } else if (c === '\\') {
      if (src[i + 1] === '\n') i += 2;
      else {
        add(src[i + 1] ?? '', false);
        i += 2;
      }
    } else {
      add(c, !cur);
      i++;
    }
  }
  endWord();
  endSeg();
  return i;
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'coproc']);
const takes = (set, w) => set.includes(w);

/** First real command of a segment, looking through env assignments, keywords and wrappers. */
function commandOf(ws) {
  let i = 0;
  const env = {};
  let viaXargs = false;
  const eatAssigns = () => {
    while (i < ws.length && ASSIGN.test(ws[i])) {
      const m = ASSIGN.exec(ws[i]);
      env[m[1]] = ws[i].slice(m[0].length);
      i++;
    }
  };
  for (let guard = 0; guard < 40; guard++) {
    eatAssigns();
    if (i >= ws.length) return null;
    const w = ws[i];
    if (KEYWORDS.has(w)) {
      i++;
      continue;
    }
    const b = basename(w);
    if (b === 'env') {
      i++;
      while (i < ws.length) {
        if (ASSIGN.test(ws[i])) eatAssigns();
        else if (takes(['-u', '-C', '-S'], ws[i])) i += 2;
        else if (ws[i].startsWith('-')) i++;
        else break;
      }
    } else if (b === 'sudo' || b === 'doas') {
      i++;
      while (ws[i]?.startsWith('-')) i += takes(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'], ws[i]) ? 2 : 1;
    } else if (['nohup', 'exec', 'command', 'builtin', 'setsid', 'caffeinate', 'unbuffer'].includes(b)) {
      i++;
      while (ws[i]?.startsWith('-')) {
        if (b === 'command' && /^-[a-zA-Z]*[vV]/.test(ws[i])) return null; // a lookup, not a run
        i++;
      }
    } else if (b === 'nice') {
      i++;
      while (ws[i]?.startsWith('-')) i += ws[i] === '-n' ? 2 : 1;
    } else if (b === 'timeout') {
      i++;
      while (ws[i]?.startsWith('-')) i += takes(['-s', '-k'], ws[i]) ? 2 : 1;
      i++; // the duration
    } else if (b === 'xargs') {
      viaXargs = true;
      i++;
      while (ws[i]?.startsWith('-')) i += takes(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-J'], ws[i]) ? 2 : 1;
    } else if (b === 'npx' || b === 'bunx') {
      i++;
      while (ws[i]?.startsWith('-')) i += takes(['-p', '--package'], ws[i]) ? 2 : 1;
    } else return { name: b, raw: w, args: ws.slice(i + 1), env, viaXargs };
  }
  return null;
}

// ------------------------------------------------------------------ rules

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const SCRIPT_RUNNERS = new Set([...SHELLS, 'source', '.', 'node', 'python', 'python3', 'ruby', 'perl', 'tsx', 'deno', 'bun']);

const NPM_FAMILY = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const DEV_SCRIPTS = new Set(['dev', 'dev:local']);

/** Arguments with options and their values removed: [positionals, optionTokens]. */
function split(args, valueOpts) {
  const pos = [];
  const opts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      opts.push(a);
      if (valueOpts.includes(a)) i++;
    } else pos.push(a);
  }
  return [pos, opts];
}

const GIT_GLOBAL_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'];
const HOOK_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'am']);
const COMMIT_VALUE = ['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer'];
const PUSH_VALUE = ['-o', '--push-option', '--receive-pack', '--exec', '--repo'];

function checkGit(c, ctx) {
  let i = 0;
  let dir = ctx.cwd;
  const cfg = [];
  const a = c.args;
  while (i < a.length && a[i].startsWith('-')) {
    const o = a[i];
    if (o === '-C') {
      dir = resolve(dir, expandTilde(a[i + 1] ?? '.'));
      i += 2;
    } else if (o === '-c') {
      cfg.push(a[i + 1] ?? '');
      i += 2;
    } else i += takes(GIT_GLOBAL_VALUE, o) ? 2 : 1;
  }
  const sub = a[i];
  if (!sub) return;
  const rest = a.slice(i + 1);

  if (HOOK_SUBS.has(sub)) {
    if (cfg.some((kv) => /^core\.hookspath=/i.test(kv)))
      deny(`overriding core.hooksPath to skip hooks on git ${sub} is blocked (built-in rule: never bypass the commit gate; no toml key)`);
    if (c.env.HUSKY === '0' || c.env.HUSKY_SKIP_HOOKS)
      deny(`HUSKY=0 to skip hooks on git ${sub} is blocked (built-in rule: never bypass the commit gate; no toml key)`);
  }

  if (sub === 'commit' || sub === 'push' || sub === 'merge' || sub === 'rebase' || sub === 'am') {
    const valueOpts = sub === 'commit' ? COMMIT_VALUE : sub === 'push' ? PUSH_VALUE : [];
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (t === '--') break;
      if (t === '--no-verify') deny(`--no-verify on git ${sub} is blocked (built-in rule: never skip the hooks; no toml key)`);
      if (t.startsWith('--')) {
        if (!t.includes('=') && valueOpts.includes(t)) k++;
      } else if (t.startsWith('-') && t.length > 1) {
        // short cluster: letters until one that takes a value (its value is the rest of the cluster or the next word)
        for (let j = 1; j < t.length; j++) {
          const ch = t[j];
          if (sub === 'commit' && ch === 'n') deny('`git commit -n` is --no-verify, which is blocked (built-in rule: never skip the hooks; no toml key)');
          if (valueOpts.includes(`-${ch}`)) {
            if (j === t.length - 1) k++;
            break;
          }
        }
      }
    }
  }

  if (sub === 'push') checkPush(rest, dir, ctx);
}

function checkPush(rest, dir, ctx) {
  const [pos, opts] = split(rest, PUSH_VALUE);
  for (const o of opts) {
    if (o === '--force' || o === '--force-if-includes' || o.startsWith('--force-with-lease'))
      deny('force-pushing is blocked (built-in rule: never force-push; no toml key)');
    if (!o.startsWith('--'))
      for (const ch of o.slice(1)) {
        if (ch === 'f') deny('force-pushing (-f) is blocked (built-in rule: never force-push; no toml key)');
        if (ch === 'o') break;
      }
    if (o === '--all' || o === '--mirror')
      deny(`git push ${o} would push every branch, including those in [git] never_push (git.never_push = ${JSON.stringify(ctx.neverPush.map((g) => g.src))})`);
  }
  if (!ctx.neverPush.length) return;
  const key = `git.never_push = ${JSON.stringify(ctx.neverPush.map((g) => g.src))}`;
  const info = () => gitInfo(dir);
  let branch;
  const current = () => (branch === undefined ? (branch = (() => { const g = info(); return g ? currentBranch(g) : null; })()) : branch);

  const refspecs = pos.slice(1);
  if (refspecs.length === 0) {
    const cb = current();
    if (cb && anyGlob(ctx.neverPush, cb)) deny(`pushing the current branch '${cb}' is blocked (${key})`);
    return;
  }
  for (const spec of refspecs) {
    if (spec.startsWith('+')) deny('force-pushing a +refspec is blocked (built-in rule: never force-push; no toml key)');
    let dst = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
    dst = dst.replace(/^refs\/heads\//, '');
    if (dst === 'HEAD') dst = current() ?? '';
    if (!dst) continue;
    if (dst.includes('*')) deny(`pushing a wildcard refspec '${spec}' could update a protected branch (${key})`);
    if (anyGlob(ctx.neverPush, dst)) deny(`pushing to '${dst}' is blocked (${key})`);
  }
}

function checkGh(c, ctx) {
  const [pos] = split(c.args, ['-R', '--repo']);
  if (pos[0] === 'pr' && pos[1] === 'merge' && !ctx.allowMerge)
    deny('`gh pr merge` is blocked: the user merges (loop.allow_merge is not true)');
  if (pos[0] === 'api' && !ctx.allowMerge && c.args.some((x) => /\/pulls\/\d+\/merge\/?$/.test(x) || x.includes('mergePullRequest')))
    deny('merging a pull request through `gh api` is blocked: the user merges (loop.allow_merge is not true)');
}

function checkDevStart(c, ctx) {
  if (!ctx.devLocked) return;
  const toks = [c.name, ...c.args];
  const startsWith = (cmd) => {
    const t = (cmd ?? '').trim().split(/\s+/).filter(Boolean);
    return t.length > 0 && t.every((x, k) => toks[k] === x);
  };
  const msg = 'agents may not start the dev stack (dev.agents_may_start = false): use `factory dev-up`';
  if (startsWith(ctx.dev.read_api?.cmd)) deny('agents may not start the API by hand (dev.agents_may_start = false): use `factory read-api up`');
  if (startsWith(ctx.dev.up)) deny(msg);
  if (NPM_FAMILY.has(c.name)) {
    const a = [...c.args];
    while (a[0]?.startsWith('-')) a.splice(0, takes(['-w', '--workspace', '--prefix', '-C'], a[0]) ? 2 : 1);
    const script = ['run', 'run-script', 'rum', 'urn'].includes(a[0]) ? a[1] : c.name === 'npm' ? null : a[0];
    if (script && DEV_SCRIPTS.has(script)) deny(msg);
  }
}

function checkKillish(c, ctx, state) {
  if (!ctx.devLocked) return;
  const ports = new Set([...(ctx.dev.all_ports ?? []), ...(ctx.dev.wait_ports ?? [])].map(String));
  const base = 'agents may not stop the dev stack (dev.agents_may_start = false)';
  if (c.name === 'lsof') {
    for (const a of c.args) for (const m of a.matchAll(/:(\d+)/g)) if (ports.has(m[1])) state.lsofPort = m[1];
  } else if (c.name === 'kill') {
    if (c.viaXargs || c.args.some((x) => x.includes('$') || x === '`')) state.dynamicKill = true;
  } else if (c.name === 'kill-port') {
    for (const a of c.args) if (ports.has(a)) deny(`${base}: kill-port ${a} is blocked`);
  } else if (c.name === 'fuser') {
    if (c.args.some((x) => /^-[a-z]*k/.test(x))) for (const a of c.args) if (ports.has(a.replace(/\/(?:tcp|udp)$/, ''))) deny(`${base}: fuser -k ${a} is blocked`);
  } else if (c.name === 'pkill' || c.name === 'killall') {
    const [pos] = split(c.args, ['-u', '-U', '-g', '-G', '-P', '-s', '-t', '-T', '-n', '-o']);
    const up = (ctx.dev.up ?? '').trim();
    for (const p of pos) {
      const s = p.toLowerCase();
      if (
        (up && s.includes(up.toLowerCase())) ||
        /npm run dev/.test(s) ||
        /(?:^|[^a-z0-9])(?:vite|firebase)(?:[^a-z0-9]|$)/.test(s) ||
        /^(?:node|npm|java)$/.test(s)
      )
        deny(`${base}: ${c.name} ${p} would stop it`);
    }
  }
}

function checkRunInWorktree(c, ctx) {
  if (!ctx.runGlobs.length) return;
  let cand = null;
  if (c.raw.includes('/') || /\.\w+$/.test(c.raw)) cand = c.raw;
  if (SCRIPT_RUNNERS.has(c.name)) cand = c.args.find((x) => !x.startsWith('-')) ?? cand;
  if (!cand || cand.includes('$')) return;
  const info = gitInfo(ctx.cwd);
  if (!info?.linked) return;
  const hit = ctx.matchPath(cand, ctx.cwd, ctx.runGlobs);
  if (hit)
    deny(`running ${hit} inside a linked worktree is blocked (never_touch.never_run_in_worktree = ${JSON.stringify(ctx.runGlobs.map((g) => g.src))}): run it from the main checkout, by the user`);
}

function checkWrites(c, redirs, ctx) {
  const targets = [...redirs];
  if (c && c.name === 'tee') targets.push(...c.args.filter((x) => !x.startsWith('-')));
  for (const t of targets) {
    if (!t || t.startsWith('/dev/') || t.includes('$')) continue;
    ctx.checkTouch(t, 'writing');
  }
}

function analyze(src, ctx, state, depth) {
  const segs = [];
  scan(src, 0, 'top', segs);
  for (const seg of segs) {
    const c = commandOf(seg.words);
    checkWrites(c, seg.redirs, ctx);
    if (!c) continue;
    if (c.name === 'cd' || c.name === 'pushd') {
      const t = c.args.find((x) => !x.startsWith('-'));
      if (t && !t.includes('$') && t !== '-') ctx.cwd = resolve(ctx.cwd, expandTilde(t));
      continue;
    }
    if (c.name === 'factory') continue; // `factory dev-up`, the shim, `factory read-api up`: the sanctioned routes
    if (depth < 4) {
      if (SHELLS.has(c.name)) {
        const k = c.args.findIndex((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
        if (k !== -1 && c.args[k + 1] != null) analyze(c.args[k + 1], ctx, state, depth + 1);
      } else if (c.name === 'eval') analyze(c.args.join(' '), ctx, state, depth + 1);
    }
    if (c.name === 'git') checkGit(c, ctx);
    else if (c.name === 'gh') checkGh(c, ctx);
    checkDevStart(c, ctx);
    checkKillish(c, ctx, state);
    checkRunInWorktree(c, ctx);
  }
}

// ------------------------------------------------------------ entry points

/** The guard's view of factory.toml. */
export function guardConfig(data, tomlPath) {
  const nt = data.never_touch ?? {};
  return {
    tomlPath,
    touchGlobs: globs(nt.paths),
    runGlobs: globs(nt.never_run_in_worktree),
    neverPush: globs(data.git?.never_push),
    dev: data.dev ?? {},
    devLocked: data.dev?.agents_may_start === false,
    allowMerge: data.loop?.allow_merge === true,
  };
}

/** Returns the deny reason, or null to allow. May throw on internal errors (the caller fails open). */
export function evaluate(payload, cfg) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input ?? {};
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();

  let rootsCache = null;
  const roots = () => {
    if (rootsCache) return rootsCache;
    const set = new Set();
    const add = (p) => {
      if (!p) return;
      set.add(p);
      set.add(realish(p));
    };
    add(dirname(cfg.tomlPath));
    const info = gitInfo(cwd);
    if (info) {
      add(info.top);
      if (basename(info.common) === '.git') add(dirname(info.common));
    }
    return (rootsCache = [...set]);
  };
  const matchPath = (p, from, gs) => {
    const abs = resolve(from, expandTilde(p));
    for (const cand of new Set([abs, realish(abs)]))
      for (const root of roots()) {
        if (!cand.startsWith(`${root}/`)) continue;
        const hit = anyGlob(gs, cand.slice(root.length + 1));
        if (hit) return hit;
      }
    return null;
  };

  const ctx = {
    ...cfg,
    cwd,
    matchPath,
    checkTouch(p, verb) {
      if (!cfg.touchGlobs.length || TEMPLATE_SUFFIX.test(p)) return;
      const hit = matchPath(p, ctx.cwd, cfg.touchGlobs);
      if (hit) deny(`${verb} ${p} is blocked: it matches never_touch.paths = ${JSON.stringify(hit)} (ask the user)`);
    },
  };

  try {
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
      const p = input.file_path ?? input.notebook_path ?? input.path;
      if (typeof p === 'string' && p) ctx.checkTouch(p, 'editing');
    } else if (tool === 'Bash' && typeof input.command === 'string') {
      const state = { lsofPort: null, dynamicKill: false };
      analyze(input.command, ctx, state, 0);
      if (state.lsofPort && state.dynamicKill)
        deny(`agents may not stop the dev stack (dev.agents_may_start = false): killing whatever listens on :${state.lsofPort} is blocked`);
    }
  } catch (e) {
    if (e instanceof Deny) return `factory hook-guard: ${e.message}`;
    throw e;
  }
  return null;
}

export function main() {
  const warn = (m) => process.stderr.write(`factory hook-guard: ${m}; allowing the call (the guard failed open)\n`);
  try {
    let raw = '';
    try {
      raw = readFileSync(0, 'utf8');
    } catch (e) {
      return warn(`cannot read stdin (${e.code ?? e.message})`);
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return warn('stdin is not JSON');
    }
    const tomlPath = process.env.FACTORY_TOML;
    if (!tomlPath) return warn('no factory.toml (run through bin/factory)');
    const cfg = guardConfig(parseToml(readFileSync(tomlPath, 'utf8')).data, tomlPath);
    const reason = evaluate(payload, cfg);
    if (reason)
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
      );
  } catch (e) {
    warn(`internal error: ${e?.message ?? e}`);
  }
}
