// Shared by `factory stack`, the hook-guard and `factory cleanup`: who targets a branch, and the stacks.json state file.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Seconds a `gh` call may take before it counts as unavailable. */
export const GH_DEADLINE_S = Number(process.env.FK_STACK_GH_TIMEOUT_S) || 20;

/**
 * The open PRs whose base is `branch`: { prs: [{ number, head }] }, or { error } when gh could not say (not installed,
 * offline, not logged in, over its deadline). `repo` is owner/name for gh -R; `cwd` where gh runs.
 */
export function openBasePrs(branch, { repo = '', cwd = process.cwd(), timeoutS = GH_DEADLINE_S } = {}) {
  const args = ['pr', 'list', ...(repo ? ['-R', repo] : []), '--base', branch, '--state', 'open', '--limit', '100', '--json', 'number,headRefName'];
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: timeoutS * 1000, killSignal: 'SIGKILL' });
  if (r.error) return { error: r.error.code === 'ENOENT' ? 'gh is not installed' : r.error.code === 'ETIMEDOUT' ? `gh did not answer within ${timeoutS}s` : r.error.message };
  if (r.status !== 0) return { error: `gh exited ${r.status}: ${(r.stderr || '').trim().split('\n')[0] || 'no message'}` };
  try {
    const list = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(list)) throw new Error('not a list');
    return { prs: list.map((p) => ({ number: p.number, head: p.headRefName })) };
  } catch (e) {
    return { error: `gh gave unreadable output (${e.message})` };
  }
}

export const stacksPath = (stateDir) => join(stateDir, 'stacks.json');

/** The recorded links: { version: 1, links: [{ child, worktree, parentPr, parentBranch, parentHead, createdAt }] }. */
export function readStacks(stateDir) {
  const file = stacksPath(stateDir);
  if (!existsSync(file)) return { version: 1, links: [] };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return { version: 1, links: Array.isArray(data.links) ? data.links : [] };
}

export function writeStacks(stateDir, data) {
  const file = stacksPath(stateDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}
