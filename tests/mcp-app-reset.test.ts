import { expect, test } from 'claude-code/testing'
import type { Reply } from '../types/apps'
import { mounted, privateReply, type ToolCall } from '../hosts/mcp-app/wire'
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

test('private envelope refusal recovers reset and mounts a fresh view', async () => {
  const calls: string[] = []
  let retired = false
  const call: ToolCall = async <T>(
    name: string,
    _args: Record<string, unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<Reply<T>> => {
    calls.push(name)
    const payload =
      name === 'brain_trail_detach'
        ? { v: 1, ok: false, error: 'forbidden' }
        : name === 'brain_trail_reset'
          ? { v: 1, ok: true, value: resetValue }
          : {
              v: 1,
              ok: true,
              value: { mountKey: token, state: { kind: 'detached' } },
            }
    return privateReply(
      {
        content: [{ type: 'text', text: 'Brain Trail request processed.' }],
        _meta: { brainTrail: payload },
      },
      valid,
    )
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
  expect(retired).toBe(true)
  expect(result?.ok).toBe(true)
  if (!result?.ok) throw new Error('reset failed')
  const next = result.value.bootstrap
  const mountResult = await call(
    'brain_trail_mount',
    {
      ...identity,
      assetDigest: next.assetDigest,
      serverEpoch: next.serverEpoch,
      viewKey: next.viewKey,
    },
    mounted,
  )
  expect(mountResult.ok).toBe(true)
  expect(calls).toEqual([
    'brain_trail_detach',
    'brain_trail_reset',
    'brain_trail_mount',
  ])
})

test('private envelope errors or missing metadata cannot authorize reset', async () => {
  for (const envelope of [
    {
      isError: true,
      _meta: { brainTrail: { v: 1, ok: false, error: 'forbidden' } },
    },
    { content: [{ type: 'text', text: 'forbidden' }] },
    { _meta: { brainTrail: { v: 1, ok: false, error: 'other' } } },
  ]) {
    const calls: string[] = []
    let retired = false
    const call: ToolCall = async <T>(
      name: string,
      _args: Record<string, unknown>,
      valid: (v: unknown) => v is T,
    ) => {
      calls.push(name)
      return privateReply(envelope, valid)
    }
    let threw = false
    try {
      await resetMountedView(
        call,
        identity,
        auth,
        () => {
          retired = true
        },
        () => true,
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(retired).toBe(false)
    expect(calls).toEqual(['brain_trail_detach'])
  }
})

test('private timeout refusal does not authorize reset', async () => {
  const calls: string[] = []
  let retired = false
  const call: ToolCall = async <T>(
    name: string,
    _args: Record<string, unknown>,
    valid: (v: unknown) => v is T,
  ) => {
    calls.push(name)
    return privateReply(
      {
        isError: false,
        _meta: { brainTrail: { v: 1, ok: false, error: 'timeout' } },
      },
      valid,
    )
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
  expect(retired).toBe(false)
  expect(calls).toEqual(['brain_trail_detach'])
})
