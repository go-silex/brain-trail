#!/usr/bin/env node
// Compare a git baseline with this dirty candidate through the pinned native
// plugin runner, then raster production SVGs and the production browser page.
// Not a native Claude Desktop pixel capture.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  access,
  cp,
  lstat,
} from 'node:fs/promises'
import { tmpdir, homedir, platform, arch } from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decideViewChanges } from './view-changes.mjs'
import { probeNativeMapLayout } from './native-map-layout.mjs'

const CANDIDATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const CLI = path.join(
  CANDIDATE,
  'node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
)
const FIXTURE = path.join('tests', 'fixtures', 'views.tsx')
const MARK_MANIFEST = 'BT_VIEW_MANIFEST:'
const MARK_CASE = 'BT_VIEW_CASE:'
const OWNER_FILE = '.view-parity-owner'
const OWNER_TEXT = 'view-parity\n'
const TEST_TIMEOUT_MS = 120_000
const FIXED_TIME = '2026-11-11T12:00:00.000Z'
const BOOT_TICK = 1000
const INSTALL_LEAD_MS = 1000
const SCENE_RUN_FOR_MS = 3200
const SCENE_TWEEN_MS = 1400
const SCENE_NAV_MS = 500
const SCENE_FINAL_NOW =
  BOOT_TICK + SCENE_RUN_FOR_MS + SCENE_TWEEN_MS + SCENE_TWEEN_MS + SCENE_NAV_MS
const SVG_SMIL_SECONDS = 1.6
const SVG_CSS_MS = 1600
const SCENE_VIEWPORT = { width: 1280, height: 720 }
const SVG_FALLBACK = { width: 800, height: 600 }
const THEME_BG = { dark: '#0b0e10', light: '#eef2f4' }
const THREE_PREFIX = 'https://cdn.jsdelivr.net/npm/three@0.160.0/'
const THREE_MODULE = `${THREE_PREFIX}build/three.module.js`

const NATIVE_LAYOUT_CASES = new Set([
  'pane-map-desktop-dark-en',
  'inline3d-desktop-dark-en',
])
const LIMIT =
  'Complete SDK descriptions plus SVG and browser proof is not actual native Claude Desktop pixel capture on Linux.'
const temps = []

process.on('exit', () => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // The async cleanup reports a leftover. Exit must not throw.
    }
  }
})

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const output = path.resolve(args.output ?? '.artifacts/view-parity')
  const baseRef =
    args.base ??
    (process.env.VIEW_BASE || process.env.RELEASE_BASE || 'origin/main')
  const receipt = {
    ok: false,
    proof: 'emitted input equivalence',
    rasterDifferent: 0,
    limit: LIMIT,
    limits: [
      LIMIT,
      'Browser scenes load Three 0.160.0 from jsDelivr and Inter/JetBrains Mono from Google Fonts. This is not an offline proof.',
      'SVG HTML only frames the production SVG on the fixture theme background. It is not a native UI replica and is not a desktop layout.',
      'SVG proof captures one frame: CSS animations are materialized at 1600 ms and cancelled; SMIL is paused at 1.6 seconds. It does not prove motion parity.',
      'Primary proof is byte equality of the native tree, harvested SVG source, browser index.html, and data.js. Raster pixel mismatches are retained and diagnostic; they do not fail that proof. Capture, decode, network, and missing-artifact errors still fail it.',
      'Numeric press.handle differences are recorded and do not fail the tree. Every other tree difference fails. Svg props.source is replaced with an ordered slot before the tree compare.',
    ],
    baseline: null,
    intended: null,
    candidate: null,
    fixture: null,
    counts: { native: 0, svg: 0, browserScenes: 0 },
    selection: null,
    versions: {},
    clock: {
      browserScene: {
        installedAt: FIXED_TIME,
        installLeadMs: INSTALL_LEAD_MS,
        timezoneId: 'UTC',
        locale: 'en-US',
        deviceScaleFactor: 1,
        bootTick: BOOT_TICK,
        runForMs: SCENE_RUN_FOR_MS,
        finalNow: SCENE_FINAL_NOW,
      },
      svg: {
        jsClock: false,
        cssMs: SVG_CSS_MS,
        smilSeconds: SVG_SMIL_SECONDS,
      },
    },
    viewport: { scene: SCENE_VIEWPORT, svgFallback: SVG_FALLBACK },
    normalization: {
      module:
        'A module string is rewritten to the path relative to its isolated root only when both sides resolve to that same relative path.',
      pressHandle:
        'press.handle numbers are opaque runtime handler ids. They are listed and excluded. No other field is excluded.',
    },
    cases: [],
    errors: [],
  }
  let exitCode = 1
  let outputReady = false
  try {
    await claimOutput(output)
    outputReady = true
    const result = await prove(baseRef, output, receipt, args.case ?? null)
    exitCode = result
  } catch (error) {
    receipt.errors.push(
      error instanceof Error
        ? operational(error.message)
        : operational(String(error)),
    )
    process.stderr.write(
      `${operational(error instanceof Error ? error.message : String(error))}\n`,
    )
  } finally {
    for (const dir of temps.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch((error) => {
        receipt.errors.push(
          operational(
            `temporary copy left: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        exitCode = 1
      })
    }
    receipt.ok =
      exitCode === 0 &&
      receipt.errors.length === 0 &&
      receipt.cases.every((item) => item.ok)
    if (!receipt.ok) exitCode = 1
    if (outputReady) {
      try {
        await writeFile(
          path.join(output, 'receipt.json'),
          `${JSON.stringify(receipt, null, 2)}\n`,
        )
      } catch (error) {
        process.stderr.write(
          `receipt write failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        exitCode = 1
      }
    }
  }
  const failed = receipt.cases.filter((item) => !item.ok).length
  const scope = receipt.selection
    ? ` [${receipt.selection} of ${receipt.fixture?.discovered ?? '?'}]`
    : ''
  const intendedCount = receipt.cases.filter((item) => item.intended).length
  const equality = intendedCount
    ? `${intendedCount} intended changes, others equal`
    : 'sources equal'
  const line = receipt.ok
    ? `view-parity: ok ${receipt.counts.native} cases${scope}, ${equality}, raster diagnostic ${receipt.rasterDifferent} — ${shown(path.join(output, 'receipt.json'))}`
    : `view-parity: fail ${failed || receipt.errors.length}${scope}, raster diagnostic ${receipt.rasterDifferent} — ${shown(path.join(output, 'receipt.json'))}`
  process.stdout.write(`${line}\n`)
  process.exitCode = exitCode
}

const prove = async (baseRef, output, receipt, onlyCase) => {
  await access(CLI)
  const cliPackage = JSON.parse(
    await readFile(
      path.join(
        CANDIDATE,
        'node_modules/@anthropic-ai/claude-code/package.json',
      ),
      'utf8',
    ),
  )
  const versionRun = await runProcess(process.execPath, [CLI, '--version'], {
    cwd: CANDIDATE,
    stdoutPath: path.join(output, 'cli-version.stdout.log'),
    stderrPath: path.join(output, 'cli-version.stderr.log'),
    timeoutMs: 30_000,
  })
  receipt.versions.cliPackage = cliPackage.version
  receipt.versions.cli = (versionRun.stdout || versionRun.stderr).trim()
  receipt.versions.cliPackagePath =
    'node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs'
  receipt.versions.platform = `${platform()}-${arch()}`
  if (versionRun.code !== 0)
    throw new Error(`pinned CLI --version exited ${versionRun.code}`)

  const commit = (
    await git(['rev-parse', '--verify', `${baseRef}^{commit}`])
  ).trim()
  const tree = (await git(['rev-parse', '--verify', `${commit}^{tree}`])).trim()
  const head = (await git(['rev-parse', 'HEAD'])).trim()
  const headTree = (await git(['rev-parse', 'HEAD^{tree}'])).trim()
  const porcelain = await git(['status', '--porcelain'])
  receipt.baseline = { ref: baseRef, commit, tree }
  receipt.candidate = { head, tree: headTree, dirty: porcelain.length > 0 }

  const root = await mkdtemp(path.join(tmpdir(), 'view-parity-'))
  temps.push(root)
  const baselineRoot = path.join(root, 'baseline')
  const candidateRoot = path.join(root, 'candidate')
  await materializeBaseline(commit, baselineRoot)
  await snapshotCandidate(candidateRoot, output)
  await assertRootCopied(CANDIDATE, candidateRoot, output)
  let declaration = null
  try {
    declaration = await readFile(
      path.join(candidateRoot, 'tests/fixtures/view-changes.json'),
      'utf8',
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  receipt.intended = decideViewChanges({
    declaration,
    baseline: commit,
  }).intended
  const fixtureHash = await installFixtures(baselineRoot, candidateRoot, root)
  receipt.fixture = fixtureHash
  const production = await hashTree(candidateRoot)
  receipt.candidate.input = {
    sha256: production.sha256,
    files: production.files.length,
    bytes: production.bytes,
    note: 'SHA256 of the isolated candidate after identical fixture copy and before throwaway wrappers. HEAD alone does not name this dirty tree.',
  }
  await writeFile(path.join(output, 'input.sha256'), production.canonical)

  const discovered = await discoverManifest(baselineRoot, candidateRoot, output)
  receipt.fixture.cases = discovered.map((item) => ({
    id: item.id,
    ...scenarioOf(item),
  }))
  receipt.fixture.discovered = discovered.length
  if (discovered.length === 0)
    throw new Error('native manifest exported zero cases')
  decideViewChanges({
    declaration,
    baseline: commit,
    names: discovered.map((item) => item.id),
  })
  const manifest = onlyCase
    ? discovered.filter((item) => item.id === onlyCase)
    : discovered
  if (onlyCase && manifest.length !== 1)
    throw new Error(
      `--case ${onlyCase} is not in the native manifest (${discovered.length} ids)`,
    )
  receipt.selection = onlyCase
  receipt.counts.native = manifest.length

  const wrappers = await installWrappers(baselineRoot, candidateRoot, manifest)
  receipt.fixture.wrappersSha256 = sha256(wrappers)
  const baselineRun = await runNative(
    'baseline',
    baselineRoot,
    output,
    manifest.length,
  )
  const candidateRun = await runNative(
    'candidate',
    candidateRoot,
    output,
    manifest.length,
  )
  const baselineCases = capturesOf(baselineRun, manifest, 'baseline')
  const candidateCases = capturesOf(candidateRun, manifest, 'candidate')
  const nativeFailed = baselineRun.code !== 0 || candidateRun.code !== 0
  if (nativeFailed) {
    const report = operational(
      `native runner failed: baseline ${baselineRun.code}, candidate ${candidateRun.code}\nbaseline\n${runnerReport(baselineRun)}\ncandidate\n${runnerReport(candidateRun)}`,
    )
    receipt.errors.push(report)
    process.stderr.write(`${report}\n`)
  }

  const needsBrowser = manifest.some((item) => {
    const left = baselineCases.get(item.id)
    const right = candidateCases.get(item.id)
    return (
      NATIVE_LAYOUT_CASES.has(item.id) ||
      left?.svgs.length ||
      right?.svgs.length ||
      browserArtifacts(left) ||
      browserArtifacts(right) ||
      looksBrowser(item)
    )
  })
  const browser = needsBrowser ? await launchBrowser(receipt) : null
  try {
    for (let index = 0; index < manifest.length; index += 1) {
      const scenario = manifest[index]
      const { item, differences } = await compareCase(
        scenario,
        index,
        baselineCases.get(scenario.id),
        candidateCases.get(scenario.id),
        baselineRoot,
        candidateRoot,
        output,
        browser,
      )
      const decision = decideViewChanges({
        declaration,
        baseline: commit,
        result: {
          name: item.id,
          errors: item.errors.map((message, position) => ({
            kind: differences.has(position) ? 'difference' : 'operational',
            message,
          })),
        },
      }).result
      item.errors = decision.errors.map((entry) => entry.message)
      if (decision.intended) item.intended = true
      item.ok = item.errors.length === 0
      receipt.cases.push(item)
      receipt.counts.svg += item.svgCount
      if (item.browser) receipt.counts.browserScenes += 1
      receipt.rasterDifferent += rasterDiagnosticCount(item)
      if (!item.ok) writeCaseDiagnostic(item, output)
      writeRasterDiagnostic(item, output)
    }
  } finally {
    if (browser) await browser.close()
  }
  const sourceFailed = receipt.cases.some((item) => !item.ok)
  if (nativeFailed || sourceFailed || receipt.errors.length) return 1
  return 0
}

const parseArgs = (argv) => {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--base' || arg === '--output' || arg === '--case') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--'))
        throw new Error(`${arg} needs a value`)
      out[arg.slice(2)] = value
      i += 1
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }
  return out
}

const git = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', CANDIDATE, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `git ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString('utf8').trim()}`,
          ),
        )
        return
      }
      resolve(Buffer.concat(out).toString('utf8'))
    })
  })

const materializeBaseline = async (commit, dest) => {
  await mkdir(dest, { recursive: true })
  await new Promise((resolve, reject) => {
    const archive = spawn(
      'git',
      ['-C', CANDIDATE, 'archive', '--format=tar', commit],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const extract = spawn('tar', ['-x', '-C', dest], {
      stdio: ['pipe', 'inherit', 'pipe'],
    })
    const errors = []
    archive.stderr.on('data', (chunk) => errors.push(chunk))
    extract.stderr.on('data', (chunk) => errors.push(chunk))
    archive.stdout.pipe(extract.stdin)
    let archiveCode = null
    let extractCode = null
    const finish = () => {
      if (archiveCode === null || extractCode === null) return
      if (archiveCode !== 0 || extractCode !== 0) {
        reject(
          new Error(
            `git archive ${commit} failed (${archiveCode}/${extractCode}): ${Buffer.concat(errors).toString('utf8').trim()}`,
          ),
        )
        return
      }
      resolve()
    }
    archive.on('close', (code) => {
      archiveCode = code ?? 1
      if (archiveCode !== 0) extract.stdin.end()
      finish()
    })
    extract.on('close', (code) => {
      extractCode = code ?? 1
      finish()
    })
    archive.on('error', reject)
    extract.on('error', reject)
  })
  await access(path.join(dest, '.claude-plugin', 'plugin.json'))
}

const snapshotCandidate = async (dest, output) => {
  await cp(CANDIDATE, dest, {
    recursive: true,
    filter: (src) => !excludedFromSnapshot(src, output),
  })
  await access(path.join(dest, '.claude-plugin', 'plugin.json'))
}

const excludedFromSnapshot = (src, output) => {
  const rel = path.relative(CANDIDATE, src)
  if (!rel || rel.startsWith('..')) return false
  if (
    rel
      .split(path.sep)
      .some(
        (part) =>
          part === '.git' || part === 'node_modules' || part === '.artifacts',
      )
  )
    return true
  const outRel = path.relative(CANDIDATE, output)
  if (
    outRel &&
    !outRel.startsWith('..') &&
    (rel === outRel || rel.startsWith(`${outRel}${path.sep}`))
  )
    return true
  return false
}

const assertRootCopied = async (from, to, output) => {
  const live = await readdir(from)
  const snap = new Set(await readdir(to))
  const missing = live.filter(
    (name) =>
      !snap.has(name) && !excludedFromSnapshot(path.join(from, name), output),
  )
  if (missing.length)
    throw new Error(
      `candidate snapshot omitted root entries: ${missing.join(', ')}`,
    )
}

const installFixtures = async (baselineRoot, candidateRoot, root) => {
  const source = path.join(CANDIDATE, 'tests', 'fixtures')
  try {
    await access(path.join(source, 'views.tsx'))
  } catch {
    throw new Error(
      `missing ${FIXTURE} in the candidate (ViewContracts owns the fixture)`,
    )
  }
  const staged = path.join(root, 'fixtures')
  await cp(source, staged, { recursive: true })
  for (const isolated of [baselineRoot, candidateRoot]) {
    await rm(path.join(isolated, 'tests'), { recursive: true, force: true })
    await cp(staged, path.join(isolated, 'tests', 'fixtures'), {
      recursive: true,
    })
  }
  const hashed = await hashTree(staged)
  return {
    path: FIXTURE,
    sha256: hashed.sha256,
    files: hashed.files.length,
    bytes: hashed.bytes,
  }
}

const discoverManifest = async (baselineRoot, candidateRoot, output) => {
  const source = manifestWrapper()
  for (const isolated of [baselineRoot, candidateRoot]) {
    const file = path.join(isolated, 'tests', 'parity-manifest.test.tsx')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, source)
  }
  const left = await runNative('manifest-baseline', baselineRoot, output, 1)
  const right = await runNative('manifest-candidate', candidateRoot, output, 1)
  for (const isolated of [baselineRoot, candidateRoot]) {
    await rm(path.join(isolated, 'tests', 'parity-manifest.test.tsx'), {
      force: true,
    })
  }
  if (left.code !== 0 || right.code !== 0) {
    throw new Error(
      `manifest runner exited baseline ${left.code}, candidate ${right.code}\nbaseline\n${runnerReport(left)}\ncandidate\n${runnerReport(right)}`,
    )
  }
  const baseline = oneManifest(left, 'baseline')
  const candidate = oneManifest(right, 'candidate')
  if (stable(baseline) !== stable(candidate)) {
    await writeFile(
      path.join(output, 'manifest.baseline.json'),
      `${JSON.stringify(baseline, null, 2)}\n`,
    )
    await writeFile(
      path.join(output, 'manifest.candidate.json'),
      `${JSON.stringify(candidate, null, 2)}\n`,
    )
    throw new Error(
      'fixture manifest differs between isolated roots; see manifest.*.json',
    )
  }
  validateManifest(baseline)
  await writeFile(
    path.join(output, 'manifest.json'),
    `${JSON.stringify(baseline, null, 2)}\n`,
  )
  return baseline
}

const oneManifest = (run, side) => {
  const lines = markerLines(run, MARK_MANIFEST)
  if (lines.length !== 1)
    throw new Error(
      `${side} manifest markers: ${lines.length}, expected 1\n${runnerReport(run)}`,
    )
  let parsed
  try {
    parsed = JSON.parse(lines[0].slice(MARK_MANIFEST.length))
  } catch (error) {
    throw new Error(
      `${side} manifest JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(parsed))
    throw new Error(`${side} manifest is not an array`)
  return parsed
}

const validateManifest = (cases) => {
  const seen = new Set()
  for (const item of cases) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('manifest case is not an object')
    if (typeof item.id !== 'string' || item.id.length === 0)
      throw new Error('manifest case is missing id')
    if (seen.has(item.id)) throw new Error(`duplicate manifest id ${item.id}`)
    seen.add(item.id)
  }
}

const installWrappers = async (baselineRoot, candidateRoot, cases) => {
  const files = cases.map((item, index) => ({
    name: `${safeName(item.id, index)}.test.tsx`,
    source: caseWrapper(item.id),
  }))
  const body = files.map((file) => file.source).join('')
  for (const isolated of [baselineRoot, candidateRoot]) {
    const dir = path.join(isolated, 'tests', 'parity-cases')
    await mkdir(dir, { recursive: true })
    for (const file of files)
      await writeFile(path.join(dir, file.name), file.source)
  }
  return body
}

const manifestWrapper = () => `import { test } from 'claude-code/testing'
import { viewCases } from './fixtures/views'

test('view-parity manifest', { timeoutMs: ${TEST_TIMEOUT_MS} }, () => {
  console.log(${JSON.stringify(MARK_MANIFEST)} + JSON.stringify(viewCases))
})
`

const caseWrapper = (id) => `import { test } from 'claude-code/testing'
import { captureView, viewCases } from '../fixtures/views'

const id = ${JSON.stringify(id)}
const scenario = viewCases.find((item) => item && item.id === id)
if (!scenario) throw new Error('view-parity wrapper missing scenario ' + id)

test(id, { timeoutMs: ${TEST_TIMEOUT_MS} }, async ($, on) => {
  const captured = await captureView($, on, scenario)
  console.log(${JSON.stringify(MARK_CASE)} + JSON.stringify(captured))
})
`

const runNative = async (name, dir, output, expectedTests) => {
  const stdoutPath = path.join(output, 'native', `${name}.stdout.log`)
  const stderrPath = path.join(output, 'native', `${name}.stderr.log`)
  await mkdir(path.dirname(stdoutPath), { recursive: true })
  const run = await runProcess(process.execPath, [CLI, 'plugin', 'test', dir], {
    cwd: dir,
    stdoutPath,
    stderrPath,
    timeoutMs: (expectedTests + 1) * (TEST_TIMEOUT_MS + 5_000),
  })
  run.name = name
  run.stdoutPath = stdoutPath
  run.stderrPath = stderrPath
  if (run.timedOut)
    throw new Error(
      `${name} native runner timed out; logs: ${shown(stdoutPath)}`,
    )
  const ran = /Ran (\d+) tests/.exec(run.stdout)
  if (ran && Number(ran[1]) !== expectedTests) {
    throw new Error(
      `${name} ran ${ran[1]} tests, expected ${expectedTests}; log: ${shown(stdoutPath)}`,
    )
  }
  return run
}

const runnerReport = (run) => {
  const text = run.stdout ?? ''
  const body =
    text.length > 8000
      ? `${text.slice(0, 8000)}\n… excerpt, full stdout ${path.basename(run.stdoutPath ?? 'stdout')} (${text.length} chars)`
      : text.trim()
  return `${body}\nstdout: ${path.basename(run.stdoutPath ?? 'stdout')}`
}
const operational = (text) =>
  String(text).split(homedir()).join('~').split(CANDIDATE).join('.')
const shown = (file) => {
  const rel = path.relative(CANDIDATE, path.resolve(file))
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  return operational(path.resolve(file))
}

const claimOutput = async (output) => {
  assertOutputAllowed(output)
  let info
  try {
    info = await lstat(output)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await mkdir(output, { recursive: true })
    await writeFile(path.join(output, OWNER_FILE), OWNER_TEXT)
    return
  }
  if (info.isSymbolicLink())
    throw new Error(`refusing --output ${output}: symlink, left untouched`)
  if (!info.isDirectory())
    throw new Error(
      `refusing --output ${output}: not a directory, left untouched`,
    )
  const names = await readdir(output)
  let owned = false
  try {
    owned =
      (await readFile(path.join(output, OWNER_FILE), 'utf8')) === OWNER_TEXT
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const foreign = names.filter((name) => name !== OWNER_FILE)
  if (!owned && foreign.length > 0) {
    throw new Error(
      `refusing --output ${output}: existing non-empty directory has no ${OWNER_FILE} marker; left untouched`,
    )
  }
  if (owned) {
    await rm(output, { recursive: true, force: true })
    await mkdir(output, { recursive: true })
  }
  await writeFile(path.join(output, OWNER_FILE), OWNER_TEXT)
}

const assertOutputAllowed = (output) => {
  const resolved = path.resolve(output)
  const candidate = path.resolve(CANDIDATE)
  if (resolved === candidate)
    throw new Error(`refusing --output ${resolved}: it is the project root`)
  const up = path.relative(resolved, candidate)
  if (up !== '' && !up.startsWith('..') && !path.isAbsolute(up)) {
    throw new Error(
      `refusing --output ${resolved}: it is an ancestor of the project`,
    )
  }
  const rel = path.relative(candidate, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
  if (rel === '.artifacts')
    throw new Error(
      `refusing --output ${resolved}: refusing the shared .artifacts directory`,
    )
  if (!rel.startsWith(`.artifacts${path.sep}`))
    throw new Error(
      `refusing --output ${resolved}: it is inside project source`,
    )
}

const capturesOf = (run, manifest, side) => {
  const lines = markerLines(run, MARK_CASE)
  const found = new Map()
  for (const line of lines) {
    let parsed
    try {
      parsed = JSON.parse(line.slice(MARK_CASE.length))
    } catch (error) {
      throw new Error(
        `${side} ${MARK_CASE} is malformed (${line.length} chars): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const problem = captureProblem(parsed)
    if (problem) throw new Error(`${side} capture ${parsed?.id}: ${problem}`)
    if (found.has(parsed.id))
      throw new Error(`${side} duplicate capture ${parsed.id}`)
    found.set(parsed.id, parsed)
  }
  const missing = manifest
    .filter((item) => !found.has(item.id))
    .map((item) => item.id)
  const extra = [...found.keys()].filter(
    (id) => !manifest.some((item) => item.id === id),
  )
  if (missing.length || extra.length) {
    throw new Error(
      `${side} capture ids missing [${missing.join(', ')}] extra [${extra.join(', ')}]\n${runnerReport(run)}`,
    )
  }
  return found
}

const captureProblem = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'not an object'
  if (typeof value.id !== 'string' || value.id.length === 0) return 'missing id'
  if (
    !value.tree ||
    typeof value.tree !== 'object' ||
    typeof value.tree.type !== 'string'
  )
    return 'tree is not a drawn element'
  if (!Array.isArray(value.svgs)) return 'svgs is not an array'
  if (!Array.isArray(value.artifacts)) return 'artifacts is not an array'
  for (const [index, svg] of value.svgs.entries()) {
    if (!svg || typeof svg.alt !== 'string' || typeof svg.source !== 'string')
      return `svg ${index} needs alt and source strings`
    if (!svg.source.trim().startsWith('<svg'))
      return `svg ${index} source is not an SVG document`
  }
  for (const [index, artifact] of value.artifacts.entries()) {
    if (
      !artifact ||
      typeof artifact.name !== 'string' ||
      typeof artifact.text !== 'string'
    )
      return `artifact ${index} needs name and text strings`
  }
  return null
}

const compareCase = async (
  scenario,
  index,
  baseline,
  candidate,
  baselineRoot,
  candidateRoot,
  output,
  browser,
) => {
  const id = scenario.id
  const dir = path.join(output, 'cases', safeName(id, index))
  await mkdir(dir, { recursive: true })
  const item = {
    id,
    scenario: scenarioOf(scenario),
    ok: false,
    errors: [],
    tree: null,
    svgs: [],
    svgCount: 0,
    browser: null,
  }
  const differences = new Set()
  const difference = (message) => {
    differences.add(item.errors.length)
    item.errors.push(message)
  }
  if (!baseline || !candidate) {
    item.errors.push('missing native capture')
    return { item, differences }
  }
  await writeFile(
    path.join(dir, 'tree.baseline.json'),
    `${JSON.stringify(baseline.tree, null, 2)}\n`,
  )
  await writeFile(
    path.join(dir, 'tree.candidate.json'),
    `${JSON.stringify(candidate.tree, null, 2)}\n`,
  )
  const leftSlots = slotSvgs(baseline.tree)
  const rightSlots = slotSvgs(candidate.tree)
  const identity = identityErrors(baseline, leftSlots, candidate, rightSlots)
  if (NATIVE_LAYOUT_CASES.has(id)) {
    try {
      item.nativeMapLayout = await probeNativeMapLayout(browser, candidate.tree)
    } catch (error) {
      item.errors.push(
        `candidate native map layout: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  item.errors.push(...identity)
  const normalized = normalizeModules(
    leftSlots.tree,
    rightSlots.tree,
    baselineRoot,
    candidateRoot,
  )
  await writeFile(
    path.join(dir, 'tree.normalized.baseline.json'),
    `${JSON.stringify(normalized.left, null, 2)}\n`,
  )
  await writeFile(
    path.join(dir, 'tree.normalized.candidate.json'),
    `${JSON.stringify(normalized.right, null, 2)}\n`,
  )
  const diff = diffValues(normalized.left, normalized.right, '')
  await writeFile(
    path.join(dir, 'tree.diff.json'),
    `${JSON.stringify({ differences: diff.differences, nonvisual: diff.nonvisual, modules: normalized.rewritten }, null, 2)}\n`,
  )
  item.tree = {
    equal: diff.differences.length === 0,
    differences: diff.differences.length,
    differencePaths: diff.differences.map((entry) => entry.path),
    nonvisual: diff.nonvisual,
    modules: normalized.rewritten,
    diff: path.relative(output, path.join(dir, 'tree.diff.json')),
  }
  if (!item.tree.equal)
    difference(`tree body differs at ${diff.differences.length} path(s)`)

  item.svgCount = Math.max(leftSlots.slots.length, rightSlots.slots.length)
  if (item.svgCount) {
    const theme = themeBackground(scenario)
    if (theme.error) item.errors.push(theme.error)
    for (let svgIndex = 0; svgIndex < item.svgCount; svgIndex += 1) {
      const { item: svgItem, viewportDifference } = await compareSvg(
        dir,
        svgIndex,
        leftSlots.slots[svgIndex],
        rightSlots.slots[svgIndex],
        baseline.svgs[svgIndex],
        candidate.svgs[svgIndex],
        theme.background,
        browser,
        output,
      )
      item.svgs.push(svgItem)
      if (svgItem.source && !svgItem.source.equal)
        difference(`svg ${svgIndex} source bytes differ`)
      if (svgItem.error) {
        const message = `svg ${svgIndex} ${svgItem.error}`
        if (viewportDifference) difference(message)
        else item.errors.push(message)
      }
    }
  }
  const leftBrowser = browserPair(baseline)
  const rightBrowser = browserPair(candidate)
  if (leftBrowser.error)
    item.errors.push(`baseline browser artifacts: ${leftBrowser.error}`)
  if (rightBrowser.error)
    item.errors.push(`candidate browser artifacts: ${rightBrowser.error}`)
  if (
    scenario.browser3d === true &&
    (!leftBrowser.files || !rightBrowser.files)
  ) {
    item.errors.push(
      'browser3d case did not produce index.html and data.js on both sides',
    )
  }
  if (leftBrowser.files || rightBrowser.files) {
    item.browser = await compareBrowser(
      dir,
      leftBrowser.files,
      rightBrowser.files,
      browser,
      output,
    )
    if (item.browser.html && !item.browser.html.equal)
      difference('browser index.html bytes differ')
    if (item.browser.data && !item.browser.data.equal)
      difference('browser data.js bytes differ')
    if (item.browser.error)
      item.errors.push(`browser scene ${item.browser.error}`)
  }
  return { item, differences }
}

const slotSvgs = (tree) => {
  const copy = JSON.parse(JSON.stringify(tree))
  const slots = []
  walkElements(copy, (node) => {
    if (
      node.type !== 'Svg' ||
      !node.props ||
      typeof node.props.source !== 'string'
    )
      return
    const index = slots.length
    slots.push({
      index,
      source: node.props.source,
      alt: node.props.alt,
      width: node.props.width,
      height: node.props.height,
    })
    node.props.source = `⟦svg:${index}⟧`
  })
  return { tree: copy, slots }
}

const identityErrors = (baseline, leftSlots, candidate, rightSlots) => {
  const errors = []
  errors.push(...sideIdentity('baseline', baseline, leftSlots))
  errors.push(...sideIdentity('candidate', candidate, rightSlots))
  return errors
}

const sideIdentity = (side, captured, slotted) => {
  if (slotted.slots.length !== captured.svgs.length) {
    return [
      `${side} drew ${slotted.slots.length} Svg nodes but harvested ${captured.svgs.length}`,
    ]
  }
  const errors = []
  for (let index = 0; index < slotted.slots.length; index += 1) {
    const slot = slotted.slots[index]
    const harvested = captured.svgs[index]
    if (slot.source !== harvested.source)
      errors.push(
        `${side} svg ${index} source is not the drawn Svg props.source`,
      )
    if (slot.alt !== harvested.alt)
      errors.push(`${side} svg ${index} alt is not the drawn Svg props.alt`)
  }
  return errors
}

const normalizeModules = (left, right, leftRoot, rightRoot) => {
  const rewritten = []
  const visit = (a, b, pointer) => {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return
    if (Array.isArray(a) || Array.isArray(b)) {
      if (Array.isArray(a) && Array.isArray(b)) {
        const count = Math.min(a.length, b.length)
        for (let index = 0; index < count; index += 1)
          visit(a[index], b[index], `${pointer}/${index}`)
      }
      return
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      const next = `${pointer}/${key}`
      if (
        key === 'module' &&
        typeof a[key] === 'string' &&
        typeof b[key] === 'string'
      ) {
        const relA = moduleRelative(a[key], leftRoot)
        const relB = moduleRelative(b[key], rightRoot)
        if (relA && relA === relB) {
          rewritten.push({ path: next, relative: relA })
          a[key] = relA
          b[key] = relB
          continue
        }
      }
      visit(a[key], b[key], next)
    }
  }
  visit(left, right, '')
  return { left, right, rewritten }
}

const moduleRelative = (value, root) => {
  if (value.startsWith('./') || value.startsWith('../')) return null
  const abs = path.isAbsolute(value) ? path.normalize(value) : null
  if (!abs) return null
  const base = path.normalize(root)
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) return null
  const rel = path.relative(base, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

const diffValues = (left, right, pointer) => {
  const differences = []
  const nonvisual = []
  const walk = (a, b, at) => {
    if (
      at.endsWith('/press/handle') &&
      typeof a === 'number' &&
      typeof b === 'number' &&
      a !== b
    ) {
      nonvisual.push({
        path: at,
        field: 'press.handle',
        baseline: a,
        candidate: b,
      })
      return
    }
    if (Object.is(a, b)) return
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) {
          differences.push({ path: at, baseline: a, candidate: b })
          return
        }
        if (a.length !== b.length)
          differences.push({
            path: `${at}/length`,
            baseline: a.length,
            candidate: b.length,
          })
        const count = Math.max(a.length, b.length)
        for (let index = 0; index < count; index += 1)
          walk(a[index], b[index], `${at}/${index}`)
        return
      }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      for (const key of keys) {
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) {
          differences.push({
            path: `${at}/${key}`,
            baseline: Object.hasOwn(a, key) ? a[key] : undefined,
            candidate: Object.hasOwn(b, key) ? b[key] : undefined,
          })
          continue
        }
        walk(a[key], b[key], `${at}/${key}`)
      }
      return
    }
    differences.push({ path: at || '/', baseline: a, candidate: b })
  }
  walk(left, right, pointer)
  return { differences, nonvisual }
}

const compareSvg = async (
  dir,
  index,
  leftSlot,
  rightSlot,
  leftHarvest,
  rightHarvest,
  background,
  browser,
  output,
) => {
  const svgDir = path.join(dir, 'svg', String(index))
  await mkdir(svgDir, { recursive: true })
  const item = {
    index,
    alt: leftHarvest?.alt ?? rightHarvest?.alt ?? null,
    source: null,
    raster: null,
    error: null,
  }
  let viewportDifference = false
  if (!leftSlot || !rightSlot || !leftHarvest || !rightHarvest) {
    item.error = 'missing svg on one side'
    return { item, viewportDifference }
  }
  item.source = byteProof(leftHarvest.source, rightHarvest.source)
  await writeFile(path.join(svgDir, 'baseline.svg'), leftHarvest.source)
  await writeFile(path.join(svgDir, 'candidate.svg'), rightHarvest.source)
  if (!background) {
    item.error = 'no theme background'
    return { item, viewportDifference }
  }
  const leftSize = svgSize(leftSlot, leftHarvest.source)
  const rightSize = svgSize(rightSlot, rightHarvest.source)
  item.viewport = { baseline: leftSize, candidate: rightSize }
  if (
    leftSize.width !== rightSize.width ||
    leftSize.height !== rightSize.height ||
    leftSize.fallback !== rightSize.fallback
  ) {
    item.error = `svg viewport differs ${JSON.stringify(leftSize)} vs ${JSON.stringify(rightSize)}`
    viewportDifference = true
  }
  if (!browser) {
    item.error = item.error ?? 'playwright unavailable for SVG raster'
    viewportDifference = false
    return { item, viewportDifference }
  }
  try {
    const leftShot = await rasterSvg(
      browser,
      leftHarvest.source,
      background,
      leftSize,
    )
    const rightShot = await rasterSvg(
      browser,
      rightHarvest.source,
      background,
      rightSize,
    )
    item.freeze = { baseline: leftShot.freeze, candidate: rightShot.freeze }
    await writeFile(path.join(svgDir, 'baseline.png'), leftShot.png)
    await writeFile(path.join(svgDir, 'candidate.png'), rightShot.png)
    const pixels = await comparePng(
      browser,
      leftShot.png,
      rightShot.png,
      svgDir,
    )
    recordRaster(item, pixels, output)
  } catch (error) {
    viewportDifference = false
    item.error = error instanceof Error ? error.message : String(error)
  }
  return { item, viewportDifference }
}

const svgSize = (slot, source) => {
  const width = positive(slot.width)
  const height = positive(slot.height)
  if (width && height)
    return {
      width: Math.ceil(width),
      height: Math.ceil(height),
      fallback: false,
      from: 'props',
    }
  const markup = markupSize(source)
  if (markup) return { ...markup, fallback: false, from: 'markup' }
  return { ...SVG_FALLBACK, fallback: true, from: 'fallback' }
}

const markupSize = (source) => {
  const tag = /^<svg\b[^>]*>/i.exec(source.trim())
  if (!tag) return null
  const width = attrNumber(tag[0], 'width')
  const height = attrNumber(tag[0], 'height')
  if (width && height)
    return { width: Math.ceil(width), height: Math.ceil(height) }
  const box = /viewBox\s*=\s*"([^"]+)"/i.exec(tag[0])
  if (!box) return null
  const parts = box[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)))
    return null
  if (parts[2] <= 0 || parts[3] <= 0) return null
  return { width: Math.ceil(parts[2]), height: Math.ceil(parts[3]) }
}

const attrNumber = (tag, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([\\d.]+)"`, 'i').exec(tag)
  if (!match) return null
  const value = Number(match[1])
  return value > 0 ? value : null
}

const defer = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const clockGate = () => {
  const hit = defer()
  const release = defer()
  release.promise.catch(() => {})
  let seen = false
  return {
    get seen() {
      return seen
    },
    arm(url, expected) {
      if (seen || url !== expected) return false
      seen = true
      hit.resolve()
      return true
    },
    hit: hit.promise,
    wait: release.promise,
    release() {
      release.resolve()
    },
    fail(error) {
      release.reject(error)
    },
  }
}

const pinClockOrigin = async (page, gate, loaded, label) => {
  let loadError
  const which = await Promise.race([
    gate.hit.then(() => 'gate'),
    loaded.then(
      () => 'loaded',
      (error) => {
        loadError = error
        return 'failed'
      },
    ),
  ])
  if (which === 'failed') throw loadError
  if (which !== 'gate')
    throw new Error(
      `${label} clock gate was not encountered before the document loaded`,
    )
  const now = await page.evaluate(() => performance.now())
  if (!Number.isFinite(now) || now < 0 || now > BOOT_TICK)
    throw new Error(
      `clock boot tick ${now} is outside 0..${BOOT_TICK}; cannot rewind past the origin`,
    )
  await page.clock.runFor(BOOT_TICK - now)
  await page.clock.setSystemTime(new Date(FIXED_TIME))
  const boot = await page.evaluate(() => ({
    now: performance.now(),
    date: Date.now(),
  }))
  if (boot.now !== BOOT_TICK)
    throw new Error(
      `clock boot tick ${boot.now} after runFor, expected ${BOOT_TICK}`,
    )
  if (boot.date !== Date.parse(FIXED_TIME))
    throw new Error(
      `clock boot date ${boot.date}, expected ${Date.parse(FIXED_TIME)}`,
    )
  gate.release()
  await loaded
  if (!gate.seen) throw new Error(`${label} clock gate was not encountered`)
  return boot
}

const rasterSvg = async (browser, source, background, size) => {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('requestfailed', (request) =>
    errors.push(
      `request failed ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ),
  )
  await page.route('**/*', (route) => allowSvgRequest(route, errors))
  try {
    await page.setContent(svgFrame(source, background), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    const frozen = await commitSvg(page)
    if (/@keyframes\b/.test(source) && frozen.count === 0)
      throw new Error(
        'CSS animation declared but document.getAnimations returned none',
      )
    if (errors.length) throw new Error(errors.join('; '))
    const second = await commitSvg(page)
    // Wait for native paint completion after the final animation seek.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const activeAnimations = await page.evaluate(
      () => document.getAnimations({ subtree: true }).length,
    )
    if (activeAnimations !== 0)
      throw new Error(
        `SVG has ${activeAnimations} active animations after materialization`,
      )
    const freeze = {
      materialized: frozen,
      secondPass: second,
      activeAnimations,
      cssPhaseMs: SVG_CSS_MS,
      proof: 'single frame, not motion parity',
    }
    return {
      png: await page.screenshot({
        type: 'png',
        caret: 'hide',
        scale: 'css',
        animations: 'allow',
      }),
      freeze,
    }
  } finally {
    await context.close()
  }
}
const commitSvg = async (page) => {
  await page.evaluate(() => {
    const svg = document.querySelector('svg')
    if (!svg) throw new Error('production SVG missing from frame')
    if (typeof document.getAnimations !== 'function')
      throw new Error('document.getAnimations is missing')
    for (const animation of document.getAnimations({ subtree: true })) {
      if (animation.currentTime == null) animation.currentTime = 0
      animation.pause()
    }
    if (typeof svg.pauseAnimations === 'function') svg.pauseAnimations()
  })
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  )
  return page.evaluate(async (ms) => {
    const svg = document.querySelector('svg')
    if (!svg) throw new Error('production SVG missing from frame')
    const animations = document.getAnimations({ subtree: true })
    await Promise.all(animations.map((animation) => animation.ready))
    const times = []
    for (const animation of animations) {
      if (animation.playState !== 'paused')
        throw new Error(
          `CSS animation ready but playState is ${animation.playState}`,
        )
      animation.currentTime = ms
      if (Number(animation.currentTime) !== ms)
        throw new Error('CSS animation currentTime did not stick')
      const target = animation.effect?.target
      if (target) getComputedStyle(target).transform
      times.push(Number(animation.currentTime))
      animation.commitStyles()
      animation.cancel()
    }
    if (typeof svg.setCurrentTime === 'function') svg.setCurrentTime(ms / 1000)
    svg.getBoundingClientRect()
    return {
      count: animations.length,
      stateBeforeMaterialization: animations.length ? 'paused' : null,
      currentTime: times.length
        ? { min: Math.min(...times), max: Math.max(...times) }
        : null,
      smil: {
        paused:
          typeof svg.animationsPaused === 'function'
            ? svg.animationsPaused()
            : null,
        time:
          typeof svg.getCurrentTime === 'function'
            ? svg.getCurrentTime()
            : null,
      },
    }
  }, SVG_CSS_MS)
}

const svgFrame = (
  source,
  background,
) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:${background};overflow:hidden}
svg{display:block}
</style></head><body>${source}<script>
const svg = document.querySelector('svg')
if (svg && typeof svg.pauseAnimations === 'function') svg.pauseAnimations()
if (svg && typeof svg.setCurrentTime === 'function') svg.setCurrentTime(${SVG_SMIL_SECONDS})
</script></body></html>`

const allowSvgRequest = async (route, errors) => {
  const url = route.request().url()
  if (
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('about:')
  ) {
    await route.continue()
    return
  }
  errors.push(`disallowed SVG request ${url}`)
  await route.abort()
}

const browserPair = (captured) => {
  if (!captured.artifacts.length) return { files: null, error: null }
  const files = {}
  const extras = []
  for (const artifact of captured.artifacts) {
    const base = path.posix.basename(artifact.name.replaceAll('\\', '/'))
    if (base !== 'index.html' && base !== 'data.js') {
      extras.push(artifact.name)
      continue
    }
    if (files[base]) return { files: null, error: `duplicate ${base}` }
    files[base] = artifact.text
  }
  if (extras.length)
    return { files: null, error: `unexpected artifact ${extras.join(', ')}` }
  if (
    typeof files['index.html'] !== 'string' ||
    typeof files['data.js'] !== 'string'
  ) {
    return {
      files: null,
      error: 'browser capture needs index.html and data.js',
    }
  }
  const pageError = productionPageProblem(files['index.html'], files['data.js'])
  if (pageError) return { files: null, error: pageError }
  return { files, error: null }
}

const productionPageProblem = (html, data) => {
  if (
    !html.includes('id="follow"') ||
    !html.includes('id="overview"') ||
    !html.includes('id="stat"') ||
    !html.includes('id="live"')
  ) {
    return 'index.html is not the production HUD page'
  }
  if (!html.includes(THREE_PREFIX))
    return 'index.html does not load Three 0.160.0 from jsDelivr'
  if (!html.includes('<script type="module">'))
    return 'index.html has no production module script'
  if (!data.startsWith('window.BT_DATA='))
    return 'data.js is not the production session payload'
  return null
}

const compareBrowser = async (dir, left, right, browser, output) => {
  const sceneDir = path.join(dir, 'browser')
  await mkdir(sceneDir, { recursive: true })
  const item = {
    html: null,
    data: null,
    raster: null,
    error: null,
    actions: [
      'overview',
      'follow',
      'ArrowRight:down',
      'runFor:500',
      'ArrowRight:up',
    ],
    network: 'jsDelivr three@0.160.0 and Google Fonts; not offline',
  }
  if (!left || !right) {
    item.error = 'missing production page on one side'
    return item
  }
  await writeFile(
    path.join(sceneDir, 'baseline.index.html'),
    left['index.html'],
  )
  await writeFile(path.join(sceneDir, 'baseline.data.js'), left['data.js'])
  await writeFile(
    path.join(sceneDir, 'candidate.index.html'),
    right['index.html'],
  )
  await writeFile(path.join(sceneDir, 'candidate.data.js'), right['data.js'])
  item.html = byteProof(left['index.html'], right['index.html'])
  item.data = byteProof(left['data.js'], right['data.js'])
  if (!browser) {
    item.error = 'playwright unavailable for browser scene'
    return item
  }
  try {
    const leftShot = await rasterScene(browser, sceneDir, 'baseline', left)
    const rightShot = await rasterScene(browser, sceneDir, 'candidate', right)
    item.probe = { baseline: leftShot.probe, candidate: rightShot.probe }
    await writeFile(path.join(sceneDir, 'baseline.png'), leftShot.png)
    await writeFile(path.join(sceneDir, 'candidate.png'), rightShot.png)
    const pixels = await comparePng(
      browser,
      leftShot.png,
      rightShot.png,
      sceneDir,
    )
    recordRaster(item, pixels, output)
  } catch (error) {
    item.error = error instanceof Error ? error.message : String(error)
  }
  return item
}

const rasterScene = async (browser, dir, side, files) => {
  const pageDir = path.join(dir, side)
  await mkdir(pageDir, { recursive: true })
  await writeFile(path.join(pageDir, 'index.html'), files['index.html'])
  await writeFile(path.join(pageDir, 'data.js'), files['data.js'])
  const context = await browser.newContext({
    viewport: SCENE_VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('requestfailed', (request) =>
    errors.push(
      `request failed ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ),
  )
  const gate = clockGate()
  await page.route('**/*', async (route) => {
    if (gate.arm(route.request().url(), THREE_MODULE)) {
      try {
        await gate.wait
      } catch {
        await route.abort()
        return
      }
    }
    await allowSceneRequest(route, errors)
  })
  let boot
  try {
    await page.clock.install({
      time: new Date(Date.parse(FIXED_TIME) - INSTALL_LEAD_MS),
    })
    await page.clock.pauseAt(new Date(FIXED_TIME))
    const loaded = page.goto(
      pathToFileURL(path.join(pageDir, 'index.html')).href,
      {
        waitUntil: 'load',
        timeout: 60_000,
      },
    )
    try {
      boot = await pinClockOrigin(page, gate, loaded, 'three.module.js')
    } catch (error) {
      gate.fail(error)
      throw error
    }
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('canvas')
        const follow = document.getElementById('follow')
        const overview = document.getElementById('overview')
        const stat = document.getElementById('stat')
        const help = document.getElementById('help')
        return Boolean(
          canvas &&
            canvas.width > 0 &&
            canvas.height > 0 &&
            follow &&
            follow.textContent &&
            overview &&
            overview.textContent &&
            stat &&
            stat.textContent &&
            help &&
            help.textContent &&
            window.BT_DATA &&
            window.BT,
        )
      },
      null,
      { timeout: 60_000 },
    )
    await page.evaluate(() => document.fonts.ready)
    const fontErrors = await page.evaluate(() =>
      [...document.fonts]
        .filter((font) => font.status === 'error')
        .map((font) => font.family),
    )
    if (fontErrors.length) errors.push(`font error: ${fontErrors.join(', ')}`)
    await page.clock.runFor(SCENE_RUN_FOR_MS)
    await assertSceneLive(page, errors)
    await page.locator('#overview').click()
    await page.clock.runFor(SCENE_TWEEN_MS)
    await page.locator('#follow').click()
    await page.clock.runFor(SCENE_TWEEN_MS)
    await page.keyboard.down('ArrowRight')
    await page.clock.runFor(SCENE_NAV_MS)
    await page.keyboard.up('ArrowRight')
    await assertSceneLive(page, errors)
    if (errors.length) throw new Error(errors.join('; '))
    const probe = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')
      return {
        now: performance.now(),
        date: Date.now(),
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        dpr: window.devicePixelRatio,
      }
    })
    probe.boot = boot
    if (probe.now !== SCENE_FINAL_NOW)
      throw new Error(
        `scene performance.now() ${probe.now}, expected ${SCENE_FINAL_NOW}`,
      )
    return {
      png: await page.screenshot({
        type: 'png',
        caret: 'hide',
        scale: 'css',
        animations: 'allow',
      }),
      probe,
    }
  } finally {
    await context.close()
  }
}

const assertSceneLive = async (page, errors) => {
  const live = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl =
      canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    const liveEl = document.getElementById('live')
    return {
      canvas: Boolean(canvas && canvas.width > 0 && canvas.height > 0),
      webgl: Boolean(gl && !gl.isContextLost()),
      renderer: gl ? gl.getParameter(gl.RENDERER) : null,
      liveClass: liveEl ? liveEl.className : '',
      liveText: liveEl ? liveEl.textContent : '',
      href: location.href,
    }
  })
  if (!live.canvas) errors.push('canvas missing after the production page ran')
  if (!live.webgl) errors.push('WebGL context missing or lost')
  if (!String(live.liveClass).includes('ok'))
    errors.push(`HUD live indicator is not initialized (${live.liveText})`)
  if (!String(live.href).startsWith('file:'))
    errors.push(`page left the production file (${live.href})`)
}

const allowSceneRequest = async (route, errors) => {
  const url = route.request().url()
  const allowed =
    url.startsWith('file:') ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith(THREE_PREFIX) ||
    url.startsWith('https://fonts.googleapis.com/') ||
    url.startsWith('https://fonts.gstatic.com/')
  if (!allowed) {
    errors.push(`disallowed request ${url}`)
    await route.abort()
    return
  }
  await route.continue()
}

const comparePng = async (browser, left, right, dir) => {
  const leftSize = pngSize(left)
  const rightSize = pngSize(right)
  if (!leftSize || !rightSize) throw new Error('screenshot is not a PNG')
  if (Buffer.compare(left, right) === 0) {
    return {
      equal: true,
      changedPixels: 0,
      encodingIdentical: true,
      width: leftSize.width,
      height: leftSize.height,
      diff: null,
    }
  }
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  try {
    const decoded = await page.evaluate(
      async ({ a, b }) => {
        const pixels = async (url) => {
          const image = new Image()
          image.src = url
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(image, 0, 0)
          return {
            width: canvas.width,
            height: canvas.height,
            data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
          }
        }
        const leftPixels = await pixels(a)
        const rightPixels = await pixels(b)
        if (
          leftPixels.width !== rightPixels.width ||
          leftPixels.height !== rightPixels.height
        ) {
          return {
            equal: false,
            reason: 'dimensions',
            changedPixels: null,
            left: { width: leftPixels.width, height: leftPixels.height },
            right: { width: rightPixels.width, height: rightPixels.height },
          }
        }
        let changed = 0
        const diff = document.createElement('canvas')
        diff.width = leftPixels.width
        diff.height = leftPixels.height
        const ctx = diff.getContext('2d')
        const image = ctx.createImageData(diff.width, diff.height)
        for (let i = 0; i < leftPixels.data.length; i += 4) {
          const same =
            leftPixels.data[i] === rightPixels.data[i] &&
            leftPixels.data[i + 1] === rightPixels.data[i + 1] &&
            leftPixels.data[i + 2] === rightPixels.data[i + 2] &&
            leftPixels.data[i + 3] === rightPixels.data[i + 3]
          if (!same) {
            changed += 1
            image.data[i] = 255
            image.data[i + 1] = 0
            image.data[i + 2] = 0
            image.data[i + 3] = 255
          } else {
            const gray = Math.round(
              leftPixels.data[i] * 0.2126 +
                leftPixels.data[i + 1] * 0.7152 +
                leftPixels.data[i + 2] * 0.0722,
            )
            image.data[i] = gray
            image.data[i + 1] = gray
            image.data[i + 2] = gray
            image.data[i + 3] = leftPixels.data[i + 3]
          }
        }
        ctx.putImageData(image, 0, 0)
        return {
          equal: changed === 0,
          changedPixels: changed,
          width: leftPixels.width,
          height: leftPixels.height,
          diff: diff.toDataURL('image/png'),
        }
      },
      {
        a: `data:image/png;base64,${left.toString('base64')}`,
        b: `data:image/png;base64,${right.toString('base64')}`,
      },
    )
    if (decoded.reason === 'dimensions') {
      return {
        equal: false,
        changedPixels: null,
        encodingIdentical: false,
        reason: `PNG dimensions ${decoded.left.width}x${decoded.left.height} vs ${decoded.right.width}x${decoded.right.height}`,
        width: leftSize.width,
        height: leftSize.height,
        diff: null,
      }
    }
    let diff = null
    if (!decoded.equal) {
      const raw = decoded.diff.replace(/^data:image\/png;base64,/, '')
      diff = path.join(dir, 'diff.png')
      await writeFile(diff, Buffer.from(raw, 'base64'))
    }
    return {
      equal: decoded.equal === true && decoded.changedPixels === 0,
      changedPixels: decoded.changedPixels,
      encodingIdentical: false,
      width: decoded.width,
      height: decoded.height,
      diff,
      reason: decoded.equal ? null : `${decoded.changedPixels} changed pixels`,
    }
  } finally {
    await context.close()
  }
}

const launchBrowser = async (receipt) => {
  const require = createRequire(path.join(CANDIDATE, 'package.json'))
  let playwright
  try {
    playwright = require('playwright')
  } catch (error) {
    throw new Error(
      `playwright is not installed (QualityFinish pins it): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  })
  receipt.versions.browser = browser.version()
  receipt.versions.playwrightPackage = null
  try {
    receipt.versions.playwrightPackage =
      require('playwright/package.json').version
  } catch {
    receipt.versions.playwrightPackage = null
  }
  return browser
}

const writeCaseDiagnostic = (item, output) => {
  const lines = [`case ${item.id}`]
  for (const error of item.errors) lines.push(`  ${error}`)
  if (item.tree && !item.tree.equal) {
    lines.push(
      `  tree paths: ${item.tree.differencePaths.slice(0, 8).join(', ')}${item.tree.differencePaths.length > 8 ? ` … ${item.tree.differencePaths.length} total` : ''}`,
    )
    lines.push(`  full tree diff: ${shown(path.join(output, item.tree.diff))}`)
  }
  if (item.tree?.nonvisual.length) {
    lines.push(
      `  nonvisual press.handle: ${item.tree.nonvisual.map((entry) => `${entry.path} ${entry.baseline}->${entry.candidate}`).join(', ')}`,
    )
  }
  for (const svg of item.svgs) {
    if (svg.source && !svg.source.equal)
      lines.push(`  svg ${svg.index}: source bytes differ`)
    if (svg.error) lines.push(`  svg ${svg.index}: ${svg.error}`)
  }
  if (item.browser?.html && !item.browser.html.equal)
    lines.push('  browser index.html bytes differ')
  if (item.browser?.data && !item.browser.data.equal)
    lines.push('  browser data.js bytes differ')
  if (item.browser?.error) lines.push(`  browser: ${item.browser.error}`)
  process.stderr.write(`${lines.join('\n')}\n`)
}
const rasterDiagnosticCount = (item) => {
  let count = 0
  for (const svg of item.svgs ?? []) if (svg.raster?.diagnostic) count += 1
  if (item.browser?.raster?.diagnostic) count += 1
  return count
}

const writeRasterDiagnostic = (item, output) => {
  const lines = []
  for (const svg of item.svgs ?? []) {
    if (!svg.raster?.diagnostic) continue
    const diff = svg.raster.diff
      ? ` ${shown(path.join(output, svg.raster.diff))}`
      : ''
    lines.push(
      `  svg ${svg.index} raster diagnostic: ${svg.raster.changedPixels} changed pixels${diff}`,
    )
  }
  if (item.browser?.raster?.diagnostic) {
    const diff = item.browser.raster.diff
      ? ` ${shown(path.join(output, item.browser.raster.diff))}`
      : ''
    lines.push(
      `  browser raster diagnostic: ${item.browser.raster.changedPixels} changed pixels${diff}`,
    )
  }
  if (lines.length)
    process.stderr.write(
      `case ${item.id} raster diagnostic\n${lines.join('\n')}\n`,
    )
}

const byteProof = (baseline, candidate) => ({
  equal: baseline === candidate,
  sha256: { baseline: sha256(baseline), candidate: sha256(candidate) },
  bytes: {
    baseline: Buffer.byteLength(baseline),
    candidate: Buffer.byteLength(candidate),
  },
})

const recordRaster = (item, pixels, output) => {
  item.raster = {
    equal: pixels.equal === true,
    changedPixels: pixels.changedPixels,
    encodingIdentical: pixels.encodingIdentical ?? null,
    width: pixels.width ?? null,
    height: pixels.height ?? null,
    diagnostic: false,
    diff: pixels.diff ? path.relative(output, pixels.diff) : null,
  }
  if (pixels.equal === true) return
  if (typeof pixels.changedPixels === 'number') {
    item.raster.diagnostic = true
    return
  }
  item.error = item.error ?? pixels.reason ?? 'raster comparison failed'
}

const markerLines = (run, prefix) => {
  const fromErr = collectMarkers(run.stderr, prefix)
  if (fromErr.length) return fromErr
  return collectMarkers(run.stdout, prefix)
}

const collectMarkers = (text, prefix) =>
  text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith(prefix))

const scenarioOf = (item) => {
  const copy = { ...item }
  delete copy.id
  return copy
}

const looksBrowser = (scenario) => scenario.browser3d === true

const browserArtifacts = (captured) => Boolean(captured?.artifacts?.length)

const themeBackground = (scenario) => {
  if (typeof scenario.theme !== 'string')
    return {
      error:
        'scenario.theme missing; SVG frame needs the fixture theme background',
    }
  const key = scenario.theme.toLowerCase()
  if (Object.hasOwn(THEME_BG, key)) return { background: THEME_BG[key] }
  return {
    error: `scenario.theme ${JSON.stringify(scenario.theme)} is not dark or light`,
  }
}

const walkElements = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkElements(child, visit)
  }
}

const hashTree = async (root) => {
  const files = []
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) {
        const buf = await readFile(abs)
        files.push({
          path: path.relative(root, abs).split(path.sep).join('/'),
          sha256: sha256(buf),
          bytes: buf.length,
        })
      }
    }
  }
  await walk(root)
  const canonical = `${files.map((file) => `${file.sha256}  ${file.path}`).join('\n')}\n`
  return {
    files,
    canonical,
    sha256: sha256(canonical),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const positive = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null

const pngSize = (buf) => {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const safeName = (id, index) => {
  const slug =
    id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'case'
  return `${String(index).padStart(2, '0')}-${slug}`.slice(0, 120)
}

const stable = (value) =>
  JSON.stringify(value, (_, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested))
      return nested
    return Object.fromEntries(
      Object.keys(nested)
        .sort()
        .map((key) => [key, nested[key]]),
    )
  })

const runProcess = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = createWriteStream(options.stdoutPath)
    const stderr = createWriteStream(options.stderrPath)
    const outChunks = []
    const errChunks = []
    child.stdout.on('data', (chunk) => {
      outChunks.push(chunk)
      stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errChunks.push(chunk)
      stderr.write(chunk)
    })
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdout.end()
      stderr.end()
      reject(error)
    }
    stdout.on('error', fail)
    stderr.on('error', fail)
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      stdout.end()
      stderr.end()
      Promise.all([finished(stdout), finished(stderr)]).then(() => {
        if (settled) return
        settled = true
        resolve({
          code: code ?? 1,
          timedOut,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        })
      }, fail)
    })
  })

await main()
