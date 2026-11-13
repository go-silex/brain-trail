import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { compare, valid } from 'semver'

const ZERO = '0'.repeat(40)
const PLUGIN = '.claude-plugin/plugin.json'
const MARKET = '.claude-plugin/marketplace.json'
const PLUGIN_NAME = 'brain-trail-v2'
const PACKAGE = 'package.json'
const RUNTIME_PACKAGE_FIELDS = [
  'omp',
  'files',
  'exports',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'engines',
]

const arg = process.argv[2]
if (process.argv.length > 3) {
  throw new Error('Usage: node scripts/check-release.mjs [base]')
}
const base =
  arg || process.env.VIEW_BASE || process.env.RELEASE_BASE || 'origin/main'
if (!base || base === ZERO) {
  throw new Error(
    'Release baseline is missing or the all-zero SHA. Refusing to substitute origin/main: after a default-branch push that ref is the candidate.',
  )
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function lines(text) {
  return text.split('\0').filter(Boolean)
}

function readJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`)
  }
}

function versionOf(value, label) {
  if (typeof value !== 'string' || valid(value) === null) {
    throw new Error(
      `${label} version must be semver, got ${value ?? 'nothing'}.`,
    )
  }
  return value
}

function entryOf(manifest, label) {
  const plugins = manifest?.plugins
  if (!Array.isArray(plugins)) throw new Error(`${label} must list plugins.`)
  const entry = plugins.find((item) => item && item.name === PLUGIN_NAME)
  if (!entry) throw new Error(`${label} must list ${PLUGIN_NAME}.`)
  if (entry.source !== './') {
    throw new Error(
      `${label} source must stay './' (source distribution, no dist artifact).`,
    )
  }
  return entry
}

function sameRequirement(current, previous, label) {
  const left = current === undefined ? null : current
  const right = previous === undefined ? null : previous
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(
      `${label} is a consumer install requirement and must stay stable.`,
    )
  }
}

// Docs and dev tooling do not ship behavior. Anything else in the source
// distribution, including a new hooks or types file, is runtime.
function nonRuntime(path) {
  if (
    path === 'README.md' ||
    path === 'CONTRIBUTING.md' ||
    path === 'SECURITY.md' ||
    path === 'LICENSE' ||
    path === '.gitignore' ||
    path === 'lefthook.yml'
  )
    return true
  if (path === 'types/contracts.ts') return true
  if (path.startsWith('docs/')) return true
  if (
    path.endsWith('/LICENSE') ||
    path.endsWith('/README.md') ||
    path.endsWith('/README')
  )
    return true
  if (
    path.startsWith('tests/') ||
    path.startsWith('scripts/') ||
    path.startsWith('.github/') ||
    path.startsWith('.artifacts/')
  )
    return true
  if (
    path === 'package.json' ||
    path === 'bun.lock' ||
    path === 'biome.json' ||
    path === 'biome.jsonc'
  )
    return true
  if (
    path === 'tsconfig.json' ||
    path === 'tsconfig.core.json' ||
    /^tsconfig\.(omp.*|browser)\.json$/.test(path)
  )
    return true
  if (
    path.startsWith('.claude-plugin/sdk/') &&
    (path.endsWith('.d.ts') || path.endsWith('tsconfig.json'))
  )
    return true
  return false
}

const baseCommit = git([
  'rev-parse',
  '--verify',
  '--end-of-options',
  `${base}^{commit}`,
]).trim()
const currentPackage = existsSync(PACKAGE)
  ? readJson(readFileSync(PACKAGE, 'utf8'), PACKAGE)
  : {}
const basePackage = git([
  'ls-tree',
  '-z',
  '--name-only',
  baseCommit,
  '--',
  PACKAGE,
])
  ? readJson(
      git(['show', `${baseCommit}:${PACKAGE}`]),
      `${baseCommit}:${PACKAGE}`,
    )
  : {}
const packageRuntimeChanged = RUNTIME_PACKAGE_FIELDS.some(
  (field) => !isDeepStrictEqual(currentPackage[field], basePackage[field]),
)
const tracked = lines(
  git(['diff', '-z', '--name-only', '--diff-filter=ACDMRTUXB', baseCommit]),
)
const untracked = lines(
  git(['ls-files', '-z', '--others', '--exclude-standard']),
)
const runtime = [
  ...new Set([
    ...[...tracked, ...untracked].filter((path) => !nonRuntime(path)),
    ...(packageRuntimeChanged ? [PACKAGE] : []),
  ]),
].sort()

const currentPlugin = readJson(readFileSync(PLUGIN, 'utf8'), PLUGIN)
const currentMarket = readJson(readFileSync(MARKET, 'utf8'), MARKET)
const currentEntry = entryOf(currentMarket, MARKET)
const currentVersion = versionOf(currentPlugin.version, PLUGIN)
if (currentPlugin.name !== PLUGIN_NAME)
  throw new Error(`${PLUGIN} name must stay ${PLUGIN_NAME}.`)
if (currentMarket.name !== 'brain-trail')
  throw new Error(`${MARKET} name must stay brain-trail.`)
if (
  currentEntry.version !== undefined &&
  currentEntry.version !== currentVersion
) {
  throw new Error(
    `${MARKET} version must equal ${PLUGIN} version ${currentVersion}.`,
  )
}
if (Object.hasOwn(currentPackage, 'omp')) {
  if (
    versionOf(currentPackage.version, PACKAGE) !== currentVersion ||
    currentEntry.version !== currentVersion
  ) {
    throw new Error(
      `${PACKAGE} version must equal ${PLUGIN} and ${MARKET} version ${currentVersion}.`,
    )
  }
}

const basePlugin = readJson(
  git(['show', `${baseCommit}:${PLUGIN}`]),
  `${baseCommit}:${PLUGIN}`,
)
const baseMarket = readJson(
  git(['show', `${baseCommit}:${MARKET}`]),
  `${baseCommit}:${MARKET}`,
)
const baseEntry = entryOf(baseMarket, `${baseCommit}:${MARKET}`)
const baseVersion = versionOf(basePlugin.version, `${baseCommit}:${PLUGIN}`)

sameRequirement(currentPlugin.name, basePlugin.name, `${PLUGIN} name`)
sameRequirement(currentMarket.name, baseMarket.name, `${MARKET} name`)
sameRequirement(currentEntry.name, baseEntry.name, 'plugin entry name')
sameRequirement(currentEntry.source, baseEntry.source, 'plugin source')
sameRequirement(
  currentEntry.dependencies,
  baseEntry.dependencies,
  'plugin dependencies',
)

if (compare(currentVersion, baseVersion) < 0) {
  throw new Error(
    `Plugin version decreased from ${baseVersion} to ${currentVersion}.`,
  )
}

if (runtime.length === 0) {
  console.log(
    `Source distribution runtime unchanged vs ${baseCommit}; plugin ${currentVersion}.`,
  )
} else {
  if (compare(currentVersion, baseVersion) <= 0) {
    throw new Error(
      `Runtime changed vs ${baseCommit} but plugin version ${currentVersion} did not increase from ${baseVersion}:\n${runtime.join('\n')}`,
    )
  }
  if (currentEntry.version !== currentVersion) {
    throw new Error(
      `Runtime changed: set ${MARKET} plugin version to ${currentVersion} as well.\n${runtime.join('\n')}`,
    )
  }
  if (typeof baseEntry.version === 'string') {
    const published = versionOf(baseEntry.version, `${baseCommit}:${MARKET}`)
    if (compare(currentVersion, published) <= 0) {
      throw new Error(
        `Marketplace version ${currentVersion} did not increase from ${published}.`,
      )
    }
  }
  console.log(
    `Source distribution ${currentVersion} > ${baseVersion} (${runtime.length} runtime paths vs ${baseCommit}).`,
  )
}
