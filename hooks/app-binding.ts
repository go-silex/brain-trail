import type { EngineInterface } from 'claude-code'
import type { RelayClient } from '../hosts/relay/client'
import { parseOpenMarker } from '../types/apps'

const bindings = new Map<
  string,
  {
    key: string
    promise: Promise<boolean>
    expires: number
    settled: boolean
    client: RelayClient
  }
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
  const now = await $.clock.now()
  const key = JSON.stringify([
    server,
    marker.challenge,
    owner.sessionId,
    generation,
  ])
  // A live grant can outlast the outcome TTL. Only evict expired, settled
  // outcomes under admission pressure after the issuing relay confirms that
  // no claimed grant survives; a failed check is not evidence of retirement.
  if (!bindings.has(marker.openId) && bindings.size >= 16) {
    for (const [id, entry] of bindings) {
      if (!entry.settled || entry.expires > now) continue
      if (entry.client.isClosed()) {
        if (bindings.get(id) === entry) bindings.delete(id)
        if (bindings.size < 16) break
        continue
      }
      try {
        const checked = await entry.client.checkApp({
          v: 1,
          target: { kind: 'approval', approval: { kind: 'code', openId: id } },
        })
        if (
          checked.kind === 'approval' &&
          checked.state !== 'claimed' &&
          checked.state !== 'pending' &&
          bindings.get(id) === entry
        )
          bindings.delete(id)
      } catch {
        /* retain unknown authority */
      }
      if (bindings.size < 16) break
    }
  }
  const existing = bindings.get(marker.openId)
  if (existing) {
    if (
      existing.key !== key ||
      existing.client !== client ||
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
  const entry = {
    key,
    promise,
    expires: now + 120000,
    settled: false,
    client,
  }
  bindings.set(marker.openId, entry)
  void promise.then(() => {
    entry.settled = true
  })
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
  let mayRevoke = false
  let cancelTimer: (() => void) | undefined
  let abort: (() => void) | undefined
  try {
    const existing = await client.checkApp({
      v: 1,
      target: { kind: 'approval', approval },
    })
    // A claimed, pending or terminal approval may belong to an earlier
    // invocation whose local outcome has aged out. It is never ours to revoke.
    if (existing.kind !== 'approval' || existing.state !== 'missing')
      return false
    if (signal?.aborted || !(await current())) return false
    mayRevoke = true
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
    if (!committed && mayRevoke) {
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
