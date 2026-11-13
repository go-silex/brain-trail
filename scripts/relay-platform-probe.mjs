// Temporary development-only probe. This does not test a packaged release.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(
  process.env.RELAY_PROBE_OUTPUT || join(root, 'relay-probe-output'),
)
const cliRoot = resolve(process.env.RELAY_CLI_ROOT || root)
const version = process.env.RELAY_CLAUDE_VERSION || '2.1.322'
const platform = `${process.platform}-${process.arch}`
const summary = {
  platform,
  claude: version,
  distribution: 'CI-built fixture; not packaged release proof',
  minimumClaude: '2.1.275 (README); not tested by this probe',
  result: 'failed',
  gatewayRequests: [],
  windowsAcl: 'not-applicable',
}
let temp, child, server, report, socketDir, work
let stdout = '',
  stderr = '',
  buildLog = ''
const maxLog = 65536
const append = (current, chunk) =>
  current.length >= maxLog
    ? current
    : (current + chunk.toString()).slice(0, maxLog)
const redact = (text) =>
  temp
    ? text
        .split(temp)
        .join('<isolated-temp>')
        .split(JSON.stringify(temp).slice(1, -1))
        .join('<isolated-temp>')
    : text
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const inside = (parent, path) => {
  const r = relative(parent, path)
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}
const fail = (message) => {
  throw new Error(message)
}

try {
  mkdirSync(output, { recursive: true })
  temp = mkdtempSync(join(tmpdir(), 'relay-probe-'))
  const home = join(temp, 'home'),
    config = join(temp, 'config'),
    scratch = join(temp, 'tmp')
  work = join(temp, 'work')
  for (const dir of [home, config, work, scratch])
    mkdirSync(dir, { mode: 0o700 })
  const plugin = join(temp, 'plugin')
  cpSync(join(root, 'tests/fixtures/relay-capability/plugin'), plugin, {
    recursive: true,
  })
  const binaryName =
    process.platform === 'win32' ? 'relay-capability.exe' : 'relay-capability'
  writeFileSync(join(plugin, 'relay-binary.txt'), binaryName)
  const build = spawnSync('go', ['build', '-o', binaryName, '.'], {
    cwd: plugin,
    timeout: 180000,
    encoding: 'utf8',
    maxBuffer: maxLog,
    windowsHide: true,
  })
  buildLog = `${build.stdout || ''}\n${build.stderr || ''}`.slice(0, maxLog)
  if (build.error || build.status !== 0)
    fail('Go fixture build failed or timed out')
  const override = process.env.RELAY_CLI_EXECUTABLE
  const pkg = join(
    cliRoot,
    'node_modules',
    '@anthropic-ai',
    `claude-code-${platform}`,
  )
  if (!override && readJson(join(pkg, 'package.json'))?.version !== version)
    fail('Pinned native Claude package is missing or version mismatch')
  const claude = override
    ? resolve(override)
    : join(pkg, process.platform === 'win32' ? 'claude.exe' : 'claude')
  summary.cliSource = override
    ? 'explicit native executable; backend CLI only, not Desktop UI'
    : 'pinned native npm package'
  if (!existsSync(claude))
    fail('Native Claude executable missing for this platform')
  server = createServer((req, res) => {
    if (summary.gatewayRequests.length < 32)
      summary.gatewayRequests.push({
        method: req.method,
        path: (req.url || '').split('?')[0].slice(0, 256),
      })
    summary.gatewayRequestCount = (summary.gatewayRequestCount || 0) + 1
    req.resume()
    res.writeHead(503)
    res.end()
  })
  await new Promise((ok, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', ok)
  })
  const env = {
    PATH: process.env.PATH || '',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: join(temp, 'cache'),
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_AUTH_TOKEN: 'probe-no-model',
  }
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ])
    if (process.env[key]) env[key] = process.env[key]
  if (override) {
    const actual = spawnSync(claude, ['--version'], {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
      windowsHide: true,
    })
    const actualVersion = (actual.stdout || '').trim().split(/\s+/)[0]
    summary.observedCliVersion = actualVersion || null
    if (actual.error || actual.status !== 0 || actualVersion !== version)
      fail(
        'Explicit Claude executable version mismatch or version command failed',
      )
  }
  child = spawn(
    claude,
    [
      '-p',
      '/relay-capability',
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
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  )
  child.stdout.on('data', (chunk) => {
    stdout = append(stdout, chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr = append(stderr, chunk)
  })
  let closed = false,
    exitCode = null,
    spawnError = false
  child.once('error', (error) => {
    spawnError = true
    stderr = append(stderr, `\n${error.message}`)
    closed = true
  })
  child.once('close', (code) => {
    exitCode = code
    closed = true
  })
  const deadline = Date.now() + 75000
  while (!closed && Date.now() < deadline) {
    report = readJson(join(work, 'probe-report.json')) || report
    if (!socketDir && report?.socketPath) {
      socketDir = dirname(resolve(report.socketPath))
      if (
        !inside(scratch, socketDir) ||
        !basename(socketDir).startsWith('btr-')
      )
        fail('Socket directory outside isolated temporary root')
      if (process.platform === 'win32') {
        // Report only counts, never usernames, paths, or raw ACL output.
        const ps =
          "$a=Get-Acl -LiteralPath $env:RELAY_ACL_PATH; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $safe=@($me,'S-1-5-18','S-1-5-32-544'); $rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); $other=@($rules | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $safe }); Write-Output $other.Count"
        const acl = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', ps],
          {
            env: { ...env, RELAY_ACL_PATH: socketDir },
            encoding: 'utf8',
            timeout: 10000,
            windowsHide: true,
          },
        )
        const count =
          acl.status === 0 && /^\s*\d+\s*$/.test(acl.stdout)
            ? Number(acl.stdout.trim())
            : null
        summary.windowsAcl =
          count === null
            ? 'inspection-failed'
            : count === 0
              ? 'no-other-allow-entries-observed'
              : 'other-allow-entries-observed'
        summary.windowsOtherAllowEntries = count
        if (count === null)
          summary.windowsAclError = redact(
            `${acl.error?.message || ''}\n${acl.stderr || ''}\n${acl.stdout || ''}`.slice(
              0,
              4096,
            ),
          )
      } else {
        summary.socketDirectoryMode = (
          statSync(socketDir).mode & 0o777
        ).toString(8)
      }
    }
    await pause(100)
  }
  report = readJson(join(work, 'probe-report.json')) || report
  const end = readJson(join(work, 'probe-end.json'))
  if (summary.gatewayRequestCount)
    fail('Unexpected inert gateway request attempted')
  if (!closed)
    fail('Headless command timed out; route or session termination unproven')
  if (report?.error)
    fail(`Fixture error: ${String(report.error).slice(0, 1024)}`)
  if (spawnError || exitCode !== 0)
    fail(`Claude startup or headless command failed (exit ${exitCode})`)
  if (
    report?.phase !== 'passed-awaiting-session-end' ||
    !Number.isSafeInteger(report.pid) ||
    report.pid <= 0 ||
    !socketDir
  )
    fail(
      `Missing relay startup/socket proof (phase ${report?.phase || 'missing'})`,
    )
  const ack = report.acknowledgements
  if (
    !Array.isArray(ack) ||
    ack.length !== 2 ||
    !ack.some(
      (a) => a.id === 'valid' && a.status === 'saved' && a.value === 'é😀',
    ) ||
    !ack.some(
      (a) =>
        a.id === 'stale' &&
        a.status === 'refused-generation' &&
        a.value === 'é😀',
    )
  )
    fail(
      `Missing store or stale-generation proof: ${JSON.stringify(ack ?? null).slice(0, 1024)}`,
    )
  if (
    end?.phase !== 'session-end' ||
    end.value !== 'é😀' ||
    end.roundtripPassed !== true
  )
    fail('Missing session-end store/lifecycle proof')
  for (let n = 0; n < 30 && alive(report.pid); n++) await pause(100)
  if (alive(report.pid)) fail('Relay still present after Claude exited')
  if (process.platform !== 'win32' && summary.socketDirectoryMode !== '700')
    fail('Socket directory is not mode 0700')
  if (
    process.platform === 'win32' &&
    summary.windowsAcl !== 'no-other-allow-entries-observed'
  )
    fail('Windows socket directory ACL privacy not established')
  summary.result = 'passed'
} catch (error) {
  summary.reason = redact(error.message)
  process.exitCode = 1
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid)
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 10000,
        windowsHide: true,
      })
    else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    await pause(500)
  }
  if (server) await new Promise((ok) => server.close(ok))
  if (work) {
    report = readJson(join(work, 'probe-report.json')) || report
    if (report?.error)
      summary.fixtureError = redact(String(report.error).slice(0, 1024))
    for (const name of [
      'probe-report.json',
      'probe-end.json',
      'probe-error.json',
      'probe-end-error.json',
    ]) {
      const path = join(work, name)
      if (existsSync(path))
        writeFileSync(
          join(output, name),
          redact(readFileSync(path, 'utf8').slice(0, maxLog)),
        )
    }
  }
  writeFileSync(join(output, 'claude-stdout.log'), redact(stdout))
  writeFileSync(join(output, 'claude-stderr.log'), redact(stderr))
  if (buildLog) writeFileSync(join(output, 'go-build.log'), redact(buildLog))
  // Only remove the socket directory after the recorded relay is gone.
  if (socketDir && report?.pid && !alive(report.pid))
    rmSync(socketDir, { recursive: true, force: true })
  if (temp && (!report?.pid || !alive(report.pid)))
    rmSync(temp, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  writeFileSync(
    join(output, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
  console.log(JSON.stringify(summary))
}
