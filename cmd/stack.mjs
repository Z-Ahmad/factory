#!/usr/bin/env node
// desc: stacked PRs: cut a child from a parent PR (new), retarget and push the children after the parent merges (land), show the stacks (status)
// usage: factory stack new <parent-pr|parent-branch> [--name <name>] [--dry-run]
//        factory stack land <merged-pr> [--dry-run]
//        factory stack status
//        factory stack bases <branch>      (plumbing for cleanup: the open PRs that target <branch>)
//
// A stack is a child PR whose base is its parent's branch. The owner merges bottom-up with squash merges, so the
// child's own history still holds the parent's commits and GitHub shows it conflicting in every file the parent
// touched. GitHub does not rebase the rest of the stack. `land` does what a person did by hand:
//   new     cuts a worktree and branch for the child from the parent's head (through `factory worktree`) and records the
//           link in <state_dir>/stacks.json: child branch, parent PR number and branch, the parent's head sha at the cut.
//           Refuses past [stack] max_depth (default 3). Prints the `gh pr create --base <parent-branch>` line. No `gh stack`.
//   land    after the owner merged a PR: for each open PR based on its branch, `gh pr edit --base <[stack] target>`, then
//           (in the child's worktree, or one made for it) `git merge --no-edit origin/<target>`. A conflicted file is
//           resolved with the child's side only when `git diff --quiet <parent-head> origin/<target> -- <file>` says main
//           holds the parent's final version of it; any other conflict stops with exit 3 and the merge left in progress.
//           The merge commit goes through the repo's hooks (never --no-verify) and a plain `git push` (never forced).
//           Only when every child is retargeted and pushed does it delete the merged PR's remote branch, local branch and
//           worktree (and its derived-data folders: `cleanup --worktree-caches`). --dry-run prints the plan. Run it again after fixing a failure: it picks the children up again.
//   status  each stack as a tree: PR number, title, state, base, mergeable, and whether the base branch still exists;
//           warns when a base is merged but the child was not landed, and when a base is gone (GitHub closes the child).
// [stack] target (default "main") is where a stack lands; max_depth (default 3) the most PRs one stack holds.
// Exit 0; 1 on a failure (not merged, gh or git failed, a push was refused); 2 on a bad argument or no gh; 3 when a child
// has a conflict a person must resolve (the merge is left in progress in the worktree it names).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { removeWorktreeCaches } from '../lib/disk.mjs';
import { GH_DEADLINE_S, openBasePrs, readStacks, writeStacks } from '../lib/stack.mjs';

const env = process.env;
const KIT = env.FK_KIT_DIR || resolve(new URL('..', import.meta.url).pathname);
const MAIN = env.FK_PROJECT_MAIN_CHECKOUT ? realpathSync(env.FK_PROJECT_MAIN_CHECKOUT) : process.cwd();
const STATE = env.FK_PROJECT_STATE_DIR || join(MAIN, '.factory');
const TARGET = env.FK_STACK_TARGET || 'main';
const MAX_DEPTH = Number(env.FK_STACK_MAX_DEPTH) || 3;
const REPO = env.FK_GIT_GITHUB || '';
const NET_S = Number(env.FK_STACK_NET_TIMEOUT_S) || 120; // every fetch and push
const LOCAL_S = 60; // every local git call

const out = (...a) => console.log(...a);
const note = (s) => out(`stack: ${s}`);
const die = (msg, code = 1) => {
  console.error(`factory-stack: ${msg}`);
  process.exit(code);
};

const gitEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(k)));
function sh(cmd, args, { cwd = MAIN, timeoutS = LOCAL_S } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: gitEnv, encoding: 'utf8', timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return {
    ok: r.status === 0 && !r.error,
    status: r.status ?? (timedOut ? 124 : 127),
    stdout: (r.stdout ?? '').trim(),
    stderr: ((r.stderr ?? '') + (r.error && !timedOut ? r.error.message : timedOut ? `${cmd} timed out after ${timeoutS}s` : '')).trim(),
  };
}
const git = (cwd, ...args) => sh('git', args, { cwd });
const gitNet = (cwd, ...args) => sh('git', args, { cwd, timeoutS: NET_S });
const ghR = (sub, ...args) => sh('gh', [...sub, ...(REPO ? ['-R', REPO] : []), ...args], { timeoutS: GH_DEADLINE_S });
const ghJson = (sub, ...args) => {
  const r = ghR(sub, ...args);
  if (!r.ok) return { error: r.stderr || `gh exited ${r.status}` };
  try {
    return { data: JSON.parse(r.stdout || 'null') };
  } catch {
    return { error: 'gh gave unreadable output' };
  }
};

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const short = (sha) => (sha || '').slice(0, 7);
const fill = (tpl, name) => tpl.replaceAll('{name}', name);
const onOrigin = (branch) => git(MAIN, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`).ok;
const remoteHas = (branch) => {
  const r = gitNet(MAIN, 'ls-remote', '--exit-code', '--heads', 'origin', branch);
  return r.status === 0 ? true : r.status === 2 ? false : null; // null: could not ask
};
const hasLocal = (branch) => git(MAIN, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).ok;

/** [{ path, branch }] for every worktree of the project. */
function worktrees() {
  const r = git(MAIN, 'worktree', 'list', '--porcelain');
  const list = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) list.push((cur = { path: line.slice(9), branch: '' }));
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}
const worktreeOf = (branch) => worktrees().find((w) => w.branch === branch) ?? null;

/** Tracked changes (untracked files such as cache symlinks do not count). */
const dirty = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=no').stdout !== '';
const mergeInProgress = (dir) => git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').ok;
const unmerged = (dir) => git(dir, 'diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);

// ------------------------------------------------------------------ arguments

const [sub, ...rest] = process.argv.slice(2);
const flags = { dryRun: false, name: '' };
const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--name') flags.name = rest[++i] ?? die('--name wants a value', 2);
  else if (a.startsWith('--')) die(`unknown arg: ${a}`, 2);
  else pos.push(a);
}
const usage = () => die('usage: factory stack new <parent-pr|parent-branch> [--name <name>] [--dry-run] | land <merged-pr> [--dry-run] | status | bases <branch>', 2);
if (!['new', 'land', 'status', 'bases'].includes(sub ?? '')) usage();
if (sub !== 'bases') {
  const v = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) die('gh is required', 2);
}
const prNumber = (s) => (/^#?\d+$/.test(s ?? '') ? Number(s.replace('#', '')) : null);

const PR_FIELDS = 'number,title,state,headRefName,headRefOid,baseRefName,mergeable,mergeCommit';

// ------------------------------------------------------------------ depth

/** How many PRs deep `branch` sits: 1 when it is based on the target (or on nothing known), +1 for each parent. */
function depthOf(branch, openByHead) {
  const links = readStacks(STATE).links;
  let n = 1;
  let cur = branch;
  for (let i = 0; i < 20; i++) {
    const link = links.find((l) => l.child === cur);
    const parent = link ? link.parentBranch : openByHead?.get(cur)?.baseRefName;
    if (!parent || parent === TARGET) break;
    n++;
    cur = parent;
  }
  return n;
}

// ------------------------------------------------------------------ new

function cmdNew() {
  const ref = pos[0] ?? usage();
  git(MAIN, 'fetch', 'origin', '--prune', '--quiet');
  let parent;
  const n = prNumber(ref);
  if (n) {
    const r = ghJson(['pr', 'view', String(n)], '--json', PR_FIELDS);
    if (r.error) die(`cannot read PR #${n}: ${r.error}`);
    parent = { pr: n, branch: r.data.headRefName, head: r.data.headRefOid, state: r.data.state };
  } else {
    const r = ghJson(['pr', 'list'], '--head', ref, '--state', 'open', '--json', PR_FIELDS);
    const pr = r.data?.[0];
    parent = { pr: pr?.number ?? null, branch: ref, head: pr?.headRefOid ?? '', state: pr ? 'OPEN' : 'NONE' };
    if (!pr && r.error) note(`warning: could not look up a PR for ${ref} (${r.error}); recording the branch only`);
  }
  if (parent.state === 'MERGED' || parent.state === 'CLOSED')
    die(`PR #${parent.pr} is ${parent.state.toLowerCase()}: cut from ${TARGET} (factory worktree <name>), not from its branch`);
  if (!onOrigin(parent.branch)) die(`branch ${parent.branch} is not on origin; push it first`);
  const originHead = git(MAIN, 'rev-parse', `origin/${parent.branch}`).stdout;
  if (parent.head && parent.head !== originHead) note(`warning: origin/${parent.branch} (${short(originHead)}) is not the PR's head (${short(parent.head)}); cutting from origin`);
  parent.head = originHead;

  const open = ghJson(['pr', 'list'], '--state', 'open', '--limit', '200', '--json', 'number,headRefName,baseRefName');
  if (open.error) note(`warning: could not list open PRs (${open.error}); depth is counted from ${'stacks.json'} only`);
  const openByHead = new Map((open.data ?? []).map((p) => [p.headRefName, p]));
  const parentDepth = depthOf(parent.branch, openByHead);
  if (parentDepth + 1 > MAX_DEPTH)
    die(`a child of ${parent.branch} would be ${parentDepth + 1} PRs deep; [stack] max_depth is ${MAX_DEPTH}. Land the bottom of the stack first, or stack on a different parent`);

  // a name nobody has: the worktree directory, its branch (from [git] worktree_branch) and the local branch must be free
  const slug = parent.branch.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'stack';
  const base = flags.name || `${slug}-next`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base)) die(`bad name: ${base}`, 2);
  const tpl = env.FK_GIT_WORKTREE_BRANCH || 'factory/{name}-wt';
  const wtDir = join(MAIN, env.FK_GIT_WORKTREES_DIR || '.worktrees');
  let name = base;
  for (let k = 2; existsSync(join(wtDir, name)) || hasLocal(fill(tpl, name)) || onOrigin(fill(tpl, name)); k++) {
    if (flags.name) die(`${name} is taken (worktree ${join(wtDir, name)} or branch ${fill(tpl, name)} exists)`);
    name = `${base}-${k}`;
  }
  const childBranch = fill(tpl, name);
  const prLine = `gh pr create --base ${parent.branch} --head ${childBranch}`;
  if (flags.dryRun) {
    note(`dry run: would cut ${childBranch} from origin/${parent.branch} (${short(parent.head)}${parent.pr ? `, PR #${parent.pr}` : ''}), depth ${parentDepth + 1} of ${MAX_DEPTH}`);
    out(`  worktree: ${join(wtDir, name)}`);
    out(`  then: ${prLine}`);
    return 0;
  }
  const w = spawnSync(join(KIT, 'bin', 'factory'), ['worktree', name, '--base', `origin/${parent.branch}`], { cwd: MAIN, env: gitEnv, stdio: 'inherit', timeout: 600_000, killSignal: 'SIGKILL' });
  if (w.status !== 0) die(`factory worktree ${name} failed (exit ${w.status ?? 'signal'})`);
  const wt = join(wtDir, name);
  const branch = git(wt, 'branch', '--show-current').stdout || childBranch;
  const cut = git(wt, 'rev-parse', 'HEAD').stdout;
  if (cut !== parent.head) die(`the new worktree is at ${short(cut)}, not at the parent's head ${short(parent.head)}; nothing recorded`);
  const data = readStacks(STATE);
  data.links = data.links.filter((l) => l.child !== branch);
  data.links.push({ child: branch, worktree: name, parentPr: parent.pr, parentBranch: parent.branch, parentHead: parent.head, createdAt: new Date().toISOString() });
  writeStacks(STATE, data);
  note(`${branch} cut from ${parent.branch} (${short(parent.head)}${parent.pr ? `, PR #${parent.pr}` : ', no PR yet'}), depth ${parentDepth + 1} of ${MAX_DEPTH}; recorded in ${join(STATE, 'stacks.json')}`);
  out(`worktree: ${wt}`);
  out('open the child PR from it:');
  out(`  git push -u origin ${branch}`);
  out(`  ${prLine}`);
  if (parent.pr) out(`after the owner merges #${parent.pr}: factory stack land ${parent.pr}`);
  return 0;
}

// ------------------------------------------------------------------ land

/** Resolves a conflicted file with the child's side; a file the child deleted is removed. */
function takeOurs(dir, file) {
  const stages = git(dir, 'ls-files', '-u', '--', file).stdout.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]);
  if (stages.includes('2')) return git(dir, 'checkout', '--ours', '--', file).ok && git(dir, 'add', '--', file).ok;
  return git(dir, 'rm', '-q', '--', file).ok;
}

/**
 * Brings one child up to date with the target and pushes it.
 * Returns { ok } | { conflict: [files], dir } | { fail: message }.
 */
function landChild(child, parent) {
  const { head } = child;
  let dir;
  let made = null; // a worktree this call created, removed again when the child lands
  const existing = worktreeOf(head);
  if (existing) {
    dir = existing.path;
    if (!mergeInProgress(dir) && dirty(dir)) return { fail: `${dir} has uncommitted changes to tracked files; commit or stash them and run land again` };
  } else {
    const wtDir = join(MAIN, env.FK_GIT_WORKTREES_DIR || '.worktrees');
    dir = join(wtDir, `stack-land-${child.number}`);
    if (hasLocal(head)) {
      const unique = git(MAIN, 'rev-list', '--count', `origin/${head}..${head}`).stdout;
      if (unique !== '0') return { fail: `local branch ${head} has ${unique} commit(s) origin/${head} lacks and no worktree; push it or check it out, then run land again` };
    }
    mkdirSync(wtDir, { recursive: true });
    const add = git(MAIN, 'worktree', 'add', '-q', '-B', head, dir, `origin/${head}`);
    if (!add.ok) return { fail: `cannot check out ${head}: ${add.stderr}` };
    made = { dir, head };
  }
  const drop = () => {
    if (!made) return;
    git(MAIN, 'worktree', 'remove', '--force', made.dir);
    git(MAIN, 'branch', '-D', made.head);
  };

  if (mergeInProgress(dir)) {
    const left = unmerged(dir);
    return left.length ? { conflict: left, dir, unresolved: true } : { fail: `a merge is in progress in ${dir} with nothing left to resolve; commit it (git commit --no-edit) and run land again` };
  }
  // bring the worktree level with what is on origin for the child
  const originRef = `origin/${head}`;
  if (!git(dir, 'merge-base', '--is-ancestor', originRef, 'HEAD').ok) {
    if (git(dir, 'merge-base', '--is-ancestor', 'HEAD', originRef).ok) {
      const ff = git(dir, 'merge', '--ff-only', '-q', originRef);
      if (!ff.ok) return { fail: `cannot fast-forward ${head} to ${originRef}: ${ff.stderr}` };
    } else return { fail: `${head} has diverged from ${originRef}; reconcile it by hand (land never rewrites)` };
  }
  if (git(dir, 'merge-base', '--is-ancestor', `origin/${TARGET}`, 'HEAD').ok) {
    note(`  #${child.number}: already contains origin/${TARGET}`);
  } else {
    const m = git(dir, 'merge', '--no-edit', `origin/${TARGET}`);
    if (!m.ok) {
      const files = unmerged(dir);
      if (!files.length) return { fail: `git merge origin/${TARGET} failed in ${dir}: ${m.stderr || m.stdout}`, keep: mergeInProgress(dir) };
      const same = files.filter((f) => git(dir, 'diff', '--quiet', parent.head, `origin/${TARGET}`, '--', f).ok);
      const differ = files.filter((f) => !same.includes(f));
      if (differ.length) {
        return { conflict: differ, safe: same, dir };
      }
      for (const f of same) if (!takeOurs(dir, f)) return { fail: `could not resolve ${f} in ${dir}`, keep: true };
      const c = git(dir, 'commit', '--no-edit');
      if (!c.ok) return { fail: `the merge commit was refused in ${dir} (the repo's hooks run on it; nothing is skipped): ${c.stderr || c.stdout}`, keep: true };
      note(`  #${child.number}: resolved ${same.length} conflicted file${same.length === 1 ? '' : 's'} with the child's side (${TARGET} holds ${short(parent.head)}'s version of each)`);
    }
  }
  const p = gitNet(dir, 'push', 'origin', `HEAD:refs/heads/${head}`);
  if (!p.ok) return { fail: `plain push of ${head} failed (nothing forced): ${p.stderr}`, keep: true };
  drop();
  return { ok: true };
}

function removeMergedBranch(merged) {
  const { headRefName: branch, headRefOid: oid } = merged;
  // the one place the kit deletes a base branch: with every child retargeted, and only if GitHub agrees nobody targets it
  const rem = remoteHas(branch);
  if (rem === null) note(`could not reach origin to delete ${branch}; left alone`);
  else if (rem) {
    const still = openBasePrs(branch, { repo: REPO, cwd: MAIN });
    if (still.error) {
      note(`kept: remote ${branch} (could not confirm no open PR targets it: ${still.error})`);
      return false;
    }
    if (still.prs.length) {
      note(`kept: remote ${branch} is the base of ${still.prs.map((x) => `#${x.number}`).join(', ')}`);
      return false;
    }
    const d = gitNet(MAIN, 'push', 'origin', '--delete', branch);
    note(d.ok ? `deleted remote branch ${branch}` : `could not delete remote ${branch}: ${d.stderr}`);
    if (!d.ok) return false;
  } else note(`remote ${branch} is already gone`);
  const wt = worktreeOf(branch);
  const here = (() => {
    const top = git(process.cwd(), 'rev-parse', '--show-toplevel');
    return top.ok ? realpathSync(top.stdout) : '';
  })();
  const behind = hasLocal(branch) && git(MAIN, 'cat-file', '-e', `${oid}^{commit}`).ok ? git(MAIN, 'rev-list', '--count', `${oid}..${branch}`).stdout : '0';
  if (behind !== '0') {
    note(`kept: local ${branch} has ${behind} commit(s) newer than the merged head`);
    return true;
  }
  if (wt && real(wt.path) !== MAIN) {
    if (real(wt.path) === here) note(`kept: worktree ${wt.path} (you are in it)`);
    else if (dirty(wt.path)) note(`kept: worktree ${wt.path} (uncommitted changes)`);
    else {
      const r = git(MAIN, 'worktree', 'remove', '--force', wt.path);
      note(r.ok ? `removed worktree ${wt.path}` : `could not remove worktree ${wt.path}: ${r.stderr}`);
      // its build folders go with it (never one a live lease or process uses); a failure here never fails the land
      if (r.ok) {
        const c = removeWorktreeCaches(basename(wt.path), branch, { env });
        if (c?.n) note(`removed ${c.n} derived-data folder${c.n === 1 ? '' : 's'} of ${basename(wt.path)}`);
      }
    }
  }
  if (hasLocal(branch) && !worktreeOf(branch)) {
    const r = git(MAIN, 'branch', '-D', branch);
    if (r.ok) note(`deleted local branch ${branch}`);
  }
  return true;
}

function cmdLand() {
  const n = prNumber(pos[0]) ?? usage();
  const v = ghJson(['pr', 'view', String(n)], '--json', PR_FIELDS);
  if (v.error) die(`cannot read PR #${n}: ${v.error}`);
  const merged = v.data;
  if (merged.state !== 'MERGED') die(`PR #${n} is ${merged.state.toLowerCase()}, not merged: land runs after the owner merges it`);
  const parent = { branch: merged.headRefName, head: merged.headRefOid };
  note(`${flags.dryRun ? 'dry run: ' : ''}#${n} ${merged.headRefName} merged (head ${short(parent.head)}${merged.mergeCommit?.oid ? `, merge commit ${short(merged.mergeCommit.oid)}` : ''}); target ${TARGET}`);

  // children: open PRs based on its branch, plus recorded ones already retargeted by an earlier run that did not finish
  const based = ghJson(['pr', 'list'], '--base', parent.branch, '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,baseRefName');
  if (based.error) die(`cannot list PRs based on ${parent.branch}: ${based.error}`);
  const children = based.data.map((p) => ({ number: p.number, title: p.title, head: p.headRefName, base: p.baseRefName }));
  const stacks = readStacks(STATE);
  for (const l of stacks.links) {
    if (!(l.parentPr === n || l.parentBranch === parent.branch) || l.landedFrom || children.some((c) => c.head === l.child)) continue;
    const r = ghJson(['pr', 'list'], '--head', l.child, '--state', 'open', '--json', 'number,title,headRefName,baseRefName');
    const p = r.data?.[0];
    if (p) children.push({ number: p.number, title: p.title, head: p.headRefName, base: p.baseRefName });
  }

  if (!children.length) note('no open PR is based on it');
  if (flags.dryRun) {
    for (const c of children) {
      const wt = worktreeOf(c.head);
      out(`  #${c.number} ${c.head} (base ${c.base}):`);
      if (c.base !== TARGET) out(`    gh pr edit ${c.number} --base ${TARGET}`);
      out(`    in ${wt ? wt.path : `a new worktree for ${c.head}`}: git merge --no-edit origin/${TARGET}`);
      out(`    a conflicted file is taken from ${c.head} only when ${TARGET} equals ${short(parent.head)} for it; otherwise stop (exit 3)`);
      out(`    git push origin HEAD:refs/heads/${c.head}   (plain; never forced)`);
    }
    out(`  then, only if every child went through: delete remote ${parent.branch}, local ${parent.branch} and its worktree`);
    return 0;
  }

  git(MAIN, 'fetch', 'origin', '--prune', '--quiet');
  gitNet(MAIN, 'fetch', 'origin', '--quiet', parent.branch);
  if (!git(MAIN, 'cat-file', '-e', `${parent.head}^{commit}`).ok) gitNet(MAIN, 'fetch', 'origin', '--quiet', `refs/pull/${n}/head`);
  if (!git(MAIN, 'cat-file', '-e', `${parent.head}^{commit}`).ok) die(`the merged head ${short(parent.head)} is not available locally (branch deleted and refs/pull/${n}/head not fetchable); nothing was changed`);
  if (!onOrigin(TARGET)) die(`origin/${TARGET} does not exist; check [stack] target. Nothing was changed`);

  let conflicts = 0;
  let failures = 0;
  const landed = [];
  for (const c of children) {
    note(`#${c.number} ${c.head}`);
    if (c.base !== TARGET) {
      const e = ghR(['pr', 'edit', String(c.number)], '--base', TARGET);
      if (!e.ok) {
        note(`  FAILED to retarget #${c.number}: ${e.stderr}`);
        failures++;
        continue;
      }
      note(`  retargeted onto ${TARGET}`);
    }
    gitNet(MAIN, 'fetch', 'origin', '--quiet', c.head);
    const r = landChild(c, parent);
    if (r.ok) {
      note(`  pushed ${c.head} (plain push)`);
      landed.push(c);
    } else if (r.conflict) {
      conflicts++;
      if (r.unresolved) note(`  CONFLICT: a merge is still in progress in ${r.dir}; resolve it, commit, and run land again`);
      else note(`  CONFLICT merging origin/${TARGET} into ${c.head}: ${TARGET} differs from ${short(parent.head)} in these files, so a person must choose:`);
      for (const f of r.conflict) out(`    ${f}`);
      if (r.safe?.length) out(`    (not touched, but safe to take from the child: ${r.safe.join(', ')})`);
      note(`  merge left in progress in ${r.dir}`);
    } else {
      failures++;
      note(`  FAILED: ${r.fail}`);
      if (r.keep) note(`  state left in ${worktreeOf(c.head)?.path ?? 'its worktree'}`);
    }
  }

  const data = readStacks(STATE);
  const sha = git(MAIN, 'rev-parse', `origin/${TARGET}`).stdout;
  for (const c of landed) {
    const link = data.links.find((l) => l.child === c.head);
    const next = { child: c.head, parentPr: null, parentBranch: TARGET, parentHead: sha, landedFrom: n, landedAt: new Date().toISOString() };
    if (link) Object.assign(link, next);
    else data.links.push({ worktree: null, createdAt: null, ...next });
  }
  if (!conflicts && !failures) data.links = data.links.filter((l) => l.child !== parent.branch);
  if (landed.length || (!conflicts && !failures)) writeStacks(STATE, data);

  if (conflicts || failures) {
    note(`${landed.length} of ${children.length} child${children.length === 1 ? '' : 'ren'} landed; ${parent.branch} was NOT deleted (it goes when every child is through: run land again)`);
    return conflicts ? 3 : 1;
  }
  removeMergedBranch(merged);
  note(`done: ${landed.length} child${landed.length === 1 ? '' : 'ren'} on ${TARGET}`);
  return 0;
}

// ------------------------------------------------------------------ status

function cmdStatus() {
  git(MAIN, 'fetch', 'origin', '--prune', '--quiet');
  const r = ghJson(['pr', 'list'], '--state', 'all', '--limit', '200', '--json', PR_FIELDS);
  if (r.error) die(`cannot list PRs: ${r.error}`);
  const prs = r.data;
  const baseMemo = new Map();
  const exists = (branch) => {
    if (!baseMemo.has(branch)) baseMemo.set(branch, onOrigin(branch));
    return baseMemo.get(branch);
  };
  const rank = { OPEN: 0, MERGED: 1, CLOSED: 2 };
  const byHead = new Map();
  for (const p of [...prs].sort((a, b) => rank[b.state] - rank[a.state] || a.number - b.number)) byHead.set(p.headRefName, p); // an open PR wins
  const parentOf = (p) => (p.baseRefName === TARGET ? null : (byHead.get(p.baseRefName) ?? null));
  // a stack member: not on the target, or a parent of one that is
  const members = new Set();
  for (const p of prs) {
    if (p.state === 'MERGED' || p.baseRefName === TARGET) continue;
    if (p.state === 'CLOSED' && (exists(p.baseRefName) || p.baseRefName === TARGET)) continue; // closed for its own reasons
    let cur = p;
    for (let i = 0; cur && i < 20; i++) {
      members.add(cur.number);
      cur = parentOf(cur);
    }
  }
  const recorded = readStacks(STATE).links.filter((l) => !l.landedFrom && !prs.some((p) => p.headRefName === l.child && p.state === 'OPEN'));
  if (!members.size && !recorded.length) {
    note(`no stacks (no PR is based on a branch other than ${TARGET})`);
    return 0;
  }
  const kids = new Map();
  for (const p of prs) if (members.has(p.number)) {
    const par = parentOf(p);
    const k = par && members.has(par.number) ? par.number : 0;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(p);
  }
  const warnings = [];
  const line = (p) => {
    const baseOk = p.baseRefName === TARGET || exists(p.baseRefName);
    const mergeable = p.state === 'OPEN' ? String(p.mergeable ?? 'UNKNOWN').toUpperCase() : '-';
    const base = p.baseRefName === TARGET ? `${p.baseRefName}` : `${p.baseRefName} (${baseOk ? 'exists' : 'GONE'})`;
    const par = parentOf(p);
    if (p.state === 'OPEN' && par?.state === 'MERGED') warnings.push(`#${p.number}: its base #${par.number} (${p.baseRefName}) is merged but #${p.number} was not landed; run: factory stack land ${par.number}`);
    if (p.baseRefName !== TARGET && !baseOk) {
      if (p.state === 'OPEN') warnings.push(`#${p.number}: its base branch ${p.baseRefName} is gone; GitHub will close #${p.number}${par ? ` (restore the branch, then: factory stack land ${par.number})` : ''}`);
      else if (p.state === 'CLOSED') warnings.push(`#${p.number}: closed, its base branch ${p.baseRefName} is gone (restore it, \`gh pr reopen ${p.number}\`, then \`factory stack land\` its parent)`);
    }
    return `#${p.number} ${p.title}  [${p.state.toLowerCase()}] base ${base}, mergeable: ${mergeable}`;
  };
  const draw = (p, prefix, last, root) => {
    out(`${root ? '' : prefix + (last ? '└─ ' : '├─ ')}${line(p)}`);
    const next = root ? '' : prefix + (last ? '   ' : '│  ');
    const cs = kids.get(p.number) ?? [];
    cs.forEach((c, i) => draw(c, next, i === cs.length - 1, false));
  };
  out(`stacks onto ${TARGET}:`);
  for (const root of kids.get(0) ?? []) {
    const par = parentOf(root);
    if (root.baseRefName !== TARGET && !par) out(`(base branch ${root.baseRefName}: ${exists(root.baseRefName) ? 'exists, no PR' : 'GONE'})`);
    draw(root, '', true, true);
    out('');
  }
  for (const l of recorded) out(`${l.child}: cut from ${l.parentBranch}${l.parentPr ? ` (#${l.parentPr})` : ''}, no open PR yet`);
  for (const w of warnings) out(`WARN ${w}`);
  return 0;
}

// ------------------------------------------------------------------ bases

/** Prints "#<n>" per open PR that targets the branch. Exit 0 when there is one, 1 none, 2 when gh could not say. */
function cmdBases() {
  const branch = pos[0] ?? usage();
  const r = openBasePrs(branch, { repo: REPO, cwd: MAIN });
  if (r.error) {
    // gh cannot answer: fall back to the recorded stacks, so a base is still kept
    const rec = readStacks(STATE).links.filter((l) => l.parentBranch === branch && !l.landedFrom && onOrigin(l.child));
    for (const l of rec) out(`${l.child}`);
    console.error(`factory-stack: ${r.error}`);
    return rec.length ? 0 : 2;
  }
  for (const p of r.prs) out(`#${p.number}`);
  return r.prs.length ? 0 : 1;
}

const code = { new: cmdNew, land: cmdLand, status: cmdStatus, bases: cmdBases }[sub]();
process.exit(code);
