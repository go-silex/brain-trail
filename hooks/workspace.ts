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
export const windowsSystemRoot = (systemRoot?: string): string | undefined => {
  const path = systemRoot?.replace(/\//g, '\\').replace(/\\+$/, '')
  if (path !== undefined)
    for (let i = 0; i < path.length; i++)
      if (path.charCodeAt(i) < 32) return undefined
  return path &&
    /^[A-Za-z]:\\[^\\/:*?"<>|]+(?:\\[^\\/:*?"<>|]+)*$/.test(path) &&
    !path.split('\\').some((part) => part === '.' || part === '..')
    ? path
    : undefined
}
export const nativeGitInventoryArgv = (
  windows: boolean,
  names: readonly string[],
  systemRoot?: string,
): string[] => {
  if (!names.length || !names.every((name) => /^GIT_[A-Z0-9_]+$/.test(name)))
    throw new Error('Invalid Git local environment names')
  const systemPath = windowsSystemRoot(systemRoot)
  if (windows && !systemPath) throw new Error('Invalid SystemRoot')
  const gitArgs = gitInventoryArgv(windows)
  return windows
    ? [
        `${systemPath}\\System32\\cmd.exe`,
        '/d',
        '/v:off',
        '/s',
        '/c',
        `${names.map((name) => `set ${name}=`).join('&')}&set GIT_NO_LAZY_FETCH=1&set NoDefaultCurrentDirectoryInExePath=1&git ${gitArgs.slice(1).join(' ')}`,
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
