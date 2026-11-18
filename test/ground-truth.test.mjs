// App-reported ground truth (proof/verdict/ground-truth.mjs): the parser, the alignment and the HITCH and settle checks,
// on synthetic logs and a synthetic clip whose answers are known.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorsFrom, fieldsOf, goodAnchors, judgeHitches, makeAligner, parseGroundTruth, settleWindows, stillInApp, wallOf } from '../proof/verdict/ground-truth.mjs'

const TOOL = fileURLToPath(new URL('../proof/verdict/proof-verdict.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'ground-truth-test.'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

// steps.log lines as os_log writes them; wall = epoch seconds
const WALL0 = 1792604355
const stamp = (wall) => {
  const d = new Date(wall * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const us = p(Math.round((wall % 1) * 1e6), 6)
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${us}+0000`
}
// media = 100 + seconds; wall = WALL0 + seconds
const log = (rows) => rows.map(([s, text]) => `${stamp(WALL0 + s)} 0x1 Default 0x0 1 0 App: (Foundation) SCENARIO demo ${text}`).join('\n') + '\n'

test('parse: fields (step= takes the rest), wall clock prefixes, MOTION pairs, steps on the media clock', () => {
  assert.deepEqual(fieldsOf(' media=1.5 dur=80.2 expected=16.7 frame=3 step=tap the card'), { media: 1.5, dur: 80.2, expected: 16.7, frame: 3, step: 'tap the card', _words: [] })
  assert.equal(wallOf('2026-10-21 13:39:15.140586-0400 0x1 …'), Date.parse('2026-10-21T13:39:15-04:00') / 1000 + 0.140586)
  const gt = parseGroundTruth(log([
    [0, 'CLOCK media=100.0000 wall=' + WALL0.toFixed(3)],
    [0.5, 'SYNC media=100.5000'],
    [1, 'MOTION start kind=sheet id=1 media=101.0000'],
    [1.2, 'HITCH media=101.2000 dur=120.0 expected=16.7 frame=70 step=open the card'],
    [1.5, 'MOTION end kind=sheet id=1 media=101.5000'],
    [2.5, 'next-1 t=2.50'],
    [2.6, 'MAPRECT media=102.6000 x=0.00 y=0.00 w=402.00 h=874.00 scale=2'],
    [2.6, 'SHEETTOP media=102.6000 y=500.00'],
    [2.7, 'LIVE start id=4 media=102.7000 x=10 y=600 w=20 h=20'],
    [2.8, 'INJECT kind=ghost id=1 media=102.8000 dur=33 step=next-1'],
    [3, 'MOTION start kind=roll id=2 media=103.0000'],
  ]))
  assert.equal(gt.found, true)
  assert.deepEqual(gt.clock, { media: 100, wall: WALL0 })
  assert.deepEqual(gt.motions.map((m) => [m.id, m.kind, m.start, m.end]), [[1, 'sheet', 101, 101.5], [2, 'roll', 103, null]])
  assert.equal(gt.hitches[0].step, 'open the card')
  assert.equal(gt.steps.length, 1)
  assert.equal(gt.steps[0].name, 'next-1')
  assert.ok(Math.abs(gt.steps[0].media - 102.5) < 0.001)
  assert.deepEqual(gt.lives[0], { id: 4, start: 102.7, end: null, x: 10, y: 600, w: 20, h: 20 })
  assert.equal(gt.injects[0].kind, 'ghost')
})

test('alignment: pairs SYNCs with marker runs by their gaps, drops a late anchor, interpolates between anchors', () => {
  // three SYNCs; the video saw the first one 0.48 s late (a launch stall) and missed none
  const syncs = [100.2, 100.9, 105.0]
  const runs = [{ frame: 10, pts: 3.07 }, { frame: 20, pts: 3.29 }, { frame: 300, pts: 7.75 }]
  // the pairing already leaves out the launch SYNC: its gap to the next one does not match the video's
  const anchors = anchorsFrom(syncs, runs)
  assert.deepEqual(anchors.map((a) => a.media), [100.9, 105.0])
  // and an anchor that does get paired but shows later than its neighbour allows is dropped
  const { kept, dropped } = goodAnchors([{ media: 100.2, pts: 3.07 }, ...anchors])
  assert.deepEqual(dropped.map((a) => a.media), [100.2])
  assert.deepEqual(kept.map((a) => a.media), [100.9, 105.0])
  const align = makeAligner(kept)
  assert.ok(Math.abs(align(100.9) - 3.29) < 1e-9)
  assert.ok(Math.abs(align(105.0) - 7.75) < 1e-9)
  assert.ok(Math.abs(align(102.95) - (3.29 + (2.05 / 4.1) * 4.46)) < 1e-9) // interpolated: the clip drifts
  assert.ok(Math.abs(align(106) - 8.75) < 1e-9) // past the last anchor: slope 1
  // a SYNC whose marker the video never showed is skipped, not paired with the next run
  const skip = anchorsFrom([100, 101, 103], [{ frame: 1, pts: 1 }, { frame: 90, pts: 4 }])
  assert.deepEqual(skip.map((a) => [a.media, a.pts]), [[100, 1], [103, 4]])
})

test('hitches: dur against hold_warn / hold_fail; only WARN inside the launch window', () => {
  const gt = parseGroundTruth(log([
    [0, 'CLOCK media=100.0000 wall=' + WALL0.toFixed(3)],
    [0.1, 'SYNC media=100.1000'],
    [0.5, 'HITCH media=100.5000 dur=464.0 expected=16.7 frame=2 step=start'],
    [9.5, 'HITCH media=109.5000 dur=30.0 expected=16.7 frame=500 step=close'],
    [9.7, 'HITCH media=109.7000 dur=203.2 expected=16.7 frame=510 step=close'],
    [9.9, 'HITCH media=109.9000 dur=66.0 expected=16.7 frame=520 step=close'],
  ]))
  const h = judgeHitches(gt, { holdWarn: 50, holdFail: 100, launchWindow: 8 })
  assert.equal(h.status, 'FAIL')
  assert.equal(h.count, 3)
  assert.equal(h.total, 4)
  assert.deepEqual(h.events.map((e) => [e.durMs, e.status, e.launch]), [[203.2, 'FAIL', false], [464, 'WARN', true], [66, 'WARN', false]])
})

test('settle windows: from the end of merged UI motion until the next UI motion, step or settle_ms; camera motion ignored', () => {
  const gt = parseGroundTruth(log([
    [0, 'CLOCK media=100.0000 wall=' + WALL0.toFixed(3)],
    [1, 'MOTION start kind=roll id=1 media=101.0000'],
    [1.1, 'MOTION start kind=sheet id=2 media=101.1000'],
    [1.4, 'MOTION end kind=roll id=1 media=101.4000'],
    [1.5, 'MOTION end kind=sheet id=2 media=101.5000'],
    [1.5, 'MOTION start kind=camera id=3 media=101.5000'],
    [3.0, 'MOTION end kind=camera id=3 media=103.0000'],
    [1.8, 'next t=1.80'],
    [4.0, 'MOTION start kind=morph id=4 media=104.0000'],
    [4.5, 'MOTION end kind=morph id=4 media=104.5000'],
  ]))
  const w = settleWindows(gt, { settleMs: 1000, graceMs: 100 })
  assert.equal(w.length, 2)
  assert.ok(Math.abs(w[0].start - 101.6) < 1e-6 && Math.abs(w[0].end - 101.8) < 1e-3) // cut short by the step
  assert.ok(Math.abs(w[1].start - 104.6) < 1e-6 && Math.abs(w[1].end - 105.5) < 1e-6)
})

// A synthetic recording at 2 px per point (402 x 874 pt): the map (above the sheet's top at y = 500 pt) moves throughout,
// a SYNC marker shows at 0.5 s and 2.0 s, the sheet's content slides 1.0-1.5 s, then (optionally) a "ghost" box shows
// for 2 frames at 1.9 s. Media time = 100 + clip time.
function settleClip(name, ghost) {
  const out = join(dir, `${name}.mp4`)
  const boxes = [
    'drawbox=x=8:y=8:w=12:h=12:color=0xFF00FF:t=fill:enable=between(t\\,0.5\\,0.6)+between(t\\,2.0\\,2.1)+between(t\\,4.5\\,4.6)', // SYNC
    'drawbox=x=mod(t*300\\,600):y=300:w=120:h=120:color=0x2266AA:t=fill', // the map: always moving
    "drawbox=x='if(lt(t\\,1)\\,100\\,if(lt(t\\,1.5)\\,100+(t-1)*400\\,300))':y=1200:w=200:h=120:color=0x333333:t=fill", // sheet content
  ]
  if (ghost) boxes.push('drawbox=x=120:y=1500:w=160:h=40:color=white:t=fill:enable=between(t\\,1.9\\,1.96)')
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xD8D2C4:s=804x1748:r=30:d=6', '-vf', `${boxes.join(',')},format=yuv420p`, '-c:v', 'libx264', '-crf', '14', '-preset', 'ultrafast', out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const steps = join(dir, `${name}.steps.log`)
  writeFileSync(steps, log([
    [0, 'CLOCK media=100.0000 wall=' + WALL0.toFixed(3)],
    [0, 'MAPRECT media=100.0000 x=0.00 y=0.00 w=402.00 h=874.00 scale=2'],
    [0, 'SHEETTOP media=100.0000 y=500.00'],
    [0.5, 'SYNC media=100.5000'],
    [1, 'MOTION start kind=sheet id=1 media=101.0000'],
    [1.5, 'MOTION end kind=sheet id=1 media=101.5000'],
    [2.0, 'SYNC media=102.0000'],
    [4.5, 'SYNC media=104.5000'],
  ]))
  return { clip: out, steps }
}
const verdict = (c, args = []) => {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FK_')))
  const r = spawnSync('node', [TOOL, c.clip, '--steps', c.steps, '--out', out, '--json', '--skip-start', '0', ...args], { encoding: 'utf8', env })
  return { code: r.status, v: JSON.parse(readFileSync(join(out, 'verdict.json'), 'utf8')), stderr: r.stderr }
}

test('settle check: a 2-frame change in the sheet after it settled is caught; the moving map never counts; report-only by default', () => {
  const bad = verdict(settleClip('ghost', true))
  assert.equal(bad.v.groundTruth.anchors.length, 3, JSON.stringify(bad.v.groundTruth))
  assert.equal(bad.v.settle.status, 'FAIL')
  assert.equal(bad.v.settle.judged, 1)
  assert.ok(bad.v.settle.events[0].changedPx > 1000, JSON.stringify(bad.v.settle.events[0]))
  assert.ok(Math.abs(bad.v.settle.events[0].t - 1.9) < 0.05)
  assert.equal(bad.v.verdict, 'PASS') // report-only
  assert.equal(bad.code, 0)
  const gated = verdict(settleClip('ghost-gated', true), ['--settle-gate'])
  assert.equal(gated.v.verdict, 'FAIL')
  assert.equal(gated.code, 4)
  const clean = verdict(settleClip('clean', false), ['--settle-gate'])
  assert.equal(clean.v.settle.status, 'PASS', JSON.stringify(clean.v.settle))
  assert.equal(clean.code, 0)
})

test('settle check: a window far from any SYNC anchor is not judged', () => {
  const c = settleClip('far', true)
  // keep only the SYNC at 104.5: the window at 101.6 s is 2.9 s from it, beyond the 2 s reach
  writeFileSync(c.steps, readFileSync(c.steps, 'utf8').split('\n').filter((l) => !/SYNC media=10[02]\.5?0/.test(l)).join('\n'))
  const { v, code } = verdict(c, ['--settle-gate'])
  assert.equal(v.groundTruth.anchors.length, 1, JSON.stringify(v.groundTruth))
  assert.equal(v.settle.judged, 0)
  assert.equal(v.settle.notJudged, 1)
  assert.equal(v.settle.status, 'PASS')
  assert.equal(code, 0)
})

test('stillInApp: a gap the app never felt is a still screen; one it felt, or one outside its log, is a hold', () => {
  // The app logged from media 100 to 114; the clip runs 2 s behind its media clock (an aligner from two anchors).
  const gt = parseGroundTruth(log([
    [0, 'CLOCK media=100.0000 wall=' + WALL0.toFixed(3)],
    [0.5, 'SYNC media=100.5000'],
    [4.2, 'HITCH media=104.2000 dur=60.0 expected=16.7 frame=200 step=still page'],
    [11, 'HITCH media=111.0000 dur=1900.0 expected=16.7 frame=300 step=stalled'],
    [14, 'SHEETTOP media=114.0000 y=500.00'],
  ]))
  const align = makeAligner([{ media: 100.5, pts: 2.5 }, { media: 105, pts: 7 }])
  // 2.5 s gap at clip 4.0-6.5 (media 102.0-104.5): only a 60 ms hitch near it, so the screen was still.
  assert.equal(stillInApp({ t: 4.0, gapMs: 2500 }, gt, align), true)
  // 2 s gap at clip 12.2-14.2 (media 110.2-112.2): a 1.9 s hitch covers it, so it was a stall.
  assert.equal(stillInApp({ t: 12.2, gapMs: 2000 }, gt, align), false)
  // The same big hitch 1 s outside a gap (alignment can drift that far) still keeps the hold: it may be this one.
  assert.equal(stillInApp({ t: 10.0, gapMs: 2000 }, gt, align), false)
  // A gap past the app's last line (media 114 = clip 16): no ground truth there, so it stays a hold.
  assert.equal(stillInApp({ t: 15.5, gapMs: 1000 }, gt, align), false)
  // No alignment or no ground truth: judged from pixels alone, as before.
  assert.equal(stillInApp({ t: 4.0, gapMs: 2500 }, gt, null), false)
  assert.equal(stillInApp({ t: 4.0, gapMs: 2500 }, parseGroundTruth(''), align), false)
})
