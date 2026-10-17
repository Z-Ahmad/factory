#!/usr/bin/env node
// desc: start night N's file from the template, carrying the previous night's open items, "With the user" and "Needs the phone"
// usage: factory night-new <N> [--from <prev N>] [--theme "..."] [--human "..."] [--target <name>] [--date YYYY-MM-DD] [--stdout]
// Renders protocol/night.md.tmpl into [project] night_file ({n} = N): a header of at most 10 lines (night, date, theme,
// branch target, the human's availability, the rules file from [loop] rules), then Backlog, With the user, Needs the phone, Log.
// --from P reads night P's file and carries:
//   Backlog          every open item line (the [project] item_line with "[ ]", so "[blocked: ...]" and "[needs-user]" items
//                    too) plus its indented continuation lines; done items and other prose stay behind
//   With the user    the section body as written (whole-line <!-- comments --> dropped; the template adds its own)
//   Needs the phone  the same
// Sections are found by their "## " heading's first words, so "## With the user (pinned; ...)" counts.
// --target picks a [[targets]] entry by name (default: the one with default = true, else the first). It is shown as
// "<push branch for night-N> → <pr_base> (<name>)".
// Refuses to overwrite an existing night file (exit 1). --stdout prints the result and writes nothing.
// Exit 0 written, 1 a bad argument, a missing previous night or an existing file.
// FK_NOW_DATE (YYYY-MM-DD) replaces today's date, for tests.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const die = (msg, code = 1) => {
  console.error(`factory night-new: ${msg}`);
  process.exit(code);
};
const USAGE =
  'usage: factory night-new <N> [--from <prev N>] [--theme "..."] [--human "..."] [--target <name>] [--date YYYY-MM-DD] [--stdout]';

// ------------------------------------------------------------------ args

const args = process.argv.slice(2);
const opt = { n: null, from: null, theme: null, human: null, target: null, date: null, stdout: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    if (i + 1 >= args.length) die(`${a} needs a value\n${USAGE}`);
    return args[++i];
  };
  if (a === '--from') opt.from = val();
  else if (a === '--theme') opt.theme = val();
  else if (a === '--human') opt.human = val();
  else if (a === '--target') opt.target = val();
  else if (a === '--date') opt.date = val();
  else if (a === '--stdout') opt.stdout = true;
  else if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (!a.startsWith('-') && opt.n === null) opt.n = a;
  else die(`unknown arg: ${a}\n${USAGE}`);
}
const isNight = (v) => typeof v === 'string' && /^[0-9]+$/.test(v);
if (!isNight(opt.n)) die(USAGE);
if (opt.from !== null && !isNight(opt.from)) die(`--from needs a night number (got: ${opt.from})`);
if (opt.from === opt.n) die('--from must name a different night');
if (opt.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(opt.date)) die(`--date must be YYYY-MM-DD (got: ${opt.date})`);

// ---------------------------------------------------------------- config

const env = process.env;
const KIT = env.FK_KIT_DIR || die('run this through bin/factory (factory night-new ...)');
const NIGHT_FILE = env.FK_PROJECT_NIGHT_FILE || die('[project] night_file is not set');
const ITEM_LINE = env.FK_PROJECT_ITEM_LINE || '- [ ] {id}.';
const LOG_LINE = env.FK_PROJECT_LOG_LINE || '{hhmm} · {id} · {sha} · {note}';
if (!ITEM_LINE.includes('[ ]') || !ITEM_LINE.includes('{id}'))
  die(`[project] item_line must contain "[ ]" and {id} (got: ${ITEM_LINE})`);

/** Replace {name} for the names given, in one pass; other {words} stay as written. */
const fill = (tpl, vals) =>
  tpl.replace(/\{([A-Za-z_]+)\}/g, (m, k) => (Object.hasOwn(vals, k) ? String(vals[k]) : m));

const nightPath = (n) => fill(NIGHT_FILE, { n });

function pickTarget() {
  const count = Number(env.FK_TARGETS_COUNT || 0);
  const t = [];
  for (let i = 0; i < count; i++)
    t.push({
      name: env[`FK_TARGETS_${i}_NAME`],
      prBase: env[`FK_TARGETS_${i}_PR_BASE`],
      isDefault: env[`FK_TARGETS_${i}_DEFAULT`] === 'true',
      prod: env[`FK_TARGETS_${i}_DEPLOYS_PROD`] === 'true',
    });
  if (opt.target !== null) {
    const hit = t.find((x) => x.name === opt.target);
    if (!hit) die(`no [[targets]] entry named ${opt.target} (have: ${t.map((x) => x.name).join(', ') || 'none'})`);
    return hit;
  }
  return t.find((x) => x.isDefault) ?? t[0] ?? null;
}

// ----------------------------------------------------------- the last night

const OPEN = ITEM_LINE.slice(0, ITEM_LINE.indexOf('[ ]') + 3); // "- [ ]"
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const [idPre, idPost] = ITEM_LINE.split('{id}');
const ID_RE = new RegExp(`^${escapeRe(idPre)}(${idPost ? `.+?(?=${escapeRe(idPost)})` : '\\S+'})`);
// The same rule as `factory tick`: two or more lowercase words joined by hyphens.
const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/** Sections of a night file: heading text (lowercased) -> body lines. */
function sections(text) {
  const out = new Map();
  let cur = null;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      cur = h[1].trim().toLowerCase();
      if (!out.has(cur)) out.set(cur, []);
      continue;
    }
    if (/^#\s/.test(line)) {
      cur = null;
      continue;
    }
    if (cur !== null) out.get(cur).push(line);
  }
  return out;
}
const section = (secs, name) => {
  for (const [k, v] of secs) if (k === name || k.startsWith(`${name} `) || k.startsWith(`${name}(`)) return v;
  return null;
};
const isComment = (l) => /^\s*<!--.*-->\s*$/.test(l);
const trimBlank = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
};

/** Open item lines and their indented continuation lines. */
function openItems(lines) {
  const out = [];
  const ids = [];
  let carrying = false;
  for (const line of lines) {
    if (line.startsWith(OPEN)) {
      carrying = true;
      out.push(line);
      const m = ID_RE.exec(line);
      if (m) ids.push(m[1]);
    } else if (carrying && /^\s+\S/.test(line)) out.push(line);
    else carrying = false;
  }
  return { lines: out, ids };
}

let backlog = [];
let ids = [];
let withUser = [];
let needsPhone = [];
let prev = 'none';
if (opt.from !== null) {
  const p = nightPath(opt.from);
  if (!existsSync(p)) die(`no night ${opt.from} file at ${p}`);
  const secs = sections(readFileSync(p, 'utf8'));
  const b = section(secs, 'backlog');
  if (b === null) console.error(`factory night-new: warning: night ${opt.from} has no "## Backlog" section; nothing carried from it`);
  ({ lines: backlog, ids } = openItems(b ?? []));
  withUser = trimBlank((section(secs, 'with the user') ?? []).filter((l) => !isComment(l)));
  needsPhone = trimBlank((section(secs, 'needs the phone') ?? []).filter((l) => !isComment(l)));
  prev = `night ${opt.from} (${ids.length} open item${ids.length === 1 ? '' : 's'} carried${ids.length ? `: ${ids.join(', ')}` : ''})`;
  // [loop] item_ids = "slug" (the default): carried codes still carry, but say which ones `factory tick` will refuse.
  const codes = (env.FK_LOOP_ITEM_IDS || 'slug') === 'any' ? [] : ids.filter((id) => !SLUG_RE.test(id));
  if (codes.length)
    console.error(`factory night-new: warning: carried item IDs that are not plain-English slugs (factory tick refuses them): ${codes.join(', ')}. Rename them in night ${opt.n}'s Backlog, e.g. lifetime-globe.`);
}

// ------------------------------------------------------------------ render

const out = nightPath(opt.n);
if (!opt.stdout && existsSync(out)) die(`${out} already exists; refusing to overwrite it`);

const tplPath = join(KIT, 'protocol', 'night.md.tmpl');
if (!existsSync(tplPath)) die(`missing template ${tplPath}`);
const target = pickTarget();
const push = env.FK_GIT_PUSH_BRANCH ? fill(env.FK_GIT_PUSH_BRANCH, { name: `night-${opt.n}` }) : null;
const targetText = target
  ? `${push ? `\`${push}\` → ` : ''}\`${target.prBase}\` (${target.name}${target.prod ? '; merging deploys production' : ''})`
  : '(no [[targets]] in factory.toml)';

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = env.FK_NOW_DATE || localDate(new Date());
const block = (lines) => lines.join('\n');
const text = fill(readFileSync(tplPath, 'utf8'), {
  project: env.FK_PROJECT_NAME || 'project',
  n: opt.n,
  date: opt.date ?? today,
  theme: opt.theme ?? '(not set: ask the human at the first firing)',
  target: targetText,
  human: opt.human ?? '(not set: ask at the first firing; if away, run only items that need no decision)',
  rules: env.FK_LOOP_RULES ? `\`${env.FK_LOOP_RULES}\` (from the repo root)` : 'the project rules (none set: add [loop] rules to factory.toml)',
  prev,
  item_example: fill(ITEM_LINE, { id: '<id>' }),
  log_example: fill(LOG_LINE, { hhmm: '<hh:mm>', id: '<id>', sha: '<sha|running|blocked>', note: '<note>' }),
  backlog: block(backlog),
  with_user: block(withUser),
  needs_phone: block(needsPhone),
}).replace(/\n{3,}/g, '\n\n');

if (opt.stdout) {
  process.stdout.write(text);
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text, { flag: 'wx' });
console.log(`wrote ${out}`);
console.log(`carried: ${opt.from === null ? 'nothing (no --from)' : `${ids.length} open item(s), ${withUser.length} "With the user" line(s), ${needsPhone.length} "Needs the phone" line(s) from night ${opt.from}`}`);
