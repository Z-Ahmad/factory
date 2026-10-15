#!/usr/bin/env node
// usage: factory clip-frames <clip.mp4> --at <seconds|end> <out.png> [--height 1000]
//        factory clip-frames <clip.mp4> --contact <out.png> [--rate 3] [--cols 6] [--height 420]
//        factory clip-frames <clip.mp4> --dump <dir> [--rate 20] [--height 1000]
// Frame grabs from a simulator proof clip that never SEEK. `xcrun simctl io recordVideo` writes variable-frame-rate h264 with
// duplicate and out-of-order timestamps (and a B-frame delay of ~1.8 s), so `ffmpeg -ss <t> -i clip` and `-sseof` land on
// STALE frames: a splash grabbed at 16.8 / 17.0 / 17.2 s came back light / light / dark and read as a fake
// light -> dark -> light bounce. ffmpeg's own frame labels are unreliable there too (they flip between pts and dts).
// So: ffprobe's presentation times (monotone, the same ones verdict/proof-verdict.mjs judges with) say WHICH frame is on screen at
// time t; ffmpeg then decodes the whole clip in order and keeps that frame by its index (select=eq(n,...)), the one thing
// it cannot get wrong. Needs only ffmpeg/ffprobe + node. Writes <out.png> only (frames go through a temp dir, deleted).
//   --at <s>|end   the frame on screen at s seconds (the last frame whose time is <= s; "end" = the last frame)
//   --contact      a contact sheet: one tile every 1/rate s (default 3 per second), `cols` columns, `height` px tall tiles
//   --dump <dir>   a constant-rate frame dump <dir>/f_0001.png ... (rate per second, default 20; a stalled stretch repeats)
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 })

// Presentation time of every frame, in decode (= display) order. Index i here is index n in ffmpeg's decoded stream.
export function probePts(clip) {
  const r = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', clip])
  if (r.status !== 0) throw new Error(`ffprobe failed on ${clip}: ${r.stderr}`)
  const pts = r.stdout.split('\n').map((l) => parseFloat(l)).filter((v) => Number.isFinite(v))
  if (!pts.length) throw new Error(`no video frames in ${clip}`)
  return pts
}

// The frame on screen at time t: the last one whose presentation time is <= t (the first frame if t is before it).
export function frameIndexAt(pts, t) {
  let lo = 0, hi = pts.length - 1, ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid] <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

// Decode the clip once, in order, and write the given frame indices as PNGs into `dir` (scaled to `vf`). Returns
// Map(index -> path). setpts=N keeps the (monotone) labels valid for the image muxer whatever the clip's timestamps are.
export function extractFrames(clip, indices, dir, vf = 'null') {
  const idx = [...new Set(indices)].sort((a, b) => a - b)
  // A balanced sum: ffmpeg's expression parser overflows on a few hundred terms in a left-leaning chain.
  const sum = (a) => (a.length <= 8 ? a.join('+') : `(${sum(a.slice(0, a.length >> 1))})+(${sum(a.slice(a.length >> 1))})`)
  const sel = sum(idx.map((n) => `eq(n\\,${n})`))
  const r = sh('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-fps_mode', 'passthrough', '-vf', `select='${sel}',setpts=N,${vf}`, '-fps_mode', 'passthrough', join(dir, 'f_%05d.png')])
  const files = readdirSync(dir).filter((f) => /^f_\d+\.png$/.test(f)).sort()
  if (files.length !== idx.length) throw new Error(`expected ${idx.length} frames from ${clip}, got ${files.length}: ${r.stderr}`)
  return new Map(idx.map((n, j) => [n, join(dir, files[j])]))
}

// One frame at time t (a number of seconds, or 'end'), as a PNG at `out`.
export function grabFrame(clip, t, out, height = 1000) {
  const pts = probePts(clip)
  const n = t === 'end' ? pts.length - 1 : frameIndexAt(pts, t)
  const dir = mkdtempSync(join(tmpdir(), 'clip-frames.'))
  try {
    const files = extractFrames(clip, [n], dir, `scale=-2:min(${height}\\,ih)`)
    copyFileSync(files.get(n), out)
    return { index: n, t: pts[n] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A contact sheet: tile k shows the frame on screen at k / rate seconds (a stalled stretch repeats its frame, as time did).
export function contactSheet(clip, out, { rate = 3, cols = 6, height = 420 } = {}) {
  const pts = probePts(clip)
  const dur = pts[pts.length - 1]
  const tiles = Math.max(1, Math.floor(dur * rate)) + 1
  const rows = Math.ceil(tiles / cols)
  const picks = Array.from({ length: tiles }, (_, k) => frameIndexAt(pts, k / rate))
  const dir = mkdtempSync(join(tmpdir(), 'clip-frames.'))
  try {
    const raw = join(dir, 'raw')
    const seq = join(dir, 'seq')
    mkdirSync(raw)
    mkdirSync(seq)
    const files = extractFrames(clip, picks, raw, `scale=-2:${height}`)
    picks.forEach((n, k) => copyFileSync(files.get(n), join(seq, `t_${String(k + 1).padStart(4, '0')}.png`)))
    const r = sh('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', join(seq, 't_%04d.png'), '-vf', `tile=${cols}x${rows}:padding=4:margin=4:color=black`, '-frames:v', '1', out])
    if (r.status !== 0) throw new Error(`contact sheet failed: ${r.stderr}`)
    return { tiles, rows }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A constant-rate dump: <dir>/f_%04d.png at `rate` frames per second of clip time.
export function dumpFrames(clip, dir, { rate = 20, height = 1000 } = {}) {
  const pts = probePts(clip)
  const count = Math.max(1, Math.floor(pts[pts.length - 1] * rate)) + 1
  const picks = Array.from({ length: count }, (_, k) => frameIndexAt(pts, k / rate))
  const raw = mkdtempSync(join(tmpdir(), 'clip-frames.'))
  try {
    const files = extractFrames(clip, picks, raw, `scale=-2:min(${height}\\,ih)`)
    mkdirSync(dir, { recursive: true })
    picks.forEach((n, k) => linkSync(files.get(n), join(dir, `f_${String(k + 1).padStart(4, '0')}.png`)))
    return count
  } finally {
    rmSync(raw, { recursive: true, force: true })
  }
}

function main(argv) {
  const die = (m) => { process.stderr.write(`${m}\n`); process.exit(1) }
  let clip = '', at = null, contact = false, dump = '', out = '', rate = null, cols = 6, height = null
  for (let a = 0; a < argv.length; a++) {
    const k = argv[a]
    const val = () => { const v = argv[++a]; if (v === undefined) die(`${k} wants a value`); return v }
    if (k === '--at') { const v = val(); at = v === 'end' ? 'end' : Number(v); if (at !== 'end' && !Number.isFinite(at)) die('--at wants seconds or "end"') }
    else if (k === '--contact') contact = true
    else if (k === '--dump') dump = val()
    else if (k === '--rate') rate = Number(val())
    else if (k === '--cols') cols = Number(val())
    else if (k === '--height') height = Number(val())
    else if (k.startsWith('--')) die(`unknown arg: ${k}`)
    else if (!clip) clip = k
    else if (!out) out = k
    else die(`unexpected arg: ${k}`)
  }
  if (!clip || (!out && !dump) || (at === null ? 0 : 1) + (contact ? 1 : 0) + (dump ? 1 : 0) !== 1) die('usage: clip-frames.mjs <clip.mp4> --at <seconds|end> <out.png> [--height 1000]  |  <clip.mp4> --contact <out.png> [--rate 3] [--cols 6] [--height 420]  |  <clip.mp4> --dump <dir> [--rate 20]')
  if (!existsSync(clip)) die(`no such clip: ${clip}`)
  clip = resolve(clip)
  out = resolve(out)
  try {
    if (dump) dumpFrames(clip, resolve(dump), { rate: rate ?? 20, height: height ?? 1000 })
    else if (contact) contactSheet(clip, out, { rate: rate ?? 3, cols, height: height ?? 420 })
    else grabFrame(clip, at, out, height ?? 1000)
  } catch (e) { die(e.message) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
