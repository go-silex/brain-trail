import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
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
} finally {
  rmSync(temp, { recursive: true, force: true })
}
