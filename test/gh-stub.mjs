// A fake `gh` for the stack tests: a node script first on PATH that answers `pr view`, `pr list` and `pr edit` from a JSON file
// (GH_STATE: { prs: [{ number, title, state, headRefName, headRefOid, baseRefName, mergeable, mergeCommit }] }), logs every
// call to GH_LOG, and fails every call when GH_FAIL is set (offline). `pr edit --base` changes the state like GitHub does.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, a.join(' ') + '\\n');
if (process.env.GH_FAIL_NTH_BASE_LIST && a[1] === 'list' && a.includes('--base')) { // fail the Nth \`pr list --base\` call (offline from then on)
  const f = process.env.GH_STATE + '.n'; const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
  fs.writeFileSync(f, String(n));
  if (n >= Number(process.env.GH_FAIL_NTH_BASE_LIST)) { console.error('gh: could not connect (offline)'); process.exit(1); }
}
if (process.env.GH_FAIL) { console.error('gh: could not connect (offline)'); process.exit(1); }
if (a[0] === '--version') { console.log('gh version 0.0.0-stub'); process.exit(0); }
const opt = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
const st = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
if (a[0] === 'pr' && a[1] === 'view') {
  const pr = st.prs.find((p) => p.number === Number(a[2]));
  if (!pr) { console.error('no such PR'); process.exit(1); }
  console.log(JSON.stringify(pr)); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'list') {
  if (a.includes('--jq')) process.exit(0); // cleanup's merged-PR lookups: none
  const state = opt('--state') || 'open', base = opt('--base'), head = opt('--head');
  const list = st.prs.filter((p) => (state === 'all' || p.state.toLowerCase() === state) && (!base || p.baseRefName === base) && (!head || p.headRefName === head));
  console.log(JSON.stringify(list)); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'edit') {
  const pr = st.prs.find((p) => p.number === Number(a[2]));
  if (opt('--base')) pr.baseRefName = opt('--base');
  fs.writeFileSync(process.env.GH_STATE, JSON.stringify(st)); process.exit(0);
}
console.error('stub gh: unhandled ' + a.join(' ')); process.exit(1);
`;

/** Installs the stub as `gh` in `binDir` with an empty PR list; returns helpers to read and change the state. */
export function installGh(binDir, stateFile, logFile) {
  writeFileSync(`${binDir}/gh`, SCRIPT);
  chmodSync(`${binDir}/gh`, 0o755);
  writeFileSync(stateFile, JSON.stringify({ prs: [] }));
  writeFileSync(logFile, '');
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  return {
    env: { GH_STATE: stateFile, GH_LOG: logFile },
    state: read,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    /** Adds or replaces a PR, with sensible defaults. */
    pr(p) {
      const s = read();
      s.prs = s.prs.filter((x) => x.number !== p.number);
      s.prs.push({ title: `PR ${p.number}`, state: 'OPEN', headRefOid: '0'.repeat(40), mergeable: 'MERGEABLE', mergeCommit: null, ...p });
      writeFileSync(stateFile, JSON.stringify(s));
    },
    set(number, fields) {
      const s = read();
      Object.assign(s.prs.find((x) => x.number === number), fields);
      writeFileSync(stateFile, JSON.stringify(s));
    },
  };
}
