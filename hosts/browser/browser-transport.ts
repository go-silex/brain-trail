import type {
  CommandRefusal,
  CommandReplies,
  HostCommand,
  ServerEvent,
} from '../../types/browser'
import {
  isExactObject,
  parseChatEnvelope,
  parseStrictJSON,
} from '../../types/apps'
import type { BrowserPairRequest, ChatEnvelope } from '../../types/apps'
import type { DashboardTransport, PageBootstrap } from './transport'

export function browserBootstrap(): {
  bootstrap: PageBootstrap
  invalid: boolean
} {
  const url = new URL(window.location.href)
  const rawGeneration = url.searchParams.get('generation')
  const path = url.searchParams.get('file')
  const hadHandoff = rawGeneration !== null || path !== null
  const generation =
    rawGeneration !== null && /^[1-9]\d*$/.test(rawGeneration)
      ? Number(rawGeneration)
      : 0
  const handoff =
    Number.isSafeInteger(generation) &&
    generation > 0 &&
    path !== null &&
    path !== ''
      ? { generation, p: path }
      : undefined
  if (hadHandoff) {
    url.searchParams.delete('generation')
    url.searchParams.delete('file')
    history.replaceState(history.state, '', url)
  }
  return {
    bootstrap: { handoff },
    invalid: hadHandoff && handoff === undefined,
  }
}
export class PairingRefusal extends Error {}

export async function issueBrowserPair(
  generation: number,
  signal: AbortSignal,
): Promise<ChatEnvelope> {
  const request: BrowserPairRequest = { v: 1, generation }
  const response = await fetch('pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    referrerPolicy: 'no-referrer',
    signal,
  })
  const result = parseStrictJSON(await response.text())
  if (
    isExactObject(result, ['v', 'ok', 'error']) &&
    result.v === 1 &&
    result.ok === false &&
    typeof result.error === 'string' &&
    [
      'stale-generation',
      'invalid',
      'forbidden',
      'unsupported',
      'launch-failed',
      'busy',
      'timeout',
      'too-large',
      'disconnected',
    ].includes(result.error)
  )
    throw new PairingRefusal(result.error)
  if (
    !response.ok ||
    !isExactObject(result, ['v', 'ok', 'value']) ||
    result.v !== 1 ||
    result.ok !== true
  )
    throw new Error('Invalid pairing response')
  const envelope = parseChatEnvelope(result.value)
  if (envelope === undefined) throw new Error('Invalid pairing response')
  return envelope
}

export function browserTransport(
  invalidEvent: () => void,
  observe: { event(value: ServerEvent): void; closed(): void },
): DashboardTransport {
  return {
    listen(sink) {
      const events = new EventSource('events')
      let active = true
      events.onopen = () => {
        if (active) sink.ready()
      }
      events.onerror = () => {
        if (!active) return
        active = false
        events.close()
        observe.closed()
        sink.closed('disconnected')
      }
      events.onmessage = (message) => {
        let event: ServerEvent
        if (!active) return
        try {
          event = JSON.parse(message.data) as ServerEvent
        } catch {
          invalidEvent()
          return
        }
        sink.event(event)
        observe.event(event)
      }
      return () => {
        active = false
        events.close()
      }
    },
    async execute<C extends HostCommand>(request: {
      v: 1
      generation: number
      command: C
    }) {
      const response = await fetch('command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        referrerPolicy: 'no-referrer',
      })
      return (await response.json()) as
        | CommandReplies[C['kind']]
        | CommandRefusal
    },
  }
}
