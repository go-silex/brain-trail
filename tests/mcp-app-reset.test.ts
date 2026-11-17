import { expect, test } from 'claude-code/testing'
import type { Reply } from '../types/apps'
import type { ToolCall } from '../hosts/mcp-app/transport'
import { resetMountedView } from '../hosts/mcp-app/reset'

const token = 'A'.repeat(43)
const identity = {
  v: 1 as const,
  wireRevision: 1 as const,
  uiBuildId: 'a'.repeat(64),
}
const auth = {
  v: 1 as const,
  serverEpoch: token,
  viewKey: token,
  mountKey: token,
}
const resetValue = {
  bootstrap: {
    ...identity,
    assetDigest: 'b'.repeat(64),
    serverEpoch: token,
    viewKey: token,
  },
  state: { kind: 'detached' },
}

test('explicit reset proceeds after expired mount is refused', async () => {
  const calls: string[] = []
  let retired = false
  const call: ToolCall = async <T>(
    name: string,
    args: Record<string, unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<Reply<T>> => {
    calls.push(name)
    if (name === 'brain_trail_detach')
      return { v: 1, ok: false, error: 'forbidden' }
    expect(name).toBe('brain_trail_reset')
    expect(args).toEqual(identity)
    expect(retired).toBe(true)
    if (!valid(resetValue)) throw new Error('invalid test response')
    return { v: 1, ok: true, value: resetValue }
  }
  const result = await resetMountedView(
    call,
    identity,
    auth,
    () => {
      retired = true
    },
    () => true,
  )
  expect(result).toEqual({ v: 1, ok: true, value: resetValue })
  expect(calls).toEqual(['brain_trail_detach', 'brain_trail_reset'])
})

test('ambiguous detach failure does not reset or discard ownership', async () => {
  const calls: string[] = []
  let retired = false
  const call: ToolCall = async (name) => {
    calls.push(name)
    return { v: 1, ok: false, error: 'timeout' }
  }
  const result = await resetMountedView(
    call,
    identity,
    auth,
    () => {
      retired = true
    },
    () => true,
  )
  expect(result).toEqual({ v: 1, ok: false, error: 'timeout' })
  expect(calls).toEqual(['brain_trail_detach'])
  expect(retired).toBe(false)
})
