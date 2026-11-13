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
