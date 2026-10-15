// Frame grabs must decode in order and never seek. Synthetic clips (ffmpeg lavfi, no recordings) check the mapping: time ->
// the frame on screen, "end" = the last frame, contact sheet / dump counts, and a variable-frame-rate clip with B-frames and
// dropped frames (the shape simctl writes), where the grab must still land on the segment whose time it asks for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contactSheet, dumpFrames, frameIndexAt, grabFrame } from '../proof/clip-frames.mjs'

const dir = mkdtempSync(join(tmpdir(), 'clip-frames-test.'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

// Mean luma (0..255) of a PNG, from decoded grey bytes.
function luma(png) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 })
  assert.equal(r.status, 0, String(r.stderr))
  let s = 0
  for (const b of r.stdout) s += b
  return s / r.stdout.length
}

// 4 flat colours, 1 s each, 30 fps: dark, grey, light, white.
const clip = join(dir, 'steps.mp4')
run('ffmpeg', ['-v', 'error', '-y', ...[0x10, 0x60, 0xb0, 0xf0].flatMap((v) => ['-f', 'lavfi', '-i', `color=c=0x${v.toString(16).padStart(2, '0').repeat(3)}:s=120x260:r=30:d=1`]),
  '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1,format=yuv420p[o]', '-map', '[o]', '-c:v', 'libx264', '-crf', '8', clip])

test('frameIndexAt is the last frame on screen at t', () => {
  const pts = [0, 0.1, 0.2, 1.5, 1.6]
  assert.equal(frameIndexAt(pts, -1), 0)
  assert.equal(frameIndexAt(pts, 0.15), 1)
  assert.equal(frameIndexAt(pts, 0.2), 2)
  assert.equal(frameIndexAt(pts, 1.0), 2) // a stall: the frame at 0.2 is still showing
  assert.equal(frameIndexAt(pts, 99), 4)
})

test('a grab at t shows the frame on screen at t; "end" is the last frame', () => {
  const at = (t) => { const out = join(dir, `g-${t}.png`); grabFrame(clip, t, out, 260); return luma(out) }
  const near = (got, want) => assert.ok(Math.abs(got - want) < 12, `luma ${got} vs ${want}`)
  near(at(0.5), 0x10)
  near(at(1.5), 0x60)
  near(at(2.5), 0xb0)
  near(at(3.5), 0xf0)
  near(at('end'), 0xf0)
})

test('a contact sheet has one tile per 1/rate s, a dump one frame per 1/rate s', () => {
  const sheet = join(dir, 'contact.png')
  const { tiles, rows } = contactSheet(clip, sheet, { rate: 2, cols: 4, height: 100 })
  assert.equal(tiles, 8) // floor(3.97 * 2) + 1
  assert.equal(rows, 2)
  assert.ok(existsSync(sheet))
  const dump = join(dir, 'dump')
  assert.equal(dumpFrames(clip, dump, { rate: 5, height: 100 }), 20)
  assert.equal(readdirSync(dump).length, 20)
})

// The same four segments as a variable-frame-rate clip with B-frames: every other frame of the grey segment is dropped and
// the timestamps are kept (so presentation times have gaps), as simctl's recordings do.
const vfr = join(dir, 'vfr.mp4')
run('ffmpeg', ['-v', 'error', '-y', ...[0x10, 0x60, 0xb0, 0xf0].flatMap((v) => ['-f', 'lavfi', '-i', `color=c=0x${v.toString(16).padStart(2, '0').repeat(3)}:s=120x260:r=30:d=1`]),
  '-filter_complex', "[0:v][1:v][2:v][3:v]concat=n=4:v=1,select='not(between(n\\,30\\,59)*mod(n\\,2))',setpts=PTS,format=yuv420p[o]", '-map', '[o]', '-fps_mode', 'vfr', '-c:v', 'libx264', '-bf', '3', '-crf', '8', vfr])

test('on a variable-frame-rate clip the grab still shows the frame on screen at t', () => {
  const at = (t) => { const out = join(dir, `v-${t}.png`); grabFrame(vfr, t, out, 260); return luma(out) }
  const near = (got, want) => assert.ok(Math.abs(got - want) < 12, `luma ${got} vs ${want}`)
  near(at(0.3), 0x10)
  near(at(1.5), 0x60)
  near(at(2.2), 0xb0)
  near(at('end'), 0xf0)
})
