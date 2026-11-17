import type { EngineInterface } from 'claude-code'
import type { RelayClient } from '../hosts/relay/client'
import { parseOpenMarker } from '../types/apps'

const bindings = new Map<
  string,
  { key: string; promise: Promise<boolean>; expires: number }
>()

// The public marker identifies an open; only the MCP process holds its verifier.
export async function bindCodeOpen(
  $: EngineInterface,
  client: RelayClient,
  server: string,
  text: string,
  owner: { host: 'code'; sessionId: string },
  generation: number,
  label: string,
  current: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  const marker = parseOpenMarker(text)
  if (!marker || signal?.aborted || !(await current())) return false
  const key = JSON.stringify([
    server,
    marker.challenge,
    owner.sessionId,
    generation,
  ])
  for (const [id, entry] of bindings)
    if (entry.expires <= Date.now()) bindings.delete(id)
  const existing = bindings.get(marker.openId)
  if (existing) {
    if (
      existing.key !== key ||
      !(await existing.promise) ||
      signal?.aborted ||
      !(await current())
    )
      return false
    try {
      const checked = await client.checkApp({
        v: 1,
        target: {
          kind: 'approval',
          approval: { kind: 'code', openId: marker.openId },
        },
      })
      return (
        checked.kind === 'approval' &&
        checked.state === 'claimed' &&
        !!checked.grantId &&
        (await current())
      )
    } catch {
      return false
    }
  }
  if (bindings.size >= 16) return false
  const promise = completeCodeOpen(
    $,
    client,
    server,
    marker,
    owner,
    generation,
    label,
    current,
    signal,
  )
  bindings.set(marker.openId, { key, promise, expires: Date.now() + 120000 })
  return promise
}

async function completeCodeOpen(
  $: EngineInterface,
  client: RelayClient,
  server: string,
  marker: { openId: string; challenge: string },
  owner: { host: 'code'; sessionId: string },
  generation: number,
  label: string,
  current: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  const approval = { kind: 'code' as const, openId: marker.openId }
  let committed = false
  let cancelTimer: (() => void) | undefined
  let abort: (() => void) | undefined
  try {
    const approved = await client.approveApp({
      v: 1,
      owner,
      generation,
      label,
      approval: { ...approval, method: 'S256', challenge: marker.challenge },
    })
    if (signal?.aborted || !(await current())) return false
    const deadline = new Promise<never>((_, reject) => {
      const timer = $.clock.after(15000, () => reject(new Error('timeout')))
      cancelTimer = () => timer.cancel()
      abort = () => reject(new Error('cancelled'))
      signal?.addEventListener('abort', abort, { once: true })
    })
    const complete = async () => {
      const outcome = await $.mcp.call(
        server,
        'brain_trail_complete_native_open',
        { v: 1, openId: marker.openId, relay: approved.relay },
      )
      if (outcome.isError || signal?.aborted || !(await current())) return false
      const result = outcome.structuredContent as
        | { v?: unknown; ok?: unknown; value?: { status?: unknown } }
        | undefined
      if (
        result?.v !== 1 ||
        result.ok !== true ||
        result.value?.status !== 'attached'
      )
        return false
      const checked = await client.checkApp({
        v: 1,
        target: { kind: 'approval', approval },
      })
      return (
        checked.kind === 'approval' &&
        checked.state === 'claimed' &&
        !!checked.grantId &&
        !signal?.aborted &&
        (await current())
      )
    }
    if (!(await Promise.race([complete(), deadline]))) return false
    committed = true
    return true
  } catch {
    return false
  } finally {
    cancelTimer?.()
    if (abort) signal?.removeEventListener('abort', abort)
    if (!committed) {
      try {
        await client.revokeApp({
          v: 1,
          target: { kind: 'approval', approval },
          reason: 'failed',
        })
      } catch {
        client.close()
      }
    }
  }
}
