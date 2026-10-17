#!/usr/bin/env node
// desc: check a night file against the shape night-new writes and tick appends to (read-only; never rewrites it)
// usage: factory night-lint [--night N | --file <night.md>] [--quiet] [--limit K]
// Validates the night file ([project] night_file with {n} = N, or --file) against [project] item_line and log_line:
//   Title      first non-blank line: "# <name> factory: night N" (N must equal --night when given)
//   Header     bullets Date + Theme (one line), Branch target, The human, Rules, Previous night
//   Sections   ## Backlog, ## With the user, ## Needs the phone, ## Log, in that order, once each
//   Backlog    item lines per item_line: a "[ ]" or "[x]" mark, an ID (a plain-English slug when [loop] item_ids = "slug",
//              the default), and for "[x]" a sha (7-40 hex) right after the ID. Tags after that are "[...]" groups or the
//              words IDEATE / TASTE / "no test". Indented lines continue the item above; comments and blank lines are free.
//   Log        per log_line: "hh:mm · <id> · <sha or status word> · <note>" (the note may contain " · "). IDs are backlog IDs
//              or free slugs (plan, phone, kit, morning, lesson, end-night, "TF <n>"). Exceptions: at most one
//              "FINAL (night N) · ..." summary line, and a line that is exactly "STOP".
// ERRORS (exit 1) break the tools or the ledger: no title line, a wrong night number, a required section missing,
//   repeated or out of order, a backlog line tick cannot parse (no ID), a done item ("[x]") without a sha, a duplicate
//   backlog ID.
// WARNINGS (exit 0, printed) are everything else: missing header bullets, an extra "## " section, a non-slug ID, a
//   malformed tag or log line, a log ID that is neither a slug nor a backlog ID, a second FINAL line, prose in the Backlog.
//   Nights written before these rules existed will warn a lot; that is expected.
// Never writes anything. --quiet prints nothing when there are no findings; --limit K prints at most K findings
// (errors first) and counts the rest. The last line is always "night-lint: clean" or "night-lint: N errors, M warnings"
// (unless --quiet and clean).
// Exit 0 no errors, 1 errors, 2 a bad argument or a missing file.
import { existsSync, readFileSync } from 'node:fs';

const USAGE = 'usage: factory night-lint [--night N | --file <night.md>] [--quiet] [--limit K]';
const die = (msg, code = 2) => {
  console.error(`factory night-lint: ${msg}`);
  process.exit(code);
};

// ------------------------------------------------------------------ args

const args = process.argv.slice(2);
const opt = { night: null, file: null, quiet: false, limit: Infinity };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    if (i + 1 >= args.length) die(`${a} needs a value\n${USAGE}`);
    return args[++i];
  };
  if (a === '--night') opt.night = val();
  else if (a === '--file') opt.file = val();
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--limit') opt.limit = Number(val());
  else if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else die(`unknown arg: ${a}\n${USAGE}`);
}
if (opt.night !== null && !/^[0-9]+$/.test(opt.night)) die(`--night wants a night number (got: ${opt.night})`);
if (opt.limit !== Infinity && (!Number.isInteger(opt.limit) || opt.limit < 1)) die('--limit wants a positive integer');
if (opt.night === null && opt.file === null) {
  console.error(USAGE);
  process.exit(2);
}

// ---------------------------------------------------------------- config

const env = process.env;
const ITEM_LINE = env.FK_PROJECT_ITEM_LINE || '- [ ] {id}.';
const LOG_LINE = env.FK_PROJECT_LOG_LINE || '{hhmm} · {id} · {sha} · {note}';
const SLUG_MODE = (env.FK_LOOP_ITEM_IDS || 'slug') !== 'any';
if (!ITEM_LINE.includes('[ ]') || !ITEM_LINE.includes('{id}'))
  die(`[project] item_line must contain "[ ]" and {id} (got: ${ITEM_LINE})`, 1);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fill = (tpl, vals) => tpl.replace(/\{([A-Za-z_]+)\}/g, (m, k) => (Object.hasOwn(vals, k) ? String(vals[k]) : m));

let path = opt.file;
if (path === null) {
  if (!env.FK_PROJECT_NIGHT_FILE) die('[project] night_file is not set', 1);
  path = fill(env.FK_PROJECT_NIGHT_FILE, { n: opt.night });
}
if (!existsSync(path)) die(`no such file: ${path}`);

// Item line: <pre>[<mark>]<mid>{id}<post>. The ID runs up to <post> (or the next space when <post> is empty).
const iMark = ITEM_LINE.indexOf('[ ]');
const iId = ITEM_LINE.indexOf('{id}');
const iPre = ITEM_LINE.slice(0, iMark);
const iMid = ITEM_LINE.slice(iMark + 3, iId);
const iPost = ITEM_LINE.slice(iId + 4);
const ITEM_HEAD = new RegExp(`^${esc(iPre)}\\[(.)\\]`);
const ITEM_RE = new RegExp(`^${esc(iPre)}\\[(.)\\]${esc(iMid)}${iPost ? `(.+?)${esc(iPost)}` : '(\\S+)'}(.*)$`);

// Log line: each {placeholder} becomes a capture group, the literal text around it is matched as written.
const LOG_FIELDS = [];
const logSrc = LOG_LINE.split(/(\{[A-Za-z_]+\})/)
  .map((part) => {
    const m = /^\{([A-Za-z_]+)\}$/.exec(part);
    if (!m) return esc(part);
    LOG_FIELDS.push(m[1]);
    return { hhmm: '(\\d{1,2}:\\d{2})', id: '(.+?)', sha: '(.+?)', note: '(.*)' }[m[1]] ?? '(.*?)';
  })
  .join('');
const LOG_RE = new RegExp(`^${logSrc}$`);
const LOG_SHAPE = fill(LOG_LINE, { hhmm: 'hh:mm', id: '<id>', sha: '<sha|status>', note: '<note>' });

const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/; // item IDs: two or more words, as `factory tick` requires
const FREE_SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/; // log IDs may be one word (plan, phone, kit)
const SHA = /^[0-9a-f]{7,40}$/i;
const SECTIONS = ['backlog', 'with the user', 'needs the phone', 'log'];
const HEADER_BULLETS = [
  ['Branch target', /^- \*\*Branch target:\*\*\s*\S/],
  ['The human', /^- \*\*The human:\*\*\s*\S/],
  ['Rules', /^- \*\*Rules:\*\*\s*\S/],
  ['Previous night', /^- \*\*Previous night:\*\*\s*\S/],
];

// -------------------------------------------------------------- findings

const findings = [];
const error = (line, msg) => findings.push({ level: 'error', line, msg });
const warn = (line, msg) => findings.push({ level: 'warn', line, msg });

const lines = readFileSync(path, 'utf8').split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const ln = (i) => i + 1;

// Comment state: a whole-line "<!-- ... -->", or a block that opens and closes on later lines.
let inComment = false;
const skippable = (line) => {
  if (inComment) {
    if (line.includes('-->')) inComment = false;
    return true;
  }
  const t = line.trim();
  if (t === '') return true;
  if (t.startsWith('<!--')) {
    if (!t.includes('-->')) inComment = true;
    return true;
  }
  return false;
};

// ----------------------------------------------------------------- title

let first = lines.findIndex((l) => l.trim() !== '');
let nightNo = null;
if (first < 0) {
  error(1, 'the file is empty');
  first = 0;
} else {
  const m = /^# (.+?) factory: night (\d+)\s*$/.exec(lines[first]);
  if (!m) error(ln(first), `first line must be "# <name> factory: night N" (got: ${lines[first].slice(0, 60)})`);
  else {
    nightNo = m[2];
    if (opt.night !== null && String(Number(m[2])) !== String(Number(opt.night)))
      error(ln(first), `title says night ${m[2]} but this is night ${opt.night}`);
    if (env.FK_PROJECT_NAME && m[1] !== env.FK_PROJECT_NAME)
      warn(ln(first), `title names "${m[1]}", [project] name is "${env.FK_PROJECT_NAME}"`);
  }
}

// ---------------------------------------------------------------- layout

const headings = []; // { name, canon|null, index }
lines.forEach((l, i) => {
  const h = /^##\s+(.*)$/.exec(l);
  if (!h) return;
  const name = h[1].trim().toLowerCase();
  const canon = SECTIONS.find((s) => name === s || name.startsWith(`${s} `) || name.startsWith(`${s}(`)) ?? null;
  headings.push({ name: h[1].trim(), canon, index: i });
});

// Header bullets: everything between the title and the first "## ".
const headerEnd = headings.length ? headings[0].index : lines.length;
const header = lines.slice(first + 1, headerEnd);
const dateLine = header.findIndex((l) => /^- \*\*Date:\*\*/.test(l));
if (dateLine < 0) warn(ln(first), 'header: missing "- **Date:** YYYY-MM-DD · **Theme:** ..."');
else {
  const l = header[dateLine];
  const d = /^- \*\*Date:\*\*\s*(\S+)/.exec(l);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d[1])) warn(ln(first + 1 + dateLine), 'header: Date is not YYYY-MM-DD');
  if (!/\*\*Theme:\*\*\s*\S/.test(l)) warn(ln(first + 1 + dateLine), 'header: Date line has no "**Theme:** ..." after it');
}
for (const [name, re] of HEADER_BULLETS)
  if (!header.some((l) => re.test(l))) warn(ln(first), `header: missing "- **${name}:** ..."`);

// Required sections, once each, in order; anything else is extra.
const seen = new Map();
let lastRank = -1;
for (const h of headings) {
  if (h.canon === null) {
    warn(ln(h.index), `extra section "## ${h.name}" (the template has ${SECTIONS.map((s) => `"${s}"`).join(', ')})`);
    continue;
  }
  if (seen.has(h.canon)) {
    error(ln(h.index), `section "## ${h.name}" appears twice (first on line ${ln(seen.get(h.canon))})`);
    continue;
  }
  seen.set(h.canon, h.index);
  const rank = SECTIONS.indexOf(h.canon);
  if (rank < lastRank) error(ln(h.index), `section "## ${h.name}" is out of order (expected ${SECTIONS.join(' → ')})`);
  lastRank = Math.max(lastRank, rank);
}
for (const s of SECTIONS) if (!seen.has(s)) error(0, `missing section "## ${s[0].toUpperCase()}${s.slice(1)}"`);

/** Body lines of a section (index of each line kept), from its first heading to the next "## ". */
function body(canon) {
  const h = headings.find((x) => x.canon === canon);
  if (!h) return [];
  const next = headings.find((x) => x.index > h.index);
  const out = [];
  for (let i = h.index + 1; i < (next ? next.index : lines.length); i++) out.push([i, lines[i]]);
  return out;
}

// --------------------------------------------------------------- backlog

const backlogIds = new Map();
/** Split what follows an item's ID (and sha) into leading tags and the rest; warn about tags that look broken. */
function checkTags(rest, at, done) {
  let s = rest.trimStart();
  for (;;) {
    if (s.startsWith('[')) {
      const close = s.indexOf(']');
      if (close < 0) {
        warn(at, 'tag "[" has no closing "]"');
        return;
      }
      if (done && /^\[blocked:/.test(s)) warn(at, 'a done item ([x]) carries a [blocked: ...] tag');
      s = s.slice(close + 1).trimStart();
      continue;
    }
    const w = /^(IDEATE|TASTE)\b/.exec(s) ?? /^"?no test"?(?=\s|$)/.exec(s);
    if (w) {
      s = s.slice(w[0].length).trimStart();
      continue;
    }
    break;
  }
  const bare = /^(needs-user|blocked:|ideate\b|taste\b)/i.exec(s);
  if (bare) warn(at, `tag "${bare[1]}" is not in the template's tag form (use [needs-user], [blocked: why], IDEATE, TASTE, "no test")`);
}

let prevWasItem = false;
for (const [i, line] of body('backlog')) {
  if (skippable(line)) continue;
  if (ITEM_HEAD.test(line)) {
    prevWasItem = true;
    const m = ITEM_RE.exec(line);
    if (!m) {
      error(ln(i), `item line has no ID in the item_line shape "${ITEM_LINE}" (factory tick cannot tick it)`);
      continue;
    }
    const [, mark, id, rest] = m;
    if (mark !== ' ' && mark !== 'x') {
      warn(ln(i), `mark "[${mark}]" is not "[ ]" or "[x]"`);
      continue;
    }
    if (backlogIds.has(id)) error(ln(i), `duplicate backlog ID "${id}" (first on line ${ln(backlogIds.get(id))}); tick ticks only the first`);
    else backlogIds.set(id, i);
    if (SLUG_MODE && !SLUG.test(id))
      warn(ln(i), `ID "${id}" is not a plain-English slug (two or more lowercase words joined by hyphens); factory tick refuses it`);
    let tail = rest;
    if (mark === 'x') {
      const sha = /^\s+(\S+)/.exec(rest);
      if (!sha || !SHA.test(sha[1])) error(ln(i), `done item "${id}" has no sha right after the ID (7-40 hex characters)`);
      else tail = rest.slice(sha[0].length);
    } else if (/^\s+[0-9a-f]{7,40}(\s|$)/i.test(rest)) {
      warn(ln(i), `open item "${id}" carries a sha`);
    }
    checkTags(tail, ln(i), mark === 'x');
  } else if (/^\s+\S/.test(line)) {
    if (!prevWasItem) warn(ln(i), 'indented line with no item above it');
  } else {
    prevWasItem = false;
    warn(ln(i), `not an item line (${ITEM_LINE}): ${line.trim().slice(0, 50)}`);
  }
}

// ------------------------------------------------------------------- log

let finals = 0;
for (const [i, line] of body('log')) {
  if (skippable(line)) continue;
  if (line === 'STOP') continue;
  const fin = /^FINAL \(night (\d+)\) · \S/.exec(line);
  if (fin) {
    finals++;
    if (finals > 1) warn(ln(i), 'a second FINAL line (at most one per night)');
    if (nightNo !== null && Number(fin[1]) !== Number(nightNo)) warn(ln(i), `FINAL says night ${fin[1]}, the title says night ${nightNo}`);
    continue;
  }
  if (/^FINAL\b/.test(line)) {
    warn(ln(i), 'FINAL line should read "FINAL (night N) · <summary>"');
    continue;
  }
  const m = LOG_RE.exec(line);
  if (!m) {
    warn(ln(i), `not a log line (${LOG_SHAPE}) and not STOP or FINAL: ${line.trim().slice(0, 50)}`);
    continue;
  }
  const f = Object.fromEntries(LOG_FIELDS.map((k, j) => [k, m[j + 1]]));
  if (f.hhmm && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(f.hhmm)) warn(ln(i), `time "${f.hhmm}" is not hh:mm`);
  if (f.id !== undefined) {
    const id = f.id.trim();
    const ok = !SLUG_MODE || FREE_SLUG.test(id) || /^TF \d+$/.test(id) || backlogIds.has(id);
    if (!ok) warn(ln(i), `log ID "${id}" is not a slug, a backlog ID or "TF <n>"`);
  }
  if (f.sha !== undefined) {
    const sha = f.sha.trim();
    const words = sha.split(/\s+/);
    if (/^[0-9a-f]{4,6}$/i.test(sha) && /\d/.test(sha)) warn(ln(i), `"${sha}" looks like a short sha (7-40 hex needed)`);
    else if (!SHA.test(sha) && (sha.length > 24 || words.length > 3 || /[:·]/.test(sha)))
      warn(ln(i), `third field "${sha.slice(0, 30)}" is neither a sha nor a short status word`);
  }
}

// ---------------------------------------------------------------- report

findings.sort((a, b) => (a.level === b.level ? a.line - b.line : a.level === 'error' ? -1 : 1));
const errors = findings.filter((f) => f.level === 'error').length;
const warnings = findings.length - errors;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const summary = findings.length === 0 ? 'night-lint: clean' : `night-lint: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`;

if (!(opt.quiet && findings.length === 0)) {
  console.log(`night-lint: ${path}`);
  for (const f of findings.slice(0, opt.limit))
    console.log(`  ${f.level === 'error' ? 'error' : 'warn '}  ${f.line > 0 ? `line ${f.line}: ` : ''}${f.msg}`);
  if (findings.length > opt.limit) console.log(`  ... ${findings.length - opt.limit} more (factory night-lint --file ${path})`);
  console.log(summary);
}
process.exit(errors > 0 ? 1 : 0);
