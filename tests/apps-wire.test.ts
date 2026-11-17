import { expect, test } from 'claude-code/testing'
import {
  isAdapterOperation,
  parseOpenMarker,
  parseOpenerToolName,
  parseStrictJSON,
} from '../types/apps'
import { startRelay, type RelayIO } from '../hosts/relay/client'
import type { CommandScope, DashboardFeed, ServerEvent } from '../types/browser'
import type { EngineInterface } from 'claude-code'
import type { RelayClient } from '../hosts/relay/client'
import { bindCodeOpen } from '../hooks/app-binding'

const token = 'A'.repeat(43)

test('adapter classification and public marker reject ambiguity', () => {
  expect(parseOpenerToolName('mcp__server__open_brain_trail')).toBe('server')
  expect(parseOpenerToolName('mcp__server__other__open_brain_trail')).toBe(
    undefined,
  )
  expect(isAdapterOperation('mcp__server__brain_trail_pull')).toBe(true)
  expect(isAdapterOperation('mcp__server__brain_trail_pull_extra')).toBe(false)
  const marker = `BRAIN_TRAIL_OPEN_V1:${token}:${token}`
  expect(parseOpenMarker(`quoted "${marker}"`)).toEqual({
    openId: token,
    challenge: token,
  })
  expect(parseOpenMarker(`${marker} ${marker}`)).toBe(undefined)
  expect(parseOpenMarker(`${marker}:extra`)).toBe(undefined)
  expect(() => parseStrictJSON('{"x":{"a":1,"a":2}}')).toThrow()
  expect(() => parseStrictJSON('{"x":1} true')).toThrow()
})

test('app current captures and encodes both parts without browser clients', async () => {
  let receive = (_chunk: string) => {}
  const posts: Array<{
    result: {
      value: {
        chunk: { events: Array<{ kind: string; layout?: { root: string } }> }
      }
    }
  }> = []
  const layout = { layoutRev: 1, root: 'old', paths: [], layout: {} }
  const feed = {
    current: () => ({
      generation: 1,
      revision: 1,
      layout,
      facts: {},
      shared: {},
    }),
    subscribe: () => () => {},
    execute: async () => ({ ok: true }),
  } as unknown as DashboardFeed
  const io: RelayIO = {
    async start(_binary, _args, _stdin, onChunk) {
      receive = onChunk
      receive('{"t":"hello","protocol":1,"socket":"/private/relay.sock"}\n')
      return { close() {} }
    },
    async request(_socket, _token, route, body) {
      if (route === '/h/app/check')
        return {
          status: 200,
          body: '{"v":1,"ok":true,"value":{"kind":"operation"}}',
        }
      if (route === '/h/app/reply') {
        posts.push(JSON.parse(body))
        layout.root = 'new'
      }
      return { status: 200, body: '{"v":1,"ok":true,"value":null}' }
    },
    schedule: () => () => {},
    onFailure: () => {},
    onLaunchOutcome: () => {},
    randomToken: () => token,
    log: () => {},
  }
  const owner = { host: 'code' as const, sessionId: 'session' }
  const client = await startRelay(io, '/relay', '/assets', feed, {
    current: async () => ({ owner, generation: 1, label: 'test' }),
  })
  try {
    receive(
      `${JSON.stringify({ v: 1, t: 'app-current', scope: { requestId: token, relayId: token, grantId: token, owner, generation: 1, lease: { epoch: 1, id: token } }, cursor: null })}\n`,
    )
    for (let i = 0; i < 100 && posts.length < 2; i++) await Promise.resolve()
    expect(posts.length).toBe(2)
    const chunks = posts.map((p) => p.result.value.chunk)
    expect(chunks[0]?.events[0]?.kind).toBe('layout')
    expect(chunks[0]?.events[0]?.layout?.root).toBe('old')
    expect(chunks[1]?.events[0]?.kind).toBe('snapshot')
  } finally {
    client.close()
  }
})

test('approval waits for an in-flight generation update and synchronizes without browser clients', async () => {
  let listener = (_event: ServerEvent) => {}
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const routes: string[] = []
  let generationPosts = 0
  const feed = {
    current: () => ({
      generation: 1,
      revision: 1,
      layout: undefined,
      facts: {},
      shared: {},
    }),
    subscribe: (callback: typeof listener) => {
      listener = callback
      return () => {}
    },
    execute: async () => ({ ok: true }),
  } as unknown as DashboardFeed
  const owner = { host: 'code' as const, sessionId: 'session' }
  const io: RelayIO = {
    async start(_binary, _args, _stdin, onChunk) {
      onChunk('{"t":"hello","protocol":1,"socket":"/private/relay.sock"}\n')
      return { close() {} }
    },
    async request(_socket, _token, route) {
      routes.push(route)
      if (route === '/h/generation') {
        if (++generationPosts === 1) await pending
        return { status: 200, body: '{"ok":true}' }
      }
      return {
        status: 200,
        body: JSON.stringify({
          v: 1,
          ok: true,
          value: {
            relay: { socket: '/private/relay.sock', relayId: token },
            approval: { kind: 'code', openId: token },
            expiresAt: 1,
            envelope: null,
          },
        }),
      }
    },
    schedule: () => () => {},
    onFailure: () => {},
    onLaunchOutcome: () => {},
    randomToken: () => token,
    log: () => {},
  }
  const client = await startRelay(io, '/relay', '/assets', feed, {
    current: async () => ({ owner, generation: 1, label: 'test' }),
  })
  try {
    listener({
      v: 1,
      kind: 'snapshot',
      generation: 1,
      revision: 1,
      facts: {},
      shared: {},
    } as unknown as ServerEvent)
    const approved = client.approveApp({
      v: 1,
      owner,
      generation: 1,
      label: 'test',
      approval: {
        kind: 'code',
        openId: token,
        method: 'S256',
        challenge: token,
      },
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(routes).toEqual(['/h/generation'])
    release()
    await approved
    expect(routes).toEqual(['/h/generation', '/h/generation', '/h/app/approve'])
  } finally {
    release()
    client.close()
  }
})

test('a late duplicate reconciles a live Code grant without reapproval or revocation', async () => {
  const openId = `${'B'.repeat(42)}A`
  const marker = `BRAIN_TRAIL_OPEN_V1:${openId}:${token}`
  let claimed = false,
    approvals = 0,
    revocations = 0,
    completions = 0
  let now = 1_000_000
  const client = {
    isClosed: () => false,
    checkApp: async () => ({
      kind: 'approval',
      state: claimed ? 'claimed' : 'missing',
      grantId: claimed ? token : null,
      expiresAt: claimed ? 1 : null,
    }),
    approveApp: async () => {
      approvals++
      return { relay: { socket: '/relay', relayId: token } }
    },
    revokeApp: async () => {
      revocations++
    },
  } as unknown as RelayClient
  const engine = {
    clock: { now: async () => now, after: () => ({ cancel() {} }) },
    mcp: {
      call: async () => {
        completions++
        claimed = true
        return {
          isError: false,
          structuredContent: { v: 1, ok: true, value: { status: 'attached' } },
        }
      },
    },
  } as unknown as EngineInterface
  const owner = { host: 'code' as const, sessionId: 'late-duplicate' }
  expect(
    await bindCodeOpen(
      engine,
      client,
      'server',
      marker,
      owner,
      1,
      'label',
      async () => true,
    ),
  ).toBe(true)
  now += 121_000
  expect(
    await bindCodeOpen(
      engine,
      client,
      'server',
      marker,
      owner,
      1,
      'label',
      async () => true,
    ),
  ).toBe(true)
  expect([approvals, completions, revocations]).toEqual([1, 1, 0])
})

test('exact cancellation aborts a producer and retains its admission slot until settlement', async () => {
  let receive = (_chunk: string) => {}
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const signals: AbortSignal[] = []
  const replies: Array<{
    scope: { requestId: string }
    result: { error?: string }
  }> = []
  const owner = { host: 'code' as const, sessionId: 'session' }
  const feed = {
    current: () => ({
      generation: 1,
      revision: 1,
      layout: undefined,
      facts: {},
      shared: {},
    }),
    subscribe: () => () => {},
    execute: async (
      _generation: number,
      _command: unknown,
      scope: CommandScope,
    ) => {
      signals.push(scope.signal)
      await pending
      return { ok: true }
    },
  } as unknown as DashboardFeed
  const io: RelayIO = {
    async start(_binary, _args, _stdin, onChunk) {
      receive = onChunk
      onChunk('{"t":"hello","protocol":1,"socket":"/private/relay.sock"}\n')
      return { close() {} }
    },
    async request(_socket, _token, route, body) {
      if (route === '/h/app/check')
        return {
          status: 200,
          body: '{"v":1,"ok":true,"value":{"kind":"operation"}}',
        }
      if (route === '/h/app/reply') replies.push(JSON.parse(body))
      return { status: 200, body: '{"v":1,"ok":true,"value":null}' }
    },
    schedule: () => () => {},
    onFailure: () => {},
    onLaunchOutcome: () => {},
    randomToken: () => token,
    log: () => {},
  }
  const client = await startRelay(io, '/relay', '/assets', feed, {
    current: async () => ({ owner, generation: 1, label: 'test' }),
  })
  const frame = (value: unknown) => receive(`${JSON.stringify(value)}\n`)
  const guard = (index: number) => ({
    requestId: `${String.fromCharCode(65 + index).repeat(42)}A`,
    relayId: token,
    grantId: token,
    owner,
    generation: 1,
    lease: { epoch: 1, id: token },
  })
  try {
    for (let i = 0; i < 16; i++)
      frame({
        v: 1,
        t: 'app-cmd',
        scope: guard(i),
        request: { v: 1, generation: 1, command: { kind: 'clear-trail' } },
      })
    for (let i = 0; i < 100 && signals.length < 16; i++) await Promise.resolve()
    expect(signals.length).toBe(16)
    frame({
      v: 1,
      t: 'app-cancel',
      scope: { ...guard(0), lease: { epoch: 2, id: token } },
    })
    expect(signals[0]?.aborted).toBe(false)
    frame({ v: 1, t: 'app-cancel', scope: guard(0) })
    expect(signals[0]?.aborted).toBe(true)
    frame({
      v: 1,
      t: 'app-cmd',
      scope: guard(16),
      request: { v: 1, generation: 1, command: { kind: 'clear-trail' } },
    })
    for (let i = 0; i < 100 && replies.length === 0; i++)
      await Promise.resolve()
    expect(replies[0]?.result.error).toBe('busy')
    expect(signals.length).toBe(16)
  } finally {
    release()
    client.close()
  }
})

test('an untracked claimed Code approval cannot be reapproved or revoked', async () => {
  const openId = `${'C'.repeat(42)}A`
  let approvals = 0,
    revocations = 0
  const client = {
    isClosed: () => false,
    checkApp: async () => ({
      kind: 'approval',
      state: 'claimed',
      grantId: token,
      expiresAt: 1,
    }),
    approveApp: async () => {
      approvals++
      throw new Error('unexpected approval')
    },
    revokeApp: async () => {
      revocations++
    },
  } as unknown as RelayClient
  const engine = {
    clock: { now: async () => 1_000_000 },
  } as unknown as EngineInterface
  const owner = { host: 'code' as const, sessionId: 'untracked' }
  expect(
    await bindCodeOpen(
      engine,
      client,
      'server',
      `BRAIN_TRAIL_OPEN_V1:${openId}:${token}`,
      owner,
      1,
      'label',
      async () => true,
    ),
  ).toBe(false)
  expect([approvals, revocations]).toEqual([0, 0])
})
