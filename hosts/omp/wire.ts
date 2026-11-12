import type { Layout } from '../../hooks/map'
import type {
  Coach,
  Lang,
  Meter,
  PreviewRef,
  TrailEvent,
  TrailSettings,
} from '../../types/model'
import type {
  CompactOutcome,
  CostHistory,
  InstructionFile,
} from '../../types/view'

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
    }
  | { v: 1; kind: 'ended'; generation: number }
export type HostCommand =
  | { kind: 'open'; ref: PreviewRef; app: string }
  | { kind: 'preview-read'; ref: PreviewRef }
  | { kind: 'settings'; next: TrailSettings }
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
  error: 'stale-generation' | 'invalid' | 'forbidden' | 'unsupported'
}
export type CommandRequest = { v: 1; generation: number; command: HostCommand }
export type DashboardFeed = {
  current(): {
    generation: number
    revision: number
    facts: FactsWire
    layout: LayoutWire | undefined
  }
  execute<C extends HostCommand>(
    generation: number,
    command: C,
  ): Promise<CommandReplies[C['kind']] | CommandRefusal>
  subscribe(listener: (event: ServerEvent) => void): () => void
  threeD(): { page: string; data: string } | undefined
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const ref = (value: unknown): value is PreviewRef =>
  record(value) &&
  typeof value.p === 'string' &&
  value.p.length > 0 &&
  (value.out === undefined || typeof value.out === 'boolean') &&
  Object.keys(value).every((k) => k === 'p' || k === 'out')
const settings = (value: unknown): value is TrailSettings =>
  record(value) &&
  typeof value.openMd === 'string' &&
  typeof value.openOther === 'string' &&
  typeof value.hover === 'boolean' &&
  (value.planUsd === undefined ||
    (typeof value.planUsd === 'number' &&
      Number.isFinite(value.planUsd) &&
      value.planUsd >= 0)) &&
  (value.band === undefined || typeof value.band === 'boolean') &&
  Object.keys(value).every((k) =>
    ['openMd', 'openOther', 'hover', 'planUsd', 'band'].includes(k),
  )

export const parseCommand = (body: unknown): CommandRequest | undefined => {
  if (
    !record(body) ||
    body.v !== 1 ||
    !Number.isSafeInteger(body.generation) ||
    typeof body.generation !== 'number' ||
    body.generation < 1 ||
    !record(body.command)
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
      if (!settings(c.next)) return undefined
      command = { kind: 'settings', next: c.next }
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
  return { v: 1, generation: body.generation, command }
}
