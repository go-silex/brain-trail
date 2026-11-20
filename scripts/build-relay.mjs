import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const relay = join(root, 'hosts/relay')
const dist = join(relay, 'bin')
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--check'))
  throw new Error('Usage: node scripts/build-relay.mjs [--check]')
const check = args.length === 1
const env = {
  ...process.env,
  GOTOOLCHAIN: 'local',
  GOENV: 'off',
  GOWORK: 'off',
  GOFLAGS: '-mod=readonly',
  GOEXPERIMENT: '',
  GOAMD64: 'v1',
  GOARM64: 'v8.0',
  CGO_ENABLED: '0',
}
const version = spawnSync('go', ['version'], { encoding: 'utf8', env })
if (version.status !== 0 || !/^go version go1\.27\.3\s/.test(version.stdout))
  throw new Error(
    `Expected Go 1.27.3: ${version.stderr || version.stdout || version.error}`,
  )
const goroot = spawnSync('go', ['env', 'GOROOT'], { encoding: 'utf8', env })
if (goroot.status !== 0 || !goroot.stdout.trim())
  throw new Error(`Cannot locate Go root: ${goroot.stderr || goroot.error}`)
const license = join(goroot.stdout.trim(), 'LICENSE')
const temp = mkdtempSync(join(tmpdir(), 'brain-trail-relay-build-'))
try {
  if (!check) mkdirSync(dist, { recursive: true })
  if (check) {
    if (!readFileSync(license).equals(readFileSync(join(dist, 'LICENSE-Go'))))
      throw new Error('LICENSE-Go differs from the pinned Go distribution')
  } else {
    copyFileSync(license, join(dist, 'LICENSE-Go'))
  }
  for (const os of ['linux', 'darwin', 'windows']) {
    for (const arch of ['amd64', 'arm64']) {
      const name = `brain-trail-relay-${os}-${arch}${os === 'windows' ? '.exe' : ''}`
      const output = join(temp, name)
      const result = spawnSync(
        'go',
        [
          'build',
          '-trimpath',
          '-buildvcs=false',
          '-ldflags=-buildid=',
          '-o',
          output,
          '.',
        ],
        {
          cwd: relay,
          env: { ...env, GOOS: os, GOARCH: arch },
          encoding: 'utf8',
        },
      )
      if (result.status !== 0)
        throw new Error(
          `Building ${name} failed: ${result.stderr || result.error}`,
        )
      if (check) {
        if (!readFileSync(output).equals(readFileSync(join(dist, name))))
          throw new Error(`${name} differs from the checked-in binary`)
      } else {
        copyFileSync(output, join(dist, name))
        chmodSync(join(dist, name), 0o755)
      }
    }
  }
  // These modules are linked by the MCP server; copy their exact upstream
  // license texts from the pinned module cache after the builds populate it.
  const moduleCache = spawnSync('go', ['env', 'GOMODCACHE'], {
    cwd: relay,
    encoding: 'utf8',
    env,
  })
  if (moduleCache.status !== 0 || !moduleCache.stdout.trim())
    throw new Error(
      `Cannot locate Go module cache: ${moduleCache.stderr || moduleCache.error}`,
    )
  const notices = [
    [
      'LICENSE-mcp-go-sdk',
      'github.com/modelcontextprotocol/go-sdk@v1.8.0/LICENSE',
    ],
    ['LICENSE-jsonschema-go', 'github.com/google/jsonschema-go@v0.4.3/LICENSE'],
    [
      'LICENSE-uritemplate',
      'github.com/yosida95/uritemplate/v3@v3.0.2/LICENSE',
    ],
    [
      'LICENSE-segmentio-encoding',
      'github.com/segmentio/encoding@v0.5.4/LICENSE',
    ],
    ['LICENSE-segmentio-asm', 'github.com/segmentio/asm@v1.1.3/LICENSE'],
    ['LICENSE-x-oauth2', 'golang.org/x/oauth2@v0.35.0/LICENSE'],
    ['LICENSE-x-sync', 'golang.org/x/sync@v0.20.0/LICENSE'],
    ['LICENSE-x-time', 'golang.org/x/time@v0.15.0/LICENSE'],
  ]
  for (const [name, source] of notices) {
    const origin = join(moduleCache.stdout.trim(), source)
    const destination = join(dist, name)
    if (check) {
      if (!readFileSync(origin).equals(readFileSync(destination)))
        throw new Error(`${name} differs from the pinned Go module`)
    } else {
      // Go's module cache is read-only; copied files inherit its mode.
      // Repair earlier generated copies before replacing their contents.
      if (existsSync(destination)) chmodSync(destination, 0o644)
      copyFileSync(origin, destination)
      chmodSync(destination, 0o644)
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
