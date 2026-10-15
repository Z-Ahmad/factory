#!/usr/bin/env node
// usage: factory proof-verdict <clip.mp4> [--out <dir>] [--steps <steps.log>] [--json]
//                     [--scenario <name>] [--budgets <file.json>] [--no-budget] [--fail-marker <text> ...] [--skip-start auto|<s>] [--launch-window 8] [--launch-search 15] [--ignore FROM-TO ...]
//                     [--flash-warn 12] [--flash-fail 30] [--ref-weight 8] [--hold-warn 50] [--hold-fail 100]
//                     [--bounce-warn 20] [--bounce-fail 60] [--bounce-window 1.2] [--bounce-level 40] [--bounce-region 0.4]
//                     [--hold-motion 0.4] [--ignore-top 0.075] [--grid 8x16] [--width 120] [--max-flags 8] [--no-flags]
// A machine verdict for a sim-proof clip (the orchestrator's frame-by-frame eyeballing, as numbers). Runs on any
// existing .mp4 with no simulator; needs only ffmpeg/ffprobe + node. sim-proof-core.sh calls it at the end.
//   (a) FLASH / GHOST   a region that changes and reverts within <= 3 frames (A -> B -> A). The clip is decoded
//                       (every recorded frame, no resampling) to small grayscale frames and cut into a tile grid;
//                       a tile flashes at frame i when diff(i-1, i) and diff(i+k-1, i+k) are both large but
//                       diff(i-1, i+k) is small, k = 1..3. Real motion (a sheet scrub, a fly, a morph) does not
//                       come back, so it scores ~0. Score = min(in, out) - ref-weight * |A - A'|, in grey levels
//                       (0..255, mean absolute difference over the tile); the heavy ref-weight means only a NEAR-EXACT
//                       return counts (a camera fly that happens to look like where it was scores ~0). A whole-frame
//                       luma spike that reverts (a white or black flash) is a flash too. Adjacent flagged frames fold
//                       into one burst. WARN >= --flash-warn, FAIL >= --flash-fail.
//   (b) HOLD / STALL    simctl records variable frame rate, so a gap in presentation timestamps is a frame the app
//                       did not draw. A gap >= --hold-warn ms (WARN; --hold-fail ms FAILs) counts only when the screen
//                       is MOVING on both sides of it: a static screen legitimately has long gaps. Holds inside the
//                       launch window (the first --launch-window s after the launch screen: a cold boot's tile load)
//                       can only WARN.
//   (c) LAYOUT-LOOP     any line in --steps <steps.log> that contains a fail marker is a FAIL. The marker is the text the app
//                       logs when it detects its own layout loop: LAYOUT-LOOP unless --fail-marker (repeatable) or
//                       [proof.ios] fail_markers says otherwise.
//   (d) BOUNCE          a whole-region step that reverses: a step that changes >= --bounce-region (default 40%) of the tiles
//                       by >= --bounce-level (default 40) grey levels within <= 2 frames, and within --bounce-window s
//                       (default 1.2) the screen comes back to within a few grey levels of where it started, having stayed
//                       away for >= 4 frames (shorter is (a)'s flash). light -> dark -> light, a sheet that drops and
//                       pops back. Score = the swing (mean absolute tile change, grey levels) minus 2 x how far it is from the
//                       start when it returns. Motion is not a step: a sheet scrub, camera fly or morph changes a few tiles
//                       per frame, never 40% in 2 frames, and a theme flip or a screen change is one-way (never reverts).
//                       WARN >= --bounce-warn (20), FAIL >= --bounce-fail (60; a light <-> dark theme swing is ~150).
// Not judged: the iOS status bar band (the clock; --ignore-top), iOS's OWN leading frames, and any --ignore FROM-TO
// window (sim-proof's --warm-resume uses it for iOS's app-switch animation). Leading frames are detected, not timed:
// the clip opens on whatever was on screen (the home screen), iOS zooms the app open (on a first install through a black
// frame), then holds the launch screen, which is a near-uniform dark field in every appearance. Analysis starts at the
// first sustained near-uniform dark frame after any black one, so the app's own launch (splash dissolve, reveal) is
// judged from its first frame. If no launch screen is found the fallback is the first non-uniform frame + 1.5 s, and the
// verdict says so. --skip-start <s> overrides detection with a blind skip (0 = judge everything). --launch-search <s>
// looks for the launch screen in the first s seconds instead of 15 (a fresh simulator's first launch can take 60 s: the
// `fresh` proof matrix passes 90).
// Thresholds: the DEFAULTS below, overridden by the project's [proof.ios.verdict] (factory exports it as
// FK_PROOF_IOS_VERDICT_*), overridden by flags. Per-scenario budgets: a project-supplied JSON file (--budgets, else
// [proof.ios] budgets, FK_PROOF_IOS_BUDGETS; a relative path is relative to the project root) maps a scenario glob to
// overrides, e.g. [{ "match": "slow-fade*", "holdFail": null, "why": "holds only WARN" }]. The scenario is --scenario or the
// clip's name; explicit flags win; the overrides that applied are printed in the VERDICT line. --no-budget ignores the file.
// Calibrate the thresholds on your own clips with `factory proof-calibrate <manifest.json>` (calibrate.mjs).
// Writes <out>/verdict.json and, when something is flagged (flash, hold or bounce, WARN or FAIL), <out>/flags.png: each event
// as a triple of frames side by side, the worst first. Flash rows are before / flagged / after with the region outlined in
// red; hold rows are the two frames before the gap and the one after it, the whole screen outlined in amber; bounce rows are
// the first frame, the far end and the return, the stepped region outlined in magenta. Prints one
// `VERDICT: PASS|FAIL (...)` line (or the JSON with --json). Exit 0 PASS, 4 FAIL, 1 usage / tool error.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULTS = {
  skipStart: 'auto', // 'auto' = detect iOS's leading frames; or a number of seconds to skip blind
  launchWindow: 8, // seconds after the launch screen in which a hold can only WARN (a cold boot's globe/tile load is ~9 s on the sim)
  ignoreTop: 0.075, // fraction of the height: the status bar band
  grid: '8x16', // tile columns x rows
  width: 120, // decoded frame width in pixels
  flashWarn: 12, // approved clips peak at 8 (past the launch); a footer jumping 100 pt scores 87-126
  flashFail: 30,
  holdWarn: 50, // 60-72 ms sim stalls were approved on a real phone: 50-100 ms is for a reviewer to judge
  holdFail: 100,
  holdMotion: 0.4, // mean grey-level change per frame that counts as "moving" beside a gap
  bounceWarn: 20, // swing in grey levels: a sheet dropping and popping back is ~20-60, a light <-> dark theme swing ~150
  bounceFail: 60,
  bounceLevel: 40, // a tile "steps" when it changes by this many grey levels...
  bounceRegion: 0.4, // ...and this share of the tiles do so within bounceSpan frames
  bounceSpan: 2,
  bounceWindow: 1.2, // seconds from the step to the return
  bounceDwell: 4, // frames away from the start (>= maxK + 1, so a shorter excursion is the flash detector's)
  bounceTol: 8, // the return is "to the start" within this mean absolute tile difference (a real restore is ~4; a splash that gives way to a dark app is ~12)
  bounceRefWeight: 2,
  maxFlags: 8,
  maxK: 3, // longest flash, in frames
  refWeight: 8, // how hard a tile that does NOT come back is marked down (score = min(in, out) - weight * |A - A'|)
  uniformFrac: 0.85, // a frame is "uniform" when this share of tiles sit within uniformBand grey levels of the median tile
  uniformBand: 6,
  darkMax: 60, // ...and a launch screen is dark
  blackMax: 8, // ...and iOS's own black frame is below this
  uniformRun: 3, // frames in a row
  searchS: 15, // look for the launch screen in the first N seconds
  fallbackExtraS: 1.5,
}

// [proof.ios.verdict] key -> DEFAULTS key. bin/factory exports the table as FK_PROOF_IOS_VERDICT_<KEY>; a value there replaces
// the built-in default (flags and budgets still beat it).
export const ENV_KEYS = {
  skip_start_s: ['skipStart', 'number'],
  ignore_top: ['ignoreTop', 'number'],
  grid: ['grid', 'string'],
  width: ['width', 'number'],
  flash_warn: ['flashWarn', 'number'],
  flash_fail: ['flashFail', 'number'],
  hold_warn_ms: ['holdWarn', 'number'],
  hold_fail_ms: ['holdFail', 'number'],
  hold_motion: ['holdMotion', 'number'],
  launch_window_s: ['launchWindow', 'number'],
  launch_search_s: ['searchS', 'number'],
  fallback_extra_s: ['fallbackExtraS', 'number'],
  bounce_warn: ['bounceWarn', 'number'],
  bounce_fail: ['bounceFail', 'number'],
  bounce_level: ['bounceLevel', 'number'],
  bounce_region: ['bounceRegion', 'number'],
  bounce_window_s: ['bounceWindow', 'number'],
  ref_weight: ['refWeight', 'number'],
  max_flags: ['maxFlags', 'number'],
}

/** DEFAULTS with the project's [proof.ios.verdict] values (FK_PROOF_IOS_VERDICT_*) laid over them. */
export function defaultsFromEnv(env = process.env) {
  const out = { ...DEFAULTS }
  for (const [key, [name, type]] of Object.entries(ENV_KEYS)) {
    const raw = env[`FK_PROOF_IOS_VERDICT_${key.toUpperCase()}`]
    if (raw === undefined || raw === '') continue
    if (type === 'string') out[name] = raw
    else {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error(`[proof.ios.verdict] ${key} must be a number, got "${raw}"`)
      out[name] = n
    }
  }
  return out
}

// Overrides a budget entry may set; null = off (never fails / no window).
const BUDGET_KEYS = ['flashWarn', 'flashFail', 'holdWarn', 'holdFail', 'bounceWarn', 'bounceFail', 'launchWindow', 'skipStart']

// ---------- pure analysis (exported for the test) ----------

// Mean absolute difference per tile between two grey frames. Writes into `out` (length cols*rows).
export function tileDiff(a, b, w, h, cols, rows, y0, out) {
  const tw = w / cols
  const th = (h - y0) / rows
  for (let r = 0; r < rows; r++) {
    const ya = Math.round(y0 + r * th)
    const yb = Math.round(y0 + (r + 1) * th)
    for (let c = 0; c < cols; c++) {
      const xa = Math.round(c * tw)
      const xb = Math.round((c + 1) * tw)
      let sum = 0
      for (let y = ya; y < yb; y++) {
        const row = y * w
        for (let x = xa; x < xb; x++) sum += Math.abs(a[row + x] - b[row + x])
      }
      out[r * cols + c] = sum / Math.max(1, (yb - ya) * (xb - xa))
    }
  }
  return out
}

// Mean luma per tile (same grid as tileDiff).
export function tileMeans(f, w, h, cols, rows, y0, out) {
  const tw = w / cols
  const th = (h - y0) / rows
  for (let r = 0; r < rows; r++) {
    const ya = Math.round(y0 + r * th)
    const yb = Math.round(y0 + (r + 1) * th)
    for (let c = 0; c < cols; c++) {
      const xa = Math.round(c * tw)
      const xb = Math.round((c + 1) * tw)
      let sum = 0
      for (let y = ya; y < yb; y++) {
        const row = y * w
        for (let x = xa; x < xb; x++) sum += f[row + x]
      }
      out[r * cols + c] = sum / Math.max(1, (yb - ya) * (xb - xa))
    }
  }
  return out
}

export function meanLuma(f, w, h, y0) {
  let s = 0
  for (let i = y0 * w; i < h * w; i++) s += f[i]
  return s / ((h - y0) * w)
}

// The streaming core: frames arrive one at a time; analysis of centre frame i runs once frame i+maxK exists.
export class FlashScanner {
  constructor({ w, h, cols, rows, y0, maxK, firstFrame = 1, refWeight = DEFAULTS.refWeight, uniformFrac = DEFAULTS.uniformFrac, uniformBand = DEFAULTS.uniformBand }) {
    Object.assign(this, { w, h, cols, rows, y0, maxK, firstFrame, refWeight, uniformFrac, uniformBand })
    this.frames = new Map() // index -> Uint8Array, only the recent window
    this.count = 0
    this.motion = [] // motion[i] = mean tile diff of (i-1, i), whole frame below the status bar
    this.luma = []
    this.tiles = []
    this.uniform = [] // per frame { frac, med }: share of tiles near the median tile luma, and that median
    this.events = [] // candidate flashes: { i, k, score, tiles:[{c,r,score}], kind }
    this.means = new Float32Array(cols * rows)
    this.scratch = new Float32Array(cols * rows)
    this.diffs = new Map()
  }

  push(frame) {
    const i = this.count++
    this.frames.set(i, frame)
    this.luma.push(meanLuma(frame, this.w, this.h, this.y0))
    const m = tileMeans(frame, this.w, this.h, this.cols, this.rows, this.y0, this.means)
    const med = [...m].sort((a, b) => a - b)[m.length >> 1]
    let near = 0
    for (const v of m) if (Math.abs(v - med) <= this.uniformBand) near++
    this.uniform.push({ frac: near / m.length, med })
    this.tiles.push(Float32Array.from(m)) // per-frame tile means, for the bounce detector
    if (i === 0) this.motion.push(0)
    else {
      const t = tileDiff(this.frames.get(i - 1), frame, this.w, this.h, this.cols, this.rows, this.y0, this.scratch)
      let s = 0
      for (const v of t) s += v
      this.motion.push(s / t.length)
    }
    const centre = i - this.maxK
    if (centre >= Math.max(1, this.firstFrame)) this.analyse(centre)
    const drop = i - this.maxK - 2
    if (drop >= 0) this.frames.delete(drop)
  }

  finish() {
    // The last maxK frames have no full lookahead: shorter k only.
    for (let c = Math.max(1, this.firstFrame, this.count - this.maxK); c < this.count; c++) this.analyse(c)
    this.propagateTransport()
    return this.events
  }

  td(a, b) {
    const key = a * 1e7 + b
    let t = this.diffs.get(key)
    if (!t) {
      t = tileDiff(this.frames.get(a), this.frames.get(b), this.w, this.h, this.cols, this.rows, this.y0, new Float32Array(this.cols * this.rows))
      this.diffs.set(key, t)
      if (this.diffs.size > 64) this.diffs.delete(this.diffs.keys().next().value)
    }
    return t
  }

  analyse(i) {
    const n = this.cols * this.rows
    let best = null
    for (let k = 1; k <= this.maxK; k++) {
      if (i + k >= this.count) break
      const dIn = this.td(i - 1, i)
      const dOut = this.td(i + k - 1, i + k)
      const dRef = this.td(i - 1, i + k)
      const tiles = []
      let top = 0, topSwing = 0, topRef = 0
      for (let t = 0; t < n; t++) {
        const score = Math.min(dIn[t], dOut[t]) - this.refWeight * dRef[t]
        if (score > 1) {
          tiles.push({ c: t % this.cols, r: Math.floor(t / this.cols), score })
          if (score > top) { top = score; topSwing = Math.min(dIn[t], dOut[t]); topRef = dRef[t] }
        }
      }
      if (top > 0 && (!best || top > best.score)) best = { i, k, score: top, tiles, kind: 'tile', swing: topSwing, ref: topRef }
    }
    // Whole-frame luma spike that reverts.
    let spike = null
    for (let k = 1; k <= this.maxK && i + k < this.count; k++) {
      const L = this.luma
      const score = Math.min(Math.abs(L[i] - L[i - 1]), Math.abs(L[i + k - 1] - L[i + k])) - this.refWeight * Math.abs(L[i + k] - L[i - 1])
      if (score > 1 && (!spike || score > spike.score)) spike = { i, k, score, tiles: [], kind: 'luma' }
    }
    if (best && best.score >= 4 && this.transported(best)) { best.score = Math.min(best.score * 0.15, 6); best.transported = true }
    if (spike) this.events.push(spike)
    if (best) this.events.push(best)
  }

  // An object in motion leaves a trail of events on neighbouring tiles in consecutive frames. One of them may not block-match
  // (the object reshapes as it moves); an event within 3 frames and 3 tiles of a transported one is the same trail.
  propagateTransport() {
    const box = (e) => {
      const rs = e.tiles.map((t) => t.r), cs = e.tiles.map((t) => t.c)
      return e.tiles.length ? { r0: Math.min(...rs), r1: Math.max(...rs), c0: Math.min(...cs), c1: Math.max(...cs) } : null
    }
    const moved = this.events.filter((e) => e.transported).map((e) => ({ i: e.i, b: box(e) })).filter((m) => m.b)
    for (const e of this.events) {
      if (e.transported || e.kind !== 'tile' || e.score < 4) continue
      const b = box(e)
      if (!b) continue
      const near = moved.some((m) => Math.abs(m.i - e.i) <= 3 && m.b.r0 - 3 <= b.r1 && b.r0 - 3 <= m.b.r1 && m.b.c0 - 3 <= b.c1 && b.c0 - 3 <= m.b.c1)
      if (near) { e.score = Math.min(e.score * 0.15, 6); e.transported = true }
    }
  }

  // A small object moving fast crosses a tile in ONE frame, which a tile sees as A -> B -> A. Block-match the flagged
  // region of B against A and against A' (+-S px). If both find it and the two displacements point opposite ways, it is
  // one object in monotone motion (A is behind it, A' ahead of it), not a revert. A real flash/jump either appears from
  // nothing (no match) or comes back to where A had it (same direction).
  transported(ev, S = 56) {
    const strong = ev.tiles.filter((t) => t.score >= Math.max(1, 0.25 * ev.score))
    if (!strong.length) return false
    const tw = this.w / this.cols
    const th = (this.h - this.y0) / this.rows
    const rect = {
      x0: Math.round(Math.min(...strong.map((t) => t.c)) * tw),
      x1: Math.round((Math.max(...strong.map((t) => t.c)) + 1) * tw),
      y0: Math.round(this.y0 + Math.min(...strong.map((t) => t.r)) * th),
      y1: Math.round(this.y0 + (Math.max(...strong.map((t) => t.r)) + 1) * th),
    }
    const B = this.frames.get(ev.i)
    const u = this.blockMatch(B, this.frames.get(ev.i - 1), rect, S)
    const v = this.blockMatch(B, this.frames.get(ev.i + ev.k), rect, S)
    if (!u || !v) return false
    return u.dx * v.dx + u.dy * v.dy < 0
  }

  // Best (dx, dy) such that X[x+dx, y+dy] ~ B[x, y] over the rect; null unless it is a good, non-zero match.
  blockMatch(B, X, { x0, x1, y0, y1 }, S) {
    const w = this.w
    const h = this.h
    const sad = (dx, dy) => {
      let s = 0, n = 0
      for (let y = y0; y < y1; y += 2) {
        const yy = y + dy
        if (yy < this.y0 || yy >= h) return Infinity
        for (let x = x0; x < x1; x += 2) {
          const xx = x + dx
          if (xx < 0 || xx >= w) return Infinity
          s += Math.abs(B[y * w + x] - X[yy * w + xx])
          n++
        }
      }
      return n ? s / n : Infinity
    }
    const zero = sad(0, 0)
    if (!(zero >= 2)) return null
    let best = { dx: 0, dy: 0, sad: zero }
    // Coarse (every 2 px) over +-S, then refine +-1 around the winner.
    for (let dy = -S; dy <= S; dy += 2) {
      for (let dx = -S; dx <= S; dx += 2) {
        if (!dx && !dy) continue
        const s = sad(dx, dy)
        if (s < best.sad) best = { dx, dy, sad: s }
      }
    }
    const c = best
    for (let dy = c.dy - 1; dy <= c.dy + 1; dy++) {
      for (let dx = c.dx - 1; dx <= c.dx + 1; dx++) {
        if (!dx && !dy) continue
        const s = sad(dx, dy)
        if (s < best.sad) best = { dx, dy, sad: s }
      }
    }
    return best.sad <= 0.6 * zero && (best.dx || best.dy) ? best : null
  }
}

// Where the app's own frames begin. `uniform[i]` = { frac, med } per frame, `pts` in seconds.
// Returns { mode: 'detected'|'fallback', startFrame, why }.
export function detectLaunch(uniform, pts, o = DEFAULTS) {
  const isUniform = (m) => m.frac >= o.uniformFrac
  const isLaunch = (m) => isUniform(m) && m.med <= o.darkMax
  const n = uniform.length
  for (let i = 0; i < n && pts[i] <= o.searchS; i++) {
    let ok = true
    for (let j = i; j < Math.min(n, i + o.uniformRun); j++) if (!isLaunch(uniform[j])) { ok = false; break }
    if (!ok) continue
    let s = i
    while (s < n && isLaunch(uniform[s]) && uniform[s].med < o.blackMax) s++ // iOS's own black frame(s)
    if (s >= n) break
    return { mode: 'detected', startFrame: s, why: i === 0 && s === 0 ? 'clip opens on the app' : `launch screen from ${pts[s].toFixed(2)} s` }
  }
  // Fallback: the first non-uniform frame (after a leading uniform run, if any), plus a margin.
  let f = 0
  while (f < n && isUniform(uniform[f])) f++
  const t = (f < n ? pts[f] : 0) + o.fallbackExtraS
  let s = pts.findIndex((p) => p >= t)
  if (s < 0) s = n
  return { mode: 'fallback', startFrame: s, why: `no launch screen found; first non-uniform frame + ${o.fallbackExtraS} s` }
}

// Gaps in presentation time with motion on both sides. `pts` in seconds (sorted), `motion[i]` as above.
export function findHolds(pts, motion, { startFrame = 0, holdWarn, holdMotion, side = 3 }) {
  const holds = []
  const avg = (a, b) => {
    let s = 0, n = 0
    for (let j = Math.max(1, a); j <= Math.min(motion.length - 1, b); j++) { s += motion[j]; n++ }
    return n ? s / n : 0
  }
  for (let i = Math.max(1, startFrame + 1); i < pts.length; i++) {
    const gap = (pts[i] - pts[i - 1]) * 1000
    if (gap < holdWarn) continue
    // Moving before: the frames up to the gap; moving after: the frames from the one that ends it (it shows the jump).
    const before = avg(i - side, i - 1)
    const after = avg(i + 1, i + side)
    if (before >= holdMotion && after >= holdMotion) holds.push({ i, t: pts[i - 1], gapMs: gap, before, after, across: motion[i] })
  }
  return holds
}

// Whole-region steps that reverse. `tiles[i]` = per-tile mean luma of frame i (tileMeans), `pts` in seconds. A step is
// frame i where >= `region` of the tiles differ by >= `level` grey levels from frame i-s (s = 1..span); a bounce is a step
// from A (= frame i-s) whose state comes back to within `tol` (mean absolute tile difference) of A at some frame j, no later
// than `windowS` after the step, after >= `dwell` frames spent at least half the swing away from A.
// Returns [{ a, peak, j, swing, back, score, tiles:[{c,r}] }], a < peak < j, non-overlapping, in time order.
export function findBounces(tiles, pts, { startFrame = 0, cols, level, region, span, windowS, dwell, tol, refWeight }) {
  const n = tiles.length
  if (!n) return []
  const nt = tiles[0].length
  const mad = (x, y) => { let s = 0; for (let t = 0; t < nt; t++) s += Math.abs(x[t] - y[t]); return s / nt }
  const frac = (x, y) => { let c = 0; for (let t = 0; t < nt; t++) if (Math.abs(x[t] - y[t]) >= level) c++; return c / nt }
  const out = []
  let resume = 0
  for (let i = Math.max(1, startFrame + 1); i < n; i++) {
    if (i < resume) continue
    let a = -1
    for (let s = 1; s <= span && i - s >= Math.max(0, startFrame); s++) if (frac(tiles[i - s], tiles[i]) >= region) { a = i - s; break }
    if (a < 0) continue
    // Earliest return to the start within the window, after a stay of at least `dwell` frames.
    let j = -1
    for (let k = i + dwell; k < n && pts[k] - pts[i] <= windowS; k++) if (mad(tiles[k], tiles[a]) <= tol) { j = k; break }
    if (j < 0) continue
    let peak = i, swing = 0
    for (let c = i; c < j; c++) { const d = mad(tiles[c], tiles[a]); if (d > swing) { swing = d; peak = c } }
    let away = 0
    for (let c = i; c < j; c++) if (mad(tiles[c], tiles[a]) >= swing / 2) away++
    if (away < dwell) continue
    const back = mad(tiles[j], tiles[a])
    const score = swing - refWeight * back
    if (score <= 1) continue
    const changed = []
    for (let t = 0; t < nt; t++) if (Math.abs(tiles[peak][t] - tiles[a][t]) >= level) changed.push({ c: t % cols, r: Math.floor(t / cols) })
    out.push({ a, peak, j, swing, back, score, tiles: changed })
    resume = j + 1
  }
  return out
}

// First budget entry whose glob matches the scenario name; { match, why, overrides }.
export function matchBudget(budgets, scenario) {
  for (const b of budgets) {
    const re = new RegExp(`^${String(b.match).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    if (re.test(scenario)) {
      const overrides = {}
      for (const k of BUDGET_KEYS) if (k in b) overrides[k] = b[k]
      return { match: b.match, why: b.why ?? '', overrides }
    }
  }
  return null
}

// ---------- tool ----------

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
const round = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v)

function die(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  let base
  try { base = defaultsFromEnv() } catch (e) { die(e.message) }
  const o = { ...base, json: false, flags: true, budget: true, budgets: process.env.FK_PROOF_IOS_BUDGETS || '', failMarkers: [], scenario: '', ignore: [], clip: '', out: '', steps: '', debug: 0, explicit: new Set() }
  const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) die(`${name} wants a number`); return n }
  for (let a = 0; a < argv.length; a++) {
    const k = argv[a]
    const val = () => { const v = argv[++a]; if (v === undefined) die(`${k} wants a value`); return v }
    const set = (key, v) => { o[key] = v; o.explicit.add(key) }
    if (k === '--out') o.out = val()
    else if (k === '--steps') o.steps = val()
    else if (k === '--json') o.json = true
    else if (k === '--no-flags') o.flags = false
    else if (k === '--no-budget') o.budget = false
    else if (k === '--budgets') o.budgets = val()
    else if (k === '--fail-marker') o.failMarkers.push(val())
    else if (k === '--scenario') o.scenario = val()
    else if (k === '--skip-start') { const v = val(); set('skipStart', v === 'auto' ? 'auto' : num(v, k)) }
    else if (k === '--launch-window') set('launchWindow', num(val(), k))
    else if (k === '--launch-search') o.searchS = num(val(), k)
    else if (k === '--ignore-top') o.ignoreTop = num(val(), k)
    else if (k === '--grid') o.grid = val()
    else if (k === '--width') o.width = num(val(), k)
    else if (k === '--flash-warn') set('flashWarn', num(val(), k))
    else if (k === '--flash-fail') set('flashFail', num(val(), k))
    else if (k === '--hold-warn') set('holdWarn', num(val(), k))
    else if (k === '--hold-fail') set('holdFail', num(val(), k))
    else if (k === '--hold-motion') o.holdMotion = num(val(), k)
    else if (k === '--bounce-warn') set('bounceWarn', num(val(), k))
    else if (k === '--bounce-fail') set('bounceFail', num(val(), k))
    else if (k === '--bounce-window') o.bounceWindow = num(val(), k)
    else if (k === '--bounce-level') o.bounceLevel = num(val(), k)
    else if (k === '--bounce-region') o.bounceRegion = num(val(), k)
    else if (k === '--max-flags') o.maxFlags = num(val(), k)
    else if (k === '--ignore') {
      const m = /^([\d.]+)-([\d.]+)$/.exec(val())
      if (!m) die('--ignore is FROM-TO in seconds, e.g. 12-16.5')
      o.ignore.push([Number(m[1]), Number(m[2])])
    } else if (k === '--ref-weight') o.refWeight = num(val(), k)
    else if (k === '--debug') o.debug = num(val(), k)
    else if (k.startsWith('--')) die(`unknown arg: ${k}`)
    else if (!o.clip) o.clip = k
    else die(`unexpected arg: ${k}`)
  }
  if (!o.clip) die('usage: factory proof-verdict <clip.mp4> [--out <dir>] [--steps <steps.log>] [--json]; see the header of proof-verdict.mjs')
  if (!existsSync(o.clip)) die(`no such clip: ${o.clip}`)
  if (!/^\d+x\d+$/.test(o.grid)) die('--grid is COLSxROWS, e.g. 8x16')
  o.clip = resolve(o.clip)
  o.out = resolve(o.out || dirname(o.clip))
  if (!o.scenario) o.scenario = basename(o.clip).replace(/\.[^.]+$/, '')
  if (!o.failMarkers.length) o.failMarkers = (process.env.FK_PROOF_IOS_FAIL_MARKERS || 'LAYOUT-LOOP').split('\n').filter(Boolean)
  return o
}

// Apply the scenario's budget entry unless a flag set the same key. Returns what applied, for the VERDICT line.
function applyBudget(o) {
  if (!o.budget || !o.budgets) return null
  const file = resolve(process.env.FK_ROOT || process.cwd(), o.budgets)
  if (!existsSync(file)) die(`no such budgets file: ${file}`)
  let budgets
  try { budgets = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { die(`${file}: ${e.message}`) }
  if (!Array.isArray(budgets)) die(`${file}: expected an array of { match, why, ... } entries`)
  const hit = matchBudget(budgets, o.scenario)
  if (!hit) return null
  const applied = {}
  for (const [k, v] of Object.entries(hit.overrides)) {
    if (o.explicit.has(k)) continue
    o[k] = v === null ? (k === 'skipStart' ? 'auto' : Infinity) : v
    applied[k] = v === null ? 'off' : v
  }
  return Object.keys(applied).length ? { match: hit.match, why: hit.why, applied } : null
}

function probe(clip) {
  const r = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', clip])
  if (r.status !== 0) die(`ffprobe failed on ${clip}: ${r.stderr}`)
  const [w, h] = r.stdout.trim().split(',').map(Number)
  const p = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', clip])
  if (p.status !== 0) die(`ffprobe frames failed: ${p.stderr}`)
  const pts = p.stdout.split('\n').map((l) => parseFloat(l)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  return { w, h, pts }
}

// Decode every recorded frame to a small grey raw frame and feed `onFrame`.
function decode(clip, w, h, onFrame) {
  return new Promise((res, rej) => {
    // enc_time_base: the clip's 1/600 s timebase puts frames recorded <2 ms apart on one tick, which rawvideo grumbles about.
    const ff = spawn('ffmpeg', ['-v', 'fatal', '-i', clip, '-fps_mode', 'passthrough', '-enc_time_base', '1:1000000', '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] })
    const size = w * h
    let carry = Buffer.alloc(0)
    ff.stdout.on('data', (chunk) => {
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      let off = 0
      while (buf.length - off >= size) {
        onFrame(Uint8Array.from(buf.subarray(off, off + size)))
        off += size
      }
      carry = buf.subarray(off)
    })
    ff.on('error', rej)
    ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))))
  })
}

// One flash is seen from several frames (and k's); fold candidates <= maxK + 1 frames apart into one burst, keeping the
// worst. A footer that jumps on every other frame of a scrub is one burst, not 400.
function bursts(events, gap = DEFAULTS.maxK + 1) {
  const out = []
  for (const e of [...events].sort((a, b) => a.i - b.i)) {
    const last = out[out.length - 1]
    if (last && e.i - last.last <= gap) {
      last.n++
      if (e.score > last.score) Object.assign(last, { ...e })
      last.last = e.i
    } else out.push({ ...e, last: e.i, n: 1 })
  }
  return out
}

const inRanges = (t, ranges) => ranges.some(([a, b]) => t >= a && t <= b)
const RANK = { PASS: 0, WARN: 1, FAIL: 2 }
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a)
const statusOf = (v, warn, fail) => (v >= fail ? 'FAIL' : v >= warn ? 'WARN' : 'PASS')

async function run() {
  const o = parseArgs(process.argv.slice(2))
  const budget = applyBudget(o)
  const [cols, rows] = o.grid.split('x').map(Number)
  const { w: vw, h: vh, pts } = probe(o.clip)
  const W = o.width
  const H = Math.round((vh * W) / vw / 2) * 2
  const y0 = Math.round(H * o.ignoreTop)
  const blind = o.skipStart === 'auto' ? null : o.skipStart
  const blindFrame = blind === null ? 1 : (pts.findIndex((t) => t >= blind) < 0 ? Infinity : Math.max(1, pts.findIndex((t) => t >= blind)))
  const scan = new FlashScanner({ w: W, h: H, cols, rows, y0, maxK: DEFAULTS.maxK, refWeight: o.refWeight, firstFrame: blindFrame })
  await decode(o.clip, W, H, (f) => scan.push(f))
  const candidates = scan.finish()
  if (scan.count !== pts.length) process.stderr.write(`note: ${scan.count} decoded frames vs ${pts.length} timestamps\n`)

  // Where the app's own frames begin, and the window in which a hold can only WARN.
  let launch
  if (blind !== null) {
    const f = pts.findIndex((t) => t >= blind)
    launch = { mode: 'blind', startFrame: blind === 0 ? 0 : f < 0 ? pts.length : f, why: `--skip-start ${blind}`, windowS: 0 }
  } else {
    launch = { ...detectLaunch(scan.uniform, pts, o), windowS: o.launchWindow }
  }
  const startT = pts[launch.startFrame] ?? Infinity
  const windowEnd = launch.windowS > 0 && Number.isFinite(startT) ? startT + launch.windowS : -1

  const kept = candidates.filter((e) => e.i > launch.startFrame && !inRanges(pts[e.i], o.ignore))
  const flashes = bursts(kept.filter((e) => e.score >= o.flashWarn)).sort((a, b) => b.score - a.score)
  const holds = findHolds(pts, scan.motion, { startFrame: launch.startFrame, holdWarn: o.holdWarn, holdMotion: o.holdMotion })
    .filter((h) => !inRanges(h.t, o.ignore))
    .map((h) => {
      const base = statusOf(h.gapMs, o.holdWarn, o.holdFail)
      const inLaunch = h.t < windowEnd
      return { ...h, launch: inLaunch, status: inLaunch && base === 'FAIL' ? 'WARN' : base }
    })
    .sort((a, b) => RANK[b.status] - RANK[a.status] || b.gapMs - a.gapMs)

  const bounces = findBounces(scan.tiles, pts, { startFrame: launch.startFrame, cols, level: o.bounceLevel, region: o.bounceRegion, span: DEFAULTS.bounceSpan, windowS: o.bounceWindow, dwell: DEFAULTS.bounceDwell, tol: DEFAULTS.bounceTol, refWeight: DEFAULTS.bounceRefWeight })
    .filter((b) => b.a > launch.startFrame && !inRanges(pts[b.a], o.ignore) && !inRanges(pts[b.j], o.ignore))
    .sort((x, y) => y.score - x.score)

  if (o.debug) {
    process.stderr.write(`launch: ${launch.mode} startFrame=${launch.startFrame} (${startT.toFixed ? startT.toFixed(2) : startT}s) ${launch.why}\n`)
    process.stderr.write('top flash candidates (score, frame, k, t, tiles):\n')
    for (const e of kept.sort((a, b) => b.score - a.score).slice(0, o.debug)) {
      process.stderr.write(`  ${e.score.toFixed(2)} i=${e.i} k=${e.k} t=${pts[e.i]?.toFixed(3)} ${e.kind} tiles=${e.tiles.length} swing=${e.swing?.toFixed(1)} ref=${e.ref?.toFixed(1)}\n`)
    }
    process.stderr.write('bounces (score, frames a/peak/j, t, swing, back, tiles):\n')
    for (const b of bounces.slice(0, o.debug)) process.stderr.write(`  ${b.score.toFixed(1)} ${b.a}/${b.peak}/${b.j} t=${pts[b.a].toFixed(3)}..${pts[b.j].toFixed(3)} swing=${b.swing.toFixed(1)} back=${b.back.toFixed(1)} tiles=${b.tiles.length}\n`)
    process.stderr.write('top holds:\n')
    for (const hd of holds.slice(0, o.debug)) process.stderr.write(`  ${hd.gapMs.toFixed(0)}ms at t=${hd.t.toFixed(3)} ${hd.status}${hd.launch ? ' (launch)' : ''} before=${hd.before.toFixed(2)} after=${hd.after.toFixed(2)}\n`)
  }

  const worstFlash = kept.reduce((m, e) => Math.max(m, e.score), 0)
  const worstHold = holds.reduce((m, h) => Math.max(m, h.gapMs), 0)
  const worstBounce = bounces.reduce((m, b) => Math.max(m, b.score), 0)
  const shownBounces = bounces.filter((b) => b.score >= o.bounceWarn)
  const loops = o.steps && existsSync(o.steps) ? readFileSync(o.steps, 'utf8').split('\n').filter((l) => o.failMarkers.some((m) => l.includes(m))) : []

  const flashStatus = statusOf(worstFlash, o.flashWarn, o.flashFail)
  const holdStatus = holds.reduce((s, h) => worse(s, h.status), 'PASS')
  const loopStatus = loops.length ? 'FAIL' : 'PASS'
  const bounceStatus = statusOf(worstBounce, o.bounceWarn, o.bounceFail)
  const overall = [flashStatus, holdStatus, loopStatus, bounceStatus].includes('FAIL') ? 'FAIL' : 'PASS'

  const bbox = (e) => {
    if (!e.tiles.length) return { x: 0, y: y0 / H, w: 1, h: 1 - y0 / H }
    const rowsOf = e.tiles.map((t) => t.r), colsOf = e.tiles.map((t) => t.c)
    const c0 = Math.min(...colsOf), c1 = Math.max(...colsOf) + 1, r0 = Math.min(...rowsOf), r1 = Math.max(...rowsOf) + 1
    const th = (H - y0) / rows
    return { x: c0 / cols, y: (y0 + r0 * th) / H, w: (c1 - c0) / cols, h: ((r1 - r0) * th) / H }
  }
  const flashEvent = (e) => ({ frame: e.i, k: e.k, t: round(pts[e.i], 3), score: round(e.score, 2), kind: e.kind, tiles: e.tiles.length, region: bbox(e), status: statusOf(e.score, o.flashWarn, o.flashFail) })
  const bounceBox = (b) => {
    if (!b.tiles.length) return { x: 0, y: y0 / H, w: 1, h: 1 - y0 / H }
    const rs = b.tiles.map((t) => t.r), cs = b.tiles.map((t) => t.c)
    const c0 = Math.min(...cs), c1 = Math.max(...cs) + 1, r0 = Math.min(...rs), r1 = Math.max(...rs) + 1
    const th = (H - y0) / rows
    return { x: c0 / cols, y: (y0 + r0 * th) / H, w: (c1 - c0) / cols, h: ((r1 - r0) * th) / H }
  }
  const bounceEvent = (b) => ({ frame: b.a, peakFrame: b.peak, returnFrame: b.j, t: round(pts[b.a], 3), returnT: round(pts[b.j], 3), score: round(b.score, 2), swing: round(b.swing, 1), residual: round(b.back, 1), tiles: b.tiles.length, region: bounceBox(b), status: statusOf(b.score, o.bounceWarn, o.bounceFail) })
  const holdEvent = (h) => ({ frame: h.i, t: round(h.t, 3), gapMs: round(h.gapMs, 1), motionBefore: round(h.before, 2), motionAfter: round(h.after, 2), launch: h.launch, status: h.status })

  // Rows for flags.png: every non-PASS flash burst and hold, FAIL before WARN, then by size against its own FAIL line.
  const rowsForPng = [
    ...flashes.map((e) => ({ sev: RANK[statusOf(e.score, o.flashWarn, o.flashFail)], mag: e.score / Math.min(o.flashFail, 1000), frames: [e.i - 1, e.i, e.i + e.k], region: bbox(e), color: 'red' })),
    ...holds.map((h) => ({ sev: RANK[h.status], mag: h.gapMs / Math.min(o.holdFail, 200), frames: [h.i - 2, h.i - 1, h.i], region: { x: 0, y: y0 / H, w: 1, h: 1 - y0 / H }, color: 'orange' })),
    ...shownBounces.map((b) => ({ sev: RANK[statusOf(b.score, o.bounceWarn, o.bounceFail)], mag: b.score / Math.min(o.bounceFail, 1000), frames: [b.a, b.peak, b.j], region: bounceBox(b), color: 'magenta' })),
  ].sort((a, b) => b.sev - a.sev || b.mag - a.mag).slice(0, o.maxFlags)

  const verdict = {
    clip: o.clip,
    scenario: o.scenario,
    verdict: overall,
    frames: scan.count,
    durationS: round(pts[pts.length - 1] ?? 0, 2),
    launch: { mode: launch.mode, startFrame: launch.startFrame, startS: round(startT, 3), holdWindowS: launch.windowS, why: launch.why },
    budget: budget ?? null,
    settings: { skipStart: o.skipStart, launchWindow: o.launchWindow, ignoreTop: o.ignoreTop, grid: o.grid, width: W, flashWarn: o.flashWarn, flashFail: o.flashFail, holdWarn: o.holdWarn, holdFail: Number.isFinite(o.holdFail) ? o.holdFail : null, holdMotion: o.holdMotion, bounceWarn: o.bounceWarn, bounceFail: Number.isFinite(o.bounceFail) ? o.bounceFail : null, bounceWindow: o.bounceWindow, bounceLevel: o.bounceLevel, bounceRegion: o.bounceRegion },
    flash: { status: flashStatus, worstScore: round(worstFlash, 2), count: flashes.length, events: flashes.slice(0, 50).map(flashEvent) }, // count = bursts (adjacent flagged frames folded)
    hold: { status: holdStatus, worstMs: round(worstHold, 1), count: holds.length, events: holds.slice(0, 50).map(holdEvent) },
    bounce: { status: bounceStatus, worstScore: round(worstBounce, 2), count: shownBounces.length, events: shownBounces.slice(0, 50).map(bounceEvent) },
    layoutLoop: { status: loopStatus, count: loops.length, lines: loops.slice(0, 20) },
  }

  mkdirSync(o.out, { recursive: true })
  const flagsPath = join(o.out, 'flags.png')
  rmSync(flagsPath, { force: true })
  if (o.flags && rowsForPng.length) verdict.flagsPng = (await writeFlags(o, vw, vh, pts, rowsForPng, flagsPath)) ? flagsPath : null
  writeFileSync(join(o.out, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`)

  if (o.json) process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
  else {
    const launchBit = launch.mode === 'detected' ? `launch screen at ${startT.toFixed(1)}s` : launch.mode === 'fallback' ? `launch screen NOT found: skipped to ${startT.toFixed(1)}s (first non-uniform frame + ${o.fallbackExtraS}s)` : `skip ${blind}s (--skip-start)`
    const bits = [
      `flash ${flashStatus} worst ${worstFlash.toFixed(1)}${flashes.length ? ` (${flashes.length})` : ''}`,
      `hold ${holdStatus} worst ${worstHold.toFixed(0)}ms${holds.length ? ` (${holds.length})` : ''}`,
      `bounce ${bounceStatus} worst ${worstBounce.toFixed(1)}${shownBounces.length ? ` (${shownBounces.length})` : ''}`,
      `layout-loop ${loops.length}`,
      launchBit,
    ]
    if (budget) bits.push(`budget ${budget.match}: ${Object.entries(budget.applied).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    process.stdout.write(`VERDICT: ${overall} (${bits.join('; ')})${verdict.flagsPng ? ` flags: ${flagsPath}` : ''}\n`)
  }
  process.exit(overall === 'FAIL' ? 4 : 0)
}

// flags.png: one row per event, three frames side by side, the region outlined. Frames are cut out of the clip in a
// single decode pass into a temp dir (deleted), then stacked with ffmpeg.
async function writeFlags(o, vw, vh, pts, events, outPng) {
  const tmp = mkdtempSync(join(tmpdir(), 'proof-verdict.'))
  try {
    const clamp = (n) => Math.min(Math.max(n, 0), pts.length - 1)
    const need = new Set()
    for (const e of events) for (const n of e.frames) need.add(clamp(n))
    const idx = [...need].sort((a, b) => a - b)
    const TH = 440
    const TW = Math.round((vw * TH) / vh / 2) * 2
    const sel = idx.map((n) => `eq(n\\,${n})`).join('+')
    const r = sh('ffmpeg', ['-v', 'error', '-y', '-i', o.clip, '-fps_mode', 'passthrough', '-vf', `select='${sel}',scale=${TW}:${TH}`, '-fps_mode', 'passthrough', join(tmp, 'f_%04d.png')])
    if (r.status !== 0) { process.stderr.write(`flags.png: ffmpeg select failed: ${r.stderr}\n`); return false }
    const files = readdirSync(tmp).sort()
    if (files.length !== idx.length) { process.stderr.write(`flags.png: expected ${idx.length} frames, got ${files.length}\n`); return false }
    const fileOf = new Map(idx.map((n, j) => [n, join(tmp, files[j])]))
    const inputs = []
    const chains = []
    events.forEach((e, row) => {
      const bx = Math.round(e.region.x * TW), by = Math.round(e.region.y * TH), bw = Math.max(4, Math.round(e.region.w * TW)), bh = Math.max(4, Math.round(e.region.h * TH))
      const labels = []
      e.frames.forEach((fr, j) => {
        inputs.push('-i', fileOf.get(clamp(fr)))
        const n = row * 3 + j
        chains.push(`[${n}:v]drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${e.color}@0.9:t=3,pad=iw+8:ih+8:4:4:color=black[p${n}]`)
        labels.push(`[p${n}]`)
      })
      chains.push(`${labels.join('')}hstack=inputs=3[r${row}]`)
    })
    const rowsL = events.map((_, row) => `[r${row}]`).join('')
    chains.push(events.length > 1 ? `${rowsL}vstack=inputs=${events.length}[out]` : '[r0]null[out]')
    const s = sh('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-frames:v', '1', outPng])
    if (s.status !== 0) { process.stderr.write(`flags.png: compose failed: ${s.stderr}\n`); return false }
    return true
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1) })
}
