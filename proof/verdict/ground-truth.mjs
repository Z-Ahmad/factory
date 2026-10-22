// App-reported ground truth for the verdict: lines a DEBUG build writes through its `SCENARIO <name> …` log prefix, which
// steps.log already collects. All optional; a clip without them is judged from pixels alone, as before.
//   SCENARIO <name> CLOCK media=<s> wall=<epoch s>          once, at scenario start: pairs the app's media clock with wall time
//   SCENARIO <name> SYNC media=<s>                          a #FF00FF marker at x/y 4-10 pt (inside the status band) drawn
//                                                           for 3 frames; media = its first frame. Aligns video to media time.
//   SCENARIO <name> HITCH media= dur=<ms> expected=<ms> frame=<n> step=<rest of line>   a display frame that came late
//   SCENARIO <name> MOTION start|end kind=camera|roll|morph|sheet id=<n> media=<s>     an animation the app runs on purpose
//   SCENARIO <name> MAPRECT media= x= y= w= h= scale=<px per pt>                      the map view's frame (points), on change
//   SCENARIO <name> SHEETTOP media= y=<pt>                                             the sheet's top edge, on change
//   SCENARIO <name> LIVE start|end id=<n> media= x= y= w= h=                         a view that changes on purpose (a caret)
//   SCENARIO <name> INJECT kind=hold|blink|ghost id=<n> media= dur=<ms> step=<rest>   a fault injected for calibration
//   SCENARIO <name> <step> t=<s>                             a scenario step (its time comes from the log line's wall clock)
// Pure functions; proof-verdict.mjs decodes the video and calls them.

const KINDS = new Set(['CLOCK', 'SYNC', 'HITCH', 'MOTION', 'MAPRECT', 'SHEETTOP', 'LIVE', 'INJECT'])

// "2026-10-21 13:39:15.140586-0400 …" (os_log's line prefix) -> epoch seconds, or null.
export function wallOf(line) {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(\d\d)/.exec(line)
  if (!m) return null
  const ms = Date.parse(`${m[1]}T${m[2]}${m[4]}:${m[5]}`)
  return Number.isFinite(ms) ? ms / 1000 + Number(m[3] || 0) : null
}

// key=value fields; `step=` takes the rest of the line (labels have spaces).
export function fieldsOf(rest) {
  const out = {}
  const stepAt = rest.search(/(^|\s)step=/)
  let head = rest
  if (stepAt >= 0) {
    out.step = rest.slice(rest.indexOf('step=', stepAt) + 5).trim()
    head = rest.slice(0, stepAt)
  }
  const words = []
  for (const tok of head.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=')
    if (eq > 0) {
      const v = tok.slice(eq + 1)
      out[tok.slice(0, eq)] = v !== '' && Number.isFinite(Number(v)) ? Number(v) : v
    } else words.push(tok)
  }
  out._words = words
  return out
}

/** steps.log text -> { found, clock, syncs, hitches, motions, maprects, sheettops, lives, injects, steps }. Media seconds. */
export function parseGroundTruth(text) {
  const gt = { found: false, clock: null, syncs: [], hitches: [], motions: [], maprects: [], sheettops: [], lives: [], injects: [], steps: [] }
  const open = new Map() // MOTION / LIVE id -> its start
  const pendingSteps = [] // { name, wall } until CLOCK is known
  for (const line of text.split('\n')) {
    const at = line.indexOf('SCENARIO ')
    if (at < 0) continue
    const m = /^SCENARIO (\S+) (\S+)(.*)$/.exec(line.slice(at))
    if (!m) continue
    const [, , kind, rest] = m
    if (!KINDS.has(kind)) {
      // a step: "<label> t=<s>" and nothing else
      if (/^[a-z][a-z0-9-]*$/.test(kind) && /^\s+t=[\d.]+\s*$/.test(rest)) pendingSteps.push({ name: kind, wall: wallOf(line) })
      continue
    }
    gt.found = true
    const f = fieldsOf(rest)
    const media = typeof f.media === 'number' ? f.media : null
    if (kind === 'CLOCK') gt.clock = { media, wall: f.wall }
    else if (kind === 'SYNC') gt.syncs.push(media)
    else if (kind === 'HITCH') gt.hitches.push({ media, durMs: f.dur, expectedMs: f.expected, frame: f.frame ?? null, step: f.step ?? '' })
    else if (kind === 'MAPRECT') gt.maprects.push({ media, x: f.x, y: f.y, w: f.w, h: f.h, scale: f.scale })
    else if (kind === 'SHEETTOP') gt.sheettops.push({ media, y: f.y })
    else if (kind === 'INJECT') gt.injects.push({ media, kind: f.kind, id: f.id ?? null, durMs: f.dur ?? null, step: f.step ?? '' })
    else if (kind === 'MOTION' || kind === 'LIVE') {
      const edge = f._words[0]
      const key = `${kind}:${f.id}`
      if (edge === 'start') {
        const rec = kind === 'MOTION' ? { id: f.id, kind: f.kind, start: media, end: null } : { id: f.id, start: media, end: null, x: f.x, y: f.y, w: f.w, h: f.h }
        open.set(key, rec)
        ;(kind === 'MOTION' ? gt.motions : gt.lives).push(rec)
      } else if (edge === 'end') {
        const rec = open.get(key)
        if (rec) { rec.end = media; open.delete(key) }
        else if (kind === 'MOTION') gt.motions.push({ id: f.id, kind: f.kind, start: null, end: media })
      }
    }
  }
  // steps go on the media clock through the wall clock CLOCK pairs with it
  if (gt.clock && Number.isFinite(gt.clock.wall)) {
    for (const s of pendingSteps) if (s.wall !== null) gt.steps.push({ name: s.name, media: gt.clock.media + (s.wall - gt.clock.wall) })
  }
  for (const list of [gt.syncs, gt.hitches, gt.motions, gt.maprects, gt.sheettops, gt.injects, gt.steps]) {
    list.sort((a, b) => (a?.media ?? a?.start ?? a ?? 0) - (b?.media ?? b?.start ?? b ?? 0))
  }
  return gt
}

/**
 * Anchors that agree: a SYNC marker can only reach the screen LATE (a stalled frame holds it back), never early, so an
 * anchor whose offset (pts - media) exceeds the next one's by more than `lateS` is dropped. Returns { kept, dropped }.
 */
export function goodAnchors(anchors, lateS = 0.1) {
  const a = anchors.filter((x) => Number.isFinite(x.media) && Number.isFinite(x.pts)).sort((x, y) => x.media - y.media)
  const off = (x) => x.pts - x.media
  const dropped = []
  let changed = true
  while (changed) {
    changed = false
    for (let k = 0; k + 1 < a.length; k++) {
      if (off(a[k]) - off(a[k + 1]) > lateS) { dropped.push(a.splice(k, 1)[0]); changed = true; break }
    }
  }
  return { kept: a, dropped }
}

/**
 * Video presentation time for a media time, from anchors [{ media, pts }]. Recording is variable-rate and drifts from the
 * app's clock (~9% was seen over 9 s), so between two anchors it interpolates linearly, and outside them it carries on
 * from the nearest one at slope 1. Null without anchors.
 */
export function makeAligner(anchors) {
  const a = anchors.filter((x) => Number.isFinite(x.media) && Number.isFinite(x.pts)).sort((x, y) => x.media - y.media)
  if (!a.length) return null
  return (media) => {
    if (media <= a[0].media) return a[0].pts + (media - a[0].media)
    const last = a[a.length - 1]
    if (media >= last.media) return last.pts + (media - last.media)
    let k = 0
    while (a[k + 1].media < media) k++
    const f = (media - a[k].media) / (a[k + 1].media - a[k].media)
    return a[k].pts + f * (a[k + 1].pts - a[k].pts)
  }
}

/** Seconds from `media` to the nearest anchor (Infinity without anchors): how far a window is from known alignment. */
export function anchorDistance(anchors, media) {
  return anchors.reduce((m, x) => Math.min(m, Math.abs(x.media - media)), Infinity)
}

/**
 * Pair SYNC media times with marker runs found in the video ([{ frame, pts }]), in order, tolerating a SYNC whose marker
 * was not seen (or a run with no SYNC line): the pairing with the most pairs whose consecutive gaps agree (within `tolS`
 * plus 10% of the gap, the drift seen).
 */
export function anchorsFrom(syncs, runs, tolS = 0.35) {
  const n = syncs.length, m = runs.length
  if (!n || !m) return []
  const best = Array.from({ length: n }, () => new Array(m).fill(1))
  const prev = Array.from({ length: n }, () => new Array(m).fill(null))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      for (let i2 = 0; i2 < i; i2++) {
        for (let j2 = 0; j2 < j; j2++) {
          const dm = syncs[i] - syncs[i2], dp = runs[j].pts - runs[j2].pts
          if (Math.abs(dp - dm) > tolS + 0.1 * dm) continue
          // >=: on a tie the later predecessor wins, so a chain avoids the launch SYNC a stall delayed
          if (best[i2][j2] + 1 >= best[i][j] && best[i2][j2] + 1 > 1) { best[i][j] = best[i2][j2] + 1; prev[i][j] = [i2, j2] }
        }
      }
    }
  }
  let bi = 0, bj = 0
  // ties go to the later pair: the launch SYNC is the one a launch stall delays
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) if (best[i][j] >= best[bi][bj]) { bi = i; bj = j }
  const out = []
  for (let c = [bi, bj]; c; c = prev[c[0]][c[1]]) out.unshift({ media: syncs[c[0]], pts: runs[c[1]].pts, frame: runs[c[1]].frame })
  return out
}

/** Marker runs: frames whose marker share is >= `on`, grouped when consecutive. `share[i]` in 0..1 per decoded frame. */
export function markerRuns(share, pts, on = 0.5) {
  const runs = []
  for (let i = 0; i < share.length; i++) {
    if (share[i] < on) continue
    if (runs.length && runs[runs.length - 1].last === i - 1) runs[runs.length - 1].last = i
    else runs.push({ frame: i, last: i, pts: pts[i] })
  }
  return runs
}

/**
 * Holds from HITCH lines: each with dur >= holdWarn is an event, WARN/FAIL by holdWarn/holdFail, and only a WARN within
 * `launchWindow` s of the launch (the first SYNC, else CLOCK). `align` (optional) adds each one's clip time.
 */
export function judgeHitches(gt, { holdWarn, holdFail, launchWindow, align = null }) {
  const launch = gt.syncs[0] ?? gt.clock?.media ?? null
  const events = []
  for (const h of gt.hitches) {
    if (!(h.durMs >= holdWarn)) continue
    const base = h.durMs >= holdFail ? 'FAIL' : 'WARN'
    const inLaunch = launch !== null && launchWindow > 0 && h.media - launch < launchWindow
    events.push({ ...h, t: align && h.media !== null ? align(h.media) : null, launch: inLaunch, status: inLaunch && base === 'FAIL' ? 'WARN' : base })
  }
  events.sort((a, b) => (b.status === 'FAIL') - (a.status === 'FAIL') || b.durMs - a.durMs)
  const status = events.some((e) => e.status === 'FAIL') ? 'FAIL' : events.length ? 'WARN' : 'PASS'
  return { status, worstMs: events.reduce((m, e) => Math.max(m, e.durMs), 0), count: events.length, total: gt.hitches.length, events }
}

/** The value of a stepwise signal (`list` of { media, … } on change) at media time t: the last one at or before t. */
export function valueAt(list, t) {
  let v = null
  for (const x of list) { if (x.media <= t) v = x; else break }
  return v ?? list[0] ?? null
}

// ---------- settle check ----------

const UI_KINDS = new Set(['roll', 'sheet', 'morph'])

/**
 * Where the UI must be still: from the end of each stretch of UI motion (roll / sheet / morph MOTION pairs, merged where
 * they overlap; camera motion only moves the map, which is not judged) plus `graceMs`, until the next UI motion or step,
 * or `settleMs` after the end, whichever comes first. Media seconds: [{ start, end, settledAt }].
 */
export function settleWindows(gt, { settleMs = 1000, graceMs = 100 } = {}) {
  const ivs = gt.motions.filter((m) => UI_KINDS.has(m.kind) && m.start !== null && m.end !== null).map((m) => [m.start, m.end]).sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [a, b] of ivs) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  // a UI motion still open at the end of the clip leaves nothing to judge after it
  const openFrom = gt.motions.filter((m) => UI_KINDS.has(m.kind) && m.start !== null && m.end === null).reduce((x, m) => Math.min(x, m.start), Infinity)
  const stops = [...merged.map((x) => x[0]), ...gt.steps.map((x) => x.media), openFrom].sort((a, b) => a - b)
  const out = []
  for (const [, e] of merged) {
    const start = e + graceMs / 1000
    const next = stops.find((x) => x > e) ?? Infinity
    const end = Math.min(e + settleMs / 1000, next)
    if (end - start >= 0.05) out.push({ start, end, settledAt: e })
  }
  return out
}

/**
 * The pixels the settle check judges, at `ppt` pixels per point in a frame `w` x `h`: the UI (sheet and chrome), so not the
 * map where the sheet does not cover it (MAPRECT above SHEETTOP), not the status band (`topPx`), not a LIVE rect open at
 * `media`. A Uint8Array mask, 1 = judged.
 */
export function uiMask(gt, media, { w, h, ppt, topPx }) {
  const mask = new Uint8Array(w * h)
  const map = valueAt(gt.maprects, media)
  const sheet = valueAt(gt.sheettops, media)
  const live = gt.lives.filter((l) => l.start !== null && l.start <= media && (l.end === null || l.end > media))
  const inRect = (x, y, r) => x >= r.x * ppt && x < (r.x + r.w) * ppt && y >= r.y * ppt && y < (r.y + r.h) * ppt
  for (let y = topPx; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map && inRect(x, y, map) && (!sheet || y < sheet.y * ppt)) continue
      if (live.some((r) => inRect(x, y, r))) continue
      mask[y * w + x] = 1
    }
  }
  return mask
}

/**
 * One settle window: frames [{ i, pts, data }] in order (grey, w x h), the first is the settled reference. The worst
 * later frame by changed pixels (|d| > `luma`) inside `mask`, with their bounding box: { i, pts, changed, box } or null.
 */
export function settleChange(frames, mask, { w, luma = 16 }) {
  if (frames.length < 2) return null
  const ref = frames[0].data
  let worst = null
  for (const f of frames.slice(1)) {
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
    for (let p = 0; p < ref.length; p++) {
      if (!mask[p] || Math.abs(f.data[p] - ref[p]) <= luma) continue
      n++
      const x = p % w, y = (p - x) / w
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
    if (n && (!worst || n > worst.changed)) worst = { i: f.i, pts: f.pts, changed: n, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } }
  }
  return worst
}
