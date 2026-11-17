import { expect, test } from 'claude-code/testing'
import {
  isAdapterOperation,
  parseOpenMarker,
  parseOpenerToolName,
  parseStrictJSON,
} from '../types/apps'
import { startRelay, type RelayIO } from '../hosts/relay/client'
import type { DashboardFeed } from '../types/browser'

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
