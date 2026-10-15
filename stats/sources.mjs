// The non-transcript sources: a night's own file (checkboxes, log lines, build numbers) and GitHub pull requests.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** Reads a night file. Items are the top-level `- [ ]` / `- [x]` lines above the Log section. */
export function readNightFile(path, buildPattern) {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const at = text.search(/^## Log\b/m);
  const head = at < 0 ? text : text.slice(0, at);
  const log = (at < 0 ? '' : text.slice(at)).split('\n').filter((l) => /^\d{1,2}:\d{2}\b/.test(l));
  const items = { shipped: 0, blocked: 0, open: 0 };
  for (const l of head.split('\n')) {
    const m = /^- \[([^\]]*)\]/.exec(l);
    if (!m) continue;
    if (/^x$/i.test(m[1])) items.shipped++;
    else if (/blocked/i.test(m[1]) || /\[blocked/i.test(l)) items.blocked++;
    else if (m[1] === ' ') items.open++;
  }
  let re = null;
  if (buildPattern) {
    try {
      re = new RegExp(buildPattern);
    } catch {
      re = null;
    }
  }
  const builds = new Set();
  if (re) for (const l of log) for (const m of l.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) if (m[1]) builds.add(m[1]);
  return {
    items,
    log_lines: log.length,
    blocked_log_lines: log.filter((l) => /\bBLOCKED\b/.test(l)).length,
    builds: [...builds].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
  };
}

// ----------------------------------------------------------------------- GitHub (read-only)

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gh: ${r.error.code ?? r.error.message}`);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout;
}

const globToRegex = (g) =>
  new RegExp(
    '^' +
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0001')
        .replace(/\*\*/g, '\u0002')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0001/g, '(?:.*/)?')
        .replace(/\u0002/g, '.*') +
      '$',
  );

/** areas: { name: "glob,glob" } -> [{ name, res }] in the order written */
export function compileAreas(areas = {}) {
  return Object.entries(areas).map(([name, globs]) => ({
    name,
    res: String(globs)
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)
      .map(globToRegex),
  }));
}

export const areaOf = (file, areas) => areas.find((a) => a.res.some((re) => re.test(file)))?.name ?? 'other';

/** One pull request: totals from `gh pr view`, per-file lines from the pulls API, split by area. */
export function fetchPr(repo, number, areas) {
  const v = JSON.parse(
    gh([
      'pr', 'view', String(number), '-R', repo, '--json',
      'number,title,state,baseRefName,createdAt,mergedAt,additions,deletions,changedFiles,commits',
    ]),
  );
  const split = {};
  const addTo = (name, a, d) => {
    const s = (split[name] ??= { additions: 0, deletions: 0, files: 0 });
    s.additions += a;
    s.deletions += d;
    s.files++;
  };
  if (areas.length) {
    const out = gh([
      'api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--jq',
      '.[] | {f: .filename, a: .additions, d: .deletions}',
    ]);
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      addTo(areaOf(f.f, areas), f.a, f.d);
    }
  }
  return {
    number: v.number,
    title: v.title,
    state: v.state,
    base: v.baseRefName,
    created: v.createdAt,
    merged: v.mergedAt ?? null,
    additions: v.additions,
    deletions: v.deletions,
    files: v.changedFiles,
    commits: Array.isArray(v.commits) ? v.commits.length : (v.commits ?? 0),
    areas: Object.fromEntries(Object.entries(split).sort()),
  };
}
