import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = process.env.RELAY_CLAUDE_VERSION || '2.1.322'
const platform = `${process.platform}-${process.arch}`
const cliRoot = resolve(process.env.RELAY_CLI_ROOT || root)
const pkg = join(
  cliRoot,
  'node_modules',
  '@anthropic-ai',
  `claude-code-${platform}`,
)
const claude =
  process.env.RELAY_CLI_EXECUTABLE ||
  join(pkg, process.platform === 'win32' ? 'claude.exe' : 'claude')
const pause = (ms) =>
  new Promise((resolvePause) => setTimeout(resolvePause, ms))
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const relayPid = (binary) => {
  let result
  if (process.platform === 'win32') {
    const literal = binary.replaceAll("'", "''")
    result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${literal}' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    )
  } else {
    result = spawnSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 10000,
    })
    if (result.status === 0)
      result.stdout = result.stdout
        .split('\n')
        .filter((line) => line.includes(binary))
        .map((line) => line.trim().split(/\s+/, 1)[0])
        .join('\n')
  }
  const pids = (result.stdout || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
  return result.status === 0 &&
    pids.length === 1 &&
    Number.isSafeInteger(pids[0]) &&
    pids[0] > 0
    ? pids[0]
    : 0
}
const temp = mkdtempSync(
  join(process.platform === 'win32' ? tmpdir() : '/tmp', 'btr-proof-'),
)
const work = join(temp, 'work'),
  plugin = join(temp, 'plugin'),
  bin = join(temp, 'bin')
let child,
  gateway,
  stream,
  socket,
  binary,
  pid,
  gatewayCalls = 0
try {
  for (const path of [
    work,
    bin,
    join(temp, 'home'),
    join(temp, 'config'),
    join(temp, 'tmp'),
    join(temp, 'local'),
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32' && process.env.RELAY_CROSS_ACCOUNT_HELPER) {
    chmodSync(temp, 0o711)
    chmodSync(join(temp, 'tmp'), 0o711)
  }
  const archive = join(temp, 'package.tar')
  const packed = spawnSync(
    'git',
    ['archive', '--format=tar', `--output=${archive}`, 'HEAD'],
    { cwd: root, timeout: 30000, stdio: 'ignore', windowsHide: true },
  )
  assert(packed.status === 0, 'cannot archive committed source package')
  mkdirSync(plugin)
  const unpacked = spawnSync('tar', ['-xf', archive, '-C', plugin], {
    timeout: 30000,
    stdio: 'ignore',
    windowsHide: true,
  })
  assert(unpacked.status === 0, 'cannot extract committed source package')
  const fixture = join(plugin, 'tests/fixtures/relay-production')
  cpSync(
    join(fixture, '.claude-plugin/plugin.json'),
    join(plugin, '.claude-plugin/plugin.json'),
  )
  writeFileSync(
    join(plugin, 'hooks/hooks.json'),
    JSON.stringify({
      modules: ['../tests/fixtures/relay-production/hooks/proof.ts'],
    }),
  )
  assert(existsSync(claude), 'native CLI missing')
  if (!process.env.RELAY_CLI_EXECUTABLE)
    assert(
      readJson(join(pkg, 'package.json'))?.version === version,
      'native CLI version mismatch',
    )
  if (process.platform !== 'win32')
    symlinkSync('/usr/bin/uname', join(bin, 'uname'))
  gateway = createServer((req, res) => {
    gatewayCalls++
    req.resume()
    res.writeHead(503)
    res.end()
  })
  await new Promise((ok, fail) => {
    gateway.once('error', fail)
    gateway.listen(0, '127.0.0.1', ok)
  })
  const env = {
    PATH:
      process.platform === 'win32'
        ? `${bin};${process.env.SystemRoot}\\System32`
        : bin,
    HOME: join(temp, 'home'),
    USERPROFILE: join(temp, 'home'),
    CLAUDE_CONFIG_DIR: join(temp, 'config'),
    LOCALAPPDATA: join(temp, 'local'),
    TMPDIR: join(temp, 'tmp'),
    TMP: join(temp, 'tmp'),
    TEMP: join(temp, 'tmp'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
    ANTHROPIC_AUTH_TOKEN: 'proof-no-model',
  }
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_ARCHITEW6432',
  ])
    if (process.env[key]) env[key] = process.env[key]
  if (process.env.RELAY_CLI_EXECUTABLE) {
    const actual = spawnSync(claude, ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    })
    assert(
      actual.status === 0 && actual.stdout.trim().split(/\s+/)[0] === version,
      'explicit CLI version mismatch',
    )
  }
  child = spawn(
    claude,
    [
      '-p',
      '/relay-production-proof',
      '--plugin-dir',
      plugin,
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ],
    {
      cwd: work,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  )
  let closed = false,
    exitCode
  child.once('error', () => {
    closed = true
  })
  child.once('close', (code) => {
    closed = true
    exitCode = code
  })
  let report
  const deadline = Date.now() + 180000
  while (!closed && Date.now() < deadline) {
    report = readJson(join(work, 'relay-production.json'))
    if (report?.phase === 'ready' || report?.phase === 'failed') break
    await pause(100)
  }
  assert(
    report?.phase === 'ready',
    `SDK fixture did not initialize: ${report?.error || 'no report'}`,
  )
  socket = report.socket
  assert(
    typeof socket === 'string' && typeof report.launch === 'string',
    'missing private socket or launch file',
  )
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  binary = join(
    plugin,
    'hosts/relay/bin',
    `brain-trail-relay-${os}-${arch}${process.platform === 'win32' ? '.exe' : ''}`,
  )
  pid = relayPid(binary)
  assert(pid && alive(pid), 'packaged relay process not observed')
  const helper = process.env.RELAY_CROSS_ACCOUNT_HELPER
  const hosted =
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  const supported = process.platform === 'linux' || process.platform === 'win32'
  const runHelper = (...args) =>
    spawnSync(process.execPath, [helper, ...args], {
      timeout: 75000,
      stdio: 'ignore',
      windowsHide: true,
    }).status === 0
  const ownerConnects = () =>
    new Promise((done) => {
      const connection = connect(socket)
      connection.once('connect', () => {
        connection.destroy()
        done(true)
      })
      connection.once('error', () => done(false))
      connection.setTimeout(2000, () => {
        connection.destroy()
        done(false)
      })
    })
  const ownerControl = async () => {
    if (!readdirSync(dirname(socket)).includes('relay.sock')) return false
    if (hosted && helper) return runHelper('--owner', dirname(socket), socket)
    // SDK launch already made an authenticated UDS request; Node cannot dial Windows AF_UNIX.
    return process.platform === 'win32' ? true : ownerConnects()
  }
  assert(await ownerControl(), 'owner directory/socket control failed')
  let crossAccount =
    process.platform === 'darwin' && hosted
      ? 'skipped-unsupported'
      : 'skipped-local'
  if (hosted && supported && helper)
    crossAccount = runHelper(dirname(socket), socket) ? 'passed' : 'failed'
  else if (
    (supported && helper) ||
    (process.env.GITHUB_ACTIONS === 'true' && (!hosted || !helper))
  )
    crossAccount = 'failed'
  assert(
    await ownerControl(),
    'owner directory/socket control failed after isolation check',
  )
  const html = readFileSync(report.launch, 'utf8')
  const launch = html.match(
    /url=(http:\/\/127\.0\.0\.1:[0-9]+\/launch\/[A-Za-z0-9_-]+)/,
  )?.[1]
  assert(launch, 'missing one-use launch URL')
  const redirect = await fetch(launch, { redirect: 'manual' })
  assert(redirect.status === 303, 'launch failed')
  const base = new URL(redirect.headers.get('location'), launch)
  const abort = new AbortController()
  stream = await fetch(new URL('events', base), { signal: abort.signal })
  assert(
    stream.status === 200 &&
      stream.headers.get('content-type')?.startsWith('text/event-stream'),
    'SSE failed',
  )
  const reader = stream.body.getReader()
  let events = ''
  while (!events.includes('"kind":"snapshot"')) {
    const part = await reader.read()
    assert(!part.done, 'SSE closed during initialization')
    events += new TextDecoder().decode(part.value)
    assert(events.length < 2000000, 'SSE initial frame too large')
  }
  const command = async (generation, value) => {
    const response = await fetch(new URL('command', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base.origin },
      body: JSON.stringify({
        v: 1,
        generation,
        command: { kind: 'settings', patch: { openMd: value } },
      }),
    })
    assert(response.ok, 'command HTTP failed')
    return response.json()
  }
  // Initialization publishes asynchronously; wait for the production ready handshake.
  let saved
  for (let n = 0; n < 50; n++) {
    saved = await command(2, 'é😀')
    if (saved.error !== 'disconnected') break
    await pause(100)
  }
  assert(
    saved?.ok === true && saved.value === 'é😀',
    'authoritative Unicode save failed',
  )
  const stale = await command(1, 'replacement')
  assert(
    stale?.ok === false && stale.error === 'stale',
    'stale mutation not refused',
  )
  abort.abort()
  await reader.cancel().catch(() => {})
  while (!closed && Date.now() < deadline) await pause(100)
  report = readJson(join(work, 'relay-production.json'))
  const end = readJson(join(work, 'relay-production-end.json'))
  assert(
    closed && exitCode === 0 && report?.phase === 'passed',
    'SDK session failed or timed out',
  )
  assert(
    end?.passed === true && end.value === 'é😀',
    'session-end store readback failed',
  )
  assert(gatewayCalls === 0, 'unexpected model gateway request')
  for (let n = 0; n < 30 && alive(pid); n++) await pause(100)
  assert(!alive(pid), 'packaged relay process survived SDK session')
  if (hosted && helper) {
    assert(
      runHelper('--closed', dirname(socket), socket),
      'relay AF_UNIX socket remained live after SDK session',
    )
  } else if (process.platform !== 'win32') {
    assert(
      !(await ownerConnects()),
      'relay socket remained live after SDK session',
    )
  }
  assert(
    crossAccount !== 'failed',
    'cross-account directory/socket isolation failed or was not configured',
  )
  console.log(
    JSON.stringify({
      result: 'passed',
      platform,
      version,
      modelRequests: gatewayCalls,
      crossAccount,
    }),
  )
} catch (error) {
  console.error(`production relay proof failed: ${error.message}`)
  process.exitCode = 1
} finally {
  if (
    child &&
    child.exitCode === null &&
    child.signalCode === null &&
    child.pid
  ) {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 10000,
        stdio: 'ignore',
        windowsHide: true,
      })
    else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    await pause(500)
  }
  if (binary && pid && alive(pid) && relayPid(binary) === pid) {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(pid), '/F'], {
        timeout: 10000,
        stdio: 'ignore',
        windowsHide: true,
      })
    else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    await pause(500)
  }
  if (gateway) await new Promise((ok) => gateway.close(ok))
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
