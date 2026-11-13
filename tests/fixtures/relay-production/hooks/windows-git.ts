import type { EngineInterface } from 'claude-code'
import {
  gitInventoryArgv,
  nativeGitInventoryArgv,
  pickFiles,
  windowsSystemRoot,
} from '../../../../hooks/workspace'

const expected = JSON.stringify(['ascii.txt', 'café-漢-😀.txt'].sort())

export async function proveWindowsGit(
  $: EngineInterface,
  cwd: string,
): Promise<'passed'> {
  const gitCwd = `${cwd}/git-unicode`
  const foreign = `${cwd}/git-foreign`
  const run = (argv: readonly string[], env?: Record<string, string>) =>
    $.process.run(argv, {
      cwd: gitCwd,
      timeoutMs: 20000,
      ...(env ? { env } : {}),
    })
  const local = await run(['git', 'rev-parse', '--local-env-vars'])
  if (
    local.exitCode !== 0 ||
    local.isStdoutTruncated ||
    local.isStderrTruncated
  )
    throw new Error('windows git: local environment discovery')
  const systemRoot = await $.env.get('SystemRoot').catch(() => undefined)
  const wrapped = nativeGitInventoryArgv(
    true,
    local.stdout.trim().split(/\r?\n/),
    systemRoot,
  )
  const systemPath = windowsSystemRoot(systemRoot)
  if (!systemPath) throw new Error('windows git: invalid SystemRoot')
  const body = wrapped[wrapped.length - 1]
  if (body === undefined) throw new Error('windows git: missing wrapper body')
  const direct = gitInventoryArgv(true)
  const hostile = {
    GIT_DIR: `${foreign}/.git`,
    GIT_WORK_TREE: foreign,
    GIT_INDEX_FILE: `${foreign}/.git/index`,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_VALUE_0: foreign,
  }
  const [clean, safe, badDirect, badWrapped, hostileDirect, hostileWrapped] =
    await Promise.all([
      run(direct),
      run(wrapped),
      run([...direct, '--brain-trail-invalid-option']),
      run([...wrapped.slice(0, -1), `${body} --brain-trail-invalid-option`]),
      run(direct, hostile),
      run(wrapped, hostile),
    ])
  if (
    [clean, safe, badDirect, badWrapped, hostileDirect, hostileWrapped].some(
      (result) => result.isStdoutTruncated || result.isStderrTruncated,
    )
  )
    throw new Error('windows git: truncated process output')
  if (
    clean.exitCode !== 0 ||
    clean.isStdoutTruncated ||
    JSON.stringify(pickFiles(clean.stdout, false, gitCwd)) !== expected
  )
    throw new Error('windows git: direct control inventory')
  if (
    safe.exitCode !== 0 ||
    safe.isStdoutTruncated ||
    safe.stdout !== clean.stdout
  )
    throw new Error('windows git: wrapped inventory')
  if (badDirect.exitCode === 0 || badWrapped.exitCode !== badDirect.exitCode)
    throw new Error('windows git: exit propagation')
  if (
    hostileDirect.exitCode !== 0 ||
    !hostileDirect.stdout.includes('foreign-canary.txt')
  )
    throw new Error('windows git: hostile environment control')
  if (
    hostileWrapped.exitCode !== 0 ||
    hostileWrapped.isStdoutTruncated ||
    hostileWrapped.stdout !== clean.stdout
  )
    throw new Error('windows git: hostile environment isolation')
  await $.fs.write(
    `${gitCwd}/git.cmd`,
    '@echo sentinel>"%~dp0sentinel-invoked.txt"\r\n@exit /b 77\r\n',
  )
  await $.fs.write(`${gitCwd}/cmd.exe`, 'not an executable')
  const original = await run(wrapped, hostile)
  const originalInvoked = await $.fs.exists(`${gitCwd}/sentinel-invoked.txt`)
  if (
    original.exitCode !== 0 ||
    original.isStdoutTruncated ||
    original.isStderrTruncated ||
    original.stdout !== clean.stdout ||
    originalInvoked
  )
    throw new Error(
      `windows git: original decoy control (exit=${original.exitCode}, sentinel=${originalInvoked}, stdoutTruncated=${original.isStdoutTruncated}, stderrTruncated=${original.isStderrTruncated})`,
    )
  const decoyed = await run(
    [
      ...wrapped.slice(0, -1),
      `set NoDefaultCurrentDirectoryInExePath=&${body}`,
    ],
    hostile,
  )
  const decoyInvoked = await $.fs.exists(`${gitCwd}/sentinel-invoked.txt`)
  if (
    decoyed.exitCode !== 0 ||
    decoyed.isStdoutTruncated ||
    decoyed.isStderrTruncated ||
    decoyed.stdout !== clean.stdout ||
    decoyInvoked
  )
    throw new Error(
      `windows git: current-directory decoys (exit=${decoyed.exitCode}, sentinel=${decoyInvoked}, stdoutTruncated=${decoyed.isStdoutTruncated}, stderrTruncated=${decoyed.isStderrTruncated})`,
    )
  const reach = await run([
    `${systemPath}\\System32\\cmd.exe`,
    '/d',
    '/v:off',
    '/s',
    '/c',
    'set NoDefaultCurrentDirectoryInExePath=&git --version',
  ])
  const reachInvoked = await $.fs.exists(`${gitCwd}/sentinel-invoked.txt`)
  if (
    reach.exitCode !== 77 ||
    reach.isStdoutTruncated ||
    reach.isStderrTruncated ||
    !reachInvoked
  )
    throw new Error(
      `windows git: decoy reachability control (exit=${reach.exitCode}, sentinel=${reachInvoked}, stdoutTruncated=${reach.isStdoutTruncated}, stderrTruncated=${reach.isStderrTruncated})`,
    )
  return 'passed'
}
