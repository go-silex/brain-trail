/// <reference lib="dom" />
import { expect, test } from 'claude-code/testing'
import { coworkTransport } from '../hosts/browser/cowork-transport'
import type { ServerEvent } from '../types/browser'

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
const receipt = {
  v: 1,
  n: 1,
  at: 100,
  ev: 'tool',
  tool: 'Read',
  ok: true,
  agent: false,
  files: [{ p: '/work/a.md', k: 'read' }],
}

test('publishes layout before snapshot and keeps ended sessions readable', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return {
      ok: true,
      json: async () => ({
        session: 'task',
        receipts: [receipt],
        next: 1,
        ended: true,
        truncated: false,
      }),
    } as Response
  }) as typeof fetch
  const events: ServerEvent[] = []
  const closed: string[] = []
  const transport = coworkTransport('task')
  const dispose = transport.listen({
    ready() {},
    event: (value) => events.push(value),
    closed: (reason) => closed.push(reason),
  })
  try {
    await settle()
    expect(urls).toEqual(['cowork/receipts?session=task&after=0'])
    expect(events.map((e) => e.kind)).toEqual(['layout', 'snapshot'])
    const layout = events[0]
    const snapshot = events[1]
    if (layout?.kind !== 'layout' || snapshot?.kind !== 'snapshot')
      throw new Error('Missing events')
    expect(layout.layout.paths).toEqual(['a.md'])
    expect(snapshot.facts.ownerHost).toBe('cowork')
    expect(snapshot.facts.workspace.kind).toBe('ready')
    expect(closed).toEqual([])
    expect(
      await transport.execute({
        v: 1,
        generation: 1,
        command: {
          kind: 'view',
          intent: { kind: 'replay-step', by: 1, steps: 999 },
        },
      }),
    ).toEqual({ ok: true })
    expect(
      await transport.execute({
        v: 1,
        generation: 1,
        command: { kind: 'clear-trail' },
      }),
    ).toEqual({ ok: false, error: 'unsupported' })
    expect(
      await transport.execute({
        v: 1,
        generation: 2,
        command: { kind: 'lang', lang: 'fr' },
      }),
    ).toEqual({ ok: false, error: 'stale-generation' })
    expect(
      await transport.execute({
        v: 1,
        generation: 1,
        command: { kind: 'settings', patch: { openMd: 'x' } },
      }),
    ).toEqual({ ok: false, error: 'unsupported' })
  } finally {
    dispose()
    globalThis.fetch = originalFetch
  }
})

test('empty session is honest and local settings and language publish snapshots', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        session: 'empty',
        receipts: [],
        next: 0,
        ended: true,
        truncated: false,
      }),
    }) as Response) as typeof fetch
  const events: ServerEvent[] = []
  const transport = coworkTransport('empty')
  const dispose = transport.listen({
    ready() {},
    event: (value) => events.push(value),
    closed() {},
  })
  try {
    await settle()
    expect(events.map((e) => e.kind)).toEqual(['snapshot'])
    expect(
      await transport.execute({
        v: 1,
        generation: 1,
        command: { kind: 'lang', lang: 'fr' },
      }),
    ).toEqual({ ok: true })
    expect(
      await transport.execute({
        v: 1,
        generation: 1,
        command: { kind: 'settings', patch: { hover: false, band: true } },
      }),
    ).toEqual({ ok: true })
    const last = events[events.length - 1]
    if (last?.kind !== 'snapshot') throw new Error('Missing snapshot')
    expect(last.revision).toBe(3)
    expect(last.facts.workspace.kind).toBe('failed')
    expect(last.facts.lang).toBe('fr')
    expect(last.facts.settings.hover).toBe(false)
    expect(last.facts.settings.band).toBe(true)
  } finally {
    dispose()
    globalThis.fetch = originalFetch
  }
})

test('rejects malformed receipts without publishing them', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        session: 'task',
        receipts: [{ ...receipt, n: 2 }],
        next: 1,
        ended: true,
        truncated: false,
      }),
    }) as Response) as typeof fetch
  const events: ServerEvent[] = []
  const closed: string[] = []
  const dispose = coworkTransport('task').listen({
    ready() {},
    event: (value) => events.push(value),
    closed: (reason) => closed.push(reason),
  })
  try {
    await settle()
    expect(events).toEqual([])
    expect(closed).toEqual(['disconnected'])
  } finally {
    dispose()
    globalThis.fetch = originalFetch
  }
})

test('drains all pages of an ended session before stopping', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: Array<() => void> = []
  globalThis.setTimeout = ((fn: () => void) => {
    scheduled.push(fn)
    return 1
  }) as typeof setTimeout
  const urls: string[] = []
  const first = Array.from({ length: 1000 }, (_, i) => ({
    v: 1,
    n: i + 1,
    at: i,
    ev: 'start',
  }))
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const nextPage = urls.length > 1
    return {
      ok: true,
      json: async () => ({
        session: 'task',
        receipts: nextPage ? [{ ...receipt, n: 1001 }] : first,
        next: nextPage ? 1001 : 1000,
        ended: true,
        truncated: false,
      }),
    } as Response
  }) as typeof fetch
  const events: ServerEvent[] = []
  const dispose = coworkTransport('task').listen({
    ready() {},
    event: (value) => events.push(value),
    closed() {},
  })
  try {
    await settle()
    scheduled.shift()?.()
    await settle()
    expect(urls).toEqual([
      'cowork/receipts?session=task&after=0',
      'cowork/receipts?session=task&after=1000',
    ])
    expect(events.map((e) => e.kind)).toEqual([
      'snapshot',
      'layout',
      'snapshot',
    ])
  } finally {
    dispose()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})
