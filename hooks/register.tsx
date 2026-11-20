import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, SessionContextBreakdown, UiPressArgument } from 'claude-code'

import type { Lang, Meter, PreviewRef, TrailSettings, Totals, TrailEvent } from '../types/model'
import { MAX_SEEN, afterCd, describe, linksIn, makeIndex, pairKey, pathsIn, touchedBy } from './files'
import type { Index } from './files'
import { coachPrompt, strings } from './i18n'
import { createMapRenderer, DARK, LIGHT, packFiles } from './map'
import { isLocal, toolsByServer } from './mcp'
import type { Layout, MapRenderer, Palette } from './map'
import { sliceToStep } from './fold'
import { assembleCapture, needsMcpScan, needsTouch } from './acts'
import { costStats, keepCosts, limitOf, projectFiles, usd, zoneOf } from './readout'
import type { CostEntry } from './readout'
import { DEFAULT_SETTINGS, findArgv, fromFind, nativeGitInventoryArgv, hash, initialSettings, isShallow, pickFiles, vaultProbe, windowsSystemRoot } from './workspace'
import { cameraDuringGesture, coachBusy, coachDone, coachFailed, GESTURE0, isSharedViewIntent, mapGesture, mapWheel, openTarget, parseGesture, plan, replayTick, STEP_MS, timerEffect, VIEW_STATE0 } from './view-controller'
import type { DashboardFeed, FactsWire, HostCommand, CommandReplies, CommandRefusal, LayoutWire, ServerEvent } from '../types/browser'
import type { DrawnFrames, GestureMemory, MapTip, SharedView, SharedViewIntent, Step, TabSnapshot, ViewActions, ViewChild, ViewIntent, ViewProps, ViewRuntime, ViewSnapshot, ViewState, ViewTag } from '../types/view'
import { reduceSharedView } from './view-controller'
import { RelayRefusal, startRelay, type RelayClient } from '../hosts/relay/client'
import { relayBinary, relayIO } from '../hosts/native/io'
import { withNativeFile } from '../hosts/native/files'
import { applySettingsPatch } from './view-settings'
import type { CommandScope } from '../types/browser'
import { isAdapterOperation, parseOpenerToolName } from '../types/apps'
import { bindCodeOpen } from './app-binding'
import { renderPane, weather } from './views'
import { createNativeLayout, type NativeLayout } from './native-layout'
import { drawSpin, spinMath } from './spin'

const COMMAND = 'brain-trail-v2'
const PANE = 'brain-trail-v2'
const LIVE_PANE = 'brain-trail-live-map'
const PANE_SVG_LIMIT = 131_072
type NativePreview = { ref: PreviewRef; pending: boolean; text?: string }
type NativePane = {
  owner: number
  stop: AbortController
  renderer: MapRenderer
  sizing: NativeLayout
  view: ViewState
  navigation: number
  hitKey: string
  mapPainted: boolean
  gesture: GestureMemory
  frames: DrawnFrames
  tip: MapTip | null
  hitBox?: { box: string; reach: number }
  preview?: NativePreview
  appsPending?: Promise<unknown>
  appsFailed?: boolean
}
let liveMap: NativePane | undefined
let hitInstance = 0
const retireNative = () => {
  liveMap?.stop.abort()
  liveMap = undefined
}
const CACHE_DIR = '.claude/brain-trail-v2'
const MAX_EVENTS = 2000

const events = atom({ plugin: 'brain-trail-v2', key: 'events' } as const, [] as TrailEvent[], { shape: 'events-1' })
const totals = atom({ plugin: 'brain-trail-v2', key: 'totals' } as const, { steps: 0 } as Totals, { shape: 'totals-1' })
const meter = atom({ plugin: 'brain-trail-v2', key: 'meter' } as const, { window: 0 } as Meter, { shape: 'meter-1' })
const langA = atom({ plugin: 'brain-trail-v2', key: 'lang' } as const, 'en' as Lang)
const zoomed = atom({ plugin: 'brain-trail-v2', key: 'zoomed' } as const, false)
// the replay: the step shown (null = live) and whether it plays
const playA = atom({ plugin: 'brain-trail-v2', key: 'play' } as const, { step: null, playing: false } as { step: number | null; playing: boolean }, { shape: 'play-1' })
let playTimer: { cancel: () => void } | undefined
// The file currently previewed in the browser, or none.
const previewA = atom({ plugin: 'brain-trail-v2', key: 'preview' } as const, null as { p: string; out?: boolean } | null, { shape: 'preview-1' })
// the coach's analysis of the session, and the lines it proposes for the instructions file
const coachA = atom({ plugin: 'brain-trail-v2', key: 'coach' } as const, { text: '', at: 0, busy: false } as { text: string; patch?: string; at: number; busy: boolean; error?: string }, { shape: 'coach-1' })
const settingsA = atom({ plugin: 'brain-trail-v2', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'settings-1' })

// ---- MCP services ----

// Each server is named from all its tools: those the context lists (connected) and those the session called.
let connected = new Map<string, Set<string>>()

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

const homeDir = async ($: EngineInterface) => {
  if (home === undefined) {
    const value = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    if (!value) throw new Error('Home directory is unavailable')
    home = value.replace(/\\/g, '/')
  }
  return home
}
const rootDir = async ($: EngineInterface) => {
  const cwd = (await $.session.cwd()).normalize('NFC').replace(/\\/g, '/')
  return cwd === '/' || /^[A-Za-z]:\/$/.test(cwd) ? cwd : cwd.replace(/\/$/, '')
}
// the folder the map draws: the session's, or the Obsidian vault it sits in (a session opened in a client's
// folder of the vault still shows the whole vault, where its links lead)
let mapRootOf: { cwd: string; root: string } | undefined
const mapRoot = async ($: EngineInterface) => {
  const cwd = await rootDir($)
  if (mapRootOf?.cwd === cwd) return mapRootOf.root
  const h = await homeDir($)
  let root = cwd
  for (const dir of vaultProbe(cwd, h)) {
    if (await $.fs.exists(`${dir}/.obsidian`).catch(() => false)) { root = dir; break }
  }
  mapRootOf = { cwd, root }
  return root
}
// a session started in the home folder (or the disk's root): the map lists its first levels only
let shallow = false
const cacheFile = async ($: EngineInterface, root: string) => `${await homeDir($)}/${CACHE_DIR}/layout-${hash(root)}.json`

const listFiles = async ($: EngineInterface, root: string) => {
  const h = await homeDir($)
  shallow = isShallow(root, h)
  const windows = (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  const localVars = shallow ? undefined : await $.process.run(['git', 'rev-parse', '--local-env-vars'], { cwd: root, timeoutMs: 20000 }).catch(() => undefined)
  const reported = localVars?.exitCode === 0 ? localVars.stdout.trim().split(/\r?\n/) : []
  const valid = reported.length > 0 && reported.every(name => /^GIT_[A-Z0-9_]+$/.test(name))
  const systemRoot = windows ? await $.env.get('SystemRoot').catch(() => undefined) : undefined
  let gitArgv: string[] | undefined
  if (valid) {
    try { gitArgv = nativeGitInventoryArgv(windows, reported, systemRoot) } catch { /* use filesystem fallback */ }
  }
  const git = gitArgv ? await $.process.run(gitArgv, { cwd: root, timeoutMs: 20000 }).catch(() => undefined) : undefined
  let raw = git !== undefined && git.exitCode === 0 ? git.stdout : ''
  if (raw === '') {
    const systemPath = windows ? windowsSystemRoot(systemRoot) : undefined
    if (windows && !systemPath) throw new Error('Cannot list workspace: invalid SystemRoot')
    const argv = windows
      ? [`${systemPath}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, '-NoProfile', '-NonInteractive', '-Command', `$root=(Get-Location).Path; Get-ChildItem -File -Recurse ${shallow ? '-Depth 2' : ''} | ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\\','/') }`]
      : findArgv(shallow)
    const found = await $.process.run(argv, { cwd: root, timeoutMs: 30000 }).catch(() => undefined)
    raw = fromFind(found?.stdout ?? '').replace(/\r/g, '')
  }
  const vault = await $.fs.exists(`${root}/.obsidian`).catch(() => false)
  return pickFiles(raw, vault, root)
}

const setLayout = (root: string, list: string[]) => {
  I = makeIndex(root, list)
  layout = packFiles(list, root.split('/').pop() || root)
}

const refresh = async ($: EngineInterface, guard?: () => Promise<void>) => {
  const root = await mapRoot($)
  const list = await listFiles($, root)
  await guard?.()
  if (layout !== undefined && I?.root === root && list.length === I.paths.length && list.every((p, i) => p === I!.paths[i])) return layout
  setLayout(root, list)
  linked.clear(); metaRead.clear()
  const cache = await cacheFile($, root)
  await guard?.()
  void $.fs.write(cache, JSON.stringify({ root, files: list })).catch(() => {})
  queuePublish($)
  $.ui.invalidate('ui.render')
  return layout!
}

const load = ($: EngineInterface, guard?: () => Promise<void>) => {
  if (layout !== undefined) return Promise.resolve(layout)
  if (packing === undefined) {
    packingSince = Date.now()
    packing = (async () => {
      const root = await mapRoot($)
      const cached = await $.fs.read(await cacheFile($, root)).then(t => JSON.parse(t) as { root: string; files: string[] }).catch(() => undefined)
      await guard?.()
      if (cached !== undefined && cached.root === root && cached.files.length > 0) {
        setLayout(root, cached.files)
        void refresh($, guard).catch(() => {})
        queuePublish($)
        $.ui.invalidate('ui.render')
        return layout!
      }
      return refresh($, guard)
    })().then(async L => { await guard?.(); failure = undefined; return L }, async (err: unknown) => {
      packing = undefined
      await guard?.()
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
const getBreakdown = async ($: EngineInterface, now: number, fresh = false) => {
  if (fresh || breakdown === undefined || now - breakdown.at > 15000) {
    const owner = generation
    const b = await $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown).catch(() => undefined)
    if (owner !== generation) return undefined
    breakdown = { at: now, b }
    if (b !== undefined) connected = new Map([...toolsByServer(b.mcpTools.map(t => t.name))].filter(([server]) => !isLocal(server)))
  }
  return breakdown?.b
}

// bars are drawn in ink, as the brand's data marks are: no colour per category

// ---- recording, never on the model's critical path ----

let chain: Promise<unknown> = Promise.resolve()
const enqueue = (work: () => Promise<unknown>) => { chain = chain.then(work, work).catch(() => {}) }
const record = async ($: EngineInterface, list: TrailEvent[], guard?: () => Promise<void>) => {
  if (list.length === 0) return
  const first = list[0]!.at
  await guard?.()
  await update($, totals, t => ({ steps: t.steps + list.length, first: t.first ?? first }))
  await guard?.()
  await update($, events, l => [...l, ...list].slice(-MAX_EVENTS))
  queuePublish($)
  if (liveMap?.owner === generation) $.ui.invalidate('ui.render')
}

// the main shell keeps its directory from one command to the next; a sub-agent's starts where the session does
let shellDir: string | undefined

let toasted: 'ok' | 'warn' | 'bad' = 'ok'

// The engine drops the window's fill on a compaction and only reports it again with the next
// reply. Until then the gauge shows the /context estimate (marked ≈) instead of the old figure.
const applyContext = async ($: EngineInterface, c: { tokens?: number; window: number; percent?: number }, guard?: () => Promise<void>) => {
  const prev = await read($, meter)
  await guard?.()
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
  await guard?.()
  const window = c.window || prev.window
  if (b === undefined || !(window > 0)) return
  const tokens = b.totalTokens
  await update($, meter, m => ({ ...m, tokens, window, percent: Math.min(100, Math.round((tokens / window) * 100)), estimated: true }))
  toasted = zoneOf(Math.round((tokens / window) * 100))
  // the compact hook may not have run (another plugin can answer it first): mark it on the trail here
  const at = await $.clock.now()
  await guard?.()
  const list = await read($, events)
  await guard?.()
  if (!list.some(ev => ev.k === 'compact' && at - ev.at < 120_000)) enqueue(() => record($, [{ k: 'compact', at }], guard))
}
const refreshMeter = async ($: EngineInterface, guard?: () => Promise<void>) => {
  const u = await $.session.usage().catch(() => undefined)
  await guard?.()
  if (u !== undefined) await applyContext($, u.context, guard)
}
let meterTimer: { cancel: () => void } | undefined

// The portable relay registry is the authority for both surfaces.
let apps: string[] | undefined
let appDiscovery: Promise<string[]> | undefined
let appsEpoch = 0
const resetApps = () => {
  appsEpoch++
  apps = undefined; appDiscovery = undefined
}
const installedApps = async ($: EngineInterface) => {
  const owner = appsEpoch
  const client = await ensureRelay($)
  if (owner !== appsEpoch) throw new Error('stale-generation')
  if (apps !== undefined) return apps
  appDiscovery ??= client.listApps()
  const pending = appDiscovery
  try {
    const found = await pending
    if (owner !== appsEpoch || relay !== client || (appDiscovery !== pending && apps !== found)) throw new Error('Relay disconnected')
    if (apps === undefined) { apps = found; queuePublish($) }
    return apps
  } finally { if (appDiscovery === pending) appDiscovery = undefined }
}


// ---- cost: the API price of this session, kept per session to compare with the person's own habits ----


const saveCost = async ($: EngineInterface, usd: number) => {
  const id = await $.session.id()
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const prompts = (await read($, events)).filter(ev => ev.k === 'prompt').length
  const all = ((await $.store.get('costs').catch(() => undefined)) ?? {}) as Record<string, CostEntry>
  all[id] = { day: all[id]?.day ?? day, usd, prompts }
  // the last 400 sessions are enough to know one's habits
  const kept = keepCosts(all)
  await $.store.set('costs', kept)
}
const costHistory = ($: EngineInterface) => costHistoryOf($).catch(() => ({ median: undefined as number | undefined, count: 0, monthUsd: 0 }))
const costHistoryOf = async ($: EngineInterface) => {
  const id = await $.session.id()
  const all = ((await $.store.get('costs').catch(() => undefined)) ?? {}) as Record<string, CostEntry>
  const month = new Date(await $.clock.now()).toISOString().slice(0, 7)
  return costStats(all, id, month)
}

let replayRun = 0
const syncReplayClock = ($: EngineInterface, playing: boolean) => {
  const run = ++replayRun, owner = generation
  playTimer?.cancel(); playTimer = undefined
  if (!playing) return
  playTimer = $.clock.every(STEP_MS, () => {
    void serial(async () => {
      await checkSession($)
      if (run !== replayRun || owner !== generation) return
      const current = await read($, playA)
      if (!current.playing || run !== replayRun || owner !== generation) return
      const count = sliceToStep(await read($, events), null, Date.now()).steps.length
      if (run !== replayRun || owner !== generation) return
      const next = replayTick(count)(current)
      await update($, playA, () => next)
      if (!next.playing) syncReplayClock($, false)
      queuePublish($)
      $.ui.invalidate('ui.render')
    })
  })
}
let previewOperation = 0
let coachOperation = 0



const miniGauge = (P: Palette, pct: number) => {
  const at = Math.max(4, Math.min(60, (pct / 100) * 64))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 8" width="64" height="8">`
    + `<rect x=".5" y="2" width="63" height="4" rx="2" fill="none" stroke="${P.line}"/>`
    + `<rect x=".5" y="2" width="${at.toFixed(1)}" height="4" rx="2" fill="${P.fg}" fill-opacity=".85"/>`
    + `<line x1="32" y1="0" x2="32" y2="8" stroke="${P.fg}" stroke-opacity=".4"/><line x1="48" y1="0" x2="48" y2="8" stroke="${P.fg}" stroke-opacity=".4"/>`
    + `<circle cx="${at.toFixed(1)}" cy="4" r="3" fill="#35b0ff"/></svg>`
}



// Start the relay on demand for browser access or native app discovery.
let relay: RelayClient | undefined
let startingRelay: Promise<RelayClient> | undefined
let relayOwner = 0
let generation = 1
let launchCopied: { expiresAt: number; generation: number } | undefined
let launchBusy = false
let launchError = false
let launchKind: 'copy' | 'browser' = 'copy'
let launchOpened: { generation: number } | undefined
let launchSite: string | undefined
let launchOperation = 0
let launchExpiry: { cancel: () => void } | undefined
let nativeControlBusy = false
let nativeControlStatus: { site: string; generation: number; result: 'copied' | 'failed' | 'opened' } | undefined
let nativeControlOperation = 0
const resetLaunch = ($: EngineInterface, redraw = true) => {
  const visible = launchBusy || launchError || launchCopied !== undefined || launchOpened !== undefined || nativeControlBusy || nativeControlStatus !== undefined
  nativeControlOperation++
  nativeControlBusy = false
  nativeControlStatus = undefined
  launchOperation++
  launchCopied = undefined
  launchOpened = undefined
  launchBusy = false
  launchError = false
  launchSite = undefined
  launchExpiry?.cancel()
  launchExpiry = undefined
  if (redraw && visible) $.ui.invalidate('ui.render')
}
let sessionId: string | undefined
let revision = 0
let layoutRevision = 0
let lastLayout: Layout | undefined
let currentFeed: ReturnType<DashboardFeed['current']> | undefined
const feedListeners = new Set<(event: ServerEvent) => void>()
// Model forks can outlive a cancelled App request and its visible reservation.
let pendingCoachForks = 0
const MAX_PENDING_COACH_FORKS = 16
let mutations: Promise<unknown> = Promise.resolve()
const serial = <T,>(work: () => Promise<T>): Promise<T> => {
  const result = mutations.then(work, work)
  mutations = result.catch(() => {})
  return result
}
const invalidateCoach = ($: EngineInterface) => {
  const invalidation = ++coachOperation
  void serial(async () => {
    if (invalidation !== coachOperation) return
    await update($, coachA, coach => ({ ...coach, busy: false }))
    queuePublish($)
  }).catch(() => {})
}
const emit = (event: ServerEvent) => { for (const listener of feedListeners) listener(event) }
const shared = async ($: EngineInterface): Promise<SharedView> => ({
  preview: await read($, previewA), zoomed: await read($, zoomed), play: await read($, playA),
})
const setShared = async ($: EngineInterface, value: SharedView, guard?: () => Promise<void>) => {
  await guard?.()
  await update($, previewA, () => value.preview)
  await guard?.()
  await update($, zoomed, () => value.zoomed)
  await guard?.()
  await update($, playA, () => value.play)
}
const revokeGeneration = async (id: string | undefined, old: number) => {
  const client = relay
  if (!client || !id) return
  try { await client.revokeApp({ v: 1, target: { kind: 'generation', owner: { host: 'code', sessionId: id }, generation: old }, reason: 'generation-ended' }) }
  catch { client.close() }
}
let sessionCheck: Promise<void> | undefined
const sourceLabel = async ($: EngineInterface) => {
  const value = (I?.root ?? await rootDir($)).replace(/\p{Cc}/gu, '')
  let label = ''
  for (const character of value) {
    if (new TextEncoder().encode(label + character).length > 512) break
    label += character
  }
  return label
}
const checkSession = async ($: EngineInterface) => {
  if (sessionCheck) { await sessionCheck; return checkSession($) }
  const work = (async () => {
  const id = await $.session.id()
  if (sessionId === undefined) sessionId = id
  else if (sessionId !== id) {
    await revokeGeneration(sessionId, generation)
    sessionId = id
    generation++
    retireNative()
    resetLaunch($)
    invalidateCoach($)
    resetApps()
    revision = 0
    lastLayout = undefined
    breakdown = undefined
    syncReplayClock($, false)
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
    $.ui.invalidate('ui.render')
  }
  })()
  sessionCheck = work
  try { await work } finally { if (sessionCheck === work) sessionCheck = undefined }
}
let publications: Promise<void> = Promise.resolve()
const publish = ($: EngineInterface) => {
  const pending = publications.then(() => publishCurrent($))
  publications = pending.catch(() => {})
  return pending
}
const publishCurrent = async ($: EngineInterface) => {
  if (relay === undefined && startingRelay === undefined) return
  await checkSession($)
  const owner = generation
  const index = I, L = layout
  let layoutWire: LayoutWire | undefined
  if (index !== undefined && L !== undefined) {
    if (lastLayout !== L) { lastLayout = L; layoutRevision++ }
    layoutWire = { root: index.root, paths: index.paths, layout: L, layoutRev: layoutRevision }
  }
  const root = index?.root ?? await rootDir($)
  const instructionFile = (await $.fs.exists(`${root}/AGENTS.md`).catch(() => false)) ? 'AGENTS.md' : 'CLAUDE.md'
  const contextBreakdown = await getBreakdown($, await $.clock.now())
  const facts: FactsWire = {
    ownerHost: 'code', assistant: 'Claude', lang: await read($, langA), meter: await read($, meter),
    events: await read($, events), settings: await read($, settingsA), coach: await read($, coachA),
    workspace: layoutWire ? { kind: 'ready', layoutRev: layoutWire.layoutRev, shallow } :
      failure ? { kind: 'failed', message: failure } : { kind: 'loading', since: packingSince },
    linked: [...linked], connected: [...connected].map(([name, tools]) => [name, [...tools]]),
    costHistory: await costHistory($), apps: apps ?? [], instructionFile,
    ...(contextBreakdown && { breakdown: {
      rawMaxTokens: contextBreakdown.rawMaxTokens,
      isAutoCompactEnabled: contextBreakdown.isAutoCompactEnabled,
      ...(contextBreakdown.autoCompactThreshold !== undefined && { autoCompactThreshold: contextBreakdown.autoCompactThreshold }),
      categories: contextBreakdown.categories.map(({ kind, name, tokens }) => ({ kind, name, tokens })),
      memoryFiles: contextBreakdown.memoryFiles.map(({ path, type, tokens }) => ({ path, type, tokens })),
      mcpTools: contextBreakdown.mcpTools.map(({ name, tokens, isLoaded }) => ({ name, tokens, isLoaded })),
      ...(contextBreakdown.skills && { skills: {
        includedSkills: contextBreakdown.skills.includedSkills,
        totalSkills: contextBreakdown.skills.totalSkills,
        tokens: contextBreakdown.skills.tokens,
      } }),
      agents: contextBreakdown.agents.map(({ agentType }) => ({ agentType })),
    } }),
  }
  const view = await shared($)
  if (owner !== generation) return
  const publishedRevision = ++revision
  currentFeed = { generation: owner, revision: publishedRevision, facts, shared: view, layout: layoutWire }
  if (layoutWire) emit({ v: 1, kind: 'layout', generation: owner, layout: layoutWire })
  emit({ v: 1, kind: 'snapshot', generation: owner, revision: publishedRevision, facts, shared: view })
}
const queuePublish = ($: EngineInterface) => {
  if (!relay && !startingRelay) return
  void publish($).catch(() => {})
}
const knownRef = async ($: EngineInterface, ref: { p: string; out?: boolean }) => {
  if (!ref.out && I?.ids.has(ref.p)) return true
  if ((await read($, events)).some(e => (e.k === 'read' || e.k === 'write') && e.p === ref.p && !!e.out === !!ref.out)) return true
  const current = await getBreakdown($, await $.clock.now(), true)
  if (!current) return false
  if (ref.out && current.memoryFiles.some(file => file.path === ref.p)) return true
  const entry = projectFiles([], current.memoryFiles, I?.root ?? '').get(ref.p)
  return entry?.start === true && !!entry.out === !!ref.out
}
type PaneLifetime = { signal: AbortSignal; assertCurrent(): Promise<void> }
const secureFile = async <T,>($: EngineInterface, expected: number, ref: PreviewRef, action: { kind: 'preview' } | { kind: 'open'; app: string }, use: (client: RelayClient, id: string) => Promise<T>, scope?: CommandScope, lifetime?: PaneLifetime): Promise<T> => {
  if (!relay || !I) throw new Error('forbidden')
  const client = relay
  await scope?.assertCurrent()
  const apps = await installedApps($)
  await scope?.assertCurrent()
  return withNativeFile(client, { root: I.root, generation: expected, refreshGeneration: async () => { await checkSession($); await lifetime?.assertCurrent() }, currentGeneration: () => generation, known: candidate => knownRef($, candidate), apps, scope }, ref, action, id => use(client, id))
}
const invalidateTrail = ($: EngineInterface) => {
  generation++; revision = 0; lastLayout = undefined; breakdown = undefined
  retireNative()
  resetLaunch($)
  invalidateCoach($)
  syncReplayClock($, false)
}
const clearTrailState = async ($: EngineInterface, guard?: () => Promise<void>) => {
  await guard?.()
  await update($, events, () => [])
  await guard?.()
  await update($, totals, () => ({ steps: 0 }))
  await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } }, guard)
}
const applySharedIntent = async ($: EngineInterface, expected: number, intent: SharedViewIntent, guard: () => Promise<void>, scope?: CommandScope, lifetime?: PaneLifetime) => {
  const operation = intent.kind === 'preview' ? ++previewOperation : undefined
  const text = intent.kind === 'preview' && intent.ref !== null
    ? await secureFile($, expected, intent.ref, { kind: 'preview' }, (client, id) => client.readFile(id), scope, lifetime)
    : undefined
  await serial(async () => {
    await guard()
    if (operation !== undefined && operation !== previewOperation) throw new Error('stale-generation')
    const count = sliceToStep(await read($, events), null, Date.now()).steps.length
    const prior = await shared($)
    const next = reduceSharedView(prior, intent, count)
    await guard()
    await setShared($, next, guard)
    // From the moment shared playback is committed, the clock belongs to the session, not to the pane.
    if (expected === generation && timerEffect(intent) !== 'none') syncReplayClock($, next.play.playing)
    if (lifetime) queuePublish($)
  })
  return text
}
const executeCommand = async ($: EngineInterface, expected: number, command: HostCommand, scope?: CommandScope, lifetime?: PaneLifetime): Promise<CommandReplies[HostCommand['kind']] | CommandRefusal> => {
  await checkSession($)
  if (expected !== generation) return { ok: false, error: 'stale-generation' }
  try {
    const guard = async () => { await checkSession($); if (expected !== generation) throw new Error('stale-generation'); await scope?.assertCurrent(); await lifetime?.assertCurrent() }
    await guard()
    switch (command.kind) {
      case 'open': {
        const launch = await secureFile($, expected, command.ref, { kind: 'open', app: command.app }, (client, id) => client.openFile(id, command.app === 'default' ? undefined : command.app, expected), scope, lifetime)
        return { ok: true, launch }
      }
      case 'preview-read': {
        const text = await secureFile($, expected, command.ref, { kind: 'preview' }, (client, id) => client.readFile(id), scope, lifetime)
        return { ok: true, text }
      }
      case 'settings': {
        const allowed = await installedApps($)
        if (![command.patch.openMd, command.patch.openOther].every(app => app === undefined || app === 'default' || app === 'preview' || allowed.includes(app))) return { ok: false, error: 'forbidden' }
        await serial(async () => {
          await guard()
          const next = applySettingsPatch(await read($, settingsA), command.patch)
          await guard()
          await $.store.set('settings', next)
          await guard()
          await update($, settingsA, () => next)
        })
        break
      }
      case 'view': {
        await applySharedIntent($, expected, command.intent, guard, scope)
        break
      }
      case 'lang':
        await serial(async () => { await guard(); await $.store.set('lang', command.lang); await guard(); await update($, langA, () => command.lang) }); break
      case 'clear-trail':
        await serial(async () => {
          await guard()
          const old = generation
          const owner = sessionId
          invalidateTrail($)
          expected = generation
          scope = undefined
          lifetime = undefined
          if (relay && owner) await relay.revokeApp({ v: 1, target: { kind: 'generation', owner: { host: 'code', sessionId: owner }, generation: old }, reason: 'generation-ended' }).catch(() => { relay?.close() })
          await guard()
          await clearTrailState($, guard)
        }); break
      case 'compact': {
        await guard()
        const result = await $.session.compact({}).catch(() => undefined)
        await guard()
        const outcome = result === undefined ? { kind: 'failed' as const } : 'skip' in result && result.skip !== undefined ? { kind: 'skipped' as const, reason: result.skip } : { kind: 'done' as const }
        await publish($)
        await guard()
        return { ok: true, outcome }
      }
      case 'refresh-meter': await guard(); await refreshMeter($, guard); await guard(); break
      case 'retry-layout': await guard(); failure = undefined; await load($, guard); await guard(); break
      case 'coach-analyse': {
        const lang = await read($, langA)
        const root = I?.root ?? await rootDir($)
        const file = await $.fs.exists(`${root}/AGENTS.md`).catch(() => false) ? 'AGENTS.md' : 'CLAUDE.md'
        const operation = await serial(async () => {
          await guard()
          if ((await read($, coachA)).busy) return undefined
          await guard()
          const accepted = ++coachOperation
          await update($, coachA, coachBusy); queuePublish($)
          return accepted
        })
        if (operation === undefined) return { ok: false, error: 'busy' }
        const owner = sessionId, reservationGeneration = expected
        let committed = false
        const signal = scope?.signal ?? lifetime?.signal
        let onAbort: (() => void) | undefined
        try {
          await guard()
          if (signal?.aborted) throw new Error('forbidden')
          if (pendingCoachForks >= MAX_PENDING_COACH_FORKS) return { ok: false, error: 'busy' }
          pendingCoachForks++
          const work = (async () => {
            try { return await $.model.fork({ prompt: coachPrompt(lang, file, 'Claude') }) }
            finally { pendingCoachForks-- }
          })().catch((err: unknown) => ({ isAnswered: false as const, reason: String(err) }))
          const cancelled = Symbol('cancelled')
          const stopped = signal && new Promise<typeof cancelled>(resolve => {
            onAbort = () => resolve(cancelled)
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
          })
          const result = stopped ? await Promise.race([work, stopped]) : await work
          if (result === cancelled) throw new Error('forbidden')
          await serial(async () => {
            await guard()
            if (operation !== coachOperation) throw new Error('stale-generation')
            if (result.isAnswered) await update($, coachA, () => coachDone(result.text, Date.now()))
            else await update($, coachA, coachFailed('reason' in result ? String(result.reason) : 'unknown', strings(lang, 'Claude')))
            committed = true
          })
        } finally {
          if (onAbort) signal?.removeEventListener('abort', onAbort)
          if (!committed) await serial(async () => {
            await checkSession($)
            if (sessionId !== owner || generation !== reservationGeneration || operation !== coachOperation) return
            await update($, coachA, coach => ({ ...coach, busy: false }))
            queuePublish($)
          })
        }
        break
      }
      case 'coach-apply': {
        const lang = await read($, langA), coach = await read($, coachA)
        const root = I?.root ?? await rootDir($)
        const file = await $.fs.exists(`${root}/AGENTS.md`).catch(() => false) ? 'AGENTS.md' : 'CLAUDE.md'
        if (!coach.patch) return { ok: false, error: 'invalid' }
        await guard()
        const filled = (await $.prompt.fill({ text: strings(lang, 'Claude').applyPrompt(file, coach.patch) }).catch(() => undefined)) !== undefined
        await guard()
        return { ok: true, filled }
      }
    }
    await guard()
    await publish($)
    await guard()
    $.ui.invalidate('ui.render')
    return { ok: true }
  } catch (error) {
    const message = String(error)
    if (error instanceof RelayRefusal) {
      const code = error.code
      return { ok: false, error: code === 'missing' ? 'forbidden' : code === 'http' ? 'disconnected' : code }
    }
    return { ok: false, error: message.includes('stale-generation') ? 'stale-generation' : message.includes('forbidden') ? 'forbidden' : 'unsupported' }
  }
}
const ensureRelay = async ($: EngineInterface, reopen = false) => {
  if (reopen) { appsEpoch++; appDiscovery = undefined }
  if (relay?.isClosed()) {
    if (launchCopied !== undefined) resetLaunch($)
    if (!reopen) throw new Error('Relay disconnected; reopen the browser from Brain Trail')
    relay = undefined
    apps = undefined; appDiscovery = undefined
  }
  if (!relay) {
    if (!startingRelay) {
      startingRelay = (async () => {
        await checkSession($)
        const startedGeneration = generation
        await load($)
        await publish($)
        const feed: DashboardFeed = {
          current: () => { if (!currentFeed) throw new Error('Feed unavailable'); return currentFeed },
          execute: <C extends HostCommand,>(g: number, c: C, scope?: CommandScope) =>
            executeCommand($, g, c, scope) as Promise<CommandReplies[C['kind']] | CommandRefusal>,
          subscribe: listener => { feedListeners.add(listener); return () => { feedListeners.delete(listener) } },
        }
        const binary = await relayBinary($)
        const owner = ++relayOwner
        const io = relayIO($, current => current === generation)
        const notifyFailure = io.onFailure
        io.onFailure = error => {
          if (relayOwner === owner) {
            const busy = launchBusy, site = launchSite
            resetLaunch($, false)
            if (busy) { launchSite = site; launchError = true }
            $.ui.invalidate('ui.render')
          }
          notifyFailure(error)
        }
        const client = await startRelay(io, binary, `${$.plugin.root}/hosts/browser/dist`, feed, {
          current: async () => {
            await checkSession($)
            if (!sessionId) throw new Error('session unavailable')
            const id = sessionId, expected = generation
            await publish($)
            const label = await sourceLabel($)
            await checkSession($)
            if (id !== sessionId || expected !== generation) throw new Error('stale-generation')
            return { owner: { host: 'code', sessionId: id }, generation: expected, label }
          },
        })
        if (generation !== startedGeneration) { client.close(); throw new Error('stale-generation') }
        return client
      })()
    }
    const pending = startingRelay
    try {
      const client = await pending
      if (startingRelay !== pending && relay !== client) { client.close(); throw new Error('stale-generation') }
      relay = client
    } finally { if (startingRelay === pending) startingRelay = undefined }
  }
  return relay
}
const browserAction = async ($: EngineInterface, press: UiPressArgument, kind: 'copy' | 'browser') => {
  if (launchBusy || nativeControlBusy) return
  resetLaunch($, false)
  const operation = ++launchOperation
  launchKind = kind
  launchSite = JSON.stringify([press.component, press.requestId, press.surface])
  launchBusy = true
  $.ui.invalidate('ui.render')
  try {
    await checkSession($)
    if (operation !== launchOperation) return
    const expected = generation
    const client = await ensureRelay($, true)
    await installedApps($)
    await publish($)
    await checkSession($)
    if (operation !== launchOperation || expected !== generation || relay !== client || client.isClosed()) return
    if (kind === 'browser') {
      await client.openBrowser(expected)
      await checkSession($)
      if (operation !== launchOperation || expected !== generation || relay !== client || client.isClosed()) return
      launchOpened = { generation: expected }
      return
    }
    const link = await client.prepareBrowserLink(expected)
    await checkSession($)
    if (operation !== launchOperation || expected !== generation || relay !== client || client.isClosed()) return
    if (link.expiresAt <= Date.now()) { launchError = true; return }
    const copied = await $.ui.copy({ text: link.url, surface: press.surface })
    await checkSession($)
    if (operation !== launchOperation || expected !== generation || relay !== client || client.isClosed()) return
    if (!copied.isCopied || link.expiresAt <= Date.now()) { launchError = true; return }
    launchCopied = { expiresAt: link.expiresAt, generation: expected }
    launchExpiry = $.clock.every(1000, () => {
      if (Date.now() >= link.expiresAt) {
        launchExpiry?.cancel()
        launchCopied = undefined
        launchExpiry = undefined
        $.ui.invalidate('ui.render')
      }
    })
  } catch {
    if (operation === launchOperation) launchError = true
  } finally {
    if (operation === launchOperation) {
      launchBusy = false
      $.ui.invalidate('ui.render')
    }
  }
}
const bindResult = async ($: EngineInterface, server: string, text: string, id: string, expected: number, signal?: AbortSignal) => {
  const current = async () => { await checkSession($); return !signal?.aborted && sessionId === id && generation === expected }
  if (!(await current())) return false
  const client = await ensureRelay($)
  await installedApps($)
  await publish($)
  if (!(await current()) || relay !== client) return false
  const label = await sourceLabel($)
  return bindCodeOpen($, client, server, text, { host: 'code', sessionId: id }, expected, label, current, signal)
}
const openNative = async ($: EngineInterface, press: UiPressArgument) => {
  if (launchBusy || nativeControlBusy) return
  resetLaunch($, false)
  const operation = ++nativeControlOperation
  const expected = generation
  const site = JSON.stringify([press.component, press.requestId, press.surface])
  nativeControlBusy = true
  $.ui.invalidate('ui.render')
  try {
    const opened = await $.ui.open({ id: LIVE_PANE, title: 'Brain Trail', rows: 24 }).catch(() => undefined)
    await checkSession($)
    if (operation !== nativeControlOperation || expected !== generation) return
    if (opened?.isPlaced) {
      nativeControlStatus = { site, generation: expected, result: 'opened' }
      return
    }
    const fr = await read($, langA).then(lang => lang === 'fr', () => false)
    if (operation !== nativeControlOperation || expected !== generation) return
    void $.ui.toast(fr
      ? 'Impossible d’afficher Brain Trail. Utilisez /brain-trail-v2 puis Copier le lien pour ouvrir le tableau de bord dans un navigateur.'
      : 'Could not display Brain Trail. Use /brain-trail-v2, then Copy link to open the dashboard in a browser.')
  } finally {
    if (operation === nativeControlOperation) { nativeControlBusy = false; $.ui.invalidate('ui.render') }
  }
}
const pairChat = async ($: EngineInterface, press: UiPressArgument) => {
  if (launchBusy || nativeControlBusy) return
  resetLaunch($, false)
  const operation = ++nativeControlOperation
  const site = JSON.stringify([press.component, press.requestId, press.surface])
  const startedGeneration = generation
  nativeControlBusy = true; $.ui.invalidate('ui.render')
  let client: RelayClient | undefined
  let pairId: string | undefined
  let copied = false
  try {
    await checkSession($)
    const id = sessionId, expected = generation
    if (!id) throw new Error('session unavailable')
    client = await ensureRelay($)
    await installedApps($)
    await publish($)
    await checkSession($)
    if (id !== sessionId || expected !== generation || client !== relay) throw new Error('stale-generation')
    pairId = relayIO($, () => true).randomToken()
    const approved = await client.approveApp({ v: 1, owner: { host: 'code', sessionId: id }, generation: expected, label: await sourceLabel($), approval: { kind: 'chat', pairId } })
    await checkSession($)
    if (operation !== nativeControlOperation || !approved.envelope || id !== sessionId || expected !== generation || approved.expiresAt <= Date.now()) throw new Error('pairing unavailable')
    const result = await $.ui.copy({ text: JSON.stringify(approved.envelope), surface: press.surface })
    await checkSession($)
    copied = result.isCopied && operation === nativeControlOperation && id === sessionId && expected === generation && approved.expiresAt > Date.now()
    if (!copied) throw new Error('copy failed')
    if (operation === nativeControlOperation && generation === startedGeneration) nativeControlStatus = { site, generation, result: 'copied' }
  } catch {
    if (operation === nativeControlOperation && generation === startedGeneration) nativeControlStatus = { site, generation, result: 'failed' }
  }
  finally {
    if (!copied && client && pairId) {
      try { await client.revokeApp({ v: 1, target: { kind: 'approval', approval: { kind: 'chat', pairId } }, reason: 'failed' }) }
      catch { client.close() }
    }
    if (operation === nativeControlOperation) { nativeControlBusy = false; $.ui.invalidate('ui.render') }
  }
}
const closeOwnPane = async ($: EngineInterface) => {
  try {
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
    await $.ui.close({ id: PANE })
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
  } catch {}
  const fr = await read($, langA).then(lang => lang === 'fr', () => false)
  $.ui.toast(fr ? 'Fermez l’ancien panneau Brain Trail manuellement.' : 'Close the old Brain Trail pane manually.')
}

const nativeElement = <P extends ViewProps>(tag: ViewTag<P, RenderElement>, props: P | null, ...children: ViewChild<RenderElement>[]): RenderElement => {
  const node = h(tag, props, ...children)
  if (!node || typeof node === 'string') throw new TypeError('Brain Trail: expected a native element')
  return node
}
const createNativeMapRenderer = (): MapRenderer => {
  const maps = createMapRenderer()
  const reduced = createMapRenderer()
  return { draw(L, trail, P, options) {
    const drawn = maps.draw(L, trail, P, options)
    if (drawn.svg.length <= PANE_SVG_LIMIT) return drawn
    // Keep the workspace outline and the latest activity in the native SVG budget.
    const moves = trail.moves.slice(-24)
    const calls = trail.calls.slice(-1)
    const state = new Map(moves.map(({ n }) => [n, trail.state.get(n)!]))
    return reduced.draw({ ...L, groups: L.groups.slice(0, 64) }, { state, moves, calls, perSvc: trail.perSvc }, P, {
      ...options, services: calls.map(({ svc }) => svc), widthPx: Math.min(options.widthPx, 320),
    })
  } }
}
const nativeRuntime = (ui: ElementTable, drawing: NativePane, lang: Lang, hitBox?: { box: string; reach: number }): ViewRuntime<RenderElement, UiPressArgument> => {
  const renderSvg: ViewRuntime<RenderElement, UiPressArgument>['Svg'] = 'Svg' in ui
    ? props => {
      if (props.source.length <= PANE_SVG_LIMIT) return nativeElement(ui.Svg, props)
      drawing.mapPainted = false
      return <ui.Text dimColor>{lang === 'fr'
        ? 'Carte trop grande pour ce panneau. Utilisez /brain-trail-v2 puis Copier le lien pour la voir dans le navigateur.'
        : 'This map exceeds the pane’s size limit. Use /brain-trail-v2, then Copy link to view it in a browser.'}</ui.Text>
    }
    : undefined
  return {
    h: nativeElement, Box: ui.Box, Text: ui.Text, Button: ui.Button, Input: ui.Input, Link: ui.Link,
    Svg: renderSvg,
    Markdown: 'Markdown' in ui ? ui.Markdown : undefined,
    Code: 'Code' in ui ? ui.Code : undefined,
    Measure: 'Client' in ui ? props => <ui.Client key={`${props.kind}-probe`} module="./measure.tsx" props={props} width={0} height="100%" /> : undefined,
    MapHit: 'Client' in ui ? () => drawing.mapPainted
      ? <ui.Client key={drawing.hitKey} module="./hit.tsx" props={{ tip: drawing.tip, ...hitBox }} width="100%" height="100%" />
      : <ui.Box />
      : undefined,
    NativeScene3d: renderSvg && (props => {
      const opts = {
        widthPx: props.widthPx, now: props.now, cam: props.state.cam3d, follow: props.state.zoomed,
        filesWord: props.filesWord, outside: props.outside, dark: props.palette.bg === DARK.bg,
        aspect: props.aspect,
      }
      let { svg, view } = drawSpin(props.layout, props.trail, props.palette, opts)
      let touched = new Set(props.semantics.touched)
      if (svg.length > PANE_SVG_LIMIT) {
        const moves = props.trail.moves.slice(-24)
        const state = new Map(moves.map(({ n }) => [n, props.trail.state.get(n)!]))
        const calls = props.trail.calls.slice(-1)
        const perSvc = new Map(calls.map(({ svc }) => [svc, props.trail.perSvc.get(svc)!]))
        ;({ svg, view } = drawSpin(props.layout, { state, moves, calls, perSvc }, props.palette, opts))
        touched = new Set(state.keys())
      }
      const count = props.trail.state.size
      const summary = lang === 'fr'
        ? `${count} fichier${count === 1 ? ' touché' : 's touchés'}`
        : `${count} file${count === 1 ? '' : 's'} touched`
      const calls = props.trail.calls.length
      const activity = calls === 0 ? summary : `${summary}, ${calls} ${strings(lang).figCalls}`
      return {
        node: nativeElement(renderSvg, { key: 'map-3d', source: svg, alt: `${props.layout.title}: ${activity} (3D)` }),
        frame: { view, layout: props.layout, touched, math: spinMath },
      }
    }),
  }
}

const nativeIsCurrent = (drawing: NativePane) => liveMap === drawing && drawing.owner === generation && !drawing.stop.signal.aborted
const nativeAssertCurrent = async ($: EngineInterface, drawing: NativePane) => {
  await checkSession($)
  if (!nativeIsCurrent(drawing)) throw new Error('stale-generation')
}
const nativeStep = (drawing: NativePane, step: Step) => {
  const v = drawing.view
  switch (step.key) {
    case 'tab': v.tab = step.next(v.tab); break
    case 'open': v.open = step.next(v.open); break
    case 'camera': v.camera = step.next(v.camera); break
    case 'view3d': v.view3d = step.next(v.view3d); break
    case 'cam3d': v.cam3d = step.next(v.cam3d); break
  }
}
const applyNativeSteps = ($: EngineInterface, drawing: NativePane, steps: Step[], navigation?: number) => serial(async () => {
  await nativeAssertCurrent($, drawing)
  for (const step of steps) {
    if (step.key === 'tab' && navigation !== undefined && navigation !== drawing.navigation) continue
    if (step.key === 'zoomed') {
      await update($, zoomed, value => nativeIsCurrent(drawing) ? step.next(value) : value)
      queuePublish($)
    } else nativeStep(drawing, step)
  }
  if (nativeIsCurrent(drawing)) $.ui.invalidate('ui.render')
})

const nativeActions = ($: EngineInterface, drawing: NativePane): ViewActions<UiPressArgument> => {
  const guard = () => nativeAssertCurrent($, drawing)
  const lifetime: PaneLifetime = { signal: drawing.stop.signal, assertCurrent: guard }
  const toast = (text: string) => { if (nativeIsCurrent(drawing)) void $.ui.toast(text) }
  const command = async <C extends HostCommand,>(cmd: C): Promise<CommandReplies[C['kind']] | undefined> => {
    try {
      await guard()
      if (cmd.kind === 'open' || cmd.kind === 'preview-read') await ensureRelay($, relay?.isClosed() === true)
      const reply = await executeCommand($, drawing.owner, cmd, undefined, lifetime)
      if (reply.ok) return reply as CommandReplies[C['kind']]
      toast(`Brain Trail: ${reply.error}`)
    } catch (error) { toast(`Brain Trail: ${String(error)}`) }
  }
  const intent = async (i: ViewIntent) => {
    const changesTab = i.kind === 'tab' || i.kind === 'legend' || (i.kind === 'preview' && i.ref !== null)
    const navigation = changesTab ? ++drawing.navigation : drawing.navigation
    try {
      await guard()
      if (isSharedViewIntent(i)) {
        if (i.kind === 'preview' && i.ref !== null) await ensureRelay($, relay?.isClosed() === true)
        const text = await applySharedIntent($, drawing.owner, i, guard, undefined, lifetime)
        await guard()
        if (i.kind === 'preview')
          drawing.preview = i.ref === null ? undefined : { ref: i.ref, text, pending: false }
      }
      const now = await $.clock.now()
      await guard()
      if (i.kind === 'toggle-3d' || i.kind === 'tab' || i.kind === 'whole') {
        drawing.gesture = GESTURE0
        drawing.tip = null
        drawing.hitKey = `map-hit-${++hitInstance}`
      }
      const steps = plan(i, { now, frames: drawing.frames, view3d: drawing.view.view3d })
      await applyNativeSteps($, drawing, isSharedViewIntent(i) ? steps.filter(step => step.key !== 'zoomed') : steps, changesTab ? navigation : undefined)
    } catch (error) { toast(`Brain Trail: ${String(error)}`) }
  }
  return {
    intent,
    scrollBody: to => { if (nativeIsCurrent(drawing) && drawing.sizing.scroll(to)) $.ui.invalidate('ui.render') },
    openFile: async ref => {
      try {
        await guard()
        const target = openTarget(await read($, settingsA), I, ref)
        if (target.kind === 'preview') await intent({ kind: 'preview', ref: target.ref })
        else await command({ kind: 'open', ref, app: target.app })
      } catch (error) { toast(`Brain Trail: ${String(error)}`) }
    },
    openIn: async (ref, app) => { await command({ kind: 'open', ref, app }) },
    copy: async (text, press) => nativeIsCurrent(drawing) && (await $.ui.copy({ text, surface: press.surface }).catch(() => undefined))?.isCopied === true,
    toast,
    compact: async () => (await command({ kind: 'compact' }))?.outcome ?? { kind: 'failed' },
    refreshMeter: async () => { await command({ kind: 'refresh-meter' }) },
    saveSettings: async patch => { await command({ kind: 'settings', patch }) },
    setLang: async lang => { await command({ kind: 'lang', lang }) },
    clearTrail: async () => { await command({ kind: 'clear-trail' }) },
    retryLayout: () => { void command({ kind: 'retry-layout' }) },
    analyseCoach: async () => { await command({ kind: 'coach-analyse' }) },
    applyCoach: async () => (await command({ kind: 'coach-apply' }))?.filled === true,
  }
}

const nativeSnapshot = async ($: EngineInterface, drawing: NativePane, columns: number, now: number, lang: Lang): Promise<ViewSnapshot> => {
  const { tab, open } = drawing.view
  const fold = { index: I, linked, connected }
  const [list, m, P] = await Promise.all([read($, events), read($, meter), palette($, now)])
  let body: TabSnapshot
  if (tab === 'map') {
    const index = I, L = layout
    if (!index || !L) {
      body = failure ? { tab, kind: 'failed', message: failure } : { tab, kind: 'loading', seconds: packingSince ? Math.max(0, Math.floor((now - packingSince) / 1000)) : 0 }
    } else {
      const view = await shared($)
      body = { tab, kind: 'ready', layout: L, shallow, fold: { ...fold, index }, state: {
        ...drawing.view, ...view, cam3d: cameraDuringGesture(drawing.view.cam3d, drawing.gesture),
      } }
    }
  } else if (tab === 'context') {
    body = { tab, breakdown: await getBreakdown($, now), costHistory: await costHistory($), settings: await read($, settingsA) }
  } else if (tab === 'files') {
    const ref = await read($, previewA)
    if (ref === null) drawing.preview = undefined
    else if (drawing.preview?.ref.p !== ref.p || !!drawing.preview?.ref.out !== !!ref.out) {
      const pending: NativePreview = { ref, pending: true }
      drawing.preview = pending
      const lifetime: PaneLifetime = {
        signal: drawing.stop.signal,
        assertCurrent: async () => {
          await nativeAssertCurrent($, drawing)
          const current = await read($, previewA)
          if (drawing.preview !== pending || !current || current.p !== ref.p || !!current.out !== !!ref.out) throw new Error('stale-generation')
        },
      }
      void (async () => {
        try {
          await lifetime.assertCurrent()
          await ensureRelay($)
          const text = await secureFile($, drawing.owner, ref, { kind: 'preview' }, (client, id) => client.readFile(id), undefined, lifetime)
          if (drawing.preview === pending && nativeIsCurrent(drawing)) pending.text = text
        } catch {}
        finally {
          if (drawing.preview === pending && nativeIsCurrent(drawing)) {
            pending.pending = false
            $.ui.invalidate('ui.render')
          }
        }
      })()
    }
    const [breakdown, settings] = await Promise.all([getBreakdown($, now), read($, settingsA)])
    const candidate = drawing.preview
    const preview = candidate && candidate.ref.p === ref?.p && !!candidate.ref.out === !!ref.out ? candidate : undefined
    body = { tab, breakdown, fold, preview: ref === null ? null : {
      ref, pending: preview?.pending ?? true, text: preview?.text,
      settings, apps: apps ?? [], appsUnavailable: drawing.appsFailed,
    } }
  } else if (tab === 'goal') {
    body = { tab, connected }
  } else if (tab === 'coach') {
    const root = I?.root ?? await rootDir($)
    const instructionFile = await $.fs.exists(`${root}/AGENTS.md`).catch(() => false) ? 'AGENTS.md' : 'CLAUDE.md'
    body = { tab, breakdown: await getBreakdown($, now), coach: await read($, coachA), instructionFile, fold }
  } else {
    if (!apps && !drawing.appsPending && !drawing.appsFailed && nativeIsCurrent(drawing))
      drawing.appsPending = installedApps($).catch(() => { drawing.appsFailed = true }).finally(() => {
        drawing.appsPending = undefined
        if (nativeIsCurrent(drawing)) $.ui.invalidate('ui.render')
      })
    body = { tab, settings: await read($, settingsA), apps: apps ?? [], appsUnavailable: drawing.appsFailed }
  }
  return { now, widthPx: Math.max(240, columns * 8 - 24), lang, assistant: 'Claude', costInfoCommand: '/cost', palette: P, meter: m, events: list, open, body }
}
const actionStatus = (ui: ElementTable, site: string, fr: boolean, band: boolean) => {
  const { Box, Text } = ui
  const control = nativeControlStatus?.site === site && nativeControlStatus.generation === generation ? nativeControlStatus.result : undefined
  if (control) return <Text size="caption">{control === 'opened'
    ? (fr ? 'Brain Trail ouvert.' : 'Brain Trail opened.')
    : control === 'copied'
      ? (fr ? 'Association copiée ; collez-la dans Chat.' : 'Pairing copied; paste it in Chat.')
      : (fr ? 'Échec de l’association.' : 'Pairing failed.')}</Text>
  if (launchSite !== site || (band && launchKind !== 'browser')) return undefined
  if (launchBusy) return <Text size="caption">{launchKind === 'browser' ? (fr ? 'Ouverture…' : 'Opening…') : (fr ? 'Copie…' : 'Copying…')}</Text>
  if (launchError) return <Text key={launchKind === 'browser' ? 'browser-open-error' : 'browser-copy-error'} size="caption">{launchKind === 'browser' ? (fr ? 'Échec de l’ouverture du navigateur.' : 'Browser launch failed.') : (fr ? 'Échec de la copie, réessayez.' : 'Copy failed; try again.')}</Text>
  if (launchOpened?.generation === generation && relay?.isClosed() === false) return <Box key="browser-open-success"><Text size="caption">{fr ? 'Ouverture demandée au navigateur.' : 'Browser launch requested.'}</Text></Box>
  if (launchCopied?.generation === generation && launchCopied.expiresAt > Date.now() && relay?.isClosed() === false) return <Box key="browser-copy-success"><Text size="caption">{fr ? 'Copié.' : 'Copied.'}</Text></Box>
  return undefined
}


export const register: Register = (on, options) => {
  const defaultLang: Lang = options.language === 'fr' ? 'fr' : 'en'

  on('session.start', async ($, e, next) => {
    void closeOwnPane($)
    await revokeGeneration(sessionId, generation)
    generation++; revision = 0; sessionId = await $.session.id(); lastLayout = undefined; breakdown = undefined
    resetLaunch($)
    invalidateCoach($)
    syncReplayClock($, false)
    resetApps()
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
    await $.command.register({ name: COMMAND, description: 'Open Brain Trail or pair with Chat' })
    const saved = await $.store.get('lang').catch(() => undefined)
    await update($, langA, () => (saved === 'fr' || saved === 'en' ? saved : defaultLang))
    const savedSet = await $.store.get('settings').catch(() => undefined) as Partial<TrailSettings> | undefined
    const vault = await $.fs.exists(`${await mapRoot($)}/.obsidian`).catch(() => false)
    await update($, settingsA, () => initialSettings(vault, savedSet))
    void load($).catch(() => {})
    meterTimer?.cancel()
    meterTimer = $.clock.every(4000, () => { void refreshMeter($).then(() => publish($)).catch(() => {}) })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    generation++
    retireNative()
    resetLaunch($)
    invalidateCoach($)
    relayOwner++; relay?.close(); relay = undefined; startingRelay = undefined
    resetApps()
    syncReplayClock($, false)
    meterTimer?.cancel(); meterTimer = undefined
    feedListeners.clear(); currentFeed = undefined; sessionId = undefined
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    void closeOwnPane($)
    return attached
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    await revokeGeneration(sessionId, generation)
    generation++; revision = 0; lastLayout = undefined; breakdown = undefined
    retireNative()
    resetLaunch($)
    invalidateCoach($)
    syncReplayClock($, false)
    const result = await next(e)
    sessionId = await $.session.id()
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
    queuePublish($)
    $.ui.invalidate('ui.render')
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    void closeOwnPane($)
    const fr = (await read($, langA)) === 'fr'
    return { text: fr ? 'Dans Claude Desktop, ouvrez Brain Trail, associez Chat ou copiez un lien pour la barre d’adresse du navigateur.' : 'In Claude Desktop, open Brain Trail, pair with Chat, or copy a link for the browser address bar.' }
  })

  // the gauge follows the engine's own measure, pushed after each turn
  on('session.measure', async ($, e, next) => {
    const c = e.context
    await update($, meter, m => ({ ...m, usd: e.cost?.usd ?? m.usd, limits: e.rateLimits.length > 0 ? e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}) })) : m.limits }))
    await applyContext($, c)
    queuePublish($)
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
    const result = await next(e)
    if (text === '/clear' || text.startsWith('/resume')) void checkSession($).then(() => publish($))
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const opener = e.agentId === undefined ? parseOpenerToolName(tool) : undefined
    if (opener) {
      await checkSession($).catch(() => {})
      const id = sessionId, expected = generation
      const ran = await next(e)
      if (id && !next.signal.aborted && ran.deny === undefined && !ran.isError) await bindResult($, opener, ran.text ?? '', id, expected, next.signal).catch(() => false)
      return ran
    }
    if (isAdapterOperation(tool)) return next(e)
    const at = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const agent = e.agentId !== undefined ? (true as const) : undefined
    const input = e as unknown as Record<string, unknown>
    const output = ran.text ?? ''
    enqueue(async () => {
      const isError = ran.isError === true
      let searchPaths: string[] | undefined
      let touch: { found: TrailEvent[]; metas: string[][] } | undefined
      if (needsMcpScan(tool, isError, output)) {
        await load($).catch(() => {})
        if (I !== undefined) searchPaths = pathsIn(I, output, await rootDir($), await homeDir($))
      } else if (needsTouch(tool, isError)) {
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
          touch = { found, metas }
        }
      }
      await record($, assembleCapture({ tool, input, output, at, agent, isError, searchPaths, touch }))
    })
    return ran
  })

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

  on('ui.close', { id: LIVE_PANE }, async (_$, e, next) => {
    const drawing = liveMap
    const result = await next(e)
    if (liveMap === drawing) retireNative()
    return result
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== LIVE_PANE || e.surface !== 'desktop') return next(e)
    const drawing = liveMap
    if (!drawing || !nativeIsCurrent(drawing)) return {}
    if (e.element.endsWith('-probe')) {
      if (drawing.sizing.measure(e.element, e.data)) $.ui.invalidate('ui.render')
      return {}
    }
    if (!e.element.startsWith('map-hit-')) return next(e)
    if (e.element !== drawing.hitKey || drawing.view.tab !== 'map' || (!drawing.frames.d2 && !drawing.frames.d3)) return {}
    if (typeof e.data === 'object' && e.data !== null && 'kind' in e.data && e.data.kind === 'box') {
      if (drawing.sizing.mapMeasurement(e.data)) $.ui.invalidate('ui.render')
      return {}
    }
    const input = parseGesture(e.data)
    if (!input) return {}
    const state = { ...drawing.view, zoomed: await read($, zoomed) }
    const result = mapGesture(input, state, drawing.gesture, drawing.frames, {
      now: await $.clock.now(), hoverNames: (await read($, settingsA)).hover,
    })
    if (!nativeIsCurrent(drawing) || e.element !== drawing.hitKey || !drawing.mapPainted) return {}
    drawing.gesture = result.memory
    drawing.tip = result.tip ?? null
    if (result.steps.length > 0) await applyNativeSteps($, drawing, result.steps)
    if (!nativeIsCurrent(drawing) || e.element !== drawing.hitKey || !drawing.mapPainted) return {}
    if (result.open) void nativeActions($, drawing).openFile(result.open)
    return { props: { tip: drawing.tip, ...drawing.hitBox } }
  }).catch(($, e, next) => next(e))

  on('ui.scroll', { component: 'Pane', requestId: LIVE_PANE }, async ($, e, next) => {
    const drawing = liveMap
    if (e.requestId !== LIVE_PANE || !drawing || !nativeIsCurrent(drawing) || e.origin.kind !== 'person' || e.by === 0) return next(e)
    const { tab, view3d } = drawing.view
    if (drawing.sizing.wheel({ by: e.by, bodyRows: e.bodyRows, contentRows: e.contentRows, tab })) {
      $.ui.invalidate('ui.render')
      return {}
    }
    if (tab !== 'map' || e.pointer === undefined || drawing.gesture.hover === undefined) return next(e)
    const now = await $.clock.now()
    const at = drawing.gesture.hover
    if (!at || !nativeIsCurrent(drawing)) return next(e)
    const result = mapWheel(e.by, view3d, at, drawing.gesture, drawing.frames, now)
    drawing.gesture = result.memory
    await applyNativeSteps($, drawing, result.steps)
    return {}
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== LIVE_PANE || e.surface !== 'desktop') return next(e)
    if (liveMap?.owner !== generation) {
      retireNative()
      liveMap = {
        owner: generation, stop: new AbortController(), renderer: createNativeMapRenderer(),
        sizing: createNativeLayout(), view: { ...VIEW_STATE0 }, frames: { d2: undefined },
        navigation: 0, hitKey: `map-hit-${++hitInstance}`, mapPainted: false, gesture: GESTURE0, tip: null,
      }
    }
    const drawing = liveMap
    const columns = e.props.bodyColumns
    const [now, lang] = await Promise.all([$.clock.now(), read($, langA)])
    if (!failure && !layout) void load($).catch(() => {})
    const snapshot = await nativeSnapshot($, drawing, columns, now, lang)
    if (!nativeIsCurrent(drawing) || snapshot.body.tab !== drawing.view.tab) return next(e)
    const { fill, hitBox } = drawing.sizing.render({
      columns, rows: e.props.scroll.bodyRows, tab: snapshot.body.tab, lang, fill: e.props.placement === 'dock',
    })
    drawing.hitBox = hitBox
    drawing.mapPainted = true
    const out = renderPane(nativeRuntime($.ui.resolve(e), drawing, lang, hitBox), { ...snapshot, fill }, nativeActions($, drawing), drawing.renderer)
    drawing.frames = {
      d2: drawing.mapPainted && out.drawn?.kind === '2d' ? out.drawn.frame : undefined,
      d3: drawing.mapPainted && out.drawn?.kind === '3d' ? out.drawn.frame : undefined,
    }
    if (!out.drawn || !drawing.mapPainted) {
      drawing.mapPainted = false
      drawing.gesture = GESTURE0
      drawing.tip = null
    }
    return out.node
  })

  // The band remains available before the first context measurement.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const set = await read($, settingsA)
    const m = await read($, meter)
    if (e.props.hasSurvey || set.band === false || (e.surface !== 'desktop' && m.percent === undefined)) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const lang = await read($, langA)
    const S = strings(lang)
    const fr = lang === 'fr'
    const pct = m.percent
    const zone = pct === undefined ? undefined : zoneOf(pct)
    const P = pct === undefined ? undefined : await palette($, await $.clock.now())
    const status = e.surface === 'desktop' ? actionStatus(ui, JSON.stringify([e.component, e.requestId, e.surface]), fr, true) : undefined
    const row = (
      <Box flexDirection="row" alignItems="center" columnGap="sm" flexWrap="wrap">
        {pct !== undefined && P !== undefined && 'Svg' in ui && <ui.Svg key="band-gauge" source={miniGauge(P, pct)} width={64} height={8} alt={`${pct} %`} />}
        {pct !== undefined && <Text size="caption" weight={zone === 'ok' ? undefined : 'medium'} tabular>{weather(pct)} {S.bandContext(pct)}</Text>}
        {m.usd !== undefined && <Text size="caption" dimColor tabular>· {S.bandCost(usd(m.usd))}</Text>}
        {limitOf(m, 'five_hour') !== undefined && <Text size="caption" dimColor tabular>· {S.band5h(Math.round(limitOf(m, 'five_hour')!.percentUsed))}</Text>}
        {limitOf(m, 'seven_day') !== undefined && <Text size="caption" dimColor tabular>· {S.band7d(Math.round(limitOf(m, 'seven_day')!.percentUsed))}</Text>}
        <Box flexGrow={1} />
        {e.surface === 'desktop' && !nativeControlBusy && !launchBusy && <Button key="open-brain-trail" label={fr ? 'Ouvrir Brain Trail' : 'Open Brain Trail'} onPress={press => openNative($, press)} />}
        {e.surface === 'desktop' && !nativeControlBusy && !launchBusy && <Button key="pair-chat" label={fr ? 'Associer Chat' : 'Pair with Chat'} onPress={press => pairChat($, press)} />}
        {e.surface === 'desktop' && !nativeControlBusy && !launchBusy && <Button key="open-browser" label="🌐" onPress={press => browserAction($, press, 'browser')} />}
      </Box>
    )
    return status ? <Box flexDirection="column">{row}{status}</Box> : row
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== COMMAND || e.surface !== 'desktop') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const fr = (await read($, langA)) === 'fr'
    const status = actionStatus(ui, JSON.stringify([e.component, e.requestId, e.surface]), fr, false)
    const row = (
      <Box flexDirection="row" alignItems="center" columnGap="sm" flexWrap="wrap">
        <Text>{fr ? 'Ouvrez Brain Trail ou associez Chat. Pour le navigateur, copiez le lien dans la barre d’adresse, pas dans la conversation.' : 'Open Brain Trail or pair with Chat. For a browser, paste the copied link into the address bar, not the conversation.'}</Text>
        {!nativeControlBusy && !launchBusy && <Button key="open-brain-trail" label={fr ? 'Ouvrir Brain Trail' : 'Open Brain Trail'} onPress={press => openNative($, press)} />}
        {!nativeControlBusy && !launchBusy && <Button key="pair-chat" label={fr ? 'Associer Chat' : 'Pair with Chat'} onPress={press => pairChat($, press)} />}
        {!nativeControlBusy && !launchBusy && <Button key="copy-browser-link" label={fr ? 'Copier le lien' : 'Copy link'} onPress={press => browserAction($, press, 'copy')} />}
      </Box>
    )
    return status ? <Box flexDirection="column">{row}{status}</Box> : row
  }).catch(($, e, next) => next(e))
}

const rank2 = (z: 'ok' | 'warn' | 'bad') => (z === 'ok' ? 0 : z === 'warn' ? 1 : 2)
