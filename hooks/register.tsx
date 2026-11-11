import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown } from 'claude-code'

import type { Handoff, Lang, Meter, TrailSettings, Tab, Totals, TrailEvent } from '../types'
import { MAX_FILES, MAX_SEEN, afterCd, describe, keepFile, linksIn, makeIndex, pairKey, pathsIn, touchedBy } from './files'
import type { Index } from './files'
import { coachPrompt, strings } from './i18n'
import type { Strings } from './i18n'
import { DARK, LIGHT, SIZE, banner, draw, fileName, gauge, kindColors, packFiles, rank, tilt } from './map'
import { isLocal, nameServer, splitMcp, toolsByServer } from './mcp'
import { base3d, data3d, page3d } from './brain3d'
import { LOGOS } from './logos'
import { CAM0, PITCH_MAX, PITCH_MIN, drawSpin, pickSpin, yawAt } from './spin'
import type { Cam, SpinView } from './spin'
import type { Call, Kind, Layout, Move, Palette, Trail } from './map'

const NAME = 'brain-trail-v2'
const COMMAND = 'brain-trail-v2'
const PANE = 'brain-trail-v2'
const TITLE = 'Brain Trail'
const CACHE_DIR = '.claude/brain-trail-v2'
const MAX_EVENTS = 2000

const events = atom({ plugin: 'brain-trail-v2', key: 'events' } as const, [] as TrailEvent[], { shape: 'events-1' })
const totals = atom({ plugin: 'brain-trail-v2', key: 'totals' } as const, { steps: 0 } as Totals, { shape: 'totals-1' })
const meter = atom({ plugin: 'brain-trail-v2', key: 'meter' } as const, { window: 0 } as Meter, { shape: 'meter-1' })
const tabA = atom({ plugin: 'brain-trail-v2', key: 'tab' } as const, 'map' as Tab)
const langA = atom({ plugin: 'brain-trail-v2', key: 'lang' } as const, 'en' as Lang)
const zoomed = atom({ plugin: 'brain-trail-v2', key: 'zoomed' } as const, false)
// the sections a person opened with « More details »
const openA = atom({ plugin: 'brain-trail-v2', key: 'open' } as const, [] as string[])
// a frame the wheel zoomed to, in map units; null = the folder's own frame
const cameraA = atom({ plugin: 'brain-trail-v2', key: 'camera' } as const, null as { x: number; y: number; side: number } | null, { shape: 'camera-1' })
// the replay: the step shown (null = live) and whether it plays
const playA = atom({ plugin: 'brain-trail-v2', key: 'play' } as const, { step: null, playing: false } as { step: number | null; playing: boolean }, { shape: 'play-1' })
let playTimer: { cancel: () => void } | undefined
// the map in 3D inside the pane (the 2D map is the default), and its camera: turn, height, zoom, turning by itself or not
const view3dA = atom({ plugin: 'brain-trail-v2', key: 'view3d' } as const, false)
const cam3dA = atom({ plugin: 'brain-trail-v2', key: 'cam3d' } as const, CAM0 as Cam, { shape: 'cam3d-1' })
let lastSpin: { view: SpinView; L: Layout; touched: Set<number> } | undefined
let drag3d: { yaw: number; pitch: number; spin: boolean } | undefined
const STEP_MS = 900
// the steps a replay walks through: notes read or written, calls to a service
const isStep = (ev: TrailEvent) => ((ev.k === 'read' || ev.k === 'write') && !ev.out) || ev.k === 'mcp'
// a file read inside the pane (the « Preview in Brain Trail » choice), or none
const previewA = atom({ plugin: 'brain-trail-v2', key: 'preview' } as const, null as { p: string; out?: boolean } | null, { shape: 'preview-1' })
// the coach's analysis of the session, and the lines it proposes for the instructions file
const coachA = atom({ plugin: 'brain-trail-v2', key: 'coach' } as const, { text: '', at: 0, busy: false } as { text: string; patch?: string; at: number; busy: boolean; error?: string }, { shape: 'coach-1' })
// the weather of the context window: clear below a quarter, a storm past three quarters
const weather = (p: number) => (p < 25 ? '☀️' : p < 50 ? '🌤️' : p < 75 ? '🌧️' : '⛈️')
const resetLabel = (iso: string | undefined, lang: Lang) => {
  if (iso === undefined) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date().toDateString() === d.toDateString()
  return today ? time : `${d.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}
const limitOf = (m: Meter, kind: string) => m.limits?.find(l => l.kind === kind)
const DEFAULT_SETTINGS: TrailSettings = { openMd: 'default', openOther: 'default', hover: true }
const settingsA = atom({ plugin: 'brain-trail-v2', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'settings-1' })

// ---- MCP services ----

// Each server is named from all its tools: those the context lists (connected) and those the session called.
let connected = new Map<string, Set<string>>()
const nameServers = (list: TrailEvent[]) => {
  const tools = new Map<string, Set<string>>([...connected].map(([k, v]) => [k, new Set(v)]))
  for (const ev of list) if (ev.k === 'mcp') tools.set(ev.server, new Set([...(tools.get(ev.server) ?? []), ev.tool]))
  return new Map([...tools].map(([server, set]) => [server, nameServer(server, set)]))
}
const LABEL_KEYS = ['query', 'q', 'search', 'subject', 'title', 'name', 'url', 'prompt']
const callLabel = (input: Record<string, unknown>) => {
  for (const k of LABEL_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim() !== '' && !v.includes('@')) return v.split(/\s+/).join(' ').slice(0, 80)
  }
  return ''
}

// ---- the folder, packed into one disc ----

let home: string | undefined
let I: Index | undefined
let layout: Layout | undefined
let packing: Promise<Layout> | undefined
let packingSince = 0
let failure: string | undefined
const linked = new Set<string>()
const metaRead = new Set<string>()
const desc = new Map<string, string>()
let isVault = false

const homeDir = async ($: EngineInterface) => {
  if (home === undefined) home = (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout
  return home
}
const rootDir = async ($: EngineInterface) => (await $.session.cwd()).normalize('NFC').replace(/\/$/, '')
// the folder the map draws: the session's, or the Obsidian vault it sits in (a session opened in a client's
// folder of the vault still shows the whole vault, where its links lead)
let mapRootOf: { cwd: string; root: string } | undefined
const mapRoot = async ($: EngineInterface) => {
  const cwd = await rootDir($)
  if (mapRootOf?.cwd === cwd) return mapRootOf.root
  const h = await homeDir($)
  let root = cwd
  for (let dir = cwd, k = 0; k < 8 && dir.startsWith(`${h}/`) && dir !== h; k++, dir = dir.slice(0, dir.lastIndexOf('/'))) {
    if (await $.fs.exists(`${dir}/.obsidian`).catch(() => false)) { root = dir; break }
  }
  mapRootOf = { cwd, root }
  return root
}
// a session started in the home folder (or the disk's root): the map lists its first levels only
let shallow = false
const hash = (s: string) => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36) }
const cacheFile = async ($: EngineInterface, root: string) => `${await homeDir($)}/${CACHE_DIR}/layout-${hash(root)}.json`

const listFiles = async ($: EngineInterface, root: string) => {
  const h = await homeDir($)
  shallow = root === h || root === '' || root === '/' || root === '/Users' || root === '/home'
  const git = shallow ? undefined : await $.process.run(['git', '-c', 'core.quotePath=false', 'ls-files', '-co', '--exclude-standard'], { cwd: root, timeoutMs: 20000 }).catch(() => undefined)
  let raw = git !== undefined && git.exitCode === 0 ? git.stdout : ''
  if (raw === '') {
    // hidden folders are left out, but .claude and .github: Claude reads them (commands, skills, workflows);
    // so are the system's and the media folders of a home folder, and heavy build folders
    const heavy = ['node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv', 'target', 'Library', 'Applications', 'Pictures', 'Movies', 'Music', 'Photos Library.photoslibrary']
    const prune = ['(', '(', '-name', '.*', '!', '-name', '.claude', '!', '-name', '.github', ')', ...heavy.flatMap(n => ['-o', '-name', n]), ')']
    const depth = shallow ? ['-maxdepth', '3'] : []
    const found = await $.process.run(['find', '.', '-mindepth', '1', ...depth, ...prune, '-prune', '-o', '-type', 'f', '-print'], { cwd: root, timeoutMs: 30000 }).catch(() => undefined)
    raw = (found?.stdout ?? '').split('\n').map(p => p.replace(/^\.\//, '')).join('\n')
  }
  const vault = await $.fs.exists(`${root}/.obsidian`).catch(() => false)
  // past the cap, the files nearest the top are kept: the folder's shape stays whole, the deep corners go
  const depthOf = (p: string) => p.split('/').length
  const all = raw.split('\n').map(p => p.normalize('NFC')).filter(p => keepFile(p) && (!vault || p.endsWith('.md')))
  const list = (all.length > MAX_FILES ? [...all].sort((a, z) => depthOf(a) - depthOf(z) || a.localeCompare(z)).slice(0, MAX_FILES) : all).sort()
  if (list.length === 0) throw new Error(`no file under ${root}`)
  return list
}

const setLayout = (root: string, list: string[]) => {
  I = makeIndex(root, list)
  layout = packFiles(list, root.split('/').pop() || root)
}

const refresh = async ($: EngineInterface) => {
  const root = await mapRoot($)
  const list = await listFiles($, root)
  if (layout !== undefined && I?.root === root && list.length === I.paths.length && list.every((p, i) => p === I!.paths[i])) return layout
  setLayout(root, list)
  linked.clear(); metaRead.clear()
  void $.fs.write(await cacheFile($, root), JSON.stringify({ root, files: list })).catch(() => {})
  $.ui.invalidate('ui.render')
  return layout!
}

const load = ($: EngineInterface) => {
  if (layout !== undefined) return Promise.resolve(layout)
  if (packing === undefined) {
    packingSince = Date.now()
    packing = (async () => {
      const root = await mapRoot($)
      isVault = await $.fs.exists(`${root}/.obsidian`).catch(() => false)
      const cached = await $.fs.read(await cacheFile($, root)).then(t => JSON.parse(t) as { root: string; files: string[] }).catch(() => undefined)
      if (cached !== undefined && cached.root === root && cached.files.length > 0) {
        setLayout(root, cached.files)
        void refresh($).catch(() => {})
        return layout!
      }
      return refresh($)
    })().then(L => { failure = undefined; return L }, (err: unknown) => {
      packing = undefined
      failure = err instanceof Error ? err.message : String(err)
      $.ui.invalidate('ui.render')
      throw err
    })
  }
  return packing
}

// A touched file is read once: its links (Markdown) and one line on what it is.
// Answers the notes it links to: their names entered the context with it.
const readMeta = async ($: EngineInterface, p: string, out?: true): Promise<string[]> => {
  if (metaRead.has(p) || I === undefined) return []
  metaRead.add(p)
  const abs = out ? p : `${I.root}/${p}`
  const text = await $.fs.read(abs).catch(() => '')
  if (text === '') return []
  const d = describe(text)
  if (d !== '') desc.set(p, d)
  const n = I.ids.get(p)
  if (n === undefined || !p.endsWith('.md')) return []
  const targets = [...linksIn(I, n, text)]
  for (const m of targets) linked.add(pairKey(n, m))
  return targets.slice(0, MAX_SEEN).map(m => I!.paths[m]!)
}

// ---- the trail, replayed from the events ----

const isNote = (p: string) => p.endsWith('.md')

const replay = (list: TrailEvent[]) => {
  const names = nameServers(list)
  const state = new Map<number, { k: Kind; count: number }>()
  const moves: Move[] = []
  const calls: Call[] = []
  const perSvc = new Map<string, number>()
  const stats = { read: 0, write: 0, hit: 0, link: 0, gap: 0 }
  let outside = 0
  const outSeen = new Set<string>()
  list.forEach((ev, i) => {
    if (ev.k === 'mcp') {
      const svc = names.get(ev.server) ?? ev.server
      calls.push({ svc, tool: ev.tool, label: ev.label, err: ev.err === true, from: moves.at(-1)?.n, at: ev.at })
      perSvc.set(svc, (perSvc.get(svc) ?? 0) + 1)
      return
    }
    // a name that entered the context: lit on the map, no move
    const mark = (n: number, k: Kind) => {
      const prev = state.get(n)
      if (!prev) stats[k]++
      else if (rank[k] > rank[prev.k]) { stats[prev.k]--; stats[k]++ }
      state.set(n, { k: prev && rank[prev.k] > rank[k] ? prev.k : k, count: (prev?.count ?? 0) + 1 })
    }
    if (ev.k === 'seen') {
      for (const p of ev.ps) { const n = I?.ids.get(p); if (n !== undefined) mark(n, ev.via === 'link' ? 'link' : 'hit') }
      return
    }
    if (ev.k !== 'read' && ev.k !== 'write' && ev.k !== 'hit') return
    if (ev.out) { if (!outSeen.has(ev.p)) { outSeen.add(ev.p); outside++ } return }
    const n = I?.ids.get(ev.p)
    if (n === undefined) return
    mark(n, ev.k)
    if (ev.k === 'hit') return
    const from = moves.at(-1)?.n
    if (from === n) return
    // a jump with no link only counts between two notes: code files have no links to follow
    const gap = from !== undefined && isNote(ev.p) && isNote(I!.paths[from]!) && !linked.has(pairKey(from, n))
    moves.push({ n, gap, at: ev.at, i })
    if (gap) stats.gap++
  })
  const gaps: { from: number; to: number }[] = []
  for (let j = moves.length - 1; j > 0; j--) {
    const m = moves[j]!, prev = moves[j - 1]!
    if (m.gap && !linked.has(pairKey(prev.n, m.n)) && !gaps.some(g => pairKey(g.from, g.to) === pairKey(prev.n, m.n))) gaps.push({ from: prev.n, to: m.n })
  }
  // the links the notes the session read declare, between two files it met
  const links: [number, number][] = []
  for (const k of linked) {
    const [a, b] = k.split(':').map(Number) as [number, number]
    if (state.has(a) && state.has(b)) links.push([a, b])
  }
  const trail: Trail = { state, moves, calls, perSvc, links }
  return { trail, stats, gaps, outside, names }
}

// ---- theme ----

let theme: { P: Palette; at: number } | undefined
const palette = async ($: EngineInterface, now: number) => {
  if (theme === undefined || now - theme.at > 5000) {
    const row = await $.config.list().then(rows => rows.find(r => r.key === 'theme')).catch(() => undefined)
    theme = { P: typeof row?.value === 'string' && row.value.startsWith('light') ? LIGHT : DARK, at: now }
  }
  return theme.P
}

// ---- the context breakdown, as /context computes it (estimated locally, no API call) ----

let breakdown: { at: number; b?: SessionContextBreakdown } | undefined
const getBreakdown = async ($: EngineInterface, now: number) => {
  if (breakdown === undefined || now - breakdown.at > 15000) {
    const b = await $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown).catch(() => undefined)
    breakdown = { at: now, b }
    if (b !== undefined) connected = new Map([...toolsByServer(b.mcpTools.map(t => t.name))].filter(([server]) => !isLocal(server)))
  }
  return breakdown.b
}

// bars are drawn in ink, as the brand's data marks are: no colour per category

// ---- recording, never on the model's critical path ----

let chain: Promise<unknown> = Promise.resolve()
const enqueue = (work: () => Promise<unknown>) => { chain = chain.then(work, work).catch(() => {}) }
const record = async ($: EngineInterface, list: TrailEvent[]) => {
  if (list.length === 0) return
  const first = list[0]!.at
  await update($, totals, t => ({ steps: t.steps + list.length, first: t.first ?? first }))
  await update($, events, l => [...l, ...list].slice(-MAX_EVENTS))
}

// the main shell keeps its directory from one command to the next; a sub-agent's starts where the session does
let shellDir: string | undefined

const fmt = (n: number) => (n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const estimate = (text: string) => Math.round(text.length / 3.6)
const zoneOf = (p: number) => (p < 50 ? 'ok' : p < 75 ? 'warn' : 'bad') as 'ok' | 'warn' | 'bad'
let toasted: 'ok' | 'warn' | 'bad' = 'ok'

// The engine drops the window's fill on a compaction and only reports it again with the next
// reply. Until then the gauge shows the /context estimate (marked ≈) instead of the old figure.
const applyContext = async ($: EngineInterface, c: { tokens?: number; window: number; percent?: number }) => {
  const prev = await read($, meter)
  if (c.percent !== undefined) {
    if (prev.percent !== c.percent || prev.tokens !== c.tokens || prev.window !== c.window || prev.estimated) {
      await update($, meter, m => ({ ...m, tokens: c.tokens, window: c.window, percent: c.percent, estimated: undefined }))
    }
    return
  }
  // no figure and none before: a fresh session, nothing to show yet
  if (prev.percent === undefined || prev.estimated) return
  breakdown = undefined
  const b = await getBreakdown($, Date.now())
  const window = c.window || prev.window
  if (b === undefined || !(window > 0)) return
  const tokens = b.totalTokens
  await update($, meter, m => ({ ...m, tokens, window, percent: Math.min(100, Math.round((tokens / window) * 100)), estimated: true }))
  toasted = zoneOf(Math.round((tokens / window) * 100))
  // the compact hook may not have run (another plugin can answer it first): mark it on the trail here
  const at = await $.clock.now()
  const list = await read($, events)
  if (!list.some(ev => ev.k === 'compact' && at - ev.at < 120_000)) enqueue(() => record($, [{ k: 'compact', at }]))
}
const refreshMeter = async ($: EngineInterface) => {
  const u = await $.session.usage().catch(() => undefined)
  if (u !== undefined) await applyContext($, u.context)
}
let meterTimer: { cancel: () => void } | undefined

// Apps a person may want to open files with: those of this list installed on the machine (macOS).
const EDITORS = ['Obsidian', 'Visual Studio Code', 'Cursor', 'Windsurf', 'Zed', 'Sublime Text', 'Typora', 'iA Writer', 'Bear', 'TextEdit', 'Xcode', 'BBEdit', 'Nova']
let apps: string[] | undefined
const installedApps = async ($: EngineInterface) => {
  if (apps === undefined) {
    const h = await homeDir($)
    const r = await $.process.run(['sh', '-c', `ls /Applications "${h}/Applications" /System/Applications 2>/dev/null`]).catch(() => undefined)
    const found = new Set((r?.stdout ?? '').split('\n').map(x => x.trim().replace(/\.app$/, '')))
    apps = EDITORS.filter(a => found.has(a))
  }
  return apps
}

// opens a file with an app: Obsidian through its own link (a note of a vault opens in its vault), another app by name
const openWith = async ($: EngineInterface, abs: string, app: string) => {
  if (app === 'Obsidian') {
    // Obsidian stores vault paths decomposed (NFD, as macOS does)
    const r = await $.process.run(['open', `obsidian://open?path=${encodeURIComponent(abs.normalize('NFD'))}`]).catch(() => undefined)
    if (r?.exitCode === 0) return
  } else if (app !== 'default') {
    const r = await $.process.run(['open', '-a', app, abs]).catch(() => undefined)
    if (r?.exitCode === 0) return
  }
  const r = await $.process.run(['open', abs]).catch(() => undefined)
  if (r === undefined || r.exitCode !== 0) await $.process.run(['xdg-open', abs]).catch(() => undefined)
}

const openFile = async ($: EngineInterface, p: string, out?: true) => {
  const abs = out || I === undefined ? p : `${I.root}/${p}`
  const set = await read($, settingsA)
  const app = abs.endsWith('.md') ? set.openMd : set.openOther
  if (app === 'preview') {
    await update($, previewA, () => ({ p, ...(out ? { out: true } : {}) }))
    await update($, tabA, () => 'files')
    return
  }
  await openWith($, abs, app)
}

// ---- cost: the API price of this session, kept per session to compare with the person's own habits ----

type CostEntry = { day: string; usd: number; prompts: number }
const saveCost = async ($: EngineInterface, usd: number) => {
  const id = await $.session.id()
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const prompts = (await read($, events)).filter(ev => ev.k === 'prompt').length
  const all = ((await $.store.get('costs').catch(() => undefined)) ?? {}) as Record<string, CostEntry>
  all[id] = { day: all[id]?.day ?? day, usd, prompts }
  // the last 400 sessions are enough to know one's habits
  const kept = Object.fromEntries(Object.entries(all).sort((a, z) => z[1].day.localeCompare(a[1].day)).slice(0, 400))
  await $.store.set('costs', kept)
}
const costHistory = ($: EngineInterface) => costHistoryOf($).catch(() => ({ median: undefined as number | undefined, count: 0, monthUsd: 0 }))
const costHistoryOf = async ($: EngineInterface) => {
  const id = await $.session.id()
  const all = ((await $.store.get('costs').catch(() => undefined)) ?? {}) as Record<string, CostEntry>
  const others = Object.entries(all).filter(([k, v]) => k !== id && v.usd > 0.01).map(([, v]) => v)
  const sorted = others.map(v => v.usd).sort((a, z) => a - z)
  const median = sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)]
  const month = new Date(await $.clock.now()).toISOString().slice(0, 7)
  const monthUsd = Object.values(all).filter(v => v.day.startsWith(month)).reduce((a, v) => a + v.usd, 0)
  return { median, count: others.length, monthUsd }
}
const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`)

// ---- the map's pointer layer ----

// what the last map drawn shows, so a click or a hover can be matched to a file or a folder
let lastMap: { view: { vx: number; vy: number; vw: number; vh: number; px: number }; L: Layout; touched: Set<number> } | undefined

// where the pointer rests on the map (fractions of its frame), so the wheel zooms there; none once it left
let lastHover: { fx: number; fy: number; at: number } | undefined
let dragBase: { vx: number; vy: number; vw: number; vh: number; px: number } | undefined

// zooms the map by `f` (under 1 = closer) around the point at (fx, fy) of the frame shown
const zoomAt = async ($: EngineInterface, fx: number, fy: number, f: number) => {
  if (lastMap === undefined) return
  const v = lastMap.view
  const X = v.vx + fx * v.vw, Y = v.vy + fy * v.vh
  const side = Math.max(70, Math.min(v.vw, v.vh) * f)
  if (side >= SIZE * 1.02) await update($, cameraA, () => null)
  else await update($, cameraA, () => ({ x: X - fx * side, y: Y - fy * side, side }))
}

const pick = (fx: number, fy: number) => {
  if (lastMap === undefined) return undefined
  const { view, L, touched } = lastMap
  const X = view.vx + fx * view.vw, Y = view.vy + fy * view.vh
  // a file Claude touched answers from further away than the others: it is the one people look for
  let best: { n: number; d: number } | undefined
  const TL = tilt(L)
  TL.files.forEach(([x, y], n) => {
    const d = Math.hypot(x - X, y - Y) / (touched.has(n) ? 2.2 : 1)
    if (d < 9 * view.px && (best === undefined || d < best.d)) best = { n, d }
  })
  const folder = TL.groups.filter(g => g.depth > 0 && ((g.tx - X) / g.r) ** 2 + ((g.ty - Y) / g.ry) ** 2 < 1).sort((a, z) => z.depth - a.depth)[0]
  return { file: best?.n, folder, X, Y }
}

const miniGauge = (P: Palette, pct: number) => {
  const at = Math.max(4, Math.min(60, (pct / 100) * 64))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 8" width="64" height="8">`
    + `<rect x=".5" y="2" width="63" height="4" rx="2" fill="none" stroke="${P.line}"/>`
    + `<rect x=".5" y="2" width="${at.toFixed(1)}" height="4" rx="2" fill="${P.fg}" fill-opacity=".85"/>`
    + `<line x1="32" y1="0" x2="32" y2="8" stroke="${P.fg}" stroke-opacity=".4"/><line x1="48" y1="0" x2="48" y2="8" stroke="${P.fg}" stroke-opacity=".4"/>`
    + `<circle cx="${at.toFixed(1)}" cy="4" r="3" fill="#35b0ff"/></svg>`
}

// ---- Claude's actions and plan, as a project manager would tell them ----

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const host = (u: string) => { const m = /^https?:\/\/([^/]+)/.exec(u); return m?.[1] ?? u }
// what an action was about, kept short: a file name, a search, the description Claude gave its command
const whatOf = (tool: string, input: Record<string, unknown>) => {
  const file = str(input.file_path) || str(input.notebook_path)
  if (file !== '') return fileName(file)
  if (tool === 'Grep' || tool === 'Glob') return str(input.pattern)
  if (tool === 'Bash') return str(input.description) || str(input.command).slice(0, 60)
  if (tool === 'WebFetch') return host(str(input.url))
  if (tool === 'WebSearch') return str(input.query)
  if (tool === 'Agent' || tool === 'Task') return str(input.description) || str(input.subagent_type)
  if (tool === 'Skill') return str(input.skill) || str(input.command)
  if (tool === 'AskUserQuestion') return str((input.questions as { question?: string }[] | undefined)?.[0]?.question)
  if (tool.startsWith('mcp__')) return callLabel(input)
  return ''
}
// the plan Claude keeps: TodoWrite, the task tools, or the app's own task list
const planOf = (tool: string, input: Record<string, unknown>, at: number): TrailEvent | undefined => {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return { k: 'plan', items: (input.todos as { content?: string; status?: string }[]).map(x => ({ t: str(x.content), s: str(x.status) })), at }
  if (tool === 'TaskCreate') return { k: 'plan', add: { id: '', t: str(input.subject) }, at }
  if (tool === 'TaskUpdate') return { k: 'plan', upd: { id: str(input.taskId), ...(input.status ? { s: str(input.status) } : {}), ...(input.subject ? { t: str(input.subject) } : {}) }, at }
  if (tool.endsWith('__update_plan')) {
    if (Array.isArray(input.items)) return { k: 'plan', items: (input.items as { content?: string; status?: string }[]).map(x => ({ t: str(x.content), s: str(x.status) })), at }
    if (input.advance === true) return { k: 'plan', adv: true, at }
    if (Array.isArray(input.done) || typeof input.start === 'number') return { k: 'plan', done: (input.done as number[] | undefined) ?? [], ...(typeof input.start === 'number' ? { start: input.start } : {}), at }
  }
  return undefined
}
// the plan as it stands after every change
const planNow = (list: TrailEvent[]) => {
  let items: { id: string; t: string; s: string }[] = []
  for (const ev of list) {
    if (ev.k !== 'plan') continue
    if (ev.items) items = ev.items.map((x, i) => ({ id: String(i + 1), t: x.t, s: x.s }))
    else if (ev.add) items = [...items, { id: String(items.length + 1), t: ev.add.t, s: 'pending' }]
    else if (ev.upd) items = items.map(x => (x.id === ev.upd!.id ? { ...x, s: ev.upd!.s ?? x.s, t: ev.upd!.t ?? x.t } : x)).filter(x => x.s !== 'deleted')
    else if (ev.adv) {
      const cur = items.findIndex(x => x.s === 'in_progress')
      items = items.map((x, i) => (i === cur ? { ...x, s: 'completed' } : i === (cur === -1 ? items.findIndex(y => y.s === 'pending') : cur + 1) && x.s === 'pending' ? { ...x, s: 'in_progress' } : x))
    } else if (ev.done || ev.start !== undefined) {
      items = items.map((x, i) => (ev.done?.includes(i + 1) ? { ...x, s: 'completed' } : ev.start === i + 1 ? { ...x, s: 'in_progress' } : x))
    }
  }
  return items
}

let opened = false

// ---- the brain in 3D: a page in the browser, where WebGL runs, fed by a data file rewritten as the session goes ----
// Both files live in the mod's own folder (~/.claude/brain-trail-v2/3d-<folder>), never in the person's files.
let live3d: { dir: string; key: string } | undefined
let live3dTimer: { cancel: () => void } | undefined
const write3d = async ($: EngineInterface) => {
  if (live3d === undefined) return
  const list = await read($, events)
  const key = `${list.length}:${list.at(-1)?.at ?? 0}`
  if (key === live3d.key) return
  live3d.key = key
  const prompt = [...list].reverse().find(ev => ev.k === 'prompt')
  await $.fs.write(`${live3d.dir}/data.js`, data3d(replay(list).trail, { v: key, logos: LOGOS, prompt: prompt?.k === 'prompt' ? prompt.text : undefined }))
}
const open3d = async ($: EngineInterface) => {
  const L = layout
  if (L === undefined || I === undefined) return false
  const dir = `${await homeDir($)}/${CACHE_DIR}/3d-${hash(I.root)}`
  await $.fs.write(`${dir}/index.html`, page3d(base3d(L, { root: I.root, vault: isVault, lang: await read($, langA) })))
  live3d = { dir, key: '' }
  await write3d($)
  live3dTimer?.cancel()
  live3dTimer = $.clock.every(1500, () => { void write3d($).catch(() => {}) })
  const r = await $.process.run(['open', `${dir}/index.html`]).catch(() => undefined)
  return r?.exitCode === 0
}
const openPane = async ($: EngineInterface) => {
  if ((await $.session.surfaces()).length === 0) return false
  const r = await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
  opened ||= r !== undefined
  return r !== undefined
}

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false
  const defaultLang: Lang = options.language === 'fr' ? 'fr' : 'en'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show what this session puts in its context, in a pane' })
    const saved = await $.store.get('lang').catch(() => undefined)
    await update($, langA, () => (saved === 'fr' || saved === 'en' ? saved : defaultLang))
    const savedSet = await $.store.get('settings').catch(() => undefined) as Partial<TrailSettings> | undefined
    const vault = await $.fs.exists(`${await mapRoot($)}/.obsidian`).catch(() => false)
    await update($, settingsA, () => ({ ...DEFAULT_SETTINGS, ...(vault ? { openMd: 'Obsidian' } : {}), ...(savedSet ?? {}) }))
    void load($).catch(() => {})
    meterTimer?.cancel()
    meterTimer = $.clock.every(4000, () => { void refreshMeter($).catch(() => {}) })
    if (autoOpen) await openPane($)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (autoOpen && !opened) await openPane($)
    return attached
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    void load($).catch(() => {})
    const S = strings(await read($, langA))
    return { text: (await openPane($)) ? S.opened : S.later }
  })

  // the gauge follows the engine's own measure, pushed after each turn
  on('session.measure', async ($, e, next) => {
    const c = e.context
    await update($, meter, m => ({ ...m, usd: e.cost?.usd ?? m.usd, limits: e.rateLimits.length > 0 ? e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}) })) : m.limits }))
    await applyContext($, c)
    if (e.cost !== undefined) void saveCost($, e.cost.usd).catch(() => {})
    const z = zoneOf(c.percent ?? 0)
    if (z !== toasted && rank2(z) > rank2(toasted)) {
      const S = strings(await read($, langA))
      void $.ui.toast(z === 'bad' ? S.toastBad : S.toastWarn)
    }
    toasted = z
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in r && r.skip !== undefined)) {
      const at = await $.clock.now()
      enqueue(() => record($, [{ k: 'compact', at }]))
      breakdown = undefined
      void refreshMeter($).catch(() => {})
    }
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    if (text !== '' && !text.startsWith('<') && !text.startsWith('/')) {
      const at = await $.clock.now()
      enqueue(() => record($, [{ k: 'prompt', text: text.slice(0, 220), at }]))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const tool = String(e.tool)
    const agent = e.agentId !== undefined ? (true as const) : undefined
    const input = e as unknown as Record<string, unknown>
    const output = ran.text ?? ''
    enqueue(async () => {
      const out: TrailEvent[] = []
      const plan = planOf(tool, input, at)
      if (plan !== undefined) out.push(plan)
      else if (!(tool.startsWith('mcp__') && isLocal(splitMcp(tool).server)) && tool !== 'ToolSearch') {
        out.push({ k: 'act', tool, what: whatOf(tool, input), at, ...(agent ? { agent } : {}) })
      }
      // what the result added to the main context; a sub-agent's results stay in its own
      if (!agent && output.length > 0) {
        const fp = typeof input.file_path === 'string' ? input.file_path : undefined
        const label = tool.startsWith('mcp__') ? splitMcp(tool).tool
          : fp !== undefined ? fp
          : typeof input.command === 'string' ? input.command.slice(0, 90)
          : typeof input.pattern === 'string' ? input.pattern
          : typeof input.url === 'string' ? input.url
          : typeof input.description === 'string' ? input.description : ''
        out.push({ k: 'cost', tool, label, tokens: estimate(output), at })
      }
      if (tool.startsWith('mcp__')) {
        const { server, tool: t } = splitMcp(tool)
        if (!isLocal(server)) {
          out.push({ k: 'mcp', server, tool: t, label: callLabel(input), at, ...(ran.isError === true ? { err: true as const } : {}), ...(agent ? { agent } : {}) })
          // a connector's result can name files of the folder (a search in the vault, a note's path): seen
          if (ran.isError !== true && output !== '') {
            await load($).catch(() => {})
            if (I !== undefined) {
              const ps = pathsIn(I, output, await rootDir($), await homeDir($))
              if (ps.length > 0) out.push({ k: 'seen', ps, via: 'search', at, ...(agent ? { agent } : {}) })
            }
          }
        }
      } else if (ran.isError !== true) {
        await load($).catch(() => {})
        if (I !== undefined) {
          const h = await homeDir($)
          const sessionDir = await rootDir($)
          if (shellDir === undefined) shellDir = sessionDir
          const start = agent ? sessionDir : shellDir
          if (!agent && tool === 'Bash' && typeof input.command === 'string') shellDir = afterCd(input.command, start, h)
          const list = await read($, events)
          const found = touchedBy(I, tool, input, output, list, at, start, h, agent)
          const metas = await Promise.all(found.map(ev => (ev.k === 'read' || ev.k === 'write' ? readMeta($, ev.p, ev.out) : Promise.resolve([] as string[]))))
          out.push(...found)
          // the notes a note read links to: their names came in with it
          const touched = new Set(found.flatMap(ev => (ev.k === 'read' || ev.k === 'write' ? [ev.p] : [])))
          const viaLink = [...new Set(found.flatMap((ev, j) => (ev.k === 'read' ? metas[j]! : [])))].filter(p => !touched.has(p))
          if (viaLink.length > 0) out.push({ k: 'seen', ps: viaLink, via: 'link', at, ...(agent ? { agent } : {}) })
        }
      }
      await record($, out)
    })
    return ran
  }).catch(($, e, next) => next(e))

  // the end of a turn of the main conversation: the goal it worked on is done for now
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) { const at = await $.clock.now(); enqueue(() => record($, [{ k: 'done', at }])) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const at = await $.clock.now()
    enqueue(() => record($, [{ k: 'skill', name: e.skill, at, ...(e.pluginName !== undefined ? { plugin: e.pluginName } : {}) }]))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const at = await $.clock.now()
    enqueue(() => record($, [{ k: 'agent', type: e.subagentType, at }]))
    return next(e)
  }).catch(($, e, next) => next(e))

  // the pointer layer over the map: a name under the pointer, a click opens a file or zooms in,
  // a right click zooms out, a drag moves the map
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'map-hit') return next(e)
    const d = e.data as { kind?: string; fx?: number; fy?: number; sfx?: number; sfy?: number; x?: number; y?: number; right?: boolean }
    if (d.kind === 'leave') lastHover = undefined
    else if (d.kind === 'hover' && typeof d.fx === 'number' && typeof d.fy === 'number') lastHover = { fx: d.fx, fy: d.fy, at: Date.now() }
    if (await read($, view3dA)) {
      // 3D: a drag turns the brain (sideways) and raises or lowers the camera (up and down)
      if (lastSpin === undefined) return { props: { tip: null } }
      const now = await $.clock.now()
      if (d.kind === 'dragend') {
        const base = drag3d
        drag3d = undefined
        if (base !== undefined) await update($, cam3dA, c => ({ ...c, spin: base.spin, at: now }))
        return { props: { tip: null } }
      }
      if (d.kind === 'leave' || typeof d.fx !== 'number' || typeof d.fy !== 'number') return { props: { tip: null } }
      const { view, L, touched } = lastSpin
      if (d.kind === 'hover') {
        const set = await read($, settingsA)
        const n = set.hover ? pickSpin(L, view, now, d.fx, d.fy, touched) : undefined
        return { props: { tip: n !== undefined ? { text: fileName(L.files[n]![0]), x: d.x ?? 0, y: d.y ?? 0 } : null } }
      }
      if (d.kind === 'drag' && typeof d.sfx === 'number' && typeof d.sfy === 'number') {
        const cam = await read($, cam3dA)
        if (drag3d === undefined) {
          drag3d = { yaw: view.yaw, pitch: cam.pitch, spin: cam.spin }
          if (await read($, zoomed)) await update($, zoomed, () => false)
        }
        const b = drag3d, dx = d.fx - d.sfx, dy = d.fy - d.sfy
        await update($, cam3dA, c => ({ ...c, yaw: b.yaw + dx * Math.PI * 1.3, pitch: Math.max(PITCH_MIN, Math.min(PITCH_MAX, b.pitch + dy * 1.4)), spin: false, at: now }))
        return { props: { tip: null } }
      }
      if (d.kind === 'click') {
        if (d.right === true) { await update($, cam3dA, c => ({ ...c, zoom: Math.max(0.6, c.zoom / 1.5) })); return { props: { tip: null } } }
        const n = pickSpin(L, view, now, d.fx, d.fy, touched)
        if (n !== undefined) void openFile($, L.files[n]![0])
        else await update($, cam3dA, c => ({ ...c, zoom: Math.min(12, c.zoom * 1.5) }))
      }
      return { props: { tip: null } }
    }
    if (lastMap === undefined) return { props: { tip: null } }
    if (d.kind === 'dragend') { dragBase = undefined; return { props: { tip: null } } }
    if (d.kind === 'leave' || typeof d.fx !== 'number' || typeof d.fy !== 'number') return { props: { tip: null } }
    if (d.kind === 'hover') {
      const hit = pick(d.fx, d.fy)
      const set = await read($, settingsA)
      return { props: { tip: set.hover && hit?.file !== undefined ? { text: fileName(lastMap.L.files[hit.file]![0]), x: d.x ?? 0, y: d.y ?? 0 } : null } }
    }
    if (d.kind === 'drag' && typeof d.sfx === 'number' && typeof d.sfy === 'number') {
      // the frame the drag started from, moved by the distance the pointer went
      if (dragBase === undefined) dragBase = { ...lastMap.view }
      const b = dragBase, side = Math.min(b.vw, b.vh)
      await update($, cameraA, () => ({ x: b.vx + (b.vw - side) / 2 - (d.fx! - d.sfx!) * b.vw, y: b.vy + (b.vh - side) / 2 - (d.fy! - d.sfy!) * b.vh, side }))
      return { props: { tip: null } }
    }
    if (d.kind === 'click') {
      if (d.right === true) { await zoomAt($, d.fx, d.fy, 1.8); return { props: { tip: null } } }
      const hit = pick(d.fx, d.fy)
      if (hit?.file !== undefined) void openFile($, lastMap.L.files[hit.file]![0])
      else await zoomAt($, d.fx, d.fy, 1 / 1.8)
    }
    return { props: { tip: null } }
  }).catch(($, e, next) => next(e))

  // the wheel over the map zooms it, around the pointer in 2D; elsewhere in the pane it scrolls as usual
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || e.pointer === undefined || lastHover === undefined || e.by === 0) return next(e)
    if ((await read($, tabA)) !== 'map') return next(e)
    const f = Math.pow(1.18, Math.max(-4, Math.min(4, e.by)))
    if (await read($, view3dA)) await update($, cam3dA, c => ({ ...c, zoom: Math.max(0.6, Math.min(12, c.zoom / f)) }))
    else await zoomAt($, lastHover.fx, lastHover.fy, f)
    return {}
  }).catch(($, e, next) => next(e))

  // ---- the band above the prompt: the context and the cost, always in sight, even with the pane closed ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const set = await read($, settingsA)
    const m = await read($, meter)
    if (e.props.hasSurvey || set.band === false || m.percent === undefined) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const S = strings(await read($, langA))
    const P = await palette($, await $.clock.now())
    const pct = m.percent
    const zone = zoneOf(pct)
    const open = async (t: Tab) => { await update($, tabA, () => t); await openPane($) }
    return (
      <Box flexDirection="row" alignItems="center" columnGap="sm" flexWrap="wrap">
        {'Svg' in ui && <ui.Svg key="band-gauge" source={miniGauge(P, pct)} width={64} height={8} alt={`${pct} %`} />}
        <Text size="caption" weight={zone === 'ok' ? undefined : 'medium'} tabular>{weather(pct)} {S.bandContext(pct)}</Text>
        {m.usd !== undefined && <Text size="caption" dimColor tabular>· {S.bandCost(usd(m.usd))}</Text>}
        {limitOf(m, 'five_hour') !== undefined && <Text size="caption" dimColor tabular>· {S.band5h(Math.round(limitOf(m, 'five_hour')!.percentUsed))}</Text>}
        {limitOf(m, 'seven_day') !== undefined && <Text size="caption" dimColor tabular>· {S.band7d(Math.round(limitOf(m, 'seven_day')!.percentUsed))}</Text>}
        <Box flexGrow={1} />
        {zone === 'bad'
          ? <Button key="band-handoff" label={S.zoneLabel.bad} variant="primary" onPress={() => open('context')} />
          : <Button key="band-open" plain dimColor label={TITLE} onPress={() => open('context')} />}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const now = await $.clock.now()
    const lang = await read($, langA)
    const S = strings(lang)
    const tab = await read($, tabA)
    const P = await palette($, now)
    const m = await read($, meter)
    const list = await read($, events)
    void load($).catch(() => {})
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 48
    const widthPx = Math.max(240, Math.min(900, cols * 8 - 24))
    const pct = m.percent ?? 0
    const zone = zoneOf(pct)

    const label = (text: string) => <Text size="caption" weight="medium" dimColor>{text.toUpperCase()}</Text>
    const card = (key: string, title: string, children: any) => (
      <Box key={key} flexDirection="column" gap="xs" borderStyle="single" borderColor={P.line} padding="sm">
        {label(title)}
        {children}
      </Box>
    )
    const svg = (key: string, source: string, w: number, ht: number, alt: string) => ('Svg' in ui
      ? (w === 0 ? <ui.Svg key={key} source={source} alt={alt} /> : <ui.Svg key={key} source={source} width={w} height={ht} alt={alt} />)
      : <Text dimColor>{S.mapOnlyDesktop}</Text>)

    // ---- header: the brand band (desktop), then the context figure and its zone ----
    const header = (
      <Box flexDirection="column" gap="sm">
        {'Svg' in ui
          ? <ui.Svg key="brand" source={banner(TITLE, S.tagline, P)} alt={`Unkillable Companies · ${TITLE}`} />
          : <Box flexDirection="column"><Text weight="medium">Unkillable Companies</Text><Text size="caption" dimColor>{TITLE.toUpperCase()} · {S.tagline}</Text></Box>}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" columnGap="sm" alignItems="center">
            <Text size="title" weight="regular" dimColor={m.percent === undefined} tabular>{m.percent !== undefined ? `${m.estimated ? '≈ ' : ''}${pct} %` : '–'}</Text>
            <Box flexDirection="column">
              <Text size="caption" dimColor>{S.window}</Text>
              {m.percent !== undefined && <Text>{weather(pct)}</Text>}
            </Box>
          </Box>
          <Box flexDirection="row" columnGap="xs" alignItems="center">
            {m.percent !== undefined && zone !== 'ok' && (
              <Button key="hdr-compact" label={`☀️ ${S.compactNow}`} variant={zone === 'bad' ? 'primary' : undefined} onPress={async () => {
                const res = await $.session.compact({}).catch(() => undefined)
                void $.ui.toast(res === undefined ? S.compactBusy : 'skip' in res && res.skip !== undefined ? res.skip : S.compactDone)
                await refreshMeter($).catch(() => {})
              }} />
            )}
            <Button key="settings" label="⚙" variant={tab === 'settings' ? 'primary' : undefined} onPress={() => update($, tabA, () => (tab === 'settings' ? 'map' : 'settings'))} />
          </Box>
        </Box>
      </Box>
    )

    const TABS: Exclude<Tab, 'settings'>[] = ['map', 'goal', 'context', 'files', 'coach']
    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" gap="xs">
        {TABS.map(t => (
          // a whole button, not a word in a frame: the click lands anywhere on it
          <Button key={`t-${t}`} label={S.tabs[t].toUpperCase()} variant={t === tab ? 'primary' : undefined} onPress={() => update($, tabA, () => t)} />
        ))}
      </Box>
    )

    const footer = (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" columnGap="xs" flexWrap="wrap" alignItems="center">
          <Text size="caption" dimColor>{S.madeBy} Unkillable Companies ·</Text>
          <ui.Link key="site" href="https://unkillablecompanies.com" label={S.site} />
        </Box>
      </Box>
    )

    const openList = await read($, openA)
    const isOpen = (k: string) => openList.includes(k)
    const more = (k: string) => (
      <Box key={`more-${k}`} flexDirection="row">
        <Button key={`more-${k}`} plain dimColor label={isOpen(k) ? S.lessDetails : S.moreDetails} onPress={() => update($, openA, l => (l.includes(k) ? l.filter(x => x !== k) : [...l, k]))} />
      </Box>
    )
    const base = { S, P, list, card, Box, Text, Button, ui, now, isOpen, more }
    const body = tab === 'context' ? await contextTab($, { ...base, m, widthPx, lang, svg })
      : tab === 'files' ? await filesTab($, base)
      : tab === 'map' ? await mapTab($, { ...base, widthPx })
      : tab === 'settings' ? await settingsTab($, { ...base, lang })
      : tab === 'coach' ? await coachTab($, { ...base, lang, m })
      : await goalTab($, { ...base, lang })

    return (
      <Box flexDirection="column" gap="sm">
        {header}
        {tabs}
        {body}
        {footer}
      </Box>
    )
  })
}

const rank2 = (z: 'ok' | 'warn' | 'bad') => (z === 'ok' ? 0 : z === 'warn' ? 1 : 2)

// The tabs share these: the element constructors and helpers of the render pass.
type Ctx = {
  S: Strings; P: Palette; list: TrailEvent[]; now: number
  card: (key: string, title: string, children: unknown) => any
  Box: any; Text: any; Button: any; ui: any
  isOpen: (k: string) => boolean
  more: (k: string) => any
}

// ---- Context: the gauge, what was loaded at start, what fills it ----

const contextTab = async ($: EngineInterface, c: Ctx & { m: Meter; widthPx: number; lang: Lang; svg: (k: string, s: string, w: number, h: number, a: string) => any }) => {
  const { S, P, m, list, card, Box, Text, Button } = c
  const b = await getBreakdown($, c.now)
  const pct = m.percent ?? 0
  const zone = zoneOf(pct)
  const win = m.window || b?.rawMaxTokens || 0
  const compactAt = b?.isAutoCompactEnabled && b.autoCompactThreshold !== undefined && win > 0 ? Math.round((b.autoCompactThreshold / win) * 100) : undefined
  const gw = Math.max(200, c.widthPx - 40)

  const used = (b?.categories ?? []).filter(k => k.kind === 'used')
  const startCats = used.filter(k => k.name !== 'Messages')
  const startTotal = startCats.reduce((a, k) => a + k.tokens, 0)
  const messages = used.find(k => k.name === 'Messages')

  // the tool results that took the most room since the last compaction
  let since = 0
  list.forEach((ev, i) => { if (ev.k === 'compact') since = i + 1 })
  const costs = list.slice(since).flatMap(ev => (ev.k === 'cost' ? [ev] : [])).sort((a, z) => z.tokens - a.tokens).slice(0, 5)
  const tipFor = (tool: string) => (tool.startsWith('mcp__') ? S.tip.mcp : (S.tip as Record<string, string>)[tool] ?? S.tip.other)
  const toolName = (tool: string) => { if (!tool.startsWith('mcp__')) return tool; const { server, tool: t } = splitMcp(tool); return `${nameServer(server, byServer.get(server) ?? new Set([t]))} · ${t}` }

  // grouped by the name a person knows (a claude.ai connector has a UUID), local app tools included: they cost too
  const byServer = toolsByServer((b?.mcpTools ?? []).map(t => t.name))
  const mcpServers = new Map<string, { tools: number; tokens: number; loaded: number }>()
  for (const t of b?.mcpTools ?? []) {
    const server = splitMcp(t.name).server
    const name = nameServer(server, byServer.get(server) ?? new Set())
    const s = mcpServers.get(name) ?? { tools: 0, tokens: 0, loaded: 0 }
    s.tools++; s.tokens += t.tokens; if (t.isLoaded) s.loaded++
    mcpServers.set(name, s)
  }
  const bar = (key: string, tokens: number, max: number, color: string) => c.svg(key,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 6" width="100" height="6" preserveAspectRatio="none"><rect width="100" height="6" rx="3" fill="${P.line}"/><rect width="${Math.max(1.5, Math.min(100, (tokens / Math.max(max, 1)) * 100))}" height="6" rx="3" fill="${color}" fill-opacity=".8"/></svg>`,
    100, 6, '')
  const row = (key: string, name: string, tokens: number, color: string, max: number, note?: string) => (
    <Box key={key} flexDirection="row" gap="sm" alignItems="center">
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        <Text size="caption" wrap="truncate-end">{name}</Text>
        {note !== undefined && note !== '' && <Text size="caption" dimColor wrap="truncate-end">{note}</Text>}
      </Box>
      {bar(`${key}-bar`, tokens, max, color)}
      <Box minWidth={6} flexDirection="row" justifyContent="flex-end"><Text size="caption" mono tabular dimColor>{fmt(tokens)}</Text></Box>
    </Box>
  )

  const hist = await costHistory($)
  const set = await read($, settingsA)
  const prompts = Math.max(1, list.filter(ev => ev.k === 'prompt').length)
  const ratio = m.usd !== undefined && hist.median !== undefined && hist.count >= 3 ? m.usd / hist.median : undefined
  const verdict = ratio === undefined ? S.verdictWait(hist.count) : ratio < 0.6 ? S.verdictLight(ratio) : ratio <= 1.5 ? S.verdictUsual : S.verdictHeavy(ratio)
  const open = c.isOpen('context')

  return (
    <Box flexDirection="column" gap="sm">
      {card('window', S.whatToDo, (
        <Box flexDirection="column" gap="xs">
          {m.percent === undefined && <Text size="caption" dimColor>{S.noReading}</Text>}
          {c.svg('gauge', gauge(P, gw, pct, compactAt, [], 100), 0, 0, `${pct}%`)}
          <Text wrap="wrap" weight={zone === 'ok' ? undefined : 'medium'}>{S.zone[zone]}</Text>
        </Box>
      ))}
      {(m.limits ?? []).some(l => l.kind === 'five_hour' || l.kind === 'seven_day') && card('plan-use', S.planUse, (
        <Box flexDirection="column" gap="sm">
          {(['five_hour', 'seven_day'] as const).map(kind => {
            const l = limitOf(m, kind)
            if (l === undefined) return null
            const reset = resetLabel(l.resetsAt, c.lang)
            return (
              <Box key={`lim-${kind}`} flexDirection="column" gap="xs">
                <Box flexDirection="row" justifyContent="space-between">
                  <Text size="caption" weight="medium">{kind === 'five_hour' ? S.limit5h : S.limit7d}</Text>
                  {reset !== '' && <Text size="caption" dimColor>{S.resetsAt(reset)}</Text>}
                </Box>
                {c.svg(`lim-bar-${kind}`, gauge(P, gw, l.percentUsed, undefined, [], 100), 0, 0, `${l.percentUsed}%`)}
                <Text size="caption" dimColor tabular>{S.usedPct(Math.round(l.percentUsed))}</Text>
              </Box>
            )
          })}
        </Box>
      ))}
      {card('cost', S.costTitle, (
        <Box flexDirection="column" gap="xs">
          {m.usd === undefined ? <Text size="caption" dimColor wrap="wrap">{S.costNone}</Text> : (
            <Box flexDirection="column" gap="xs">
              <Text size="title" weight="regular" tabular>{usd(m.usd)}</Text>
              <Text size="caption" dimColor wrap="wrap">{S.costWhat}</Text>
              <Text wrap="wrap">{verdict}</Text>
            </Box>
          )}
        </Box>
      ))}
      {c.more('context')}
      {open && card('details-window', S.window, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor tabular>{S.ofTokens(fmt(m.tokens ?? 0), fmt(win))}</Text>
          <Text size="caption" dimColor>{compactAt !== undefined ? S.compactAt(compactAt) : b !== undefined && !b.isAutoCompactEnabled ? S.compactOff : ''}</Text>
        </Box>
      ))}
      {open && m.usd !== undefined && card('details-cost', S.costTitle, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" tabular>{S.perRequest(usd(m.usd / prompts), prompts)}</Text>
          <Text size="caption" tabular>{S.thisMonth(usd(hist.monthUsd))}</Text>
          {set.planUsd !== undefined && set.planUsd > 0
            ? <Text size="caption" weight="medium" wrap="wrap">{hist.monthUsd >= set.planUsd ? S.saved(usd(hist.monthUsd - set.planUsd), usd(set.planUsd)) : S.notYet(usd(set.planUsd - hist.monthUsd), usd(set.planUsd))}</Text>
            : <Text size="caption" dimColor wrap="wrap">{S.planHint}</Text>}
          <Text size="caption" dimColor wrap="wrap">{S.costHow}</Text>
        </Box>
      ))}
      {open && b !== undefined && card('start', `${S.startTitle} · ${fmt(startTotal)}`, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="wrap">{S.startWhy}</Text>
          {startCats.map(k => row(`cat-${k.name}`, k.name, k.tokens, P.fg, startTotal))}
          {b.memoryFiles.length > 0 && <Box marginTop="xs">{label2(Text, S.memory)}</Box>}
          {b.memoryFiles.map(f => (
            <Box key={`mem-${f.path}`} flexDirection="row" gap="sm" alignItems="center">
              <Box flexGrow={1} flexShrink={1} flexDirection="column">
                <Button key={`open-mem-${f.path}`} plain onPress={() => openFile($, f.path, true)}>{fileName(f.path)} <Text dimColor>{f.type}</Text></Button>
                <Text size="caption" dimColor wrap="truncate-start">{f.path}</Text>
              </Box>
              <Text size="caption" mono tabular dimColor>{fmt(f.tokens)}</Text>
            </Box>
          ))}
          {mcpServers.size > 0 && <Box marginTop="xs">{label2(Text, `${S.mcp} · ${S.mcpLine(mcpServers.size, b.mcpTools.length)}`)}</Box>}
          {[...mcpServers].sort((a, z) => z[1].tokens - a[1].tokens).slice(0, 8).map(([s, v]) => row(`mcp-${s}`, s, v.tokens, P.fg, startTotal, v.loaded < v.tools ? `${v.tools} · ${S.deferred}` : String(v.tools)))}
          {b.skills !== undefined && <Box marginTop="xs">{label2(Text, `${S.skills} · ${S.skillsLine(b.skills.includedSkills, b.skills.totalSkills)} · ${fmt(b.skills.tokens)}`)}</Box>}
          {b.agents.length > 0 && <Text size="caption" dimColor>{S.agents}: {b.agents.map(a => a.agentType).join(', ')}</Text>}
        </Box>
      ))}
      {open && card('eaters', `${S.eaters}${messages ? ` · ${fmt(messages.tokens)}` : ''}`, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="wrap">{S.eatersWhy}</Text>
          {costs.length === 0 && <Text size="caption" dimColor>{S.noEaters}</Text>}
          {costs.map((ev, i) => (
            <Box key={`eat-${i}`} flexDirection="column">
              <Box flexDirection="row" gap="sm">
                <Text size="caption" mono tabular>{`≈${fmt(ev.tokens)}`.padStart(6)}</Text>
                <Text size="caption" weight="medium">{toolName(ev.tool)}</Text>
                <Text size="caption" dimColor wrap="truncate-start">{ev.label}</Text>
              </Box>
              <Text size="caption" dimColor wrap="wrap">{tipFor(ev.tool)}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

const label2 = (Text: any, text: string) => <Text size="caption" weight="medium" dimColor>{text}</Text>

// ---- Files: the figures first, then the session's files as a tree of their folders ----

type Entry = { p: string; out?: true; reads: number; writes: number; seen: boolean; linked: boolean; start: boolean; agent: boolean; tokens: number }
type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: Entry[] }

const filesTab = async ($: EngineInterface, c: Ctx) => {
  const { S, P, list, card, Box, Text, Button } = c
  const b = await getBreakdown($, c.now)
  await load($).catch(() => undefined)

  // a file shown in the pane itself, when the settings say so
  const shown = await read($, previewA)
  if (shown !== null) return previewView($, c, shown)

  const root = I?.root ?? ''
  const rel = (abs: string) => (root !== '' && abs.startsWith(`${root}/`) ? { p: abs.slice(root.length + 1) } : { p: abs, out: true as const })
  const all = new Map<string, Entry>()
  const entry = (p: string, out?: true) => {
    let x = all.get(p)
    if (x === undefined) { x = { p, ...(out ? { out } : {}), reads: 0, writes: 0, seen: false, linked: false, start: false, agent: false, tokens: 0 }; all.set(p, x) }
    return x
  }
  for (const f of b?.memoryFiles ?? []) { const r = rel(f.path); const x = entry(r.p, r.out); x.start = true; x.tokens += f.tokens }
  const costByFile = new Map<string, number>()
  for (const ev of list) if (ev.k === 'cost' && ev.tool === 'Read') costByFile.set(ev.label, (costByFile.get(ev.label) ?? 0) + ev.tokens)
  for (const ev of list) {
    if (ev.k === 'seen') { for (const p of ev.ps) { const x = entry(p); if (ev.via === 'link') x.linked = true; else x.seen = true } continue }
    if (ev.k !== 'read' && ev.k !== 'write' && ev.k !== 'hit') continue
    const x = entry(ev.p, ev.out)
    if (ev.k === 'hit') x.seen = true
    else if (ev.agent) x.agent = true
    else if (ev.k === 'read') x.reads++
    else x.writes++
  }
  for (const x of all.values()) if (x.reads > 0) x.tokens += costByFile.get(x.out ? x.p : `${root}/${x.p}`) ?? costByFile.get(x.p) ?? 0
  const { gaps } = replay(list)

  // the figures: one card each
  const entries = [...all.values()]
  // each figure opens the list of its files under the cards (one at a time)
  type Fig = { id: string; label: string; why: string; files?: Entry[]; n: number }
  const pickFiles = (keep: (x: Entry) => boolean) => entries.filter(keep).sort((a, z) => z.tokens - a.tokens || a.p.localeCompare(z.p))
  const figures: Fig[] = [
    { id: 'start', label: S.gStart, why: S.gStartWhy, files: pickFiles(x => x.start) },
    { id: 'read', label: S.gRead, why: S.gReadWhy, files: pickFiles(x => x.reads > 0) },
    { id: 'written', label: S.gWritten, why: S.gWrittenWhy, files: pickFiles(x => x.writes > 0) },
    { id: 'found', label: S.gFound, why: S.gFoundWhy, files: pickFiles(x => x.seen && x.reads === 0 && x.writes === 0) },
    { id: 'linked', label: S.gLinked, why: S.gLinkedWhy, files: pickFiles(x => x.linked && !x.seen && x.reads === 0 && x.writes === 0) },
    ...(entries.some(x => x.agent) ? [{ id: 'agent', label: S.gAgent, why: S.gAgentWhy, files: pickFiles(x => x.agent) }] : []),
    { id: 'missing', label: S.missing, why: S.missingWhy },
  ].map(fg => ({ ...fg, n: fg.files?.length ?? gaps.length }))
  const chosen = figures.find(fg => c.isOpen(`kpi:${fg.id}`))
  const choose = (id: string) => update($, openA, l => {
    const was = l.includes(`kpi:${id}`)
    const rest = l.filter(k => !k.startsWith('kpi:'))
    return was ? rest : [...rest, `kpi:${id}`]
  })
  const kpis = (
    <Box flexDirection="row" flexWrap="wrap" gap="xs">
      {figures.map(fg => (
        <Box key={`kpi-${fg.id}`} flexDirection="column" flexGrow={1} minWidth="30%" borderStyle="single" borderColor={chosen?.id === fg.id ? P.fg : P.line} padding="sm">
          <Text size="heading" weight="regular" tabular dimColor={fg.n === 0}>{fg.n}</Text>
          <Button key={`kpi-open-${fg.id}`} plain dimColor={chosen?.id !== fg.id} label={`${fg.label} ${chosen?.id === fg.id ? '▴' : '▾'}`} onPress={() => choose(fg.id)} />
        </Box>
      ))}
    </Box>
  )
  const detailRow = (x: Entry) => {
    const facts = [x.reads > 0 ? S.kpiRead(x.reads) : '', x.writes > 0 ? S.kpiWrite(x.writes) : '', x.tokens > 0 ? S.kpiTokens(fmt(x.tokens)) : ''].filter(Boolean).join(' · ')
    const dir = x.p.includes('/') ? x.p.slice(0, x.p.lastIndexOf('/')) : ''
    return (
      <Box key={`kd-${x.p}`} flexDirection="row" gap="sm" alignItems="center">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Button key={`kd-open-${x.p}`} plain label={fileName(x.p)} onPress={() => openFile($, x.p, x.out)} />
          {dir !== '' && <Text size="caption" dimColor wrap="truncate-start">{dir}</Text>}
        </Box>
        {facts !== '' && <Text size="caption" mono tabular dimColor>{facts}</Text>}
      </Box>
    )
  }

  // the tree: the folders of the files the session used, as they sit in the folder; files outside it after
  const top: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  const outside: Entry[] = []
  for (const x of entries) {
    if (x.reads === 0 && x.writes === 0 && !x.start && !x.agent) continue
    if (x.out) { outside.push(x); continue }
    const parts = x.p.split('/')
    let d = top
    for (const part of parts.slice(0, -1)) {
      const path = d.path === '' ? part : `${d.path}/${part}`
      if (!d.dirs.has(part)) d.dirs.set(part, { name: part, path, dirs: new Map(), files: [] })
      d = d.dirs.get(part)!
    }
    d.files.push(x)
  }
  const fileRow = (x: Entry, depth: number) => (
    <Box key={`f-${x.p}`} flexDirection="row" paddingLeft={depth * 2 + 2}>
      <Button key={`open-${x.p}`} plain label={fileName(x.p)} onPress={() => openFile($, x.p, x.out)} />
    </Box>
  )
  // a folder opens and closes; all are open at first
  const rows: any[] = []
  const walk = (d: Dir, depth: number) => {
    for (const s of [...d.dirs.values()].sort((a, z) => a.name.localeCompare(z.name))) {
      const closed = c.isOpen(`fold:${s.path}`)
      rows.push(
        <Box key={`d-${s.path}`} flexDirection="row" paddingLeft={depth * 2}>
          <Button key={`dir-${s.path}`} plain label={`${closed ? '▸' : '▾'} ${s.name}`} onPress={() => update($, openA, l => (l.includes(`fold:${s.path}`) ? l.filter(k => k !== `fold:${s.path}`) : [...l, `fold:${s.path}`]))} />
        </Box>,
      )
      if (!closed) walk(s, depth + 1)
    }
    for (const x of [...d.files].sort((a, z) => a.p.localeCompare(z.p))) rows.push(fileRow(x, depth))
  }
  walk(top, 0)
  if (outside.length > 0) {
    rows.push(
      <Box key="d-outside" flexDirection="row" columnGap="sm" alignItems="center" marginTop="xs">
        <Text size="caption" dimColor>{S.outsideN(outside.length)}</Text>
        {c.more('outside')}
      </Box>,
    )
    if (c.isOpen('outside')) for (const x of outside.sort((a, z) => a.p.localeCompare(z.p))) rows.push(fileRow(x, 0))
  }

  const gapRows = I === undefined ? [] : gaps.slice(0, 10).map(g => {
    const from = I!.paths[g.from]!, to = I!.paths[g.to]!
    const line = `- Related: [[${to.replace(/\.md$/, '')}|${fileName(to).replace(/\.md$/, '')}]]`
    return (
      <Box key={`gap-${pairKey(g.from, g.to)}`} flexDirection="row" gap="sm" alignItems="center">
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text size="caption" wrap="truncate-end">{fileName(from)}</Text>
          <Text size="caption" dimColor wrap="truncate-end">{S.then} {fileName(to)}</Text>
        </Box>
        <Button key={`copy-${pairKey(g.from, g.to)}`} label={S.copy} onPress={async (press: { surface: 'desktop' }) => {
          const res = await $.ui.copy({ text: line, surface: press.surface }).catch(() => undefined)
          if (res !== undefined) void $.ui.toast(`${S.copied}: ${line}`)
        }} />
        {/* the note the line goes in: open it, paste the line */}
        <Button key={`open-gap-${pairKey(g.from, g.to)}`} label={S.open} onPress={() => openFile($, from)} />
      </Box>
    )
  })

  const detail = chosen === undefined ? undefined : card(`kpi-detail-${chosen.id}`, `${chosen.label} · ${chosen.n}`, (
    <Box flexDirection="column" gap="xs">
      <Text size="caption" dimColor wrap="wrap">{chosen.why}</Text>
      {chosen.n === 0 && <Text size="caption" dimColor>{S.kpiEmpty}</Text>}
      {chosen.files !== undefined ? chosen.files.slice(0, 80).map(detailRow) : gapRows}
    </Box>
  ))

  return (
    <Box flexDirection="column" gap="sm">
      {kpis}
      {detail}
      {card('tree', S.filesIntro, rows.length === 0 ? <Text size="caption" dimColor>{S.noFiles}</Text> : <Box flexDirection="column">{rows}</Box>)}
      {gapRows.length > 0 && chosen?.id !== 'missing' && card('gaps', `${S.missing} · ${gapRows.length}`, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="wrap">{S.missingWhy}</Text>
          {gapRows}
        </Box>
      ))}
    </Box>
  )
}

// a file read in the pane: its text, a way back, and a way to open it in the app
const previewView = async ($: EngineInterface, c: Ctx, shown: { p: string; out?: boolean }) => {
  const { S, card, Box, Text, Button } = c
  const abs = shown.out || I === undefined ? shown.p : `${I.root}/${shown.p}`
  const text = await $.fs.read(abs).catch(() => undefined)
  const body = text === undefined ? undefined : text.length > 40000 ? `${text.slice(0, 40000)}\n\n…` : text
  const set = await read($, settingsA)
  const apps = await installedApps($)
  const app = abs.endsWith('.md') && apps.includes('Obsidian') ? 'Obsidian' : (set.openOther !== 'preview' && set.openOther !== 'default' ? set.openOther : 'default')
  return (
    <Box flexDirection="column" gap="sm">
      <Box flexDirection="row" gap="xs" alignItems="center">
        <Button key="preview-back" label={`‹ ${S.back}`} onPress={() => update($, previewA, () => null)} />
        <Button key="preview-open" label={app === 'default' ? S.openElsewhere : S.openIn(app)} onPress={() => openWith($, abs, app)} />
      </Box>
      {card('preview', fileName(shown.p), (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="truncate-start">{shown.p}</Text>
          {body === undefined ? <Text dimColor>{S.cannotRead}</Text>
            : abs.endsWith('.md') && 'Markdown' in c.ui ? <c.ui.Markdown text={body} />
            : 'Code' in c.ui ? <c.ui.Code source={body} path={abs} /> : <Text wrap="wrap">{body}</Text>}
        </Box>
      ))}
    </Box>
  )
}

// ---- Map: the folder as one disc, the trail over it ----

const mapTab = async ($: EngineInterface, c: Ctx & { widthPx: number }) => {
  const { S, P, list, Box, Text, Button } = c
  const L = layout
  if (L === undefined || I === undefined) {
    if (failure !== undefined) {
      return (
        <Box flexDirection="column" gap="sm">
          <Text color="error" wrap="wrap">{S.packFailed} {failure}</Text>
          <Button key="retry" label={S.retry} onPress={() => { failure = undefined; void load($).catch(() => {}) }} />
        </Box>
      )
    }
    return <Text dimColor>{S.packing(packingSince ? Math.round((Date.now() - packingSince) / 1000) : 0)}</Text>
  }
  const isTrail = await read($, zoomed)
  const camera = await read($, cameraA)
  const play = await read($, playA)
  await getBreakdown($, c.now)
  // a replay draws the session as it stood at one step, the step's move drawn as it happens
  const steps = list.flatMap((ev, k) => (isStep(ev) ? [k] : []))
  const at = play.step === null ? undefined : Math.min(play.step, steps.length - 1)
  const shownList = at === undefined || steps.length === 0 ? list : list.slice(0, steps[at]! + 1).map((ev, k) => (k === steps[at]! ? { ...ev, at: c.now } : ev))
  const R = replay(shownList)
  const T = R.trail
  const services = [...T.perSvc.keys()]
  const vault = L.files.every(([p]) => p.endsWith('.md'))
  const in3d = await read($, view3dA)
  const cam = await read($, cam3dA)
  const touchedSet = new Set([...T.state.entries()].filter(([, s]) => s.k === 'read' || s.k === 'write').map(([n]) => n))
  let svg: string
  if (in3d) {
    const r = drawSpin(L, T, P, { widthPx: c.widthPx, now: c.now, cam, follow: isTrail, filesWord: vault ? S.notes : S.files, outside: R.outside, dark: P.bg === DARK.bg })
    svg = r.svg
    lastSpin = { view: r.view, L, touched: touchedSet }
  } else {
    const r = draw(L, T, P, { zoomed: isTrail, widthPx: c.widthPx, now: c.now, outside: R.outside, filesWord: vault ? S.notes : S.files, services, box: camera ?? undefined })
    svg = r.svg
    lastMap = { view: r.view, L, touched: touchedSet }
  }
  const whole = camera === null && !isTrail

  const stop = () => { playTimer?.cancel(); playTimer = undefined }
  const start = async () => {
    stop()
    await update($, playA, p => ({ step: p.step === null || p.step >= steps.length - 1 ? 0 : p.step, playing: true }))
    playTimer = $.clock.every(STEP_MS, () => {
      void update($, playA, p => {
        const next = (p.step ?? 0) + 1
        if (next >= steps.length) { stop(); return { step: steps.length - 1, playing: false } }
        return { step: next, playing: true }
      })
    })
  }
  const pause = async () => { stop(); await update($, playA, p => ({ ...p, playing: false })) }
  const live = async () => { stop(); await update($, playA, () => ({ step: null, playing: false })) }
  const by = async (d: number) => { stop(); await update($, playA, p => ({ step: Math.max(0, Math.min(steps.length - 1, (p.step ?? steps.length - 1) + d)), playing: false })) }


  const following = isTrail && (in3d || camera === null)
  // controls laid over the map: one group per corner, each a single row on the map's own background.
  // No fragment inside: the app lays a fragment out as a column of its own.
  const group = (key: string, children: any[]) => (
    <Box key={key} flexDirection="row" flexWrap="nowrap" columnGap="xs" alignItems="center" padding="xs">{children}</Box>
  )
  const playing = play.step !== null
  const playControls = steps.length < 2 ? [] : !playing
    ? [<Button key="play" label={`▶  ${S.replay}`} onPress={start} />]
    : [
      play.playing ? <Button key="pause" label="❚❚" onPress={pause} /> : <Button key="play" label="▶" onPress={start} />,
      <Button key="back" label="‹" onPress={() => by(-1)} />,
      <Button key="fwd" label="›" onPress={() => by(1)} />,
      <Text key="step" size="caption" dimColor tabular>{`${(at ?? 0) + 1}/${steps.length}`}</Text>,
      <Button key="live" label={S.live} onPress={live} />,
    ]
  // 3D: turn a step either way, pause or resume the slow turn, come closer or step back
  const turn = (by: number) => async () => { const now = await $.clock.now(); await update($, zoomed, () => false); await update($, cam3dA, k => ({ ...k, yaw: yawAt(k, now) + by, at: now })) }
  const controls3d = [
    <Button key="turn-left" label="⟲" onPress={turn(-Math.PI / 6)} />,
    <Button key="spin" label={cam.spin ? '❚❚' : '▶'} onPress={async () => { const now = await $.clock.now(); await update($, cam3dA, k => ({ ...k, yaw: yawAt(k, now), spin: !k.spin, at: now })) }} />,
    <Button key="turn-right" label="⟳" onPress={turn(Math.PI / 6)} />,
    <Button key="zoom-out" label="−" onPress={() => update($, cam3dA, k => ({ ...k, zoom: Math.max(0.6, k.zoom / 1.5) }))} />,
    <Button key="zoom-in" label="+" onPress={() => update($, cam3dA, k => ({ ...k, zoom: Math.min(12, k.zoom * 1.5) }))} />,
  ]
  const zoomControls = in3d ? controls3d : [
    <Button key="zoom-out" label="−" onPress={() => zoomAt($, 0.5, 0.5, 1.8)} />,
    <Button key="zoom-in" label="+" onPress={() => zoomAt($, 0.5, 0.5, 1 / 1.8)} />,
    ...(whole ? [] : [<Button key="whole" label="⤢" onPress={async () => { await update($, cameraA, () => null); await update($, zoomed, () => false) }} />]),
  ]

  // the legend: one colour per way a file entered the context, with its count; a press lists the files
  const K = kindColors(P)
  const legendItems: { id: string; col: string; n: number; label: string }[] = [
    { id: 'read', col: K.read, n: R.stats.read, label: S.lgRead },
    { id: 'written', col: K.write, n: R.stats.write, label: S.lgWrite },
    { id: 'found', col: K.hit, n: R.stats.hit, label: S.lgFound },
    { id: 'linked', col: K.link, n: R.stats.link, label: S.lgLinked },
    { id: 'missing', col: K.gap, n: R.stats.gap, label: S.lgGap },
  ]
  const legend = (
    <Box key="map-legend" flexDirection="row" flexWrap="wrap" columnGap="md" rowGap="xs" alignItems="center">
      {legendItems.map(it => (
        <Box key={`lg-${it.id}`} flexDirection="row" columnGap="xs" alignItems="center">
          <Text key={`lg-dot-${it.id}`} color={it.col}>●</Text>
          <Button key={`lg-btn-${it.id}`} plain dimColor={it.n === 0} label={`${it.n} ${it.label}`} onPress={async () => {
            await update($, openA, l => [...l.filter(k => !k.startsWith('kpi:')), `kpi:${it.id}`])
            await update($, tabA, () => 'files')
          }} />
        </Box>
      ))}
      {services.length > 0 && <Text key="lg-mcp" size="caption" dimColor tabular>{`${T.calls.length} ${S.figCalls}`}</Text>}
    </Box>
  )

  if (!('Svg' in c.ui)) return <Text dimColor>{S.mapOnlyDesktop}</Text>
  return (
    <Box key="map-col" flexDirection="column" gap="xs">
    {shallow && <Text key="map-shallow" size="caption" dimColor wrap="wrap">{S.homeRoot}</Text>}
    <Box key="map-wrap" position="relative" flexDirection="column">
      <c.ui.Svg key="map" source={svg} alt={`${L.title}: ${T.state.size} files touched`} />
      {'Client' in c.ui && (
        <Box key="map-hit-box" position="absolute" top={0} left={0} width="100%" height="100%">
          <c.ui.Client key="map-hit" module="./hit.tsx" props={{ tip: null }} width="100%" height="100%" />
        </Box>
      )}
      {T.state.size === 0 && T.calls.length === 0 && (
        <Box key="map-empty" position="absolute" top={2} left={0} right={0} flexDirection="row" justifyContent="center">
          <Box paddingX="sm"><Text size="caption" dimColor>{S.mapEmpty}</Text></Box>
        </Box>
      )}
      <Box key="top-bar" position="absolute" top={0} right={0} flexDirection="row">
        {group('follow', [
          <Button key="view-3d" label={in3d ? '2D' : '3D'} onPress={() => update($, view3dA, v => !v)} />,
          ...(in3d ? [<Button key="open-3d" label={S.open3dBig} onPress={async () => { const ok = await open3d($).catch(() => false); if (!ok) void $.ui.toast(S.open3dFailed) }} />] : []),
          <Button key="follow" label={following ? S.unfollow : S.follow} variant={following ? 'primary' : undefined} onPress={async () => { await update($, cameraA, () => null); await update($, zoomed, () => !following) }} />,
        ])}
      </Box>
      <Box key="bottom-bar" position="absolute" bottom={0} left={0} right={0} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="flex-end">
        {playControls.length > 0 ? group('play', playControls) : <Box key="play-none" />}
        {group('zoom', zoomControls)}
      </Box>
    </Box>
    {legend}
    </Box>
  )
}

// ---- TrailSettings: what opens a file, the language, the map's hover names ----

const settingsTab = async ($: EngineInterface, c: Ctx & { lang: Lang }) => {
  const { S, P, card, Box, Text, Button, lang } = c
  const set = await read($, settingsA)
  const list = ['preview', 'default', ...(await installedApps($))]
  const save = async (patch: Partial<TrailSettings>) => {
    const next = { ...set, ...patch }
    await update($, settingsA, () => next)
    await $.store.set('settings', next)
  }
  const choice = (key: string, value: string, on: boolean, label: string, press: () => unknown) => (
    <Button key={`${key}-${value}`} label={label} variant={on ? 'primary' : undefined} onPress={press} />
  )
  const appRow = (key: 'openMd' | 'openOther', title: string) => (
    <Box key={`row-${key}`} flexDirection="column" gap="xs">
      <Text size="caption" weight="medium">{title}</Text>
      <Box flexDirection="row" flexWrap="wrap" gap="xs">
        {list.map(a => choice(key, a, set[key] === a, a === 'default' ? S.defaultApp : a === 'preview' ? S.previewApp : a, () => save({ [key]: a })))}
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" gap="sm">
      {card('open-with', S.openWith, (
        <Box flexDirection="column" gap="sm">
          <Text size="caption" dimColor wrap="wrap">{S.openWithWhy}</Text>
          {appRow('openMd', S.openMd)}
          {appRow('openOther', S.openOther)}
        </Box>
      ))}
      {card('plan', S.planTitle, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="wrap">{S.planWhy}</Text>
          <c.ui.Input key="plan-usd" placeholder={S.planPlaceholder} value={set.planUsd !== undefined ? String(set.planUsd) : ''} submitLabel={S.save} onSubmit={(v: string) => { const n = Number(v.replace(',', '.').replace(/[^0-9.]/g, '')); return save({ planUsd: n > 0 ? n : undefined }) }} />
        </Box>
      ))}
      {card('trail', S.trailCard, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="wrap">{S.clearWhy}</Text>
          <Box flexDirection="row"><Button key="clear" label={S.clear} onPress={async () => { await update($, events, () => []); await update($, totals, () => ({ steps: 0 })); await update($, playA, () => ({ step: null, playing: false })) }} /></Box>
        </Box>
      ))}
      {card('display', S.display, (
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="column" gap="xs">
            <Text size="caption" weight="medium">{S.language}</Text>
            <Box flexDirection="row" gap="xs">
              {choice('lang', 'en', lang === 'en', 'English', async () => { await update($, langA, () => 'en'); await $.store.set('lang', 'en') })}
              {choice('lang', 'fr', lang === 'fr', 'Français', async () => { await update($, langA, () => 'fr'); await $.store.set('lang', 'fr') })}
            </Box>
          </Box>
          <Box flexDirection="column" gap="xs">
            <Text size="caption" weight="medium">{S.bandSetting}</Text>
            <Text size="caption" dimColor wrap="wrap">{S.bandWhy}</Text>
            <Box flexDirection="row" gap="xs">
              {choice('band', 'on', set.band !== false, S.on, () => save({ band: true }))}
              {choice('band', 'off', set.band === false, S.off, () => save({ band: false }))}
            </Box>
          </Box>
          <Box flexDirection="column" gap="xs">
            <Text size="caption" weight="medium">{S.hoverNames}</Text>
            <Text size="caption" dimColor wrap="wrap">{S.hoverWhy}</Text>
            <Box flexDirection="row" gap="xs">
              {choice('hover', 'on', set.hover, S.on, () => save({ hover: true }))}
              {choice('hover', 'off', !set.hover, S.off, () => save({ hover: false }))}
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

// ---- Goal: what Claude does, told the way a project manager would tell it ----

const dur = (ms: number, S: Strings) => { const m = Math.round(ms / 60000); return m < 1 ? S.lessMin : S.mins(m) }

// what a service's tool does, from its name: look something up, add, update, send, remove
const verbOf = (tool: string): 'look' | 'add' | 'update' | 'send' | 'remove' | 'use' => {
  const t = tool.toLowerCase().replace(/^(slack_|notion-)/, '')
  if (/^(get|list|search|read|fetch|query|find|load|lookup|semantic|view|download|inspect|check)/.test(t)) return 'look'
  if (/^(create|add|upsert|insert|new|upload|import)/.test(t)) return 'add'
  if (/^(update|edit|set|change|modify|apply|mark|move|rename|configure|reorder)/.test(t)) return 'update'
  if (/^(send|post|reply|forward|publish|invite|share|schedule)/.test(t)) return 'send'
  if (/^(delete|trash|remove|cancel|archive)/.test(t)) return 'remove'
  return 'use'
}

type Told = { key: string; items: string[]; tell: (items: string[]) => string; agent?: true }

// each action becomes a sentence; actions of the same kind in a row become one sentence
const tell = (events: TrailEvent[], S: Strings, names: Map<string, string>) => {
  const out: Told[] = []
  for (const ev of events) {
    if (ev.k !== 'act') continue
    let key = ev.tool, item = ev.what, phrase: (items: string[]) => string
    if (ev.tool === 'Read') phrase = S.g.read
    else if (ev.tool === 'Write') phrase = S.g.write
    else if (['Edit', 'MultiEdit', 'NotebookEdit'].includes(ev.tool)) { key = 'Edit'; phrase = S.g.edit }
    else if (ev.tool === 'Grep' || ev.tool === 'Glob') { key = 'search'; phrase = S.g.search }
    else if (ev.tool === 'Bash') phrase = S.g.run
    else if (ev.tool === 'WebFetch') phrase = S.g.web
    else if (ev.tool === 'WebSearch') phrase = S.g.websearch
    else if (ev.tool === 'Agent' || ev.tool === 'Task') phrase = S.g.agent
    else if (ev.tool === 'Skill') phrase = S.g.skill
    else if (ev.tool === 'AskUserQuestion') phrase = S.g.ask
    else if (ev.tool.startsWith('mcp__')) {
      const { server, tool } = splitMcp(ev.tool)
      const svc = names.get(server) ?? nameServer(server, new Set([tool]))
      const verb = verbOf(tool)
      key = `mcp:${svc}:${verb}`
      item = ev.what || tool.replace(/[_-]+/g, ' ')
      phrase = items => S.g.service(svc, verb, items)
    } else { key = `other:${ev.tool}`; item = ev.tool; phrase = S.g.other }
    const last = out.at(-1)
    if (last !== undefined && last.key === key && last.agent === ev.agent) { if (item !== '' && !last.items.includes(item)) last.items.push(item); continue }
    out.push({ key, items: item !== '' ? [item] : [], tell: phrase, ...(ev.agent ? { agent: true as const } : {}) })
  }
  return out.map(t => (t.agent ? S.g.byAgent(t.tell(t.items)) : t.tell(t.items)))
}

// the time a request was made, as the clock on the wall reads it
const hhmm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

const goalTab = async ($: EngineInterface, c: Ctx & { lang: Lang }) => {
  const { S, list, card, Box, Text } = c
  const names = nameServers(list)
  // one block per request: what was asked, what Claude did, when it ended
  type Block = { prompt: string; at: number; end?: number; events: TrailEvent[] }
  const blocks: Block[] = []
  for (const ev of list) {
    if (ev.k === 'prompt') { blocks.push({ prompt: ev.text, at: ev.at, events: [] }); continue }
    const b = blocks.at(-1)
    if (b === undefined) continue
    if (ev.k === 'done') b.end = ev.at
    else { b.events.push(ev); if (ev.k === 'act') b.end = undefined }
  }
  if (blocks.length === 0) return card('goal', S.goalNow, <Text size="caption" dimColor wrap="wrap">{S.noGoal}</Text>)

  const cur = blocks.at(-1)!
  const working = cur.end === undefined
  const plan = planNow(list)
  const doneCount = plan.filter(x => x.s === 'completed').length
  const acts = (b: Block) => b.events.filter(ev => ev.k === 'act').length

  return (
    <Box flexDirection="column" gap="sm">
      {card('goal', S.goalNow, (
        <Box flexDirection="column" gap="xs">
          <Text weight="medium" wrap="wrap">{cur.prompt}</Text>
          <Text size="caption" dimColor>{working ? S.workingFor(dur(c.now - cur.at, S)) : S.doneIn(dur((cur.end ?? c.now) - cur.at, S))} · {S.actionsN(acts(cur))}</Text>
        </Box>
      ))}
      {plan.length > 0 && card('plan', `${S.planOfClaude} · ${doneCount}/${plan.length}`, (
        <Box flexDirection="column" gap="xs">
          {plan.map((x, i) => (
            <Box key={`plan-${i}`} flexDirection="row" columnGap="sm">
              <Text dimColor={x.s === 'completed'}>{x.s === 'completed' ? '✓' : x.s === 'in_progress' ? '●' : '○'}</Text>
              <Text wrap="wrap" weight={x.s === 'in_progress' ? 'medium' : undefined} dimColor={x.s === 'completed'}>{x.t}</Text>
            </Box>
          ))}
        </Box>
      ))}
      {card('history', S.history, (
        <Box flexDirection="column" gap="sm">
          {blocks.slice().reverse().map((b, bi) => {
            const live = bi === 0 && working
            const told = tell(b.events, S, names)
            return (
              <Box key={`h-${b.at}`} flexDirection="column" gap="xs">
                <Box flexDirection="row" columnGap="sm">
                  <Text size="caption" dimColor tabular>{hhmm(b.at)}</Text>
                  <Text weight="medium" wrap="wrap">{b.prompt}</Text>
                </Box>
                {told.length === 0
                  ? <Box paddingLeft={6}><Text size="caption" dimColor>{live ? S.thinking : S.noAction}</Text></Box>
                  : told.slice(-15).map((t, i, all) => (
                    <Box key={`h-${b.at}-${i}`} flexDirection="row" columnGap="sm" paddingLeft={6}>
                      <Text dimColor>{live && i === all.length - 1 ? '●' : '✓'}</Text>
                      <Text wrap="wrap" weight={live && i === all.length - 1 ? 'medium' : undefined}>{t}</Text>
                    </Box>
                  ))}
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

// ---- Coach: what to do better next time, from what this session did ----

type Tip = { title: string; body: string }

// what the session's own figures say, with no model call
const coachTips = (list: TrailEvent[], b: SessionContextBreakdown | undefined, m: Meter, S: Strings): Tip[] => {
  const tips: Tip[] = []
  // a whole file read when a part would have done
  const big = list.flatMap(ev => (ev.k === 'cost' && ev.tool === 'Read' && ev.tokens > 8000 ? [ev] : [])).sort((a, z) => z.tokens - a.tokens)[0]
  if (big !== undefined) tips.push(S.tipBigRead(fileName(big.label), fmt(big.tokens)))
  // the same note read again and again: its essentials belong in the instructions
  const reads = new Map<string, number>()
  for (const ev of list) if (ev.k === 'read' && !ev.agent) reads.set(ev.p, (reads.get(ev.p) ?? 0) + 1)
  const again = [...reads].sort((a, z) => z[1] - a[1])[0]
  if (again !== undefined && again[1] >= 3) tips.push(S.tipReread(fileName(again[0]), again[1]))
  // many searches for one request: Claude did not know where things are
  let searches = 0, most = 0
  for (const ev of list) {
    if (ev.k === 'prompt') { most = Math.max(most, searches); searches = 0 }
    if (ev.k === 'act' && (ev.tool === 'Grep' || ev.tool === 'Glob')) searches++
  }
  most = Math.max(most, searches)
  if (most >= 5) tips.push(S.tipSearch(most))
  // a short request that took many actions: the goal was not clear enough
  const blocks: { text: string; acts: number }[] = []
  for (const ev of list) {
    if (ev.k === 'prompt') blocks.push({ text: ev.text, acts: 0 })
    else if (ev.k === 'act' && blocks.length > 0) blocks.at(-1)!.acts++
  }
  const vague = blocks.find(x => x.text.length < 40 && x.acts >= 8)
  if (vague !== undefined) tips.push(S.tipShort(vague.text, vague.acts))
  // notes chained with no link between them
  const gaps = replay(list).gaps.length
  if (gaps >= 3) tips.push(S.tipLinks(gaps))
  // what is loaded before the first message
  const mcpTokens = (b?.mcpTools ?? []).filter(t => t.isLoaded).reduce((a, t) => a + t.tokens, 0)
  const servers = new Set((b?.mcpTools ?? []).map(t => splitMcp(t.name).server).filter(s => !isLocal(s))).size
  const used = new Set(list.flatMap(ev => (ev.k === 'mcp' ? [ev.server] : []))).size
  if (mcpTokens > 15000 && servers > used + 3) tips.push(S.tipMcp(servers, used, fmt(mcpTokens)))
  const memory = (b?.memoryFiles ?? []).reduce((a, f) => a + f.tokens, 0)
  if (memory > 12000) tips.push(S.tipMemory(fmt(memory)))
  if ((m.percent ?? 0) >= 50) tips.push(S.tipWindow(m.percent ?? 0))
  return tips
}

const coachTab = async ($: EngineInterface, c: Ctx & { lang: Lang; m: Meter }) => {
  const { S, list, card, Box, Text, Button, lang, m } = c
  const b = await getBreakdown($, c.now)
  const tips = coachTips(list, b, m, S)
  const co = await read($, coachA)
  // the project's instructions file: AGENTS.md where there is one, else CLAUDE.md
  const root = I?.root ?? (await rootDir($))
  const file = (await $.fs.exists(`${root}/AGENTS.md`).catch(() => false)) ? 'AGENTS.md' : 'CLAUDE.md'

  const analyse = async () => {
    await update($, coachA, x => ({ ...x, busy: true, error: undefined }))
    const r = await $.model.fork({ prompt: coachPrompt(lang, file) }).catch((err: unknown) => ({ isAnswered: false as const, reason: String(err) }))
    if (r.isAnswered) {
      const block = /```context\s*\n([\s\S]*?)```/.exec(r.text)
      const text = r.text.replace(/```context\s*\n[\s\S]*?```/, '').trim()
      await update($, coachA, () => ({ text, patch: block?.[1]?.trim() || undefined, at: Date.now(), busy: false }))
    } else {
      const reason = 'reason' in r ? String(r.reason) : 'unknown'
      await update($, coachA, x => ({ ...x, busy: false, error: reason === 'nothing-to-fork' ? S.coachEmpty : `${S.coachFailed} ${reason}` }))
    }
  }
  const apply = async () => {
    if (co.patch === undefined) return
    const res = await $.prompt.fill({ text: S.applyPrompt(file, co.patch) }).catch(() => undefined)
    void $.ui.toast(res !== undefined ? S.applyReady : S.applyFailed)
  }
  const Markdown = 'Markdown' in c.ui ? c.ui.Markdown : undefined

  return (
    <Box flexDirection="column" gap="sm">
      {card('tips', S.whatISee, tips.length === 0 ? <Text size="caption" dimColor wrap="wrap">{S.noTip}</Text> : (
        <Box flexDirection="column" gap="sm">
          {tips.map((t, i) => (
            <Box key={`tip-${i}`} flexDirection="column">
              <Text weight="medium" wrap="wrap">{t.title}</Text>
              <Text size="caption" dimColor wrap="wrap">{t.body}</Text>
            </Box>
          ))}
        </Box>
      ))}
      {card('analysis', S.coachTitle, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="wrap">{S.coachWhy}</Text>
          <Box flexDirection="row"><Button key="coach-run" label={co.busy ? S.coachBusy : co.text ? S.coachAgain : S.coachRun} variant={co.text ? undefined : 'primary'} onPress={() => { if (!co.busy) void analyse() }} /></Box>
          {co.error !== undefined && <Text color="error" wrap="wrap">{co.error}</Text>}
          {co.text !== '' && (Markdown !== undefined ? <Markdown text={co.text} /> : <Text wrap="wrap">{co.text}</Text>)}
        </Box>
      ))}
      {co.patch !== undefined && card('patch', S.toAdd(file), (
        <Box flexDirection="column" gap="xs">
          {'Code' in c.ui ? <c.ui.Code source={co.patch} language="markdown" /> : <Text wrap="wrap">{co.patch}</Text>}
          <Box flexDirection="row"><Button key="coach-apply" label={S.applyWith(file)} variant="primary" onPress={apply} /></Box>
          <Text size="caption" dimColor wrap="wrap">{S.applyHow}</Text>
        </Box>
      ))}
      {card('academy', S.academyTitle, (
        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor wrap="wrap">{S.academyWhy}</Text>
          {'Link' in c.ui ? <c.ui.Link key="academy" href="https://academy.unkillablecompanies.com" label={S.academyLink} /> : <Text>academy.unkillablecompanies.com</Text>}
        </Box>
      ))}
    </Box>
  )
}
