import { expect, test } from 'claude-code/testing'
import { RelayRefusal, startRelay, type RelayIO } from '../hosts/relay/client'
import type { DashboardFeed, ServerEvent } from '../types/browser'

test('continuous publication cannot starve commands or revive a stale generation', async () => {
  let receive = (_chunk: string) => {}
  let listener = (_event: ServerEvent) => {}
  let generation = 1
  let revision = 1
  let effects = 0
  const executions: number[] = []
  const completed: Array<{ route: string; body: Record<string, unknown> }> = []
  const replies: Array<Record<string, unknown>> = []
  const pending: Array<() => void> = []
  const feed = {
    current: () => ({
      generation,
      revision,
      layout: {},
      facts: {},
      shared: {},
    }),
    subscribe: (callback: (event: ServerEvent) => void) => {
      listener = callback
      return () => {}
    },
    execute: async (requested: number) => {
      executions.push(requested)
      if (requested !== generation)
        return { ok: false, error: 'stale-generation' }
      effects++
      return { ok: true }
    },
  } as unknown as DashboardFeed
  const io: RelayIO = {
    async start(_binary, _args, _stdin, onChunk) {
      receive = onChunk
      onChunk(
        `${JSON.stringify({ t: 'hello', protocol: 1, socket: '/private/relay.sock' })}\n`,
      )
      return { close() {} }
    },
    request(_socket, _token, route, data) {
      const body = JSON.parse(data) as Record<string, unknown>
      if (route === '/h/reply') {
        replies.push(body)
        return Promise.resolve({ status: 200, body: '{"ok":true}' })
      }
      return new Promise((resolve) => {
        pending.push(() => {
          completed.push({ route, body })
          resolve({ status: 200, body: '{"ok":true}' })
        })
      })
    },
    schedule: () => () => {},
    onFailure: (error) => {
      throw error
    },
    onLaunchOutcome: () => {},
    randomToken: () => 'token',
    log: () => {},
  }
  const client = await startRelay(io, '/relay', '/assets', feed)
  const frame = (value: unknown) => receive(`${JSON.stringify(value)}\n`)
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }
  const update = () => {
    revision++
    listener({ v: 1, kind: 'layout', generation, layout: {} } as ServerEvent)
  }
  try {
    frame({ t: 'clients', n: 1, seq: 1 })
    frame({
      t: 'cmd',
      id: 'old',
      body: {
        v: 1,
        generation: 1,
        command: { kind: 'view', intent: { kind: 'replay-pause' } },
      },
    })
    generation = 2
    update()
    expect(executions).toEqual([])
    // Keep publishing before each slow HTTP completion. A quiescence-based
    // drain never executes the command under this sustained update stream.
    for (let i = 0; i < 8 && replies.length === 0; i++) {
      await settle()
      const release = pending.shift()
      if (release) {
        update()
        release()
      }
    }
    await settle()
    expect(replies.length).toBe(1)
    expect(replies[0]).toEqual({
      id: 'old',
      body: { ok: false, error: 'stale-generation' },
    })
    expect(effects).toBe(0)
    expect(executions).toEqual([1])
    expect(completed.some((item) => item.route === '/h/ready')).toBe(true)
    frame({
      t: 'cmd',
      id: 'current',
      body: {
        v: 1,
        generation: 2,
        command: { kind: 'view', intent: { kind: 'replay-pause' } },
      },
    })
    for (let i = 0; i < 8 && replies.length < 2; i++) {
      await settle()
      const release = pending.shift()
      if (release) {
        update()
        release()
      }
    }
    await settle()
    expect(replies[1]).toEqual({ id: 'current', body: { ok: true } })
    expect(executions).toEqual([1, 2])
    expect(effects).toBe(1)
    const events = completed
      .filter((item) => item.route === '/h/event')
      .map((item) => item.body)
    const generations = events.map((event) => event.generation as number)
    expect(generations).toEqual([...generations].sort((a, b) => a - b))
    expect(events[0]?.kind).toBe('layout')
    expect(events[1]?.kind).toBe('snapshot')
  } finally {
    client.close()
  }
})

test('launch outcomes are correlated before receipts, nonfatal, and generation-scoped', async () => {
  let receive = (_chunk: string) => {}
  let generation = 1
  let token = 0
  let resolveLaunch:
    | ((value: { status: number; body: string }) => void)
    | undefined
  const requests: Array<Record<string, unknown>> = []
  const outcomes: Array<{ id: string; generation: number; code: number }> = []
  const commandReplies: Array<Record<string, unknown>> = []
  const failures: string[] = []
  let rejectSpawn = false
  const feed = {
    current: () => ({
      generation,
      revision: 1,
      layout: undefined,
      facts: {},
      shared: {},
    }),
    subscribe: () => () => {},
    execute: async () => ({ ok: true }),
  } as unknown as DashboardFeed
  const io: RelayIO = {
    async start(_binary, _args, _stdin, onChunk) {
      receive = onChunk
      onChunk(
        `${JSON.stringify({ t: 'hello', protocol: 1, socket: '/private/relay.sock' })}\n`,
      )
      return { close() {} }
    },
    request(_socket, _token, route, data) {
      if (route === '/h/reply')
        commandReplies.push(JSON.parse(data) as Record<string, unknown>)
      if (route === '/h/apps')
        return Promise.resolve({ status: 200, body: '{"apps":["Editor"]}' })
      if (route === '/h/launch' || route === '/h/file/open') {
        requests.push(JSON.parse(data) as Record<string, unknown>)
        if (rejectSpawn)
          return Promise.resolve({
            status: 200,
            body: '{"ok":false,"error":"launch-failed"}',
          })
        return new Promise((resolve) => {
          resolveLaunch = resolve
        })
      }
      return Promise.resolve({ status: 200, body: '{"ok":true}' })
    },
    schedule: () => () => {},
    onFailure: (error) => {
      failures.push(error.code)
    },
    onLaunchOutcome: (outcome) => {
      outcomes.push(outcome)
    },
    randomToken: () => `token-${++token}`,
    log: () => {},
  }
  const client = await startRelay(io, '/relay', '/assets', feed)
  const frame = (value: unknown) => receive(`${JSON.stringify(value)}\n`)
  try {
    const first = client.openBrowser(1)
    const id = requests[0]?.id as string
    frame({ t: 'launch-exit', id, generation: 1, code: 7 })
    expect(outcomes).toEqual([{ id, generation: 1, code: 7 }])
    resolveLaunch?.({ status: 200, body: '{"ok":true,"status":"spawned"}' })
    expect(await first).toEqual({ status: 'spawned' })
    expect(await client.listApps()).toEqual(['Editor'])
    expect(client.isClosed()).toBe(false)

    const second = client.openFile('held-file', undefined, 1)
    const staleId = requests[1]?.launchId as string
    resolveLaunch?.({ status: 200, body: '{"ok":true,"status":"spawned"}' })
    expect(await second).toEqual({ status: 'spawned' })
    generation = 2
    frame({ t: 'launch-exit', id: staleId, generation: 1, code: 3 })
    expect(outcomes).toEqual([{ id, generation: 1, code: 7 }])

    rejectSpawn = true
    let refusal = ''
    try {
      await client.openBrowser(2)
    } catch (error) {
      if (error instanceof RelayRefusal) refusal = error.code
    }
    expect(refusal).toBe('launch-failed')
    frame({ t: 'clients', n: 1, seq: 1 })
    frame({
      t: 'cmd',
      id: 'unrelated',
      body: { v: 1, generation: 2, command: { kind: 'refresh-meter' } },
    })
    for (let i = 0; i < 80 && commandReplies.length === 0; i++)
      await Promise.resolve()
    expect(commandReplies).toEqual([{ id: 'unrelated', body: { ok: true } }])
    expect(await client.listApps()).toEqual(['Editor'])
    expect(client.isClosed()).toBe(false)
    expect(failures).toEqual([])
  } finally {
    client.close()
  }
})

test('browser link rejects stale and closed requests across the transport boundary', async () => {
  let generation = 1
  let listener = (_event: ServerEvent) => {}
  let token = 0
  let resolveLink:
    | ((value: { status: number; body: string }) => void)
    | undefined
  const requests: Array<Record<string, unknown>> = []
  let notifyLaunch = () => {}
  const nextLaunch = () =>
    new Promise<void>((resolve) => {
      notifyLaunch = resolve
    })
  const feed = {
    current: () => ({
      generation,
      revision: 1,
      layout: undefined,
      facts: {},
      shared: {},
    }),
    subscribe: (onEvent: (event: ServerEvent) => void) => {
      listener = onEvent
      return () => {}
    },
    execute: async () => ({ ok: true }),
  } as unknown as DashboardFeed
  const io: RelayIO = {
    async start(_binary, _args, _stdin, onChunk) {
      onChunk(
        `${JSON.stringify({ t: 'hello', protocol: 1, socket: '/private/relay.sock' })}\n`,
      )
      return { close() {} }
    },
    request(_socket, _token, route, body) {
      if (route === '/h/launch') {
        requests.push(JSON.parse(body) as Record<string, unknown>)
        return new Promise((resolve) => {
          resolveLink = resolve
          notifyLaunch()
        })
      }
      return Promise.resolve({ status: 200, body: '{"ok":true}' })
    },
    schedule: () => () => {},
    onFailure: () => {},
    onLaunchOutcome: () => {},
    randomToken: () => `token-${++token}`,
    log: () => {},
  }
  const client = await startRelay(io, '/relay', '/assets', feed)
  const refusal = async (operation: Promise<unknown>) => {
    try {
      await operation
      return ''
    } catch (error) {
      return error instanceof RelayRefusal ? error.code : 'unexpected'
    }
  }
  const response = () => ({
    status: 200,
    body: JSON.stringify({
      ok: true,
      url: `http://127.0.0.1:1234/launch/${'a'.repeat(43)}`,
      expiresAt: Date.now() + 60_000,
    }),
  })
  try {
    expect(
      await refusal(Promise.resolve().then(() => client.prepareBrowserLink(2))),
    ).toBe('stale-generation')
    expect(requests).toEqual([])
    const firstStarted = nextLaunch()
    const first = client.prepareBrowserLink(1)
    await firstStarted
    resolveLink?.(response())
    const link = await first
    expect(link.url).toBe(`http://127.0.0.1:1234/launch/${'a'.repeat(43)}`)
    expect(link.expiresAt > Date.now()).toBe(true)

    for (const url of [
      `http://localhost:1234/launch/${'a'.repeat(43)}`,
      `http://127.0.0.1:1234/s/${'a'.repeat(43)}`,
    ]) {
      const started = nextLaunch()
      const invalid = client.prepareBrowserLink(1)
      await started
      resolveLink?.({
        status: 200,
        body: JSON.stringify({ ok: true, url, expiresAt: Date.now() + 60_000 }),
      })
      expect(await refusal(invalid)).toBe('invalid')
    }

    const oldStarted = nextLaunch()
    const old = client.prepareBrowserLink(1)
    const oldResult = refusal(old)
    await oldStarted
    const replacementStarted = nextLaunch()
    const replacement = client.prepareBrowserLink(1)
    resolveLink?.(response())
    expect(await oldResult).toBe('stale-generation')
    await replacementStarted
    resolveLink?.(response())
    expect((await replacement).url).toBe(
      `http://127.0.0.1:1234/launch/${'a'.repeat(43)}`,
    )

    const pendingStarted = nextLaunch()
    const pending = client.prepareBrowserLink(1)
    await pendingStarted
    generation = 2
    resolveLink?.(response())
    expect(await refusal(pending)).toBe('stale-generation')
    listener({ v: 1, kind: 'ended', generation: 2 })
    expect(
      await refusal(Promise.resolve().then(() => client.prepareBrowserLink(2))),
    ).toBe('stale-generation')
    generation = 3
    const closedStarted = nextLaunch()
    const closed = client.prepareBrowserLink(3)
    await closedStarted
    const closedResult = refusal(closed)
    client.close()
    resolveLink?.(response())
    expect(await closedResult).toBe('disconnected')
    expect(
      await refusal(Promise.resolve().then(() => client.prepareBrowserLink(3))),
    ).toBe('disconnected')
  } finally {
    client.close()
  }
})

for (const ending of [false, true])
  test(`${ending ? 'end' : 'generation update'} cannot overtake an in-flight publication`, async () => {
    let receive = (_chunk: string) => {}
    let listener = (_event: ServerEvent) => {}
    let generation = 1
    let serverGeneration = 0
    let serverEnded = false
    let releaseEvent: (() => void) | undefined
    let held = false
    const failures: string[] = []
    const requests: Array<{
      route: string
      generation: number
      kind?: string
    }> = []
    const feed = {
      current: () => ({
        generation,
        revision: 1,
        layout: {},
        facts: {},
        shared: {},
      }),
      subscribe: (callback: (event: ServerEvent) => void) => {
        listener = callback
        return () => {}
      },
      execute: async () => ({ ok: true }),
    } as unknown as DashboardFeed
    const io: RelayIO = {
      async start(_binary, _args, _stdin, onChunk) {
        receive = onChunk
        onChunk(
          `${JSON.stringify({ t: 'hello', protocol: 1, socket: '/private/relay.sock' })}\n`,
        )
        return { close() {} }
      },
      request(_socket, _token, route, raw) {
        const body = JSON.parse(raw) as { generation?: number; kind?: string }
        const value = body.generation ?? 0
        requests.push({ route, generation: value, kind: body.kind })
        const complete = () => {
          if (
            route === '/h/event' &&
            (value < serverGeneration || (serverEnded && body.kind !== 'ended'))
          )
            return { status: 409, body: '{}' }
          if (route === '/h/event' || route === '/h/generation')
            serverGeneration = Math.max(serverGeneration, value)
          if (route === '/h/event' && body.kind === 'ended') serverEnded = true
          return { status: 200, body: '{"ok":true}' }
        }
        if (route === '/h/event' && value === 1 && !held) {
          held = true
          return new Promise((resolve) => {
            releaseEvent = () => resolve(complete())
          })
        }
        return Promise.resolve(complete())
      },
      schedule: () => () => {},
      onFailure: (error) => {
        failures.push(error.code)
      },
      onLaunchOutcome: () => {},
      randomToken: () => 'token',
      log: () => {},
    }
    const client = await startRelay(io, '/relay', '/assets', feed)
    const settle = async () => {
      for (let i = 0; i < 80; i++) await Promise.resolve()
    }
    try {
      receive(`${JSON.stringify({ t: 'clients', n: 1, seq: 1 })}\n`)
      await settle()
      expect(held).toBe(true)
      if (ending) listener({ v: 1, kind: 'ended', generation: 1 })
      else {
        generation = 2
        listener({
          v: 1,
          kind: 'layout',
          generation: 2,
          layout: {},
        } as ServerEvent)
      }
      await settle()
      expect(
        requests.some((item) =>
          ending
            ? item.kind === 'ended'
            : item.route === '/h/generation' && item.generation === 2,
        ),
      ).toBe(false)
      releaseEvent?.()
      await settle()
      expect(failures).toEqual([])
      expect(client.isClosed()).toBe(false)
      expect(serverGeneration).toBe(ending ? 1 : 2)
      expect(serverEnded).toBe(ending)
    } finally {
      releaseEvent?.()
      client.close()
    }
  })
