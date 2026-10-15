// Synthetic clips from ffmpeg's lavfi (no simulator, no recordings): a clean moving clip must PASS, one inverted frame
// must FAIL as a flash at that frame, dropped frames mid-motion must FAIL as a hold, a scenario budget turns a hold into
// a WARN, an object moving fast across a tile is NOT a flash, and iOS's leading frames (black, then the dark launch
// screen) are found and skipped while the app's own frames are judged. Thresholds, the budgets file and the fail markers
// come from FK_* variables (what bin/factory exports from factory.toml) or from flags.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultsFromEnv, DEFAULTS } from '../proof/verdict/proof-verdict.mjs'

const TOOL = fileURLToPath(new URL('../proof/verdict/proof-verdict.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'proof-verdict-test.'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const run = (args) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
}

// 3 s at 60 fps, 240x520, with moving content. `vf` is appended to the generator.
function clip(name, vf = 'null', extra = []) {
  const out = join(dir, `${name}.mp4`)
  run(['-f', 'lavfi', '-i', 'testsrc2=s=240x520:r=60:d=3', '-vf', `${vf},format=yuv420p`, ...extra, '-c:v', 'libx264', '-crf', '12', out])
  return out
}

// 1 s black + 1 s dark navy (iOS's launch screen) + 3 s of moving content.
function launchClip(name, vf = 'null') {
  const out = join(dir, `${name}.mp4`)
  run(['-f', 'lavfi', '-i', 'color=c=black:s=240x520:r=60:d=1', '-f', 'lavfi', '-i', 'color=c=0x0F172A:s=240x520:r=60:d=1', '-f', 'lavfi', '-i', 'testsrc2=s=240x520:r=60:d=3',
    '-filter_complex', `[0:v][1:v][2:v]concat=n=3:v=1[c];[c]${vf},format=yuv420p[o]`, '-map', '[o]', '-c:v', 'libx264', '-crf', '12', out])
  return out
}

// The environment a project's factory.toml would give the tool: FK_* only as the test sets it.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FK_')))

function verdict(path, args = [], skip = ['--skip-start', '0'], env = {}) {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`)
  const r = spawnSync('node', [TOOL, path, '--out', out, '--json', ...skip, ...args], { encoding: 'utf8', env: { ...cleanEnv(), ...env } })
  let v = null
  try { v = JSON.parse(readFileSync(join(out, 'verdict.json'), 'utf8')) } catch { /* the tool refused to run */ }
  return { code: r.status, v, out, stderr: r.stderr }
}

test('a clean moving clip passes', () => {
  const { code, v } = verdict(clip('clean'))
  assert.equal(code, 0, JSON.stringify(v.flash))
  assert.equal(v.flash.count, 0)
  assert.equal(v.hold.count, 0)
})

test('one inverted frame is a flash, flagged at that frame, with a flags.png', () => {
  const { code, v } = verdict(clip('flash', 'negate=enable=eq(n\\,90)'))
  assert.equal(code, 4)
  assert.equal(v.flash.status, 'FAIL')
  const worst = v.flash.events[0]
  assert.ok(Math.abs(worst.frame - 90) <= 1, `flash at frame ${worst.frame}`)
  assert.ok(v.flagsPng, 'flags.png written')
})

test('frames dropped mid-motion are a hold; 50-100 ms only warns', () => {
  const dropped = (n) => clip(`hold${n}`, `select='not(between(n\\,90\\,${90 + n}))',setpts=PTS`, ['-fps_mode', 'vfr'])
  const long = verdict(dropped(6)) // ~117 ms gap
  assert.equal(long.code, 4)
  assert.equal(long.v.hold.status, 'FAIL')
  assert.ok(long.v.hold.worstMs >= 100, `worst hold ${long.v.hold.worstMs} ms`)
  assert.equal(long.v.flash.status, 'PASS')
  const mid = verdict(dropped(3)) // ~67 ms gap
  assert.equal(mid.code, 0)
  assert.equal(mid.v.hold.status, 'WARN')
  assert.ok(mid.v.flagsPng, 'a WARN hold still writes flags.png')
})

// A clip with a 6-frame hole at 1.5 s, named for the scenario a budget can match.
function holdClip(name) {
  const path = join(dir, `${name}.mp4`)
  run(['-f', 'lavfi', '-i', 'testsrc2=s=240x520:r=60:d=3', '-vf', "select='not(between(n\\,90\\,96))',setpts=PTS,format=yuv420p", '-fps_mode', 'vfr', '-c:v', 'libx264', '-crf', '12', path])
  return path
}
const budgetsFile = join(dir, 'budgets.json')
writeFileSync(budgetsFile, JSON.stringify([{ match: 'slow-fade*', holdFail: null, why: 'pacing waived: holds only WARN' }]))

test('a scenario budget makes holds warn-only; an explicit flag beats it; --no-budget ignores it', () => {
  const path = holdClip('slow-fade-in')
  const budgeted = verdict(path, ['--budgets', budgetsFile])
  assert.equal(budgeted.code, 0, budgeted.stderr)
  assert.equal(budgeted.v.hold.status, 'WARN')
  assert.equal(budgeted.v.budget.match, 'slow-fade*')
  assert.equal(verdict(path, ['--budgets', budgetsFile, '--hold-fail', '100']).code, 4)
  assert.equal(verdict(path, ['--budgets', budgetsFile, '--no-budget']).code, 4)
  assert.equal(verdict(path).code, 4) // no budgets file configured: the default thresholds apply
  assert.equal(verdict(holdClip('other-name'), ['--budgets', budgetsFile]).code, 4) // the glob does not match
})

test('the budgets file comes from FK_PROOF_IOS_BUDGETS, relative paths to FK_ROOT; a missing file is an error', () => {
  const path = holdClip('slow-fade-out')
  const viaEnv = verdict(path, [], undefined, { FK_PROOF_IOS_BUDGETS: 'budgets.json', FK_ROOT: dir })
  assert.equal(viaEnv.code, 0, viaEnv.stderr)
  assert.equal(viaEnv.v.budget.match, 'slow-fade*')
  const missing = verdict(path, [], undefined, { FK_PROOF_IOS_BUDGETS: 'nope.json', FK_ROOT: dir })
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /no such budgets file/)
})

test('[proof.ios.verdict] thresholds arrive as FK_PROOF_IOS_VERDICT_*, and a flag still beats them', () => {
  const path = holdClip('hold-thresholds')
  const strict = verdict(path, [], undefined, { FK_PROOF_IOS_VERDICT_HOLD_FAIL_MS: '1000' })
  assert.equal(strict.code, 0) // the 117 ms hold is under the configured fail line: WARN
  assert.equal(strict.v.hold.status, 'WARN')
  assert.equal(strict.v.settings.holdFail, 1000)
  assert.equal(verdict(path, ['--hold-fail', '100'], undefined, { FK_PROOF_IOS_VERDICT_HOLD_FAIL_MS: '1000' }).code, 4)
  const bad = verdict(path, [], undefined, { FK_PROOF_IOS_VERDICT_GRID: '4x8', FK_PROOF_IOS_VERDICT_WIDTH: 'wide' })
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /width must be a number/)
})

test('defaultsFromEnv lays the configured values over the built-in defaults', () => {
  assert.deepEqual(defaultsFromEnv({}), DEFAULTS)
  const d = defaultsFromEnv({ FK_PROOF_IOS_VERDICT_FLASH_WARN: '7', FK_PROOF_IOS_VERDICT_GRID: '4x8', FK_PROOF_IOS_VERDICT_BOUNCE_WINDOW_S: '2.5', FK_PROOF_IOS_VERDICT_LAUNCH_SEARCH_S: '90', FK_PROOF_IOS_VERDICT_SKIP_START_S: '' })
  assert.equal(d.flashWarn, 7)
  assert.equal(d.grid, '4x8')
  assert.equal(d.bounceWindow, 2.5)
  assert.equal(d.searchS, 90)
  assert.equal(d.skipStart, 'auto') // an empty value is "not set"
  assert.equal(d.flashFail, DEFAULTS.flashFail)
})

test('a LAYOUT-LOOP line in steps.log fails the verdict; the marker is configurable', () => {
  const steps = join(dir, 'steps.log')
  writeFileSync(steps, 'App: SCENARIO x start\nApp: LAYOUT-LOOP detected\nApp: RELAYOUT-STORM seen\n')
  const { code, v } = verdict(clip('clean2'), ['--steps', steps])
  assert.equal(code, 4)
  assert.equal(v.layoutLoop.count, 1)
  // another marker, by flag or by [proof.ios] fail_markers (one per line in FK_PROOF_IOS_FAIL_MARKERS)
  assert.equal(verdict(clip('clean3'), ['--steps', steps, '--fail-marker', 'RELAYOUT-STORM']).v.layoutLoop.count, 1)
  const env = verdict(clip('clean4'), ['--steps', steps], undefined, { FK_PROOF_IOS_FAIL_MARKERS: 'RELAYOUT-STORM\nLAYOUT-LOOP' })
  assert.equal(env.v.layoutLoop.count, 2)
  assert.equal(verdict(clip('clean5'), ['--steps', steps], undefined, { FK_PROOF_IOS_FAIL_MARKERS: 'NEVER-LOGGED' }).code, 0)
})

test("iOS's black frame and launch screen are skipped, the app's own frames are judged", () => {
  // The black second is iOS's: the start lands on the first navy frame (t = 1.0 s).
  const clean = verdict(launchClip('lead'), [], [])
  assert.equal(clean.v.launch.mode, 'detected')
  assert.ok(clean.v.launch.startS >= 0.95 && clean.v.launch.startS <= 1.1, `start ${clean.v.launch.startS}`)
  assert.equal(clean.code, 0, JSON.stringify(clean.v.flash))
  // From there on everything is judged: a flash during the launch screen (frame 90, t = 1.5 s) and one in the app (frame 200).
  for (const f of [90, 200]) {
    const bad = verdict(launchClip(`flash${f}`, `negate=enable=eq(n\\,${f})`), [], [])
    assert.equal(bad.code, 4, `flash at ${f}`)
    assert.ok(Math.abs(bad.v.flash.events[0].frame - f) <= 1)
  }
})

test('an object moving fast across the screen is motion, not a flash', () => {
  // A white box moving 40 px per frame: any one tile sees it for a single frame (A -> B -> A to a tile).
  const out = join(dir, 'box.mp4')
  run(['-f', 'lavfi', '-i', 'color=c=0x203040:s=240x520:r=60:d=2', '-f', 'lavfi', '-i', 'color=c=white:s=40x40:r=60:d=2', '-filter_complex', "[0:v][1:v]overlay=x='mod(n*40\\,200)':y=240,format=yuv420p[o]", '-map', '[o]', '-c:v', 'libx264', '-crf', '12', out])
  const { code, v } = verdict(out)
  assert.equal(code, 0, JSON.stringify(v.flash.events))
})

// ---------- (d) bounce ----------

// `segments` = [[color, seconds], ...] full-frame at 60 fps (hex without #); `band` = only the bottom half changes (the
// top half keeps the first colour): a region that is >= 40% of the tiles but not the whole screen.
function bounceClip(name, segments, { band = false } = {}) {
  const out = join(dir, `${name}.mp4`)
  const total = segments.reduce((s, x) => s + x[1], 0)
  const inputs = segments.flatMap(([c, d]) => ['-f', 'lavfi', '-i', `color=c=0x${c}:s=240x520:r=60:d=${d}`])
  const cat = `${segments.map((_, i) => `[${i}:v]`).join('')}concat=n=${segments.length}:v=1[c]`
  const vf = band
    ? `${cat};color=c=0x${segments[0][0]}:s=240x260:r=60:d=${total}[top];[c]crop=240:260:0:260[bot];[top][bot]vstack,format=yuv420p[o]`
    : `${cat};[c]format=yuv420p[o]`
  run([...inputs, '-filter_complex', vf, '-map', '[o]', '-c:v', 'libx264', '-crf', '10', out])
  return out
}
const LIGHT = 'e8eef7'
const DARK = '0f172a'

test('light -> dark -> light within 1.2 s is a bounce, FAIL at theme scale, with its frames in flags.png', () => {
  const { code, v } = verdict(bounceClip('bounce-full', [[LIGHT, 1], [DARK, 0.4], [LIGHT, 1]]))
  assert.equal(code, 4)
  assert.equal(v.verdict, 'FAIL')
  assert.equal(v.bounce.status, 'FAIL')
  assert.equal(v.bounce.count, 1)
  const e = v.bounce.events[0]
  assert.ok(Math.abs(e.t - 0.97) < 0.1 && Math.abs(e.returnT - 1.4) < 0.1, `bounce ${e.t} -> ${e.returnT}`)
  assert.ok(e.swing > 150 && e.residual < 5, JSON.stringify(e))
  assert.equal(v.flash.status, 'PASS') // 24 frames away is not the flash detector's
  assert.ok(v.flagsPng, 'flags.png written with the first / far / return frames')
})

test('a one-way flip, a return after more than 1.2 s, and a return that is not to the start are not bounces', () => {
  assert.equal(verdict(bounceClip('flip-once', [[LIGHT, 1], [DARK, 2]])).v.bounce.count, 0)
  assert.equal(verdict(bounceClip('slow-return', [[LIGHT, 1], [DARK, 1.5], [LIGHT, 1]])).v.bounce.count, 0)
  assert.equal(verdict(bounceClip('other-place', [[LIGHT, 1], [DARK, 0.4], ['8090a0', 1]])).v.bounce.count, 0)
})

test('a half-screen region that drops and pops back is a WARN (swing ~40), not a FAIL', () => {
  const { code, v } = verdict(bounceClip('bounce-band', [['c8d2e0', 1], ['98a2b8', 0.4], ['c8d2e0', 1]], { band: true }))
  assert.equal(v.bounce.status, 'WARN', JSON.stringify(v.bounce))
  assert.equal(code, 0)
  assert.ok(v.bounce.worstScore >= 20 && v.bounce.worstScore < 60, `score ${v.bounce.worstScore}`)
  assert.ok(v.flagsPng, 'a WARN bounce still writes flags.png')
})

test('a large sheet sliding up and back is motion, not a bounce', () => {
  // A 240x364 light panel rises from the bottom edge and leaves again in 1 s: it covers ~70% of the tiles at its peak,
  // but never steps them: a few tiles change per frame.
  const out = join(dir, 'sheet.mp4')
  run(['-f', 'lavfi', '-i', 'color=c=0x305070:s=240x520:r=60:d=3', '-f', 'lavfi', '-i', 'color=c=0xf0f0e8:s=240x364:r=60:d=3',
    '-filter_complex', "[0:v][1:v]overlay=x=0:y='if(between(t\\,1\\,2)\\,main_h-overlay_h*sin(PI*(t-1))\\,main_h)',format=yuv420p[o]", '-map', '[o]', '-c:v', 'libx264', '-crf', '10', out])
  const { code, v } = verdict(out)
  assert.equal(code, 0, JSON.stringify(v.bounce))
  assert.equal(v.bounce.count, 0)
})

test('--bounce-fail turns a bounce into a WARN (the same switch a scenario budget uses)', () => {
  const path = bounceClip('bounce-warnonly', [[LIGHT, 1], [DARK, 0.4], [LIGHT, 1]])
  const r = verdict(path, ['--bounce-fail', '1000'])
  assert.equal(r.code, 0)
  assert.equal(r.v.bounce.status, 'WARN')
})
