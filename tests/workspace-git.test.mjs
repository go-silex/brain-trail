import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nativeGitInventoryArgv } from '../hooks/workspace.ts'

const run = (argv, cwd, env) => {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${argv[0]} exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`

test('native Git inventory ignores hostile repository and inherited Git context', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'brain-trail-git-'))
  try {
    const root = join(sandbox, 'workspace')
    const foreign = join(sandbox, 'foreign')
    const template = join(sandbox, 'empty-template')
    const config = join(sandbox, 'gitconfig')
    const excludes = join(sandbox, 'global-excludes')
    const hook = join(sandbox, 'fsmonitor.sh')
    const sentinel = join(root, '.bt-fsmonitor-sentinel')
    for (const dir of [root, foreign, template]) mkdirSync(dir)
    writeFileSync(config, '')
    writeFileSync(excludes, 'excluded.txt\ncmd.exe\ngit.exe\n')
    writeFileSync(hook, '#!/bin/sh\nprintf invoked > .bt-fsmonitor-sentinel\n')

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
    )
    Object.assign(env, {
      HOME: sandbox,
      XDG_CONFIG_HOME: sandbox,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TEMPLATE_DIR: template,
      GIT_TERMINAL_PROMPT: '0',
    })
    run(
      ['git', 'config', '--global', 'core.excludesFile', excludes],
      sandbox,
      env,
    )
    for (const dir of [root, foreign]) run(['git', 'init', '-q'], dir, env)
    writeFileSync(join(root, 'tracked.txt'), 'workspace\n')
    writeFileSync(join(root, 'untracked.txt'), 'workspace\n')
    writeFileSync(join(root, 'excluded.txt'), 'ignored globally\n')
    writeFileSync(join(foreign, 'foreign.txt'), 'foreign\n')
    run(['git', 'add', '--', 'tracked.txt'], root, env)
    run(['git', 'add', '--', 'foreign.txt'], foreign, env)

    const hookCommand = `sh ${shellQuote(hook.replace(/\\/g, '/'))}`
    run(['git', 'config', '--local', 'core.fsmonitor', hookCommand], root, env)

    // Positive control: Git really executes this repository's configured hook.
    run(['git', 'ls-files', '-co', '--exclude-standard'], root, env)
    expect(existsSync(sentinel)).toBe(true)
    unlinkSync(sentinel)

    const names = run(['git', 'rev-parse', '--local-env-vars'], root, env)
      .trim()
      .split(/\r?\n/)
    if (process.platform === 'win32') {
      const decoy = join(process.env.SystemRoot, 'System32', 'where.exe')
      copyFileSync(decoy, join(root, 'cmd.exe'))
      copyFileSync(decoy, join(root, 'git.exe'))
    }
    const hostile = {
      ...env,
      GIT_DIR: join(foreign, '.git'),
      GIT_WORK_TREE: foreign,
      GIT_INDEX_FILE: join(foreign, '.git', 'index'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: hookCommand,
      GIT_NO_LAZY_FETCH: '0',
    }
    const argv = nativeGitInventoryArgv(
      process.platform === 'win32',
      names,
      process.env.SystemRoot,
    )
    const output = run(argv, root, hostile)
    expect(output.trim().split(/\r?\n/).sort()).toEqual([
      'tracked.txt',
      'untracked.txt',
    ])
    expect(existsSync(sentinel)).toBe(false)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('Windows inventory refuses an absent or unsafe system root', () => {
  for (const root of [
    undefined,
    null,
    '',
    'relative',
    'C:\\Windows\\..\\evil',
    ...Array.from(
      { length: 32 },
      (_, code) => `C:\\Win${String.fromCharCode(code)}dows`,
    ),
  ]) {
    expect(() => nativeGitInventoryArgv(true, ['GIT_DIR'], root)).toThrow()
  }
})
