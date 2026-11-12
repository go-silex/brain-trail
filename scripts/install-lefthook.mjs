import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const managed = ['pre-commit', 'pre-push']
const receiptName = 'brain-trail-quality-hooks.json'

function git(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function absFromRoot(path) {
  return isAbsolute(path) ? resolve(path) : resolve(root, path)
}

function nativeLefthook() {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const extension = process.platform === 'win32' ? '.exe' : ''
  return createRequire(import.meta.url).resolve(
    `lefthook-${os}-${process.arch}/bin/lefthook${extension}`,
  )
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function expectedShims(bin) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-trail-lefthook-'))
  try {
    const init = spawnSync('git', ['init', '-q'], {
      cwd: dir,
      encoding: 'utf8',
    })
    if (init.status !== 0)
      throw new Error(init.stderr.trim() || 'git init failed')
    cpSync(join(root, 'lefthook.yml'), join(dir, 'lefthook.yml'))
    const installed = spawnSync(bin, ['install'], {
      cwd: dir,
      encoding: 'utf8',
    })
    if (installed.status !== 0) {
      throw new Error(
        installed.stderr.trim() ||
          installed.stdout.trim() ||
          'lefthook install failed in scratch',
      )
    }
    const shims = {}
    for (const name of managed) {
      const bytes = readFileSync(join(dir, '.git', 'hooks', name))
      if (bytes.length === 0) throw new Error(`scratch ${name} shim is empty`)
      shims[name] = bytes
    }
    return shims
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readReceipt(path) {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const hooks = {}
  for (const name of managed) {
    const hash = parsed?.hooks?.[name]
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(
        `Refusing to install: receipt ${path} has no SHA256 for ${name}. Existing hooks were not changed.`,
      )
    }
    hooks[name] = hash
  }
  return hooks
}

const shown = spawnSync(
  'git',
  ['config', '--show-origin', '--get', 'core.hooksPath'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
if (shown.status !== 0 && shown.status !== 1) {
  throw new Error(shown.stderr.trim() || 'git config read failed')
}
if (shown.status === 0) {
  const [origin, value] = shown.stdout.trim().split('\t')
  throw new Error(
    `Refusing to install: core.hooksPath is ${value} (${origin}). It was not changed.`,
  )
}

const common = absFromRoot(git(['rev-parse', '--git-common-dir']))
const canonical = resolve(common, 'hooks')
const actual = absFromRoot(git(['rev-parse', '--git-path', 'hooks']))
if (actual !== canonical) {
  throw new Error(
    `Refusing to install: hooks path ${actual} is not the canonical common-dir hooks ${canonical}.`,
  )
}

const receiptPath = join(common, 'info', receiptName)
const receipt = readReceipt(receiptPath)
const expected = expectedShims(nativeLefthook())
const expectedHash = Object.fromEntries(
  managed.map((name) => [name, sha256(expected[name])]),
)

const present = {}
for (const name of managed) {
  const file = join(canonical, name)
  if (!existsSync(file)) continue
  present[name] = sha256(readFileSync(file))
  if (!receipt) {
    throw new Error(
      `Refusing to install: ${file} exists and there is no receipt. It was not overwritten.`,
    )
  }
  if (present[name] !== receipt[name]) {
    throw new Error(
      `Refusing to install: ${file} does not match the receipt. It was not overwritten.`,
    )
  }
}

const changed = managed.some((name) => present[name] !== expectedHash[name])
if (!changed) {
  console.log(`Lefthook hooks match ${receiptPath}.`)
  process.exit(0)
}

const created = []
const replaced = []
try {
  for (const name of managed) {
    if (present[name] === expectedHash[name]) continue
    const file = join(canonical, name)
    const old = present[name] === undefined ? null : readFileSync(file)
    writeFileSync(file, expected[name])
    chmodSync(file, 0o755)
    if (old === null) created.push(file)
    else replaced.push({ file, old })
  }
  mkdirSync(join(common, 'info'), { recursive: true })
  writeFileSync(
    receiptPath,
    `${JSON.stringify({ hooks: expectedHash }, null, 2)}\n`,
  )
} catch (error) {
  for (const item of replaced) {
    writeFileSync(item.file, item.old)
    chmodSync(item.file, 0o755)
  }
  for (const file of created) rmSync(file, { force: true })
  throw error
}
console.log(`Installed lefthook hooks; receipt ${receiptPath}.`)
