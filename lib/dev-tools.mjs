#!/usr/bin/env node
// usage: node dev-tools.mjs <dir> <command>
// The programs a dev command needs that neither PATH nor a node_modules/.bin (in <dir> or above it) has, one per line.
// `npm run <script>` (also pnpm/yarn, `-w <workspace>`) is followed into the nearest package.json's script, up to 3
// deep; a quoted argument (`concurrently "npm run a"`) is data, not a command. A project with package.json files that
// declare dependencies and no node_modules anywhere prints `node_modules`. Prints nothing when all is there.
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

const [dir0, cmd0] = process.argv.slice(2);
if (!dir0 || !cmd0) process.exit(0);
const dir = resolve(dir0);

const ancestors = [];
for (let d = dir; ; d = dirname(d)) {
  ancestors.push(d);
  if (dirname(d) === d) break;
}
const binDirs = ancestors.map((a) => join(a, 'node_modules', '.bin'));
const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
const exe = (d, w) => [w, `${w}.cmd`, `${w}.exe`].some((n) => existsSync(join(d, n)));
const have = (w) => pathDirs.some((d) => exe(d, w)) || binDirs.some((d) => exe(d, w));

const BUILTINS = new Set(['cd', 'echo', 'export', 'exit', 'set', 'unset', 'test', '[', 'true', 'false', 'source', '.', 'exec', 'env', 'wait', 'sleep', 'trap', 'eval', 'command', 'printf', ':']);
const PMS = new Set(['npm', 'pnpm', 'yarn']);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const nearestPackage = (from) => {
  for (let d = from; ; d = dirname(d)) {
    const j = existsSync(join(d, 'package.json')) ? readJson(join(d, 'package.json')) : null;
    if (j) return { dir: d, json: j };
    if (dirname(d) === d) return null;
  }
};

const missing = new Set();

// split a command line into segments, dropping quoted text
function segments(text) {
  const unquoted = text.replace(/"[^"]*"|'[^']*'/g, ' ');
  return unquoted.split(/&&|\|\||;|\||&|\n|\(|\)|`|\$\(/).map((s) => s.trim().split(/\s+/).filter(Boolean));
}

function scan(text, from, depth) {
  for (const toks of segments(text)) {
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
    const word = toks[0];
    if (!word || BUILTINS.has(word) || /[/$\\*{}]/.test(word)) continue;
    if (!have(word)) missing.add(word);
    if (PMS.has(word) && depth < 3) {
      let script = null;
      let base = from;
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i];
        if ((t === '-w' || t === '--workspace' || t === '--filter') && toks[i + 1]) {
          const root = nearestPackage(from);
          const ws = toks[++i];
          if (root) {
            const cand = [join(root.dir, ws), ...(root.json.workspaces ?? []).filter((w) => typeof w === 'string' && !w.includes('*')).map((w) => join(root.dir, w))];
            const hit = cand.find((c) => existsSync(join(c, 'package.json')) && (c.endsWith(ws) || readJson(join(c, 'package.json'))?.name === ws));
            if (hit) base = hit;
          }
        } else if (t === 'run' || t === 'run-script') { script = toks[i + 1]; break; }
        else if (!t.startsWith('-') && word !== 'npm') { script = t; break; }
      }
      if (script && !script.startsWith('-')) {
        const pkg = nearestPackage(base);
        const body = pkg?.json.scripts?.[script];
        if (body) scan(body, pkg.dir, depth + 1);
      }
    }
  }
}
scan(cmd0, dir, 0);

// dependencies declared, but nothing installed anywhere
const pkg = nearestPackage(dir);
if (pkg && (Object.keys(pkg.json.dependencies ?? {}).length || Object.keys(pkg.json.devDependencies ?? {}).length)
  && !ancestors.some((a) => existsSync(join(a, 'node_modules')))) missing.add('node_modules');

for (const m of missing) console.log(m);
