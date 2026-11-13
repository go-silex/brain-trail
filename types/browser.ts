import type { Layout } from '../hooks/map'
import type {
  Coach,
  Lang,
  Meter,
  PreviewRef,
  TrailEvent,
  TrailSettings,
} from './model'
import type {
  CompactOutcome,
  CostHistory,
  InstructionFile,
  SettingsPatch,
  SharedView,
  SharedViewIntent,
} from './view'

export type FactsWire = {
  assistant: string
  lang: Lang
  meter: Meter
  events: TrailEvent[]
  settings: TrailSettings
  coach: Coach
  workspace:
    | { kind: 'loading'; since: number }
    | { kind: 'failed'; message: string }
    | { kind: 'ready'; layoutRev: number; shallow: boolean }
  linked: string[]
  connected: [string, string[]][]
  costHistory: CostHistory
  apps: string[]
  instructionFile: InstructionFile
}
export type LayoutWire = {
  layoutRev: number
  root: string
  paths: string[]
  layout: Layout
}
export type ServerEvent =
  | { v: 1; kind: 'layout'; generation: number; layout: LayoutWire }
  | {
      v: 1
      kind: 'snapshot'
      generation: number
      revision: number
      facts: FactsWire
      shared: SharedView
    }
  | { v: 1; kind: 'ended'; generation: number }
export type HostCommand =
  | { kind: 'open'; ref: PreviewRef; app: string }
  | { kind: 'preview-read'; ref: PreviewRef }
  | { kind: 'settings'; patch: SettingsPatch }
  | { kind: 'view'; intent: SharedViewIntent }
  | { kind: 'lang'; lang: Lang }
  | {
      kind:
        | 'clear-trail'
        | 'compact'
        | 'refresh-meter'
        | 'retry-layout'
        | 'coach-analyse'
        | 'coach-apply'
    }
export type CommandReplies = {
  open: { ok: true }
  'preview-read': { ok: true; text: string | null }
  settings: { ok: true }
  view: { ok: true }
  lang: { ok: true }
  'clear-trail': { ok: true }
  compact: { ok: true; outcome: CompactOutcome }
  'refresh-meter': { ok: true }
  'retry-layout': { ok: true }
  'coach-analyse': { ok: true }
  'coach-apply': { ok: true; filled: boolean }
}
export type CommandRefusal = {
  ok: false
  error:
    | 'stale-generation'
    | 'invalid'
    | 'forbidden'
    | 'unsupported'
    | 'busy'
    | 'timeout'
    | 'too-large'
    | 'disconnected'
}
export type CommandRequest = { v: 1; generation: number; command: HostCommand }
export type DashboardFeed = {
  current(): {
    generation: number
    revision: number
    facts: FactsWire
    shared: SharedView
    layout: LayoutWire | undefined
  }
  execute<C extends HostCommand>(
    generation: number,
    command: C,
  ): Promise<CommandReplies[C['kind']] | CommandRefusal>
  subscribe(listener: (event: ServerEvent) => void): () => void
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const ref = (value: unknown): value is PreviewRef =>
  record(value) &&
  typeof value.p === 'string' &&
  value.p.length > 0 &&
  (value.out === undefined || typeof value.out === 'boolean') &&
  Object.keys(value).every((k) => k === 'p' || k === 'out')
const settings = (value: unknown): value is SettingsPatch =>
  record(value) &&
  Object.keys(value).length > 0 &&
  Object.entries(value).every(([k, v]) =>
    k === 'openMd' || k === 'openOther'
      ? typeof v === 'string'
      : k === 'hover' || k === 'band'
        ? typeof v === 'boolean'
        : k === 'planUsd'
          ? v === null ||
            (typeof v === 'number' && Number.isFinite(v) && v >= 0)
          : false,
  )

const intent = (value: unknown): value is SharedViewIntent => {
  if (!record(value)) return false
  const keys = Object.keys(value)
  switch (value.kind) {
    case 'preview':
      return keys.length === 2 && (value.ref === null || ref(value.ref))
    case 'follow':
      return keys.length === 2 && typeof value.following === 'boolean'
    case 'replay-play':
      return (
        keys.length === 2 &&
        Number.isSafeInteger(value.steps) &&
        (value.steps as number) >= 0
      )
    case 'replay-step':
      return (
        keys.length === 3 &&
        (value.by === -1 || value.by === 1) &&
        Number.isSafeInteger(value.steps) &&
        (value.steps as number) >= 0
      )
    case 'whole':
    case 'replay-pause':
    case 'replay-live':
    case 'replay-reset':
      return keys.length === 1
    default:
      return false
  }
}

export const parseCommand = (body: unknown): CommandRequest | undefined => {
  if (
    !record(body) ||
    body.v !== 1 ||
    !Number.isSafeInteger(body.generation) ||
    typeof body.generation !== 'number' ||
    body.generation < 1 ||
    !record(body.command) ||
    Object.keys(body).some((k) => !['v', 'generation', 'command'].includes(k))
  )
    return undefined
  const c = body.command
  let command: HostCommand
  switch (c.kind) {
    case 'open':
      if (!ref(c.ref) || typeof c.app !== 'string') return undefined
      command = { kind: 'open', ref: c.ref, app: c.app }
      break
    case 'preview-read':
      if (!ref(c.ref)) return undefined
      command = { kind: 'preview-read', ref: c.ref }
      break
    case 'settings':
      if (!settings(c.patch)) return undefined
      command = { kind: 'settings', patch: c.patch }
      break
    case 'view':
      if (!intent(c.intent)) return undefined
      command = { kind: 'view', intent: c.intent }
      break
    case 'lang':
      if (c.lang !== 'en' && c.lang !== 'fr') return undefined
      command = { kind: 'lang', lang: c.lang }
      break
    case 'clear-trail':
    case 'compact':
    case 'refresh-meter':
    case 'retry-layout':
    case 'coach-analyse':
    case 'coach-apply':
      command = { kind: c.kind }
      break
    default:
      return undefined
  }
  const allowed =
    command.kind === 'open'
      ? ['kind', 'ref', 'app']
      : command.kind === 'preview-read'
        ? ['kind', 'ref']
        : command.kind === 'settings'
          ? ['kind', 'patch']
          : command.kind === 'view'
            ? ['kind', 'intent']
            : command.kind === 'lang'
              ? ['kind', 'lang']
              : ['kind']
  if (Object.keys(c).some((k) => !allowed.includes(k))) return undefined
  return { v: 1, generation: body.generation, command }
}
