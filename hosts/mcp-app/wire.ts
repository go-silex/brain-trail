import type {
  Bootstrap,
  Mounted,
  Pulled,
  Reply,
  ResetView,
  Attached,
} from '../../types/apps'
import { isCursor, isLabel, isOwner, isToken } from '../../types/apps'
import type { CommandRefusal, ServerEvent } from '../../types/browser'

export type ToolCall = <T>(
  name: string,
  args: Record<string, unknown>,
  validate: (value: unknown) => value is T,
) => Promise<Reply<T>>

type Obj = Record<string, unknown>
const obj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const keys = (v: Obj, names: string[]) =>
  Object.keys(v).length === names.length &&
  names.every((k) => Object.hasOwn(v, k))
const positive = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) > 0
const nonnegative = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0
const hex = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export const bootstrap = (v: unknown): v is Bootstrap =>
  obj(v) &&
  keys(v, [
    'v',
    'wireRevision',
    'uiBuildId',
    'assetDigest',
    'serverEpoch',
    'viewKey',
  ]) &&
  v.v === 1 &&
  v.wireRevision === 1 &&
  hex(v.uiBuildId) &&
  hex(v.assetDigest) &&
  isToken(v.serverEpoch) &&
  isToken(v.viewKey)
const attached = (v: unknown): v is Attached => {
  if (
    !obj(v) ||
    !keys(v, ['kind', 'generation', 'source']) ||
    v.kind !== 'attached' ||
    !positive(v.generation) ||
    !obj(v.source) ||
    !keys(v.source, ['owner', 'label'])
  )
    return false
  return isOwner(v.source.owner) && isLabel(v.source.label)
}
const state = (v: unknown) =>
  attached(v) ||
  (obj(v) &&
    keys(v, ['kind']) &&
    (v.kind === 'pending' || v.kind === 'detached'))
export const mounted = (v: unknown): v is Mounted =>
  obj(v) &&
  keys(v, ['mountKey', 'state']) &&
  isToken(v.mountKey) &&
  state(v.state)
export const resetView = (v: unknown): v is ResetView =>
  obj(v) &&
  keys(v, ['bootstrap', 'state']) &&
  bootstrap(v.bootstrap) &&
  obj(v.state) &&
  keys(v.state, ['kind']) &&
  v.state.kind === 'detached'
const event = (
  v: unknown,
  generation: number,
  ownerHost: 'code' | 'omp',
): v is Exclude<ServerEvent, { kind: 'ended' }> => {
  if (!obj(v) || v.v !== 1 || v.generation !== generation) return false
  if (v.kind === 'layout')
    return (
      keys(v, ['v', 'kind', 'generation', 'layout']) &&
      obj(v.layout) &&
      nonnegative(v.layout.layoutRev)
    )
  if (v.kind === 'snapshot')
    return (
      keys(v, ['v', 'kind', 'generation', 'revision', 'facts', 'shared']) &&
      nonnegative(v.revision) &&
      obj(v.facts) &&
      v.facts.ownerHost === ownerHost &&
      obj(v.shared)
    )
  return false
}
export const pulled = (v: unknown): v is Pulled => {
  if (
    !obj(v) ||
    !keys(v, ['state', 'cursor', 'events']) ||
    !state(v.state) ||
    !Array.isArray(v.events)
  )
    return false
  if (!attached(v.state)) return v.cursor === null && v.events.length === 0
  const currentState = v.state
  const currentCursor = v.cursor
  if (
    !isCursor(currentCursor) ||
    currentCursor.generation !== currentState.generation ||
    v.events.length > 2 ||
    !v.events.every((e) =>
      event(e, currentState.generation, currentState.source.owner.host),
    )
  )
    return false
  if (
    v.events.length === 2 &&
    (v.events[0]?.kind !== 'layout' || v.events[1]?.kind !== 'snapshot')
  )
    return false
  return v.events.every((e) =>
    e.kind === 'layout'
      ? e.layout.layoutRev === currentCursor.layoutRev
      : e.revision === currentCursor.revision,
  )
}
const errors: Record<string, true> = {
  'stale-generation': true,
  invalid: true,
  forbidden: true,
  unsupported: true,
  'launch-failed': true,
  busy: true,
  timeout: true,
  'too-large': true,
  disconnected: true,
}
export function reply<T>(
  v: unknown,
  valid: (value: unknown) => value is T,
): Reply<T> | undefined {
  if (!obj(v) || v.v !== 1) return undefined
  if (
    v.ok === false &&
    keys(v, ['v', 'ok', 'error']) &&
    typeof v.error === 'string' &&
    errors[v.error] === true
  )
    return v as Reply<T>
  if (v.ok === true && keys(v, ['v', 'ok', 'value']) && valid(v.value))
    return v as Reply<T>
  return undefined
}
export const refusal = (error: CommandRefusal['error']): CommandRefusal => ({
  ok: false,
  error,
})
export const detached = (v: unknown): v is { kind: 'detached' } =>
  obj(v) && keys(v, ['kind']) && v.kind === 'detached'
export const nil = (v: unknown): v is null => v === null
export { attached }
