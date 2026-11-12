import { constants } from 'node:fs'
import { open, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

export class FileAuthorityError extends Error {
  constructor(
    readonly reason: 'missing' | 'forbidden' | 'unsupported' | 'cancelled',
  ) {
    super(reason)
  }
}

const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new FileAuthorityError('cancelled')
}
const within = (root: string, path: string) => {
  const part = relative(root, path)
  return (
    part !== '' &&
    part !== '..' &&
    !part.startsWith(`..${sep}`) &&
    !isAbsolute(part)
  )
}
const missing = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT'

export async function withOpenedFile<T>(
  path: string,
  root: string | undefined,
  signal: AbortSignal,
  use: (file: FileHandle, canonical: string) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'linux') throw new FileAuthorityError('unsupported')
  check(signal)
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch (error) {
    throw new FileAuthorityError(missing(error) ? 'missing' : 'forbidden')
  }
  check(signal)
  if (root !== undefined && !within(root, canonical))
    throw new FileAuthorityError('forbidden')
  let file: FileHandle
  try {
    file = await open(
      canonical,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    )
  } catch (error) {
    throw new FileAuthorityError(missing(error) ? 'missing' : 'forbidden')
  }
  try {
    check(signal)
    if (!(await file.stat()).isFile()) throw new FileAuthorityError('forbidden')
    let opened: string
    try {
      opened = await readlink(`/proc/self/fd/${file.fd}`)
    } catch {
      throw new FileAuthorityError('unsupported')
    }
    check(signal)
    if (opened !== canonical || (root !== undefined && !within(root, opened)))
      throw new FileAuthorityError('forbidden')
    return await use(file, canonical)
  } finally {
    await file.close()
  }
}

export async function readPrefix(
  file: FileHandle,
  signal: AbortSignal,
  units: number,
): Promise<string> {
  const bytes = Buffer.alloc(160004)
  let offset = 0
  while (offset < bytes.length) {
    check(signal)
    const result = await file.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  check(signal)
  return bytes.subarray(0, offset).toString('utf8').slice(0, units)
}
