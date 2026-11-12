import assert from 'node:assert/strict'
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
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const candidate = resolve(scriptsDir, '..')
const nodeModules = join(candidate, 'node_modules')
const ZERO = '0'.repeat(40)
const managed = ['pre-commit', 'pre-push']
const frozen = new Date('2020-01-01T00:00:00Z')
const markerDecoy = `#!/bin/sh
# call_lefthook()
# call_lefthook run "pre-commit"
# $LEFTHOOK
printf '%s\\n' 'handwritten-not-owned'
`
const openYml = `no_auto_install: true
assert_lefthook_installed: false
pre-commit:
  commands:
    release:
      run: node scripts/check-release.mjs
pre-push:
  commands:
    verify:
      run: node scripts/check-release.mjs
`
const strictYml = openYml.replace(
  'assert_lefthook_installed: false',
  'assert_lefthook_installed: true',
)

function isolatedEnv(gitconfig) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_CONFIG') || key.startsWith('LEFTHOOK')) continue
    if (
      key === 'GIT_DIR' ||
      key === 'GIT_WORK_TREE' ||
      key === 'GIT_INDEX_FILE'
    )
      continue
    if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_'))
      continue
    if (key === 'VIEW_BASE' || key === 'RELEASE_BASE') continue
    env[key] = value
  }
  env.GIT_AUTHOR_NAME = 'Gate Contracts'
  env.GIT_AUTHOR_EMAIL = 'gate@example.test'
  env.GIT_COMMITTER_NAME = 'Gate Contracts'
  env.GIT_COMMITTER_EMAIL = 'gate@example.test'
  env.GIT_CONFIG_GLOBAL = gitconfig
  env.GIT_CONFIG_SYSTEM = gitconfig
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_COUNT = '0'
  return env
}

function git(cwd, args, env) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function nativeBin() {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const extension = process.platform === 'win32' ? '.exe' : ''
  return join(
    nodeModules,
    `lefthook-${os}-${process.arch}`,
    'bin',
    `lefthook${extension}`,
  )
}

function plugin(version) {
  return `${JSON.stringify({ name: 'brain-trail-v2', version }, null, 2)}\n`
}

function market(version) {
  return `${JSON.stringify(
    {
      name: 'brain-trail',
      plugins: [{ name: 'brain-trail-v2', source: './', version }],
    },
    null,
    2,
  )}\n`
}

function writeManifests(dir, version) {
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), plugin(version))
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    market(version),
  )
}

function runNode(script, args, cwd, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  })
}

function assertFailed(result, text) {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.stderr.includes(text), true, result.stderr)
}

function assertOk(result, text) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.stdout.includes(text), true, result.stdout)
}

function gitPath(cwd, args, env) {
  return resolve(cwd, git(cwd, args, env))
}

function oracleShims(yml, env) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-shim-'))
  try {
    writeFileSync(join(dir, 'lefthook.yml'), yml)
    git(dir, ['init', '-q'], env)
    const installed = spawnSync(nativeBin(), ['install'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    })
    assert.equal(installed.status, 0, installed.stderr || installed.stdout)
    return Object.fromEntries(
      managed.map((name) => [
        name,
        readFileSync(join(dir, '.git', 'hooks', name)),
      ]),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function freeze(path) {
  utimesSync(path, frozen, frozen)
}

function assertFrozen(path) {
  const delta = Math.abs(statSync(path).mtimeMs - frozen.getTime())
  assert.equal(delta < 1, true, `${path} was rewritten`)
}

test('release CLI decides the shipped source against an explicit baseline', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'quality-release-'))
  const gitconfig = join(sandbox, 'gitconfig')
  writeFileSync(gitconfig, '')
  const env = isolatedEnv(gitconfig)
  const dir = join(sandbox, 'plugin')
  const map = join(dir, 'hooks', 'map.ts')
  const hookConfig = join(dir, 'lefthook.yml')
  const mapV1 = 'export const mark = 1\n'
  const mapV2 = 'export const mark = 2\n'
  const maintained = 'no_auto_install: true\n'
  const edited = 'no_auto_install: true\n# maintenance only\n'
  try {
    assert.equal(existsSync(join(nodeModules, 'semver', 'package.json')), true)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    mkdirSync(join(dir, 'hooks'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    cpSync(
      join(scriptsDir, 'check-release.mjs'),
      join(dir, 'scripts', 'check-release.mjs'),
    )
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    writeFileSync(hookConfig, maintained)
    writeFileSync(map, mapV1)
    writeManifests(dir, '2.1.1-rc.10')
    git(dir, ['init', '-q', '-b', 'main'], env)
    symlinkSync(nodeModules, join(dir, 'node_modules'), 'dir')
    git(
      dir,
      [
        'add',
        '--',
        '.gitignore',
        'lefthook.yml',
        'hooks/map.ts',
        '.claude-plugin/plugin.json',
        '.claude-plugin/marketplace.json',
        'scripts/check-release.mjs',
      ],
      env,
    )
    git(dir, ['commit', '-q', '-m', 'publish rc.10'], env)
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], env)
    const published = git(dir, ['rev-parse', 'HEAD'], env)
    assert.equal(git(dir, ['rev-parse', 'origin/main'], env), published)
    const stray = git(
      dir,
      ['ls-files', '-z', '--others', '--exclude-standard'],
      env,
    )
    assert.equal(stray.includes('node_modules'), false, stray)
    const script = join(dir, 'scripts', 'check-release.mjs')
    const run = (args) => runNode(script, args, dir, env)

    writeFileSync(map, mapV2)
    const unbumped = run([published])
    assertFailed(
      unbumped,
      `Runtime changed vs ${published} but plugin version 2.1.1-rc.10 did not increase from 2.1.1-rc.10:\nhooks/map.ts`,
    )
    assert.equal(unbumped.stderr.includes('decreased'), false, unbumped.stderr)
    const viaOrigin = run([])
    assertFailed(
      viaOrigin,
      `Runtime changed vs ${published} but plugin version 2.1.1-rc.10 did not increase from 2.1.1-rc.10:\nhooks/map.ts`,
    )

    writeFileSync(map, mapV1)
    writeFileSync(hookConfig, edited)
    const tooling = run([published])
    assertOk(
      tooling,
      `Source distribution runtime unchanged vs ${published}; plugin 2.1.1-rc.10.`,
    )
    writeFileSync(hookConfig, maintained)

    writeFileSync(map, mapV2)
    writeManifests(dir, '2.1.1-rc.2')
    const downgrade = run([published])
    assertFailed(
      downgrade,
      'Plugin version decreased from 2.1.1-rc.10 to 2.1.1-rc.2.',
    )
    assert.equal(
      downgrade.stdout.includes('Source distribution'),
      false,
      downgrade.stdout,
    )

    assert.equal(git(dir, ['rev-parse', 'HEAD'], env), published)
    assert.equal(git(dir, ['rev-parse', 'origin/main'], env), published)
    const zero = run([ZERO])
    assertFailed(
      zero,
      'Release baseline is missing or the all-zero SHA. Refusing to substitute origin/main: after a default-branch push that ref is the candidate.',
    )
    assert.equal(zero.stderr.includes('Runtime changed'), false, zero.stderr)
    assert.equal(zero.stderr.includes('decreased'), false, zero.stderr)

    writeFileSync(map, mapV1)
    writeManifests(dir, '2.1.1-rc.2')
    git(
      dir,
      [
        'add',
        '--',
        '.claude-plugin/plugin.json',
        '.claude-plugin/marketplace.json',
      ],
      env,
    )
    git(dir, ['commit', '-q', '-m', 'publish rc.2'], env)
    const lower = git(dir, ['rev-parse', 'HEAD'], env)
    writeFileSync(map, mapV2)
    writeManifests(dir, '2.1.1-rc.10')
    const shipped = run([lower])
    assertOk(shipped, `Source distribution 2.1.1-rc.10 > 2.1.1-rc.2 (`)
    assert.match(shipped.stdout, new RegExp(`runtime paths vs ${lower}`))
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('installer refuses a handwritten hook carrying the old markers', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'quality-decoy-'))
  const gitconfig = join(sandbox, 'gitconfig')
  writeFileSync(gitconfig, '')
  const env = isolatedEnv(gitconfig)
  const dir = join(sandbox, 'repo')
  try {
    assert.equal(existsSync(nativeBin()), true, nativeBin())
    assert.match(markerDecoy, /^#!\/bin\/sh\n/)
    assert.match(markerDecoy, /call_lefthook\(\)\n/)
    assert.match(markerDecoy, /call_lefthook run "pre-commit"/)
    assert.match(markerDecoy, /\$LEFTHOOK/)
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    cpSync(
      join(scriptsDir, 'install-lefthook.mjs'),
      join(dir, 'scripts', 'install-lefthook.mjs'),
    )
    writeFileSync(join(dir, 'lefthook.yml'), openYml)
    git(dir, ['init', '-q', '-b', 'main'], env)
    symlinkSync(nodeModules, join(dir, 'node_modules'), 'dir')
    const hooks = gitPath(dir, ['rev-parse', '--git-path', 'hooks'], env)
    const common = gitPath(dir, ['rev-parse', '--git-common-dir'], env)
    const decoyPath = join(hooks, 'pre-commit')
    writeFileSync(decoyPath, markerDecoy)
    freeze(decoyPath)
    const before = readFileSync(decoyPath)
    const result = runNode(
      join(dir, 'scripts', 'install-lefthook.mjs'),
      [],
      dir,
      env,
    )
    assertFailed(
      result,
      `Refusing to install: ${decoyPath} exists and there is no receipt. It was not overwritten.`,
    )
    assert.deepEqual(readFileSync(decoyPath), before)
    assertFrozen(decoyPath)
    assert.equal(existsSync(join(hooks, 'pre-push')), false)
    assert.equal(
      existsSync(join(common, 'info', 'brain-trail-quality-hooks.json')),
      false,
    )
    const hooksPath = spawnSync(
      'git',
      ['config', '--local', '--get', 'core.hooksPath'],
      {
        cwd: dir,
        encoding: 'utf8',
        env,
      },
    )
    assert.equal(hooksPath.status, 1, hooksPath.stdout)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('linked worktree install owns only receipt-matched canonical hooks', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'quality-worktree-'))
  const gitconfig = join(sandbox, 'gitconfig')
  writeFileSync(gitconfig, '')
  const env = isolatedEnv(gitconfig)
  const main = join(sandbox, 'main')
  const linked = join(sandbox, 'linked')
  let locked = null
  try {
    assert.equal(existsSync(nativeBin()), true, nativeBin())
    mkdirSync(join(main, 'scripts'), { recursive: true })
    cpSync(
      join(scriptsDir, 'install-lefthook.mjs'),
      join(main, 'scripts', 'install-lefthook.mjs'),
    )
    writeFileSync(join(main, 'lefthook.yml'), openYml)
    writeFileSync(join(main, '.gitignore'), 'node_modules\n')
    git(main, ['init', '-q', '-b', 'main'], env)
    git(
      main,
      [
        'add',
        '--',
        '.gitignore',
        'lefthook.yml',
        'scripts/install-lefthook.mjs',
      ],
      env,
    )
    git(main, ['commit', '-q', '-m', 'installer'], env)
    git(
      main,
      ['worktree', 'add', '-q', '-b', 'quality-linked', linked, 'HEAD'],
      env,
    )
    symlinkSync(nodeModules, join(linked, 'node_modules'), 'dir')
    const common = gitPath(linked, ['rev-parse', '--git-common-dir'], env)
    const hooks = gitPath(linked, ['rev-parse', '--git-path', 'hooks'], env)
    assert.equal(hooks, join(common, 'hooks'))
    const workGit = gitPath(linked, ['rev-parse', '--git-dir'], env)
    assert.notEqual(workGit, common)
    const receiptPath = join(common, 'info', 'brain-trail-quality-hooks.json')
    const files = Object.fromEntries(
      managed.map((name) => [name, join(hooks, name)]),
    )
    const script = join(linked, 'scripts', 'install-lefthook.mjs')
    const prepare = () => runNode(script, [], linked, env)
    const expected = oracleShims(openYml, env)

    const installed = prepare()
    assertOk(installed, `Installed lefthook hooks; receipt ${receiptPath}.`)
    for (const name of managed) {
      assert.deepEqual(readFileSync(files[name]), expected[name])
      assert.equal(statSync(files[name]).mode & 0o111, 0o111)
      assert.equal(existsSync(join(workGit, 'hooks', name)), false)
    }
    const receipt = readFileSync(receiptPath, 'utf8')
    assert.equal(receipt.endsWith('\n'), true)
    const parsed = JSON.parse(receipt)
    for (const name of managed) {
      assert.equal(parsed.hooks[name], sha256(expected[name]))
    }
    for (const key of ['core.hooksPath', 'user.name', 'user.email']) {
      const shown = spawnSync('git', ['config', '--local', '--get', key], {
        cwd: linked,
        encoding: 'utf8',
        env,
      })
      assert.equal(shown.status, 1, `${key} written: ${shown.stdout}`)
    }

    for (const name of managed) freeze(files[name])
    freeze(receiptPath)
    const repeated = prepare()
    assertOk(repeated, `Lefthook hooks match ${receiptPath}.`)
    for (const name of managed) {
      assertFrozen(files[name])
      assert.deepEqual(readFileSync(files[name]), expected[name])
    }
    assertFrozen(receiptPath)
    assert.equal(readFileSync(receiptPath, 'utf8'), receipt)

    const tampered = Buffer.concat([
      expected['pre-commit'],
      Buffer.from('\n# local edit\n'),
    ])
    writeFileSync(files['pre-commit'], tampered)
    freeze(files['pre-commit'])
    const refused = prepare()
    assertFailed(
      refused,
      `Refusing to install: ${files['pre-commit']} does not match the receipt. It was not overwritten.`,
    )
    assert.deepEqual(readFileSync(files['pre-commit']), tampered)
    assertFrozen(files['pre-commit'])
    assert.deepEqual(readFileSync(files['pre-push']), expected['pre-push'])
    assert.equal(readFileSync(receiptPath, 'utf8'), receipt)

    writeFileSync(files['pre-commit'], expected['pre-commit'])
    chmodSync(files['pre-commit'], 0o755)
    writeFileSync(join(linked, 'lefthook.yml'), strictYml)
    const strict = oracleShims(strictYml, env)
    assert.notDeepEqual(strict['pre-commit'], expected['pre-commit'])
    const updated = prepare()
    assertOk(updated, `Installed lefthook hooks; receipt ${receiptPath}.`)
    for (const name of managed) {
      assert.deepEqual(readFileSync(files[name]), strict[name])
    }
    const updatedReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    for (const name of managed) {
      assert.equal(updatedReceipt.hooks[name], sha256(strict[name]))
    }

    const owned = Object.fromEntries(
      managed.map((name) => [name, readFileSync(files[name])]),
    )
    const ownedReceipt = readFileSync(receiptPath)
    writeFileSync(join(linked, 'lefthook.yml'), openYml)
    locked = receiptPath
    chmodSync(receiptPath, 0o444)
    const rolled = prepare()
    assert.equal(rolled.status, 1, `${rolled.stdout}\n${rolled.stderr}`)
    assert.equal(rolled.stderr.includes('EACCES'), true, rolled.stderr)
    assert.equal(rolled.stderr.includes(receiptPath), true, rolled.stderr)
    for (const name of managed) {
      assert.deepEqual(readFileSync(files[name]), owned[name])
    }
    assert.deepEqual(readFileSync(receiptPath), ownedReceipt)
  } finally {
    if (locked && existsSync(locked)) chmodSync(locked, 0o644)
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('release CLI classifies OMP package changes and aligns shipped versions', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'quality-omp-release-'))
  const gitconfig = join(sandbox, 'gitconfig')
  writeFileSync(gitconfig, '')
  const env = isolatedEnv(gitconfig)
  const dir = join(sandbox, 'plugin')
  const packagePath = join(dir, 'package.json')
  const runtimePath = join(dir, 'hosts', 'omp', 'index.ts')
  const basePackage = {
    name: 'synthetic-extension',
    version: '2.2.0',
    omp: { extensions: ['./hosts/omp/index.ts'] },
    files: ['hosts'],
    exports: { '.': './hosts/omp/index.ts' },
    dependencies: { example: '1.0.0', other: '1.0.0' },
    optionalDependencies: { optional: '1.0.0' },
    peerDependencies: { peer: '^1.0.0' },
    engines: { node: '>=20' },
    scripts: { check: 'node check.mjs' },
    devDependencies: { tooling: '1.0.0' },
  }
  const writePackage = (value) =>
    writeFileSync(packagePath, `${JSON.stringify(value, null, 2)}\n`)

  try {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    mkdirSync(join(dir, 'hosts', 'omp'), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    cpSync(
      join(scriptsDir, 'check-release.mjs'),
      join(dir, 'scripts', 'check-release.mjs'),
    )
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    writeFileSync(runtimePath, 'export const factory = 1\n')
    writeFileSync(
      join(dir, 'hosts', 'omp', 'other.ts'),
      'export const factory = 2\n',
    )
    writeManifests(dir, '2.2.0')
    writePackage({
      name: 'legacy-quality',
      version: '9.0.0',
      scripts: { check: 'node check.mjs' },
      devDependencies: { tooling: '1.0.0' },
    })
    git(dir, ['init', '-q', '-b', 'main'], env)
    symlinkSync(nodeModules, join(dir, 'node_modules'), 'dir')
    git(dir, ['add', '--', '.'], env)
    git(dir, ['commit', '-q', '-m', 'legacy package'], env)
    const script = join(dir, 'scripts', 'check-release.mjs')
    const run = (base) => runNode(script, [base], dir, env)
    const legacy = git(dir, ['rev-parse', 'HEAD'], env)
    assertOk(run(legacy), `runtime unchanged vs ${legacy}; plugin 2.2.0`)

    writePackage(basePackage)
    git(dir, ['add', '--', 'package.json'], env)
    git(dir, ['commit', '-q', '-m', 'publish OMP package'], env)
    const base = git(dir, ['rev-parse', 'HEAD'], env)

    writePackage({
      ...basePackage,
      scripts: { check: 'node changed-check.mjs' },
      devDependencies: { tooling: '2.0.0' },
      dependencies: { other: '1.0.0', example: '1.0.0' },
    })
    assertOk(run(base), `runtime unchanged vs ${base}; plugin 2.2.0`)

    const runtimeChanges = [
      { omp: { extensions: ['./hosts/omp/other.ts'] } },
      { files: ['hosts', 'assets'] },
      { exports: { '.': './hosts/omp/other.ts' } },
      { dependencies: { example: '2.0.0', other: '1.0.0' } },
      { optionalDependencies: { optional: '2.0.0' } },
      { peerDependencies: { peer: '^2.0.0' } },
      { engines: { node: '>=22' } },
    ]
    for (const change of runtimeChanges) {
      writePackage({ ...basePackage, ...change })
      const rejected = run(base)
      assertFailed(rejected, 'did not increase from 2.2.0')
      assert.match(rejected.stderr, /package\.json/)
    }

    writePackage({
      ...basePackage,
      omp: { extensions: ['./hosts/omp/other.ts'] },
    })
    writeFileSync(runtimePath, 'export const factory = 2\n')
    writeManifests(dir, '2.2.1')
    const mismatched = run(base)
    assert.equal(mismatched.status, 1, mismatched.stderr)
    assert.match(mismatched.stderr, /package\.json.*version/i)
    assert.match(mismatched.stderr, /2\.2\.1/)
    assert.doesNotMatch(mismatched.stderr, /did not increase/)

    writePackage({
      ...basePackage,
      version: '2.2.1',
      omp: { extensions: ['./hosts/omp/other.ts'] },
      dependencies: { example: '2.0.0', other: '1.0.0' },
    })
    assertOk(run(base), 'Source distribution 2.2.1 > 2.2.0')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
