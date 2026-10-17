// A synthetic project tree for the cleanup and disk-guard tests. Everything lives under one scratch
// directory: a state dir with frame dumps, a build-cache dir, a scratch tmp dir, a git checkout with
// worktrees and archives, and fake `xcrun` and `df` programs first on PATH.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './helpers.mjs';

const LONG_AGO = new Date('2001-01-01T00:00:00Z');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });

const SHOOTER = '11111111-0000-0000-0000-00000000000A';
const SIMS = [
  ['Shooter Phone', SHOOTER, 'Booted'],
  ['box-factory-1', '11111111-0000-0000-0000-000000000002', 'Booted'],
  ['box-opus-2', '11111111-0000-0000-0000-000000000003', 'Shutdown'],
  ['box-test-123', '11111111-0000-0000-0000-000000000004', 'Shutdown'],
  ['box-test-abc', '11111111-0000-0000-0000-000000000005', 'Shutdown'],
  ['box-test-kit', '11111111-0000-0000-0000-000000000006', 'Booted'],
  ['box-factory-prot', SHOOTER.replace('A', '7'), 'Shutdown'],
  ['Plain Phone', '11111111-0000-0000-0000-000000000008', 'Shutdown'],
];

const old = (p) => utimesSync(p, LONG_AGO, LONG_AGO);

/**
 * Builds the tree and returns paths plus helpers.
 * `diskExtra` and `simExtra` are TOML lines appended inside [disk] and [sim]; `extraToml` text goes at the end of the file.
 */
export function tree({ diskOverrides = {}, diskExtra = '', simExtra = '', gitExtra = '', extraToml = () => '' } = {}) {
  const s = scratch();
  const root = realpathSync(s.dir);
  const p = (...a) => join(root, ...a);

  // frame dumps: two old, one new, plus files that must stay
  const shots = (n, d) => p('state', `night-${n}`, 'shots', d);
  for (const [n, d] of [[1, 'a'], [1, 'b'], [2, 'c']]) {
    mkdirSync(join(shots(n, d), 'frames'), { recursive: true });
    writeFileSync(join(shots(n, d), 'frames', 'f.png'), 'x');
  }
  writeFileSync(join(shots(1, 'a'), 'contact.png'), 'x');
  old(join(shots(1, 'a'), 'frames'));
  old(join(shots(1, 'b'), 'frames'));

  // proof clips, each next to evidence that must stay (one nested, one upper-case, one in a night of its own)
  writeFileSync(join(shots(1, 'a'), 'run.mp4'), 'x');
  mkdirSync(join(shots(1, 'a'), 'sub'));
  writeFileSync(join(shots(1, 'a'), 'sub', 'deep.mp4'), 'x');
  writeFileSync(join(shots(1, 'a'), 'sub', 'verdict.json'), '{}');
  writeFileSync(join(shots(1, 'b'), 'x.MP4'), 'x');
  writeFileSync(join(shots(1, 'b'), 'verdict.json'), '{}');
  writeFileSync(join(shots(2, 'c'), 'c.mp4'), 'x');
  writeFileSync(join(shots(2, 'c'), 'flags.png'), 'x');

  // the per-user temp dir ($TMPDIR): trace and upload leftovers among files that must stay
  for (const d of ['XcodeDistPipeline.old', 'instruments-run', 'Run.trace', 'other-dir', 'dd-old1']) mkdirSync(p('utmp', d), { recursive: true });
  mkdirSync(p('utmp', 'XcodeDistPipeline.new'));
  for (const f of ['big.ktrace', 'notes.txt', 'my-instruments.log', 'fresh.ktrace']) writeFileSync(p('utmp', f), 'x');
  for (const f of ['XcodeDistPipeline.old', 'instruments-run', 'Run.trace', 'other-dir', 'dd-old1', 'big.ktrace', 'notes.txt', 'my-instruments.log']) old(p('utmp', f));

  // build caches
  for (const d of ['dd-app', 'dd-test-Foo', 'dd-test-kit', 'dd-stale1', 'dd-stale2', 'dd-scripted', 'dd-literal', 'notes'])
    mkdirSync(p('cache', d), { recursive: true });

  // scratch dir
  const tmpNames = ['dd-old1', 'dd-sim', 'ee1-old', 'ee1-new', 'sg-abc', 'theme-x', 'tmp.zzz', 'unrelated', 'dd-fresh'];
  for (const d of tmpNames) mkdirSync(p('tmp', d), { recursive: true });
  writeFileSync(p('tmp', 'ee1-old', 'file'), 'x');
  for (const d of ['dd-old1', 'dd-sim', 'ee1-old', 'sg-abc', 'theme-x', 'tmp.zzz', 'unrelated']) old(p('tmp', d));

  // git checkout with an origin, a nightly branch and worktrees
  const main = p('main');
  git(root, 'init', '-q', '--bare', 'origin.git');
  git(root, 'init', '-q', '-b', 'trunk', 'main');
  git(main, 'remote', 'add', 'origin', p('origin.git'));
  mkdirSync(join(main, 'ios', 'scripts'), { recursive: true });
  writeFileSync(join(main, 'ios', 'scripts', 'a.sh'), 'resolve_dd "$1" scripted\necho dd-literal\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'one');
  git(main, 'push', '-q', 'origin', 'trunk');
  git(main, 'push', '-q', 'origin', 'trunk:refs/heads/nightly/up');
  git(main, 'fetch', '-q', 'origin');
  const wt = join(main, '.worktrees');
  mkdirSync(wt);
  for (const n of ['agent-merged', 'agent-symlink', 'agent-dirty', 'agent-ahead', 'night-1', 'phone', 'other'])
    git(main, 'worktree', 'add', '-q', join(wt, n), '-b', `${n}-b`, 'trunk');
  symlinkSync('/nonexistent', join(wt, 'agent-symlink', 'cache-link'));
  writeFileSync(join(wt, 'agent-dirty', 'stray.txt'), 'stray');
  writeFileSync(join(wt, 'agent-ahead', 'more.txt'), 'more');
  git(join(wt, 'agent-ahead'), 'add', 'more.txt');
  git(join(wt, 'agent-ahead'), 'commit', '-q', '-m', 'ahead');

  // archives: 10, 9 in the checkout; 8, 7 in one worktree; 6 in another
  const arch = (dir, n) => {
    mkdirSync(join(dir, 'build', `App-${n}.xcarchive`), { recursive: true });
    writeFileSync(join(dir, 'build', `App-${n}.xcarchive`, 'Info'), 'x');
  };
  arch(main, 10); arch(main, 9); arch(join(wt, 'night-1'), 8); arch(join(wt, 'night-1'), 7); arch(join(wt, 'phone'), 6);

  // fake programs
  const bin = p('bin');
  mkdirSync(bin);
  const xcrunLog = p('xcrun.log');
  const list = SIMS.map(([n, u, st]) => `    ${n} (${u}) (${st}) `).join('\n');
  writeFileSync(
    join(bin, 'xcrun'),
    `#!/usr/bin/env bash
if [[ "$1 $2" == "simctl list" ]]; then
cat <<'LIST'
== Devices ==
-- iOS 99.0 --
${list}
LIST
else
  echo "$*" >> '${xcrunLog}'
fi
`,
  );
  // fake df: prints $DF_GB gigabytes free on the first call, $DF_GB_AFTER (when set) on later ones
  writeFileSync(
    join(bin, 'df'),
    `#!/usr/bin/env bash
n=0; [[ -f '${p('df.count')}' ]] && n=$(cat '${p('df.count')}')
echo $((n + 1)) > '${p('df.count')}'
gb="$DF_GB"; if [[ $n -gt 0 && -n "\${DF_GB_AFTER:-}" ]]; then gb="$DF_GB_AFTER"; fi
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "fake 1000 1000 $((gb * 1048576)) 1% /"
`,
  );
  // fake pgrep: lists the lines of pgrep.out (a test writes it to pretend `simctl io … recordVideo` is running)
  writeFileSync(
    join(bin, 'pgrep'),
    `#!/usr/bin/env bash
[[ -s '${p('pgrep.out')}' ]] && { cat '${p('pgrep.out')}'; exit 0; }
exit 1
`,
  );
  chmodSync(join(bin, 'xcrun'), 0o755);
  chmodSync(join(bin, 'df'), 0o755);
  chmodSync(join(bin, 'pgrep'), 0o755);

  const disk = {
    min_gb: 40,
    floor_gb: 20,
    low_cleanup: ['frames', 'tmp', 'sims'],
    frames_age_days: 2,
    ...diskOverrides,
  };
  const q = (v) => (Array.isArray(v) ? `[${v.map(q).join(', ')}]` : typeof v === 'number' ? String(v) : `"${v}"`);
  const toml = `[kit]
repo = "https://example.invalid/factory.git"
ref  = "v0.0.0"

[project]
name          = "fixture"
main_checkout = "${main}"
state_dir     = "${p('state')}"
night_file    = "{state_dir}/night-{n}.md"
shots_dir     = "{state_dir}/night-{n}/shots"

[git]
worktrees_dir       = ".worktrees"
worktree_branch     = "x/{name}-wt"
push_branch         = "nightly/{name}"
agent_worktrees     = "agent-*"
protected_worktrees = ["night-*", "phone"]${gitExtra ? `\n${gitExtra}` : ''}

[[targets]]
name    = "app"
base    = "origin/trunk"
pr_base = "trunk"
default = true

[disk]
min_gb           = ${disk.min_gb}
floor_gb         = ${disk.floor_gb}
low_cleanup      = ${q(disk.low_cleanup)}
frames_age_days  = ${disk.frames_age_days}
dd_root          = "${p('cache')}"
dd_keep          = ["app", "test-kit", "test-*"]
dd_keep_derive   = ["ios/scripts/*.sh"]
dd_keep_patterns = ['resolve_dd "[^"]*" +[a-z][a-z-]*', '\\bdd-[a-z][a-z-]*[a-z]\\b']
tmp_dir          = "${p('tmp')}"
tmp_keep         = ["${p('tmp', 'dd-sim')}"]
tmp_globs        = ["dd-*", "ee1*", "sg-*", "theme*", "tmp.*"]
archives         = { glob = "build/App-*.xcarchive", keep = 3 }${diskExtra ? `\n${diskExtra}` : ''}

[sim]
protected = ["${SHOOTER.replace('A', '7')}", "box-test-kit", "Shooter Phone"]
ephemeral = ["box-factory-*", "box-opus-*", "box-test-+([0-9])"]
sweep     = ["box-*"]${simExtra ? `\n${simExtra}` : ''}
${extraToml(p)}`;
  writeFileSync(p('factory.toml'), toml);

  const env = { FACTORY_TOML: p('factory.toml'), PATH: `${bin}:${process.env.PATH}`, DF_GB: '67', TMPDIR: `${p('utmp')}/`, FK_CORESIM_DIR: p('coresim') };
  const names = (...a) => (existsSync(p(...a)) ? readdirSync(p(...a)).sort() : []);
  const xcrunCalls = () => (existsSync(xcrunLog) ? readFileSync(xcrunLog, 'utf8').trim().split('\n') : []);
  /** Replaces the fixture root in output so expectations don't depend on the scratch path. */
  const clean = (text) => text.split(root).join('<root>');
  const gitOut = (cwd, ...a) => git(cwd, ...a).toString().trim();
  /** A simulator's data dir under the fake CoreSimulator root, `kb` kilobytes big. */
  const simData = (udid, kb) => {
    mkdirSync(p('coresim', udid, 'data'), { recursive: true });
    writeFileSync(p('coresim', udid, 'data', 'blob'), Buffer.alloc(kb * 1024, 1));
  };
  const pgrepSays = (text) => writeFileSync(p('pgrep.out'), text);
  return { ...s, root, p, main, wt, env, names, xcrunCalls, clean, tmpNames, simData, pgrepSays, git: gitOut };
}
