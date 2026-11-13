import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { withNativeFile } from '../hosts/native/files'
import type { RelayClient } from '../hosts/relay/client'

test('approval arriving after a generation change cannot read the held file', async () => {
  let generation = 1
  let answer!: (value: string) => void
  let asked!: () => void
  const prompt = new Promise<string>((resolve) => {
    answer = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    asked = resolve
  })
  const engine = {
    session: { surfaces: async () => ['desktop'] },
    ui: {
      ask: async () => {
        asked()
        return prompt
      },
    },
  } as unknown as EngineInterface
  let released = 0
  let used = 0
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
  const operation = withNativeFile(
    engine,
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
  answer('Allow')
  expect(await operation).toContain('stale-generation')
  expect(used).toBe(0)
  expect(released).toBe(1)
})

test('unknown references and unlisted applications cannot reach file preparation', async () => {
  let prepared = 0
  const engine = {} as EngineInterface
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
      engine,
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

test('external opens require exact consent and release the held file on refusal', async () => {
  for (const answer of ['Deny', '', 'allow']) {
    let used = 0
    let released = 0
    const questions: string[] = []
    const engine = {
      session: { surfaces: async () => ['desktop'] },
      ui: {
        ask: async (question: string) => {
          questions.push(question)
          return answer
        },
      },
    } as unknown as EngineInterface
    const relay = {
      prepareFile: async () => ({
        id: 'held',
        path: '/work/known.md',
        inside: true,
      }),
      verifyFile: async () => true,
      releaseFile: async () => {
        released++
      },
    } as unknown as RelayClient
    const result = await withNativeFile(
      engine,
      relay,
      {
        root: '/work',
        generation: 1,
        refreshGeneration: async () => {},
        currentGeneration: () => 1,
        known: async () => true,
        apps: ['Editor'],
      },
      { p: 'known.md' },
      { kind: 'open', app: 'Editor' },
      async () => {
        used++
      },
    ).then(
      () => 'unexpected success',
      (error: unknown) => String(error),
    )
    expect(result).toContain('forbidden')
    expect(questions).toEqual(['Open /work/known.md with Editor?'])
    expect(used).toBe(0)
    expect(released).toBe(1)
  }
})
