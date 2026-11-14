import { expect, test } from 'claude-code/testing'

import { withNativeFile } from '../hosts/native/files'
import type { RelayClient } from '../hosts/relay/client'

test('a generation change during file verification prevents use and releases the held file', async () => {
  let generation = 1
  let finishVerification!: (value: boolean) => void
  let verificationStarted!: () => void
  const verification = new Promise<boolean>((resolve) => {
    finishVerification = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    verificationStarted = resolve
  })
  let released = 0
  let used = 0
  const relay = {
    prepareFile: async () => ({
      id: 'held',
      path: '/outside/note.md',
      inside: false,
    }),
    verifyFile: async () => {
      verificationStarted()
      return verification
    },
    releaseFile: async () => {
      released++
    },
  } as unknown as RelayClient
  const operation = withNativeFile(
    relay,
    {
      root: '/work',
      generation: 1,
      refreshGeneration: async () => {},
      currentGeneration: () => generation,
      known: async () => true,
      apps: [],
    },
    { p: '/outside/note.md', out: true },
    { kind: 'preview' },
    async () => {
      used++
      return 'secret'
    },
  ).then(
    () => 'unexpected success',
    (error: unknown) => String(error),
  )
  await waiting
  generation = 2
  finishVerification(true)
  expect(await operation).toContain('stale-generation')
  expect(used).toBe(0)
  expect(released).toBe(1)
})

test('unknown references and unlisted applications cannot reach file preparation', async () => {
  let prepared = 0
  const relay = {
    prepareFile: async () => {
      prepared++
      throw new Error('unexpected preparation')
    },
  } as unknown as RelayClient
  const authority = {
    root: '/work',
    generation: 1,
    refreshGeneration: async () => {},
    currentGeneration: () => 1,
    known: async (ref: { p: string }) => ref.p === 'known.md',
    apps: ['Editor'],
  }
  const attempt = (ref: { p: string }, app: string) =>
    withNativeFile(
      relay,
      authority,
      ref,
      { kind: 'open', app },
      async () => 'opened',
    ).then(
      () => 'unexpected success',
      (error: unknown) => String(error),
    )
  expect(await attempt({ p: 'unknown.md' }, 'Editor')).toContain('forbidden')
  expect(await attempt({ p: 'known.md' }, 'unlisted')).toContain('forbidden')
  expect(prepared).toBe(0)
})

test('known outside previews and allowed application opens use and release verified files', async () => {
  const prepared: string[] = []
  const verified: string[] = []
  const released: string[] = []
  const used: string[] = []
  const relay = {
    prepareFile: async (_root: string, path: string) => {
      prepared.push(path)
      return { id: path, path, inside: path.startsWith('/work/') }
    },
    verifyFile: async (id: string) => {
      verified.push(id)
      return true
    },
    releaseFile: async (id: string) => {
      released.push(id)
    },
  } as unknown as RelayClient
  const authority = {
    root: '/work',
    generation: 1,
    refreshGeneration: async () => {},
    currentGeneration: () => 1,
    known: async () => true,
    apps: ['Editor'],
  }
  const use = async (id: string) => {
    used.push(id)
    return `used ${id}`
  }
  expect(
    await withNativeFile(
      relay,
      authority,
      { p: '/outside/note.md', out: true },
      { kind: 'preview' },
      use,
    ),
  ).toBe('used /outside/note.md')
  expect(
    await withNativeFile(
      relay,
      authority,
      { p: 'known.md' },
      { kind: 'open', app: 'Editor' },
      use,
    ),
  ).toBe('used /work/known.md')
  expect(prepared).toEqual(['/outside/note.md', '/work/known.md'])
  expect(verified).toEqual(prepared)
  expect(used).toEqual(prepared)
  expect(released).toEqual(prepared)
})

test('relative references resolving outside the workspace are refused and released', async () => {
  let used = 0
  let released = 0
  const relay = {
    prepareFile: async () => ({
      id: 'held',
      path: '/outside/note.md',
      inside: false,
    }),
    verifyFile: async () => true,
    releaseFile: async () => {
      released++
    },
  } as unknown as RelayClient
  const result = await withNativeFile(
    relay,
    {
      root: '/work',
      generation: 1,
      refreshGeneration: async () => {},
      currentGeneration: () => 1,
      known: async () => true,
      apps: [],
    },
    { p: 'link.md' },
    { kind: 'preview' },
    async () => {
      used++
      return 'secret'
    },
  ).then(
    () => 'unexpected success',
    (error: unknown) => String(error),
  )
  expect(result).toContain('forbidden')
  expect(used).toBe(0)
  expect(released).toBe(1)
})

test('failed identity verification and failed use both release the held file', async () => {
  let verified = false
  let released = 0
  let used = 0
  const relay = {
    prepareFile: async () => ({
      id: 'held',
      path: '/work/known.md',
      inside: true,
    }),
    verifyFile: async () => verified,
    releaseFile: async () => {
      released++
    },
  } as unknown as RelayClient
  const authority = {
    root: '/work',
    generation: 1,
    refreshGeneration: async () => {},
    currentGeneration: () => 1,
    known: async () => true,
    apps: ['Editor'],
  }
  const attempt = () =>
    withNativeFile(
      relay,
      authority,
      { p: 'known.md' },
      { kind: 'open', app: 'Editor' },
      async () => {
        used++
        throw new Error('open failed')
      },
    ).then(
      () => 'unexpected success',
      (error: unknown) => String(error),
    )
  expect(await attempt()).toContain('forbidden')
  expect(used).toBe(0)
  expect(released).toBe(1)
  verified = true
  expect(await attempt()).toContain('open failed')
  expect(used).toBe(1)
  expect(released).toBe(2)
})
