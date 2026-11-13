import type { TrailSettings } from '../types/model'
import { keepFile, MAX_FILES } from './files'

export const hash = (s: string) => {
  let h = 5381
  for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
  return h.toString(36)
}
export const vaultProbe = (cwd: string, home: string): string[] => {
  const dirs: string[] = []
  for (
    let dir = cwd, k = 0;
    k < 8 && dir.startsWith(`${home}/`) && dir !== home;
    k++, dir = dir.slice(0, dir.lastIndexOf('/'))
  )
    dirs.push(dir)
  return dirs
}
export const isShallow = (root: string, home: string) =>
  root === home ||
  root === '' ||
  root === '/' ||
  root === '/Users' ||
  root === '/home'
export const gitInventoryArgv = (windows: boolean): string[] => [
  'git',
  '--no-pager',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=',
  '-c',
  `core.hooksPath=${windows ? '\\\\.\\NUL' : '/dev/null'}`,
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.askPass=',
  '-c',
  'submodule.recurse=false',
  'ls-files',
  '-co',
  '--exclude-standard',
]
export const nativeGitInventoryArgv = (
  windows: boolean,
  names: readonly string[],
): string[] => {
  if (!names.length || !names.every((name) => /^GIT_[A-Z0-9_]+$/.test(name)))
    throw new Error('Invalid Git local environment names')
  const gitArgs = gitInventoryArgv(windows)
  return windows
    ? [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${names.map((name) => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`).join('; ')}; $env:GIT_NO_LAZY_FETCH='1'; & git ${gitArgs
          .slice(1)
          .map((arg) => `'${arg.replace(/'/g, "''")}'`)
          .join(' ')}; exit $LASTEXITCODE`,
      ]
    : [
        'env',
        ...names.flatMap((name) => ['-u', name]),
        'GIT_NO_LAZY_FETCH=1',
        ...gitArgs,
      ]
}
export const findArgv = (shallow: boolean): string[] => {
  const heavy = [
    'node_modules',
    'dist',
    'build',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    'Library',
    'Applications',
    'Pictures',
    'Movies',
    'Music',
    'Photos Library.photoslibrary',
  ]
  const prune = [
    '(',
    '(',
    '-name',
    '.*',
    '!',
    '-name',
    '.claude',
    '!',
    '-name',
    '.github',
    ')',
    ...heavy.flatMap((n) => ['-o', '-name', n]),
    ')',
  ]
  return [
    'find',
    '.',
    '-mindepth',
    '1',
    ...(shallow ? ['-maxdepth', '3'] : []),
    ...prune,
    '-prune',
    '-o',
    '-type',
    'f',
    '-print',
  ]
}
export const fromFind = (stdout: string) =>
  stdout
    .split('\n')
    .map((p) => p.replace(/^\.\//, ''))
    .join('\n')
export const pickFiles = (
  raw: string,
  vault: boolean,
  root: string,
): string[] => {
  const all = raw
    .split('\n')
    .map((p) => p.normalize('NFC'))
    .filter((p) => keepFile(p) && (!vault || p.endsWith('.md')))
  const list = (
    all.length > MAX_FILES
      ? [...all]
          .sort(
            (a, z) =>
              a.split('/').length - z.split('/').length || a.localeCompare(z),
          )
          .slice(0, MAX_FILES)
      : all
  ).sort()
  if (list.length === 0) throw new Error(`no file under ${root}`)
  return list
}
export const DEFAULT_SETTINGS: TrailSettings = {
  openMd: 'default',
  openOther: 'default',
  hover: true,
}
export const initialSettings = (
  vault: boolean,
  saved: Partial<TrailSettings> | undefined,
): TrailSettings => ({
  ...DEFAULT_SETTINGS,
  ...(vault ? { openMd: 'Obsidian' } : {}),
  ...(saved ?? {}),
})
export const EDITORS = [
  'Obsidian',
  'Visual Studio Code',
  'Cursor',
  'Windsurf',
  'Zed',
  'Sublime Text',
  'Typora',
  'iA Writer',
  'Bear',
  'TextEdit',
  'Xcode',
  'BBEdit',
  'Nova',
]
