# Reading a proof

A proof dir (`factory proof`) holds `<scenario>.mp4`, `contact.png`, `rest-start.png`, `rest-end.png`, `steps.log`,
`verdict.json`, and `flags.png` when anything was flagged. A matrix dir (`factory proof-matrix`) holds one such dir per
cell plus `matrix.md` and `matrix-contact.png`. Review in this order and stop at the first FAIL: it already blocks.

## 1. The verdict line and verdict.json

```
VERDICT: FAIL (flash FAIL worst 87.3 (2); hold PASS worst 0ms; bounce PASS worst 0.0; layout-loop 0; launch screen at 1.6s) flags: <dir>/flags.png
```

| Detector | Catches | Score |
|---|---|---|
| **flash / ghost** | a tile that changes and returns within ≤ 3 frames (A → B → A): a one-frame pop, an element that blinks | grey-level change, discounted when the return isn't exact; a scrub, camera move or morph scores ~0 |
| **hold / stall** | a gap in the recording's frame times with motion on both sides: a held frame | ms of the gap; holds inside the launch window can only WARN |
| **bounce** | a big whole-frame change that reverses within ~1 s (light → dark → light) | luma step; a full theme swing is far above the FAIL line |
| **fail markers** | lines the app logs (`[proof.ios] fail_markers`, e.g. `LAYOUT-LOOP`) in `steps.log` | any line FAILs |

The launch bit says where judging began: `launch screen at <t>s` (detected) is normal; `launch screen NOT found` means the
detector guessed, so check the first seconds by eye.

**Bands.** Each detector is PASS / WARN / FAIL against `[proof.ios.verdict]` (`*_warn`, `*_fail`), with per-scenario
overrides in the project's budgets file (`[proof.ios] budgets`). **FAIL** blocks the item. **WARN** is a finding to look
at in `flags.png`, not a pass to ignore: a WARN on a motion item's key transition deserves a frame-by-frame look and a
line in the Log; a WARN hold on a fresh simulator's first launch is usually the cold start. Thresholds change only
against a labelled corpus (`factory proof-calibrate <manifest>`), never to make one clip pass.

## 2. flags.png (open it first)

One row per flagged event, worst first, FAIL before WARN. Flash rows: before / flagged / after, the region outlined in
red. Hold rows: the two frames before the gap and the one after, outlined in amber. Ask of each row: is the outlined
thing a real element appearing or vanishing, or the scenario's own intended motion? A real one is a defect regardless of
size.

## 3. matrix.md

One row per cell: device, launch (`first` / `warm`), system / app appearance, verdict, worst flash, worst hold ms, worst
bounce, marker count, its flags.png. The last line is `MATRIX: PASS|FAIL (n/m cells; launches: …)`. Read the failing
cell's flags.png, then compare that cell's contact sheet with a passing one in `matrix-contact.png` (same scenario,
side by side). Mismatch and second-size cells catch what the default cell hides; a cell that only fails on a fresh
simulator points at first-launch state (caches, launch snapshot).

## 4. Frames you grab yourself

Simulator recordings are variable-frame-rate with duplicate and out-of-order timestamps, so `ffmpeg -ss` / `-sseof`
**return stale frames** (a fake light → dark → light bounce is the classic). Always grab with the kit:

```
factory clip-frames <clip.mp4> --at 4.2 <out.png>          # the frame on screen at 4.2 s
factory clip-frames <clip.mp4> --at end <out.png>
factory clip-frames <clip.mp4> --contact <out.png> --rate 10   # a dense strip around a moment
factory clip-frames <clip.mp4> --dump "$(mktemp -d)" --rate 60 # every frame; delete the dir after
```

Use `steps.log` timestamps (scenario steps, the app's own markers) to pick the moments: the frames just before, at and
after each step. The first launch after an install shows the system's own black frame; that is not the app.

## 5. Beyond the machine verdict

The verdict catches flashes, holds and bounces. It doesn't catch taste. Check against the rules file's gates and
guardrails by eye:
- motion that the finger can't interrupt (a scenario that grabs mid-flight should show it follow or reverse);
- two states' text on screen at once, or a fade through an empty container;
- a control visible but inert, or a second surface where the project has one;
- a port that drifted from its reference: compare with a recording of the reference side by side, frame for frame.

## 6. Agent reports

Agents over-claim: seeds never written, "clean" strips where the content never loaded, passes that only hold on one cell.
A report is a pointer to evidence, never evidence. If the artifacts are missing or the verdict line isn't in the
output, the proof didn't happen.
