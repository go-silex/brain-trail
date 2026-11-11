// Replay of a recorded session onto the folder index. No host SDK.
import type { Call, Kind, Move, Trail, TrailEvent } from '../types/model'
import { rank } from '../types/model'
import { pairKey } from './files'
import { nameServer } from './mcp'

// the steps a replay walks through: notes read or written, calls to a service
export const isStep = (ev: TrailEvent) =>
  ((ev.k === 'read' || ev.k === 'write') && !ev.out) || ev.k === 'mcp'

export type FoldIndex = {
  ids: { get(p: string): number | undefined }
  paths: readonly string[]
}

// Each server is named from all its tools: those the context lists (connected) and those the session called.
export const nameServers = (
  list: readonly TrailEvent[],
  connected: ReadonlyMap<string, Set<string>>,
) => {
  const tools = new Map<string, Set<string>>(
    [...connected].map(([k, v]) => [k, new Set(v)]),
  )
  for (const ev of list)
    if (ev.k === 'mcp')
      tools.set(ev.server, new Set([...(tools.get(ev.server) ?? []), ev.tool]))
  return new Map(
    [...tools].map(([server, set]) => [server, nameServer(server, set)]),
  )
}

const isNote = (p: string) => p.endsWith('.md')

export type ReplayStats = {
  read: number
  write: number
  hit: number
  link: number
  gap: number
}
export type Replay = {
  trail: Trail
  stats: ReplayStats
  gaps: { from: number; to: number }[]
  outside: number
  names: Map<string, string>
}

export const replay = (
  list: readonly TrailEvent[],
  index: FoldIndex | undefined,
  linked: { has(key: string): boolean; keys(): Iterable<string> },
  connected: ReadonlyMap<string, Set<string>>,
): Replay => {
  const names = nameServers(list, connected)
  const state = new Map<number, { k: Kind; count: number }>()
  const moves: Move[] = []
  const calls: Call[] = []
  const perSvc = new Map<string, number>()
  const stats: ReplayStats = { read: 0, write: 0, hit: 0, link: 0, gap: 0 }
  let outside = 0
  const outSeen = new Set<string>()
  list.forEach((ev, i) => {
    if (ev.k === 'mcp') {
      const svc = names.get(ev.server) ?? ev.server
      calls.push({
        svc,
        tool: ev.tool,
        label: ev.label,
        err: ev.err === true,
        from: moves.at(-1)?.n,
        at: ev.at,
      })
      perSvc.set(svc, (perSvc.get(svc) ?? 0) + 1)
      return
    }
    // a name that entered the context: lit on the map, no move
    const mark = (n: number, k: Kind) => {
      const prev = state.get(n)
      if (!prev) stats[k]++
      else if (rank[k] > rank[prev.k]) {
        stats[prev.k]--
        stats[k]++
      }
      state.set(n, {
        k: prev && rank[prev.k] > rank[k] ? prev.k : k,
        count: (prev?.count ?? 0) + 1,
      })
    }
    if (ev.k === 'seen') {
      for (const p of ev.ps) {
        const n = index?.ids.get(p)
        if (n !== undefined) mark(n, ev.via === 'link' ? 'link' : 'hit')
      }
      return
    }
    if (ev.k !== 'read' && ev.k !== 'write' && ev.k !== 'hit') return
    if (ev.out) {
      if (!outSeen.has(ev.p)) {
        outSeen.add(ev.p)
        outside++
      }
      return
    }
    const n = index?.ids.get(ev.p)
    if (n === undefined) return
    mark(n, ev.k)
    if (ev.k === 'hit') return
    const from = moves.at(-1)?.n
    if (from === n) return
    // a jump with no link only counts between two notes: code files have no links to follow
    const gap =
      from !== undefined &&
      isNote(ev.p) &&
      isNote(index!.paths[from]!) &&
      !linked.has(pairKey(from, n))
    moves.push({ n, gap, at: ev.at, i })
    if (gap) stats.gap++
  })
  const gaps: { from: number; to: number }[] = []
  for (let j = moves.length - 1; j > 0; j--) {
    const m = moves[j]!,
      prev = moves[j - 1]!
    if (
      m.gap &&
      !linked.has(pairKey(prev.n, m.n)) &&
      !gaps.some((g) => pairKey(g.from, g.to) === pairKey(prev.n, m.n))
    )
      gaps.push({ from: prev.n, to: m.n })
  }
  // the links the notes the session read declare, between two files it met
  const links: [number, number][] = []
  for (const k of linked.keys()) {
    const [a, b] = k.split(':').map(Number) as [number, number]
    if (state.has(a) && state.has(b)) links.push([a, b])
  }
  const trail: Trail = { state, moves, calls, perSvc, links }
  return { trail, stats, gaps, outside, names }
}

// The events a replay draws up to one step, that step stamped as happening now. `step === null` is the live list, same reference.
export const sliceToStep = (
  list: TrailEvent[],
  step: number | null,
  now: number,
) => {
  const steps = list.flatMap((ev, k) => (isStep(ev) ? [k] : []))
  const at = step === null ? undefined : Math.min(step, steps.length - 1)
  const shown =
    at === undefined || steps.length === 0
      ? list
      : list
          .slice(0, steps[at]! + 1)
          .map((ev, k) => (k === steps[at]! ? { ...ev, at: now } : ev))
  return { steps, at, shown }
}
