import type {
  AppAuth,
  Cursor,
  Pulled,
  Reply,
  ViewState,
} from '../../types/apps'
import type {
  CommandRefusal,
  CommandReplies,
  HostCommand,
} from '../../types/browser'
import type { DashboardTransport } from '../browser/transport'
import { pulled, refusal, type ToolCall } from './wire'

function commandReply<C extends HostCommand>(
  command: C,
  value: unknown,
): value is CommandReplies[C['kind']] {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const result = value as Record<string, unknown>
  if (result.ok !== true) return false
  const names = Object.keys(result)
  if (command.kind === 'preview-read')
    return (
      names.length === 2 &&
      (result.text === null || typeof result.text === 'string')
    )
  if (command.kind === 'coach-apply')
    return names.length === 2 && typeof result.filled === 'boolean'
  if (command.kind === 'open') {
    const launch = result.launch
    return (
      names.length === 2 &&
      typeof launch === 'object' &&
      launch !== null &&
      !Array.isArray(launch) &&
      Object.keys(launch).length === 1 &&
      'status' in launch &&
      (launch.status === 'spawned' || launch.status === 'dispatched')
    )
  }
  if (command.kind === 'compact') {
    const outcome = result.outcome
    if (
      names.length !== 2 ||
      typeof outcome !== 'object' ||
      outcome === null ||
      Array.isArray(outcome) ||
      !('kind' in outcome)
    )
      return false
    if (outcome.kind === 'done' || outcome.kind === 'failed')
      return Object.keys(outcome).length === 1
    return (
      outcome.kind === 'skipped' &&
      Object.keys(outcome).length === 2 &&
      'reason' in outcome &&
      typeof outcome.reason === 'string'
    )
  }
  return names.length === 1
}

export function appTransport(
  auth: AppAuth,
  call: ToolCall,
  initial: ViewState,
  onState: (state: ViewState) => void,
  onClosed: () => void,
): DashboardTransport {
  let active = false
  let epoch = 0
  let cursor: Cursor | null = null
  let current: ViewState = initial
  let timer: number | undefined
  let close:
    | ((reason: 'ended' | 'revoked' | 'disconnected') => void)
    | undefined
  const end = (reason: 'ended' | 'revoked' | 'disconnected') => {
    if (!active) return
    active = false
    epoch++
    clearTimeout(timer)
    cursor = null
    current = { kind: 'detached' }
    close?.(reason)
    onClosed()
  }
  const fail = (error: CommandRefusal['error']) => {
    if (error === 'stale-generation' || error === 'forbidden') end('revoked')
    else if (error === 'disconnected' || error === 'timeout')
      end('disconnected')
  }
  return {
    listen(sink) {
      active = true
      const mine = ++epoch
      close = sink.closed
      sink.ready()
      const poll = async () => {
        if (!active || mine !== epoch) return
        let result: Reply<Pulled>
        try {
          result = await call('brain_trail_pull', { ...auth, cursor }, pulled)
        } catch {
          end('disconnected')
          return
        }
        if (!active || mine !== epoch) return
        if (!result.ok) {
          fail(result.error)
          if (active) end('disconnected')
          return
        }
        const next = result.value
        if (
          cursor !== null &&
          next.cursor !== null &&
          (next.cursor.generation !== cursor.generation ||
            next.cursor.revision < cursor.revision ||
            (cursor.layoutRev !== null &&
              (next.cursor.layoutRev === null ||
                next.cursor.layoutRev < cursor.layoutRev)))
        ) {
          end('revoked')
          return
        }
        if (current.kind === 'attached' && next.state.kind !== 'attached') {
          end('revoked')
          return
        }
        if (
          next.state.kind === 'attached' &&
          current.kind === 'attached' &&
          (next.state.generation !== current.generation ||
            next.state.source.owner.host !== current.source.owner.host ||
            next.state.source.owner.sessionId !==
              current.source.owner.sessionId)
        ) {
          end('revoked')
          return
        }
        current = next.state
        onState(current)
        if (!active || mine !== epoch) return
        if (current.kind === 'detached') {
          end('revoked')
          return
        }
        cursor = next.cursor
        for (const event of next.events) {
          if (!active || mine !== epoch) return
          try {
            sink.event(event)
          } catch {
            end('disconnected')
            return
          }
        }
        if (active && mine === epoch) timer = window.setTimeout(poll, 1000)
      }
      if (current.kind !== 'detached') void poll()
      return () => {
        active = false
        epoch++
        clearTimeout(timer)
        cursor = null
        current = { kind: 'detached' }
        close = undefined
      }
    },
    async execute<C extends HostCommand>(request: {
      v: 1
      generation: number
      command: C
    }) {
      if (
        !active ||
        current.kind !== 'attached' ||
        current.generation !== request.generation
      )
        return refusal('stale-generation')
      const mine = epoch
      try {
        const result = await call(
          'brain_trail_command',
          { ...auth, request },
          (v): v is CommandReplies[C['kind']] =>
            commandReply(request.command, v),
        )
        if (!active || mine !== epoch) return refusal('disconnected')
        if (!result.ok) {
          fail(result.error)
          return result
        }
        return result.value
      } catch {
        if (active && mine === epoch) end('disconnected')
        return refusal('disconnected')
      }
    },
  }
}
