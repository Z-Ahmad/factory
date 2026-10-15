#!/usr/bin/env node
// desc: validate and query factory.toml (validate | get <dotted.key> | env --sh)
//
// A zero-dependency reader for the TOML subset factory.toml uses: tables,
// [[arrays of tables]], strings, ints, floats, bools, arrays (multi-line too),
// inline tables and comments. Not supported (and rejected with a clear error):
// dotted keys, multi-line strings, dates.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export class ConfigError extends Error {
  constructor(message, line = 0) {
    super(message);
    this.line = line;
  }
}

// ---------------------------------------------------------------- parser

export function parseToml(source) {
  const s = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  let pos = 0;
  const data = {};
  const lines = new Map(); // dotted path -> 1-based line
  const explicit = new Set(); // table paths introduced by a [header]
  const aot = new WeakSet(); // arrays created by [[header]]
  const closed = new WeakSet(); // tables defined by key = {...}: cannot be reopened

  const lineAt = (p) => {
    let n = 1;
    for (let i = 0; i < p && i < s.length; i++) if (s[i] === '\n') n++;
    return n;
  };
  const fail = (msg, p = pos) => {
    throw new ConfigError(msg, lineAt(p));
  };
  const show = () =>
    pos >= s.length || s[pos] === '\n' ? 'end of line' : `'${s[pos]}'`;
  const skipWs = () => {
    while (s[pos] === ' ' || s[pos] === '\t') pos++;
  };
  const skipComment = () => {
    if (s[pos] === '#') while (pos < s.length && s[pos] !== '\n') pos++;
  };
  const skipTrivia = () => {
    for (;;) {
      const c = s[pos];
      if (c === ' ' || c === '\t' || c === '\n') pos++;
      else if (c === '#') skipComment();
      else break;
    }
  };
  const endOfLine = (what) => {
    skipWs();
    skipComment();
    if (pos < s.length && s[pos] !== '\n') {
      const hint = s[pos] === ';' ? ' (TOML takes one key = value per line)' : '';
      fail(`unexpected ${show()} after ${what}${hint}`);
    }
  };
  const sticky = (re) => {
    re.lastIndex = pos;
    return re.exec(s);
  };

  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const parseBasicString = () => {
    const start = pos;
    if (s.startsWith('"""', pos)) fail('multi-line strings are not supported', start);
    pos++;
    let out = '';
    for (;;) {
      const c = s[pos];
      if (c === undefined || c === '\n') fail('unterminated string', start);
      if (c === '"') {
        pos++;
        return out;
      }
      if (c === '\\') {
        const e = s[pos + 1];
        if (e in ESC) {
          out += ESC[e];
          pos += 2;
          continue;
        }
        if (e === 'u' || e === 'U') {
          const n = e === 'u' ? 4 : 8;
          const hex = s.slice(pos + 2, pos + 2 + n);
          if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) fail(`bad \\${e} escape`, pos);
          out += String.fromCodePoint(parseInt(hex, 16));
          pos += 2 + n;
          continue;
        }
        fail(`unknown escape '\\${e ?? ''}'`, pos);
      }
      out += c;
      pos++;
    }
  };
  const parseLiteralString = () => {
    const start = pos;
    if (s.startsWith("'''", pos)) fail('multi-line strings are not supported', start);
    const end = s.indexOf("'", pos + 1);
    const nl = s.indexOf('\n', pos);
    if (end === -1 || (nl !== -1 && nl < end)) fail('unterminated string', start);
    const out = s.slice(pos + 1, end);
    pos = end + 1;
    return out;
  };
  const parseKeyPart = () => {
    const c = s[pos];
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    const m = sticky(/[A-Za-z0-9_-]+/y);
    if (!m) fail(`expected a key, found ${show()}`);
    pos += m[0].length;
    return m[0];
  };

  const parseValue = (path) => {
    const c = s[pos];
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') return parseArray(path);
    if (c === '{') return parseInline(path);
    for (const word of ['true', 'false']) {
      if (s.startsWith(word, pos) && !/[A-Za-z0-9_]/.test(s[pos + word.length] ?? '')) {
        pos += word.length;
        return word === 'true';
      }
    }
    const m = sticky(/[+-]?(?:0|[1-9][0-9_]*)(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?/y);
    if (m) {
      pos += m[0].length;
      return Number(m[0].replace(/_/g, ''));
    }
    return fail(`expected a value, found ${show()}`);
  };

  const parseArray = (path) => {
    const start = pos;
    pos++;
    const out = [];
    for (;;) {
      skipTrivia();
      if (pos >= s.length) fail('unterminated array (missing ])', start);
      if (s[pos] === ']') {
        pos++;
        return out;
      }
      out.push(parseValue(path));
      skipTrivia();
      if (pos >= s.length) fail('unterminated array (missing ])', start);
      if (s[pos] === ',') {
        pos++;
        continue;
      }
      if (s[pos] === ']') {
        pos++;
        return out;
      }
      fail(`expected ',' or ']' in array, found ${show()}`);
    }
  };

  const parseInline = (path) => {
    const start = pos;
    pos++;
    const out = {};
    closed.add(out);
    skipWs();
    if (s[pos] === '}') {
      pos++;
      return out;
    }
    for (;;) {
      skipWs();
      if (pos >= s.length || s[pos] === '\n')
        fail('inline tables must close on the same line (missing })', start);
      const kpos = pos;
      const key = parseKeyPart();
      skipWs();
      if (s[pos] !== '=') fail(`expected '=' after key '${key}', found ${show()}`);
      pos++;
      skipWs();
      const sub = [...path, key];
      lines.set(sub.join('.'), lineAt(kpos));
      const v = parseValue(sub);
      if (Object.hasOwn(out, key)) fail(`duplicate key '${key}'`, kpos);
      out[key] = v;
      skipWs();
      if (s[pos] === ',') {
        pos++;
        continue;
      }
      if (s[pos] === '}') {
        pos++;
        return out;
      }
      fail(
        `expected ',' or '}' in inline table, found ${show()} (inline tables must close on the same line)`,
        pos >= s.length ? start : pos,
      );
    }
  };

  let cur = data;
  let curPath = [];

  for (;;) {
    skipTrivia();
    if (pos >= s.length) break;

    if (s[pos] === '[') {
      const hstart = pos;
      const isArr = s[pos + 1] === '[';
      pos += isArr ? 2 : 1;
      const parts = [];
      for (;;) {
        skipWs();
        parts.push(parseKeyPart());
        skipWs();
        if (s[pos] === '.') {
          pos++;
          continue;
        }
        break;
      }
      const close = isArr ? ']]' : ']';
      if (!s.startsWith(close, pos))
        fail(`expected '${close}' to close the table header, found ${show()}`);
      pos += close.length;
      endOfLine('table header');

      const name = parts.join('.');
      let node = data;
      const path = [];
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        path.push(k);
        let v = node[k];
        if (v === undefined) {
          v = {};
          node[k] = v;
        } else if (Array.isArray(v)) {
          if (!aot.has(v))
            fail(`cannot extend '${path.join('.')}': it is an array of values, not tables`, hstart);
          node = v[v.length - 1];
          path.push(String(v.length - 1));
          continue;
        } else if (typeof v !== 'object' || closed.has(v)) {
          fail(`cannot extend '${path.join('.')}': it is already defined as a value`, hstart);
        }
        node = v;
      }
      const last = parts[parts.length - 1];
      const here = [...path, last];
      const hline = lineAt(hstart);
      if (isArr) {
        let arr = node[last];
        if (arr === undefined) {
          arr = [];
          node[last] = arr;
          aot.add(arr);
        } else if (!aot.has(arr)) {
          const what = Array.isArray(arr)
            ? 'an array of values'
            : typeof arr === 'object'
              ? 'a table'
              : 'a value';
          fail(`cannot use [[${name}]]: '${name}' is already defined as ${what}`, hstart);
        }
        const el = {};
        arr.push(el);
        curPath = [...here, String(arr.length - 1)];
        if (!lines.has(here.join('.'))) lines.set(here.join('.'), hline);
        lines.set(curPath.join('.'), hline);
        cur = el;
      } else {
        let t = node[last];
        const key = here.join('.');
        if (t === undefined) {
          t = {};
          node[last] = t;
        } else if (Array.isArray(t) && aot.has(t)) {
          fail(`cannot redefine array of tables '${name}' as a table [${name}]`, hstart);
        } else if (typeof t !== 'object' || Array.isArray(t) || closed.has(t)) {
          fail(`cannot define table [${name}]: '${name}' is already defined as a value`, hstart);
        } else if (explicit.has(key)) {
          fail(`table [${name}] is defined twice`, hstart);
        }
        explicit.add(key);
        lines.set(key, hline);
        curPath = here;
        cur = t;
      }
      continue;
    }

    const kpos = pos;
    const key = parseKeyPart();
    skipWs();
    if (s[pos] === '.')
      fail(`dotted keys are not supported (key '${key}'); use a [table] header instead`);
    if (s[pos] !== '=') fail(`expected '=' after key '${key}', found ${show()}`);
    pos++;
    skipWs();
    const kpath = [...curPath, key];
    lines.set(kpath.join('.'), lineAt(kpos));
    const v = parseValue(kpath);
    endOfLine('value');
    if (Object.hasOwn(cur, key)) fail(`duplicate key '${key}'`, kpos);
    cur[key] = v;
  }
  return { data, lines };
}

// ---------------------------------------------------------------- schema

const leaf = (t, o = {}) => ({ t, ...o });
const str = (o) => leaf('string', o);
const int = (o) => leaf('int', o);
const num = (o) => leaf('number', o);
const bool = (o) => leaf('bool', o);
const strs = (o) => leaf('string[]', o);
const ints = (o) => leaf('int[]', o);
const table = (keys, o = {}) => ({ t: 'table', keys, ...o });
const strMap = () => ({ t: 'table', values: str() });
const REQ = { required: true };

export const SCHEMA = table({
  kit: table({ repo: str(REQ), ref: str(REQ) }, REQ),
  project: table(
    {
      name: str(REQ),
      main_checkout: str(REQ),
      state_dir: str(REQ),
      night_file: str(REQ),
      shots_dir: str(),
      item_line: str(),
      log_line: str(),
    },
    REQ,
  ),
  git: table(
    {
      github: str(),
      worktrees_dir: str(REQ),
      worktree_branch: str(REQ),
      push_branch: str(REQ),
      agent_worktrees: str(),
      protected_worktrees: strs(),
      phone_worktree: str(),
      never_push: strs(),
      commit_trailer: str(),
    },
    REQ,
  ),
  targets: {
    t: 'aot',
    required: true,
    min: 1,
    keys: {
      name: str(REQ),
      base: str(REQ),
      pr_base: str(REQ),
      paths: strs(),
      default: bool(),
      deploys_prod: bool(),
    },
  },
  worktree: table({ cache_symlinks: strs() }),
  never_touch: table({
    paths: strs(),
    never_run_in_worktree: strs(),
    secret_nonempty: strMap(),
  }),
  dev: table({
    up: str(),
    cwd: str(),
    log: str(),
    wait_ports: ints(),
    all_ports: ints(),
    timeout_s: int(),
    agents_may_start: bool(),
    read_api: table({ cwd: str(REQ), cmd: str(REQ), port: int(REQ) }),
  }),
  seed: table({
    restore: str(),
    snapshot: str(),
    dry_run: str(),
    firebase_project: str(),
    user: str(),
    trip: str(),
    fixture_dir: str(),
    buckets: strs(),
    emulators: strMap(),
  }),
  disk: table({
    min_gb: int(),
    floor_gb: int(),
    low_cleanup: strs(),
    frames_age_days: int(),
    dd_root: str(),
    dd_keep: strs(),
    dd_keep_derive: strs(),
    dd_keep_patterns: strs(),
    tmp_dir: str(),
    tmp_keep: strs(),
    tmp_globs: strs(),
    archives: table({ glob: str(REQ), keep: int(REQ) }),
  }),
  sim: table({
    shooter_udid: str(),
    shooter_device: str(),
    protected: strs(),
    ephemeral: strs(),
    sweep: strs(),
    second_size: str(),
    reset_keyboard_prefs: bool(),
  }),
  proof: table({
    ios: table({
      requires: str(),
      wrapper: str(),
      build: str(),
      dd: str(),
      app: str(),
      bundle_id: str(),
      process: str(),
      scenario_env: str(),
      env_prefix: str(),
      launch_env: strMap(),
      password_from: str(),
      flag_env: strMap(),
      seconds: int(),
      fps: int(),
      rest_at_s: num(),
      contact_cols: int(),
      contact_max_tiles: int(),
      log_markers: strs(),
      fail_markers: strs(),
      verdict: table({
        skip_start_s: num(),
        ignore_top: num(),
        grid: str(),
        width: int(),
        flash_warn: int(),
        flash_fail: int(),
        hold_warn_ms: int(),
        hold_fail_ms: int(),
        hold_motion: num(),
      }),
    }),
    matrix: { t: 'table', values: table({ cells: strs(REQ) }) },
  }),
  tests: table({ unit: str(), gate: str(), retry_once: strs() }),
  phone: table({
    export: str(),
    cmd: str(),
    link_from_main: strs(),
    wipe: strs(),
    ask_before_install: bool(),
  }),
  release: table({
    ios: table({ testflight: str(), build_required: bool(), last_build_file: str() }),
  }),
  loop: table({
    models: table({
      implement: str(),
      shoot: str(),
      ideate: str(),
      rescue: str(),
      banned: strs(),
    }),
    rounds: int(),
    taste_rounds: int(),
    stuck: str(),
    stop_after_blocked: int(),
    wake_s: int(),
    usage_limit_wake_s: int(),
    implementer_words: int(),
    shooter_words: int(),
    linear: table({ prefix: str(), on_ship: str() }),
  }),
});

// `{name}` placeholders. REFS are filled in from the config itself when it is
// loaded; RUNTIME ones are left as written for the command that owns them.
export const REFS = {
  state_dir: 'project.state_dir',
  main_checkout: 'project.main_checkout',
  dd_root: 'disk.dd_root',
  dd: 'proof.ios.dd',
  trip: 'seed.trip',
};
export const RUNTIME = ['n', 'id', 'hhmm', 'sha', 'note', 'ref', 'build', 'password', 'name'];

// ------------------------------------------------------------ validation

const typeName = (v) => {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'object') return 'table';
  return typeof v;
};
const preview = (v) => {
  const j = JSON.stringify(v);
  return j.length > 40 ? `${j.slice(0, 37)}...` : j;
};
const isScalarOk = (t, v) =>
  (t === 'string' && typeof v === 'string') ||
  (t === 'bool' && typeof v === 'boolean') ||
  (t === 'int' && Number.isInteger(v)) ||
  (t === 'number' && typeof v === 'number');

function checkNode(spec, value, path, report) {
  const here = path.join('.');
  switch (spec.t) {
    case 'string':
    case 'int':
    case 'number':
    case 'bool':
      if (!isScalarOk(spec.t, value))
        report(here, `expected ${spec.t}, got ${typeName(value)} (${preview(value)})`);
      return;
    case 'string[]':
    case 'int[]': {
      const el = spec.t.slice(0, -2);
      if (!Array.isArray(value)) {
        report(here, `expected ${spec.t}, got ${typeName(value)} (${preview(value)})`);
        return;
      }
      value.forEach((x, i) => {
        if (!isScalarOk(el, x))
          report(here, `expected ${spec.t}, but element ${i + 1} is ${typeName(x)} (${preview(x)})`);
      });
      return;
    }
    case 'table':
      if (typeName(value) !== 'table') {
        report(here, `expected table, got ${typeName(value)} (${preview(value)})`);
        return;
      }
      checkTableKeys(spec, value, path, report);
      return;
    case 'aot':
      if (!Array.isArray(value) || value.some((x) => typeName(x) !== 'table')) {
        report(
          here,
          `expected array of tables ([[${here}]]), got ${typeName(value)} (${preview(value)})`,
        );
        return;
      }
      if (spec.min && value.length < spec.min)
        report(here, `needs at least ${spec.min} [[${here}]] entry`);
      value.forEach((el, i) => checkTableKeys(spec, el, [...path, String(i)], report));
      return;
    default:
      throw new Error(`bad schema node ${spec.t}`);
  }
}

function checkTableKeys(spec, value, path, report) {
  const here = path.join('.');
  if (spec.keys) {
    for (const [k, sub] of Object.entries(spec.keys)) {
      if (value[k] === undefined) {
        if (sub.required) {
          const section = sub.t === 'table' || sub.t === 'aot';
          const name = [...path, k].join('.');
          report(name, section ? `missing required section [${name}]` : `missing required key '${k}'`);
        }
      } else checkNode(sub, value[k], [...path, k], report);
    }
    if (!spec.values) {
      for (const k of Object.keys(value)) {
        if (!(k in spec.keys))
          report([...path, k].join('.'), `unknown key '${k}'${here ? ` in [${here}]` : ''}`);
      }
    }
  }
  if (spec.values) {
    for (const [k, v] of Object.entries(value)) checkNode(spec.values, v, [...path, k], report);
  }
}

function getPath(data, path) {
  let cur = data;
  for (const seg of path) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}

function walkStrings(v, path, fn) {
  if (typeof v === 'string') fn(v, path);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, [...path, String(i)], fn));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) walkStrings(x, [...path, k], fn);
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Returns [{ path, line, message }]; empty when the config is valid. */
export function validate(data, lines) {
  const errors = [];
  const lineFor = (dotted) => {
    const segs = dotted.split('.');
    while (segs.length) {
      const l = lines.get(segs.join('.'));
      if (l) return l;
      segs.pop();
    }
    return 0;
  };
  const report = (path, message) => errors.push({ path, line: lineFor(path), message });

  checkTableKeys(SCHEMA, data, [], report);
  walkStrings(data, [], (text, path) => {
    for (const m of text.matchAll(PLACEHOLDER)) {
      const name = m[1];
      const dotted = path.join('.');
      if (RUNTIME.includes(name)) continue;
      if (!(name in REFS)) {
        const known = (xs) => xs.map((k) => `{${k}}`).join(' ');
        report(
          dotted,
          `unknown placeholder {${name}} (config: ${known(Object.keys(REFS))}; runtime: ${known(RUNTIME)})`,
        );
      } else if (typeof getPath(data, REFS[name].split('.')) !== 'string') {
        report(dotted, `placeholder {${name}} needs ${REFS[name]}, which is not set`);
      }
    }
  });
  return errors;
}

// ------------------------------------------------------------ expansion

const expandTilde = (v) =>
  v === '~' ? homedir() : v.startsWith('~/') ? homedir() + v.slice(1) : v;

/** Fills {config} placeholders and expands ~; {runtime} placeholders stay as written. */
export function resolve(data) {
  const cache = new Map();
  const expandString = (text, stack) => {
    const out = text.replace(PLACEHOLDER, (whole, name) => {
      if (!(name in REFS)) return whole;
      if (stack.includes(name))
        throw new ConfigError(`placeholder cycle: ${[...stack, name].join(' -> ')}`);
      if (!cache.has(name)) {
        const raw = getPath(data, REFS[name].split('.'));
        cache.set(name, expandString(raw, [...stack, name]));
      }
      return cache.get(name);
    });
    return expandTilde(out);
  };
  const map = (v) => {
    if (typeof v === 'string') return expandString(v, []);
    if (Array.isArray(v)) return v.map(map);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]));
    return v;
  };
  return map(data);
}

/** Parse + validate + resolve. Throws ConfigError on syntax; schema problems come back in `errors`. */
export function load(text) {
  const { data, lines } = parseToml(text);
  const errors = validate(data, lines);
  return { data, lines, errors, resolved: errors.length ? null : resolve(data) };
}

// --------------------------------------------------------------- outputs

const sanitize = (k) =>
  k.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();

export function flatten(resolved) {
  const out = {};
  const walk = (prefix, v) => {
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        out[`${prefix}_COUNT`] = String(v.length);
        v.forEach((x, i) => walk(`${prefix}_${i}`, x));
      } else out[prefix] = v.map(String).join('\n');
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(`${prefix}_${sanitize(k)}`, x);
    } else out[prefix] = String(v);
  };
  for (const [k, v] of Object.entries(resolved)) walk(`FK_${sanitize(k)}`, v);
  return out;
}

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

export function toEnvSh(resolved, file) {
  const vars = { FK_CONFIG: file, FK_ROOT: dirname(file), ...flatten(resolved) };
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join('\n');
}

export function getKey(resolved, dotted) {
  const v = getPath(resolved, dotted.split('.'));
  if (v === undefined) return { found: false };
  const text =
    typeof v === 'string'
      ? v
      : Array.isArray(v) && v.every((x) => typeof x !== 'object')
        ? v.map(String).join('\n')
        : typeof v === 'object'
          ? JSON.stringify(v, null, 2)
          : String(v);
  return { found: true, text };
}

// ------------------------------------------------------------------- CLI

const USAGE = `usage: factory config <command>
  validate          check factory.toml against the schema
  get <dotted.key>  print one value (lists one per line, tables as JSON)
  env --sh          print FK_* exports for sourcing in bash`;

function main(argv) {
  const rest = [...argv];
  let file = process.env.FACTORY_TOML;
  const i = rest.findIndex((a) => a === '--file' || a === '-f');
  if (i !== -1) {
    file = rest[i + 1];
    rest.splice(i, 2);
  }
  const [cmd, ...args] = rest;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  if (!['validate', 'get', 'env'].includes(cmd)) {
    console.error(`factory config: unknown command '${cmd}'\n${USAGE}`);
    return 2;
  }
  if (cmd === 'get' && args.length !== 1) {
    console.error('usage: factory config get <dotted.key>');
    return 2;
  }
  if (cmd === 'env' && !args.includes('--sh')) {
    console.error('usage: factory config env --sh');
    return 2;
  }
  if (!file) {
    console.error(
      'factory config: no config file (run through bin/factory, or pass --file / set FACTORY_TOML)',
    );
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`factory config: cannot read ${file}: ${e.code ?? e.message}`);
    return 2;
  }

  let result;
  try {
    result = load(text);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`${file}${e.line ? `:${e.line}` : ''}: ${e.message}`);
    return 1;
  }
  if (result.errors.length) {
    for (const e of result.errors)
      console.error(`${file}${e.line ? `:${e.line}` : ''}: ${e.path}: ${e.message}`);
    const n = result.errors.length;
    console.error(`${n} problem${n === 1 ? '' : 's'} in ${file}`);
    return 1;
  }

  if (cmd === 'validate') {
    console.log(`ok: ${file}`);
  } else if (cmd === 'get') {
    const r = getKey(result.resolved, args[0]);
    if (!r.found) {
      console.error(`factory config: ${args[0]} is not set in ${file}`);
      return 3;
    }
    console.log(r.text);
  } else {
    console.log(toEnvSh(result.resolved, file));
  }
  return 0;
}

const invoked =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invoked) process.exitCode = main(process.argv.slice(2));
