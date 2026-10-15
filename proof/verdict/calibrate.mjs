#!/usr/bin/env node
// usage: factory proof-calibrate <manifest.json> [--out <dir>] [--tool <proof-verdict.mjs>] [--detail] [--jobs N] [--arg <verdict flag> ...]
// Runs the verdict over a project's own labelled clips and prints the confusion table. The clips are the project's, never the
// kit's: a manifest names them (paths are relative to the manifest; ~ is the home directory).
//   {
//     "budgets": "proof-budgets.json",        // optional: passed to the verdict as --budgets (relative to the manifest)
//     "args": ["--hold-fail", "80"],           // optional: flags for every clip
//     "clips": [
//       { "name": "footer-before", "clip": "shots/footer-before/x.mp4", "expected": "FAIL", "must": true,
//         "class": "MUST FAIL", "note": "free text", "scenario": "optional, else the file name",
//         "args": ["--steps", "shots/footer-before/steps.log"] },
//       { "name": "scrub-approved", "clip": "shots/scrub/y.mp4", "expected": "PASS", "must": true }
//     ]
//   }
// `expected` is the verdict a person decided (PASS or FAIL). `must` (default true when `expected` is set) puts the clip in the
// confusion table; a clip with an expectation but must = false, or none at all, is only listed (--detail). Each clip's
// verdict.json and flags.png land in <out>/runs/<name>/ (default: a temp dir that is deleted; pass --out to keep them).
// `--tool` runs another copy of proof-verdict.mjs, e.g. an older one, to compare tables.
// Exit 0 when every `must` clip got its expected verdict; 1 when one did not (or a run failed).
import { spawn } from 'node:child_process'
import { cpus, homedir, tmpdir } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const die = (m) => { process.stderr.write(`${m}\n`); process.exit(2) }
const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

/** Rows of the confusion table: one per expected verdict among the `must` clips; columns = the verdicts seen. */
export function confusion(results) {
  const rows = new Map()
  for (const r of results.filter((x) => x.must)) {
    if (!rows.has(r.expected)) rows.set(r.expected, { total: 0, got: {} })
    const row = rows.get(r.expected)
    row.total++
    row.got[r.verdict] = (row.got[r.verdict] ?? 0) + 1
  }
  return rows
}

export function renderConfusion(results) {
  const rows = confusion(results)
  const seen = new Set(['FAIL', 'PASS'])
  for (const r of results) if (r.must) seen.add(r.verdict)
  const cols = ['FAIL', 'PASS', ...[...seen].filter((c) => c !== 'FAIL' && c !== 'PASS').sort()]
  const lines = [`| expected | ${cols.map((c) => `verdict ${c}`).join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`]
  for (const exp of ['FAIL', 'PASS']) {
    const row = rows.get(exp) ?? { total: 0, got: {} }
    lines.push(`| ${exp} (${row.total} clips) | ${cols.map((c) => row.got[c] ?? 0).join(' | ')} |`)
  }
  const others = results.filter((r) => !r.must)
  if (others.length) {
    const tally = {}
    for (const r of others) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1
    lines.push(`| no expectation (${others.length} clips) | ${cols.map((c) => tally[c] ?? 0).join(' | ')} |`)
  }
  return lines.join('\n')
}

const cell = (v) => (v ? `${v.worstScore ?? v.worstMs ?? 0} (${v.count}) ${v.status}` : '-')

export function renderDetail(results) {
  const lines = ['| clip | class | expected | verdict | flash worst | hold worst ms | bounce worst | launch | note |', '|---|---|---|---|---|---|---|---|---|']
  for (const r of results) {
    const v = r.json
    const budget = v?.budget ? ` budget ${v.budget.match}` : ''
    const ok = r.must && r.expected !== r.verdict ? ' (MISSED)' : ''
    lines.push(`| ${r.name} | ${r.class ?? ''} | ${r.expected ?? '-'} | **${r.verdict}**${ok} | ${cell(v?.flash)} | ${v ? `${v.hold.worstMs} (${v.hold.count}) ${v.hold.status}${budget}` : '-'} | ${cell(v?.bounce)} | ${v ? `${v.launch.mode} ${v.launch.startS}s` : '-'} | ${r.note ?? ''} |`)
  }
  return lines.join('\n')
}

function runOne(tool, args) {
  return new Promise((res) => {
    const p = spawn('node', [tool, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (c) => { err += c })
    p.on('close', (code) => res({ code, err }))
    p.on('error', (e) => res({ code: -1, err: String(e) }))
  })
}

async function main(argv) {
  let manifestPath = '', out = '', tool = join(HERE, 'proof-verdict.mjs'), detail = false, jobs = Math.max(1, Math.min(4, cpus().length))
  const extra = []
  for (let a = 0; a < argv.length; a++) {
    const k = argv[a]
    const val = () => { const v = argv[++a]; if (v === undefined) die(`${k} wants a value`); return v }
    if (k === '--out') out = resolve(val())
    else if (k === '--tool') tool = resolve(val())
    else if (k === '--detail') detail = true
    else if (k === '--jobs') jobs = Math.max(1, Number(val()) || 1)
    else if (k === '--arg') extra.push(val())
    else if (k.startsWith('--')) die(`unknown arg: ${k}`)
    else if (!manifestPath) manifestPath = k
    else die(`unexpected arg: ${k}`)
  }
  if (!manifestPath) die('usage: factory proof-calibrate <manifest.json> [--out <dir>] [--tool <proof-verdict.mjs>] [--detail] [--jobs N]')
  manifestPath = resolve(manifestPath)
  if (!existsSync(manifestPath)) die(`no such manifest: ${manifestPath}`)
  if (!existsSync(tool)) die(`no such verdict tool: ${tool}`)
  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (e) { die(`${manifestPath}: ${e.message}`) }
  if (!Array.isArray(manifest.clips) || !manifest.clips.length) die(`${manifestPath}: "clips" must be a non-empty array`)
  const base = dirname(manifestPath)
  const path = (p) => resolve(base, expandHome(p))

  const names = new Set()
  const clips = manifest.clips.map((c, i) => {
    if (!c.name || !c.clip) die(`${manifestPath}: clip ${i + 1} needs "name" and "clip"`)
    if (!/^[A-Za-z0-9._-]+$/.test(c.name)) die(`${manifestPath}: clip name "${c.name}" may only use letters, digits, . _ -`)
    if (names.has(c.name)) die(`${manifestPath}: duplicate clip name "${c.name}"`)
    names.add(c.name)
    if (c.expected !== undefined && c.expected !== 'PASS' && c.expected !== 'FAIL') die(`${manifestPath}: ${c.name}: expected is PASS or FAIL`)
    return { ...c, file: path(c.clip), must: c.must ?? c.expected !== undefined }
  })
  for (const c of clips) if (c.must && !c.expected) die(`${manifestPath}: ${c.name}: must needs expected`)
  for (const c of clips) if (!existsSync(c.file)) die(`${manifestPath}: ${c.name}: no clip at ${c.file}`)

  const keep = Boolean(out)
  const root = out || mkdtempSync(join(tmpdir(), 'proof-calibrate.'))
  const results = new Array(clips.length)
  let next = 0, done = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= clips.length) return
      const c = clips[i]
      const dir = join(root, 'runs', c.name)
      mkdirSync(dir, { recursive: true })
      const args = [c.file, '--out', dir]
      if (c.scenario) args.push('--scenario', c.scenario)
      if (manifest.budgets) args.push('--budgets', path(manifest.budgets))
      args.push(...(manifest.args ?? []), ...extra)
      for (let j = 0; j < (c.args ?? []).length; j++) {
        const a = c.args[j]
        // a value that names a file in the project is relative to the manifest, like "clip"
        args.push(j > 0 && /^--(steps|budgets)$/.test(c.args[j - 1]) ? path(a) : a)
      }
      const { code, err } = await runOne(tool, args)
      let json = null
      try { json = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')) } catch { /* the tool failed */ }
      const ok = (code === 0 || code === 4) && json
      results[i] = { ...c, verdict: ok ? json.verdict : 'ERROR', json, error: ok ? '' : `exit ${code}: ${err.trim().split('\n').pop()}` }
      process.stderr.write(`\r${++done}/${clips.length} clips`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, clips.length) }, worker))
  process.stderr.write('\n')

  const out1 = ['## Confusion', '', renderConfusion(results)]
  if (detail) out1.push('', '## Clips', '', renderDetail(results))
  const errors = results.filter((r) => r.verdict === 'ERROR')
  for (const r of errors) out1.push('', `ERROR ${r.name}: ${r.error}`)
  const missed = results.filter((r) => r.must && r.verdict !== r.expected)
  if (missed.length) out1.push('', `MISSED: ${missed.map((r) => `${r.name} (expected ${r.expected}, got ${r.verdict})`).join(', ')}`)
  const text = `${out1.join('\n')}\n`
  process.stdout.write(text)
  if (keep) writeFileSync(join(root, 'table.md'), text)
  else rmSync(root, { recursive: true, force: true })
  process.exit(missed.length || errors.length ? 1 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
