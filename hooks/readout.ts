// Projections and figures of the recorded session and its meter. No host SDK.
import type { Lang, Meter, TrailEvent } from '../types/model'

// Fields a projection reads off a context breakdown. The host breakdown is passed as-is; it is not imported.
export type ContextView = {
  rawMaxTokens?: number
  isAutoCompactEnabled?: boolean
  autoCompactThreshold?: number
  categories?: readonly { kind: string; name: string; tokens: number }[]
  mcpTools?: readonly { name: string; tokens: number; isLoaded: boolean }[]
  memoryFiles?: readonly { path: string; tokens: number }[]
}

export const resetLabel = (iso: string | undefined, lang: Lang) => {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? time
    : `${d.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

export const limitOf = (m: Meter, kind: string) =>
  m.limits?.find((l) => l.kind === kind)

export const fmt = (n: number) =>
  n >= 100000
    ? `${Math.round(n / 1000)}k`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(Math.round(n))
export const estimate = (text: string) => Math.round(text.length / 3.6)
export const usd = (n: number) =>
  n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`
export const zoneOf = (p: number) =>
  (p < 50 ? 'ok' : p < 75 ? 'warn' : 'bad') as 'ok' | 'warn' | 'bad'

export type CostEntry = { day: string; usd: number; prompts: number }

// the last 400 sessions are enough to know one's habits
export const keepCosts = (all: Record<string, CostEntry>) =>
  Object.fromEntries(
    Object.entries(all)
      .sort((a, z) => z[1].day.localeCompare(a[1].day))
      .slice(0, 400),
  )

export const costStats = (
  all: Record<string, CostEntry>,
  id: string,
  month: string,
) => {
  const others = Object.entries(all)
    .filter(([k, v]) => k !== id && v.usd > 0.01)
    .map(([, v]) => v)
  const sorted = others.map((v) => v.usd).sort((a, z) => a - z)
  const median =
    sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)]
  const monthUsd = Object.values(all)
    .filter((v) => v.day.startsWith(month))
    .reduce((a, v) => a + v.usd, 0)
  return { median, count: others.length, monthUsd }
}

export const windowFacts = (
  percent: number | undefined,
  window: number,
  b: ContextView | undefined,
) => {
  const pct = percent ?? 0
  const win = window || b?.rawMaxTokens || 0
  const compactAt =
    b?.isAutoCompactEnabled && b.autoCompactThreshold !== undefined && win > 0
      ? Math.round((b.autoCompactThreshold / win) * 100)
      : undefined
  return { pct, zone: zoneOf(pct), win, compactAt }
}

export const usedStart = (categories: ContextView['categories']) => {
  const used = (categories ?? []).filter((k) => k.kind === 'used')
  const startCats = used.filter((k) => k.name !== 'Messages')
  const startTotal = startCats.reduce((a, k) => a + k.tokens, 0)
  const messages = used.find((k) => k.name === 'Messages')
  return { startCats, startTotal, messages }
}

// the tool results that took the most room since the last compaction
export const costsSinceCompact = (list: readonly TrailEvent[]) => {
  let since = 0
  list.forEach((ev, i) => {
    if (ev.k === 'compact') since = i + 1
  })
  return list
    .slice(since)
    .flatMap((ev) => (ev.k === 'cost' ? [ev] : []))
    .sort((a, z) => z.tokens - a.tokens)
    .slice(0, 5)
}

export const costRatio = (
  spent: number | undefined,
  median: number | undefined,
  count: number,
) =>
  spent !== undefined && median !== undefined && count >= 3
    ? spent / median
    : undefined

export type FileEntry = {
  p: string
  out?: true
  reads: number
  writes: number
  seen: boolean
  linked: boolean
  start: boolean
  agent: boolean
  tokens: number
}
export type FileDir = {
  name: string
  path: string
  dirs: Map<string, FileDir>
  files: FileEntry[]
}

export const projectFiles = (
  list: readonly TrailEvent[],
  memory: ContextView['memoryFiles'],
  root: string,
) => {
  const rel = (abs: string) =>
    root !== '' && abs.startsWith(`${root}/`)
      ? { p: abs.slice(root.length + 1) }
      : { p: abs, out: true as const }
  const all = new Map<string, FileEntry>()
  const entry = (p: string, out?: true) => {
    let x = all.get(p)
    if (x === undefined) {
      x = {
        p,
        ...(out ? { out } : {}),
        reads: 0,
        writes: 0,
        seen: false,
        linked: false,
        start: false,
        agent: false,
        tokens: 0,
      }
      all.set(p, x)
    }
    return x
  }
  for (const f of memory ?? []) {
    const r = rel(f.path)
    const x = entry(r.p, r.out)
    x.start = true
    x.tokens += f.tokens
  }
  // token weight of a whole-file read, as the capture recorded it under the Read tool name
  const costByFile = new Map<string, number>()
  for (const ev of list)
    if (ev.k === 'cost' && ev.tool === 'Read')
      costByFile.set(ev.label, (costByFile.get(ev.label) ?? 0) + ev.tokens)
  for (const ev of list) {
    if (ev.k === 'seen') {
      for (const p of ev.ps) {
        const x = entry(p)
        if (ev.via === 'link') x.linked = true
        else x.seen = true
      }
      continue
    }
    if (ev.k !== 'read' && ev.k !== 'write' && ev.k !== 'hit') continue
    const x = entry(ev.p, ev.out)
    if (ev.k === 'hit') x.seen = true
    else if (ev.agent) x.agent = true
    else if (ev.k === 'read') x.reads++
    else x.writes++
  }
  for (const x of all.values())
    if (x.reads > 0)
      x.tokens +=
        costByFile.get(x.out ? x.p : `${root}/${x.p}`) ??
        costByFile.get(x.p) ??
        0
  return all
}

export const fileTree = (entries: Iterable<FileEntry>) => {
  const top: FileDir = { name: '', path: '', dirs: new Map(), files: [] }
  const outside: FileEntry[] = []
  for (const x of entries) {
    if (x.reads === 0 && x.writes === 0 && !x.start && !x.agent) continue
    if (x.out) {
      outside.push(x)
      continue
    }
    const parts = x.p.split('/')
    let d = top
    for (const part of parts.slice(0, -1)) {
      const path = d.path === '' ? part : `${d.path}/${part}`
      if (!d.dirs.has(part))
        d.dirs.set(part, { name: part, path, dirs: new Map(), files: [] })
      d = d.dirs.get(part)!
    }
    d.files.push(x)
  }
  return { top, outside }
}

export type FigureId =
  | 'start'
  | 'read'
  | 'written'
  | 'found'
  | 'linked'
  | 'agent'
  | 'missing'
export type FileFigure = { id: FigureId; files?: FileEntry[]; n: number }

export const fileFigures = (
  entries: readonly FileEntry[],
  gaps: number,
): FileFigure[] => {
  const pickFiles = (keep: (x: FileEntry) => boolean) =>
    entries
      .filter(keep)
      .sort((a, z) => z.tokens - a.tokens || a.p.localeCompare(z.p))
  const figures: { id: FigureId; files?: FileEntry[] }[] = [
    { id: 'start', files: pickFiles((x) => x.start) },
    { id: 'read', files: pickFiles((x) => x.reads > 0) },
    { id: 'written', files: pickFiles((x) => x.writes > 0) },
    {
      id: 'found',
      files: pickFiles((x) => x.seen && x.reads === 0 && x.writes === 0),
    },
    {
      id: 'linked',
      files: pickFiles(
        (x) => x.linked && !x.seen && x.reads === 0 && x.writes === 0,
      ),
    },
    ...(entries.some((x) => x.agent)
      ? [{ id: 'agent' as const, files: pickFiles((x) => x.agent) }]
      : []),
    { id: 'missing' },
  ]
  return figures.map((fg) => ({ ...fg, n: fg.files?.length ?? gaps }))
}
