/// <reference lib="dom" />
import { expect, test } from 'claude-code/testing'
import {
  coworkNotices,
  coworkTransport,
} from '../hosts/browser/cowork-transport'
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
        instance: 1,
        receipts: [receipt],
        next: 1,
        ended: true,
        truncated: false,
        more: false,
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
        instance: 1,
        receipts: [],
        next: 0,
        ended: true,
        truncated: false,
        more: false,
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

test('rejects malformed envelopes without publishing them', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        session: 'task',
        instance: 1,
        receipts: [receipt],
        next: 1,
        ended: true,
        truncated: false,
        more: 'false',
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
  const first = [{ v: 1, n: 1, at: 0, ev: 'start' }]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const nextPage = urls.length > 1
    return {
      ok: true,
      json: async () => ({
        session: 'task',
        instance: 1,
        receipts: nextPage ? [{ ...receipt, n: 2 }] : first,
        next: nextPage ? 2 : 1,
        ended: true,
        truncated: false,
        more: !nextPage,
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
      'cowork/receipts?session=task&after=1',
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

test('skips invalid receipts and advances to the next page', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: Array<{ fn: () => void; delay: number }> = []
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    scheduled.push({ fn, delay })
    return 1
  }) as typeof setTimeout
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const first = urls.length === 1
    return {
      ok: true,
      json: async () => ({
        session: 'task',
        instance: 1,
        receipts: first
          ? [
              { ...receipt, n: 1, at: 'invalid' },
              { ...receipt, n: 2 },
            ]
          : [{ ...receipt, n: 3, files: [{ p: '/work/b.md', k: 'read' }] }],
        next: first ? 2 : 3,
        ended: true,
        truncated: false,
        more: first,
      }),
    } as Response
  }) as typeof fetch
  const events: ServerEvent[] = []
  const closed: string[] = []
  const dispose = coworkTransport('task').listen({
    ready() {},
    event: (value) => events.push(value),
    closed: (reason) => closed.push(reason),
  })
  try {
    await settle()
    expect(scheduled[0]?.delay).toBe(0)
    scheduled.shift()?.fn()
    await settle()
    expect(urls).toEqual([
      'cowork/receipts?session=task&after=0',
      'cowork/receipts?session=task&after=2',
    ])
    const layouts = events.filter((event) => event.kind === 'layout')
    const last = layouts[layouts.length - 1]
    if (last?.kind !== 'layout') throw new Error('Missing layout')
    expect(last.layout.paths).toEqual(['a.md', 'b.md'])
    expect(closed).toEqual([])
    expect(scheduled[0]?.delay).toBe(5000)
  } finally {
    dispose()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('publishes and retains truncation on an empty poll', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: Array<() => void> = []
  globalThis.setTimeout = ((fn: () => void) => {
    scheduled.push(fn)
    return 1
  }) as typeof setTimeout
  let calls = 0
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        session: 'task',
        instance: 1,
        receipts: [],
        next: 0,
        ended: ++calls === 2,
        truncated: calls === 2,
        more: false,
      }),
    }) as Response) as typeof fetch
  const events: ServerEvent[] = []
  const transport = coworkTransport('task')
  const dispose = transport.listen({
    ready() {},
    event: (value) => events.push(value),
    closed() {},
  })
  try {
    await settle()
    scheduled.shift()?.()
    await settle()
    await transport.execute({
      v: 1,
      generation: 1,
      command: { kind: 'lang', lang: 'fr' },
    })
    const snapshots = events.filter((event) => event.kind === 'snapshot')
    const last = snapshots[snapshots.length - 1]
    if (last?.kind !== 'snapshot') throw new Error('Missing snapshot')
    expect(snapshots.length).toBe(3)
    expect(last.facts.coworkCoverage?.truncated).toBe(true)
  } finally {
    dispose()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('connector-only task publishes a ready empty layout and observed events', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        session: 'task',
        instance: 1,
        receipts: [
          {
            v: 1,
            n: 1,
            at: 100,
            ev: 'tool',
            tool: 'mcp__drive__read',
            ok: true,
            agent: false,
            mcp: { server: 'drive', tool: 'read' },
          },
        ],
        next: 1,
        ended: true,
        truncated: false,
        more: false,
      }),
    }) as Response) as typeof fetch
  const events: ServerEvent[] = []
  const dispose = coworkTransport('task').listen({
    ready() {},
    event: (value) => events.push(value),
    closed() {},
  })
  try {
    await settle()
    const layout = events.find((event) => event.kind === 'layout')
    const snapshot = events.find((event) => event.kind === 'snapshot')
    if (layout?.kind !== 'layout' || snapshot?.kind !== 'snapshot')
      throw new Error('Missing events')
    expect(layout.layout.paths).toEqual([])
    expect(snapshot.facts.workspace.kind).toBe('ready')
    expect(snapshot.facts.connected.length).toBe(1)
    expect(snapshot.facts.events.some((event) => event.k === 'mcp')).toBe(true)
  } finally {
    dispose()
    globalThis.fetch = originalFetch
  }
})

test('publishes partial inventory coverage when observed files exceed the cap', async () => {
  const originalFetch = globalThis.fetch
  const receipts = Array.from({ length: 61 }, (_, i) => ({
    v: 1,
    n: i + 1,
    at: i,
    ev: 'tool',
    tool: 'Glob',
    ok: true,
    agent: false,
    seen: Array.from(
      { length: i === 60 ? 1 : 200 },
      (_, j) => `/work/f${i * 200 + j}.md`,
    ),
  }))
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        session: 'task',
        instance: 1,
        receipts,
        next: 61,
        ended: true,
        truncated: false,
        more: false,
      }),
    }) as Response) as typeof fetch
  const events: ServerEvent[] = []
  const dispose = coworkTransport('task').listen({
    ready() {},
    event: (value) => events.push(value),
    closed() {},
  })
  try {
    await settle()
    const layout = events.find((event) => event.kind === 'layout')
    const snapshot = events.find((event) => event.kind === 'snapshot')
    if (layout?.kind !== 'layout' || snapshot?.kind !== 'snapshot')
      throw new Error('Missing events')
    expect(layout.layout.paths.length).toBe(12000)
    expect(snapshot.facts.coworkCoverage?.partialInventory).toBe(true)
  } finally {
    dispose()
    globalThis.fetch = originalFetch
  }
})

test('continues after end, accepts late and resumed tools, and resets a recreated session', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: Array<{ fn: () => void; delay: number }> = []
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    scheduled.push({ fn, delay })
    return 1
  }) as typeof setTimeout
  const urls: string[] = []
  const connector = {
    v: 1,
    n: 2,
    at: 101,
    ev: 'tool',
    tool: 'mcp__drive__read',
    ok: true,
    agent: false,
    mcp: { server: 'drive', tool: 'read' },
  }
  const pages = [
    { instance: 1, receipts: [receipt], next: 1, ended: true, truncated: true },
    {
      instance: 1,
      receipts: [connector],
      next: 2,
      ended: true,
      truncated: true,
    },
    {
      instance: 1,
      receipts: [{ ...receipt, n: 3, files: [{ p: '/work/b.md', k: 'read' }] }],
      next: 3,
      ended: false,
      truncated: true,
    },
    { instance: 2, receipts: [], next: 3, ended: false, truncated: false },
    {
      instance: 2,
      receipts: [{ ...receipt, files: [{ p: '/new/c.md', k: 'read' }] }],
      next: 1,
      ended: false,
      truncated: false,
    },
  ]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const page = pages[urls.length - 1]
    return {
      ok: true,
      json: async () => ({ session: 'task', more: false, ...page }),
    } as Response
  }) as typeof fetch
  const events: ServerEvent[] = []
  const closed: string[] = []
  const dispose = coworkTransport('task').listen({
    ready() {},
    event: (event) => events.push(event),
    closed: (reason) => closed.push(reason),
  })
  try {
    await settle()
    for (const delay of [5000, 5000, 1000, 0]) {
      const timer = scheduled.shift()
      expect(timer?.delay).toBe(delay)
      timer?.fn()
      await settle()
      if (urls.length === 2)
        expect(events.filter((event) => event.kind === 'layout').length).toBe(1)
    }
    expect(urls).toEqual([
      'cowork/receipts?session=task&after=0',
      'cowork/receipts?session=task&after=1',
      'cowork/receipts?session=task&after=2',
      'cowork/receipts?session=task&after=3',
      'cowork/receipts?session=task&after=0',
    ])
    const layouts = events.filter((event) => event.kind === 'layout')
    const lastLayout = layouts[layouts.length - 1]
    if (lastLayout?.kind !== 'layout') throw new Error('Missing layout')
    expect(lastLayout.layout.paths).toEqual(['c.md'])
    const snapshots = events.filter((event) => event.kind === 'snapshot')
    const last = snapshots[snapshots.length - 1]
    if (last?.kind !== 'snapshot') throw new Error('Missing snapshot')
    expect(last.facts.connected).toEqual([])
    expect(last.facts.coworkCoverage?.truncated).toBe(false)
    expect(scheduled[0]?.delay).toBe(1000)
    expect(closed).toEqual([])
  } finally {
    dispose()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('rejects pages whose raw final sequence disagrees with the cursor', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const page of [
      { receipts: [], next: 1 },
      { receipts: [receipt], next: 2 },
      { receipts: [receipt, { ...receipt, n: 'invalid' }], next: 1 },
    ]) {
      globalThis.fetch = (async () =>
        ({
          ok: true,
          json: async () => ({
            session: 'task',
            instance: 1,
            ended: false,
            truncated: false,
            more: false,
            ...page,
          }),
        }) as Response) as typeof fetch
      const events: ServerEvent[] = []
      const closed: string[] = []
      const dispose = coworkTransport('task').listen({
        ready() {},
        event: (event) => events.push(event),
        closed: (reason) => closed.push(reason),
      })
      await settle()
      expect(events).toEqual([])
      expect(closed).toEqual(['disconnected'])
      dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ended task remains visible through rejection and 404, then recovers a new instance', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: Array<{ fn: () => void; delay: number }> = []
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    scheduled.push({ fn, delay })
    return 1
  }) as typeof setTimeout
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    if (urls.length === 2) throw new Error('network')
    if (urls.length === 3) return { ok: false, status: 404 } as Response
    const body =
      urls.length === 1
        ? {
            instance: 1,
            receipts: [receipt],
            next: 1,
            ended: true,
            truncated: true,
          }
        : urls.length === 4
          ? {
              instance: 2,
              receipts: [],
              next: 1,
              ended: false,
              truncated: false,
            }
          : {
              instance: 2,
              receipts: [
                { ...receipt, files: [{ p: '/new/b.md', k: 'read' }] },
              ],
              next: 1,
              ended: false,
              truncated: false,
            }
    return {
      ok: true,
      json: async () => ({ session: 'task', more: false, ...body }),
    } as Response
  }) as typeof fetch
  const events: ServerEvent[] = []
  const closed: string[] = []
  const transport = coworkTransport('task')
  const dispose = transport.listen({
    ready() {},
    event: (event) => events.push(event),
    closed: (reason) => closed.push(reason),
  })
  const snapshot = () => {
    const event = events.filter((value) => value.kind === 'snapshot').at(-1)
    if (!event || event.kind !== 'snapshot') throw new Error('Missing snapshot')
    return event
  }
  try {
    await settle()
    const originalEvents = snapshot().facts.events
    for (const status of ['reconnecting', 'unavailable']) {
      const timer = scheduled.shift()
      expect(timer?.delay).toBe(5000)
      timer?.fn()
      await settle()
      expect(snapshot().facts.coworkCoverage?.status).toBe(status)
      expect(snapshot().facts.coworkCoverage?.truncated).toBe(true)
      expect(snapshot().facts.events).toEqual(originalEvents)
      expect(snapshot().facts.workspace.kind).toBe('ready')
    }
    await transport.execute({
      v: 1,
      generation: 1,
      command: { kind: 'lang', lang: 'fr' },
    })
    expect(snapshot().facts.lang).toBe('fr')
    expect(snapshot().facts.coworkCoverage?.status).toBe('unavailable')
    scheduled.shift()?.fn()
    await settle()
    expect(snapshot().facts.coworkCoverage?.status).toBe(undefined)
    expect(scheduled[0]?.delay).toBe(0)
    scheduled.shift()?.fn()
    await settle()
    expect(urls).toEqual([
      'cowork/receipts?session=task&after=0',
      'cowork/receipts?session=task&after=1',
      'cowork/receipts?session=task&after=1',
      'cowork/receipts?session=task&after=1',
      'cowork/receipts?session=task&after=0',
    ])
    expect(snapshot().facts.coworkCoverage?.truncated).toBe(false)
    expect(closed).toEqual([])
  } finally {
    dispose()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('HTTP retryable failures recover and authorization failures stop polling', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  try {
    for (const status of [500, 413, 401, 403]) {
      const scheduled: Array<{ fn: () => void; delay: number }> = []
      globalThis.setTimeout = ((fn: () => void, delay: number) => {
        scheduled.push({ fn, delay })
        return 1
      }) as typeof setTimeout
      globalThis.fetch = (async () =>
        ({ ok: false, status }) as Response) as typeof fetch
      const events: ServerEvent[] = []
      const closed: string[] = []
      const dispose = coworkTransport('task').listen({
        ready() {},
        event: (event) => events.push(event),
        closed: (reason) => closed.push(reason),
      })
      await settle()
      const event = events[0]
      if (event?.kind !== 'snapshot') throw new Error('Missing status snapshot')
      const terminal = status === 401 || status === 403
      expect(event.facts.coworkCoverage?.status).toBe(
        terminal ? 'closed' : 'reconnecting',
      )
      expect(scheduled.length).toBe(terminal ? 0 : 1)
      if (!terminal) expect(scheduled[0]?.delay).toBe(5000)
      expect(closed).toEqual([])
      dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('consumer notices are bilingual and preserve coverage after recovery', () => {
  const coverage = { truncated: true, partialInventory: true } as const
  expect(coworkNotices({ ...coverage, status: 'reconnecting' }, 'en')).toBe(
    'Reconnecting · History capped · Partial inventory',
  )
  expect(coworkNotices({ ...coverage, status: 'unavailable' }, 'fr')).toBe(
    'Tâche indisponible · Historique plafonné · Inventaire partiel',
  )
  expect(coworkNotices({ ...coverage, status: 'closed' }, 'en')).toBe(
    'Viewer closed · History capped · Partial inventory',
  )
  expect(coworkNotices({ ...coverage, status: 'closed' }, 'fr')).toBe(
    'Visionneuse fermée · Historique plafonné · Inventaire partiel',
  )
  expect(coworkNotices(coverage, 'en')).toBe(
    'History capped · Partial inventory',
  )
})

test('recreated instances refetch from zero before comparing old cursor', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  try {
    for (const recreated of [
      { receipts: [], next: 8 },
      { receipts: [receipt], next: 1 },
    ]) {
      const scheduled: Array<() => void> = []
      globalThis.setTimeout = ((fn: () => void) => {
        scheduled.push(fn)
        return 1
      }) as typeof setTimeout
      const urls: string[] = []
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        urls.push(String(input))
        const page =
          urls.length === 1
            ? { instance: 1, receipts: [{ ...receipt, n: 8 }], next: 8 }
            : urls.length === 2
              ? { instance: 2, ...recreated }
              : { instance: 2, receipts: [receipt], next: 1 }
        return {
          ok: true,
          json: async () => ({
            session: 'task',
            ended: false,
            truncated: false,
            more: false,
            ...page,
          }),
        } as Response
      }) as typeof fetch
      const events: ServerEvent[] = []
      const closed: string[] = []
      const dispose = coworkTransport('task').listen({
        ready() {},
        event: (event) => events.push(event),
        closed: (reason) => closed.push(reason),
      })
      await settle()
      scheduled.shift()?.()
      await settle()
      scheduled.shift()?.()
      await settle()
      expect(urls).toEqual([
        'cowork/receipts?session=task&after=0',
        'cowork/receipts?session=task&after=8',
        'cowork/receipts?session=task&after=0',
      ])
      expect(closed).toEqual([])
      const last = events.filter((event) => event.kind === 'snapshot').at(-1)
      if (last?.kind !== 'snapshot') throw new Error('Missing snapshot')
      expect(last.facts.workspace.kind).toBe('ready')
      dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('only valid responses reset the deadline and delayed retries stop before fetch', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  let now = 0
  const scheduled: Array<{ fn: () => void; delay: number }> = []
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    scheduled.push({ fn, delay })
    return 1
  }) as typeof setTimeout
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls === 2 || calls === 4 || calls === 5)
      return { ok: false, status: 404 } as Response
    if (calls === 6) return { ok: false, status: 500 } as Response
    if (calls === 3)
      return {
        ok: true,
        json: async () => ({
          session: 'task',
          instance: 1,
          receipts: [],
          next: 0,
          ended: true,
          truncated: false,
          more: false,
        }),
      } as Response
    throw new Error('network')
  }) as typeof fetch
  const events: ServerEvent[] = []
  const dispose = coworkTransport('task', () => now).listen({
    ready() {},
    event: (event) => events.push(event),
    closed() {},
  })
  const status = () => {
    const event = events.filter((value) => value.kind === 'snapshot').at(-1)
    if (event?.kind !== 'snapshot') throw new Error('Missing snapshot')
    return event.facts.coworkCoverage?.status
  }
  const advance = async (elapsed: number) => {
    const timer = scheduled.shift()
    if (!timer) throw new Error('Missing retry')
    now += elapsed
    timer.fn()
    await settle()
  }
  try {
    await settle()
    expect(status()).toBe('reconnecting')
    await advance(30000)
    expect(status()).toBe('unavailable')
    await advance(30000)
    expect(status()).toBe(undefined)
    await advance(50000)
    expect(status()).toBe('unavailable')
    await advance(5000)
    expect(status()).toBe('unavailable')
    await advance(5000)
    expect(status()).toBe('reconnecting')
    expect(calls).toBe(6)
    await advance(1)
    expect(status()).toBe('closed')
    expect(calls).toBe(6)
    expect(scheduled).toEqual([])
  } finally {
    dispose()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('rejects a replacement instance with an inconsistent raw cursor', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  const scheduled: Array<() => void> = []
  globalThis.setTimeout = ((fn: () => void) => {
    scheduled.push(fn)
    return 1
  }) as typeof setTimeout
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    const page =
      calls === 1
        ? { instance: 1, receipts: [{ ...receipt, n: 8 }], next: 8 }
        : { instance: 2, receipts: [{ ...receipt, n: 2 }], next: 3 }
    return {
      ok: true,
      json: async () => ({
        session: 'task',
        ended: false,
        truncated: false,
        more: false,
        ...page,
      }),
    } as Response
  }) as typeof fetch
  const closed: string[] = []
  const events: ServerEvent[] = []
  const dispose = coworkTransport('task').listen({
    ready() {},
    event: (event) => events.push(event),
    closed: (reason) => closed.push(reason),
  })
  try {
    await settle()
    const before = events.length
    scheduled.shift()?.()
    await settle()
    expect(closed).toEqual(['disconnected'])
    expect(events.length).toBe(before)
    expect(scheduled).toEqual([])
  } finally {
    dispose()
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})
