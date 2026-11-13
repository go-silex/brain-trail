import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, SessionContextBreakdown, UiPressArgument } from 'claude-code'

import type { Lang, Meter, TrailSettings, Tab, Totals, TrailEvent } from '../types/model'
import { MAX_SEEN, afterCd, describe, linksIn, makeIndex, pairKey, pathsIn, touchedBy } from './files'
import type { Index } from './files'
import { coachPrompt, strings } from './i18n'
import { DARK, LIGHT, createMapRenderer, packFiles } from './map'
import { isLocal, toolsByServer } from './mcp'
import { CAM0 } from './spin'
import type { Cam, SpinView } from './spin'
import type { Layout, Palette } from './map'
import { sliceToStep } from './fold'
import { assembleCapture, needsMcpScan, needsTouch } from './acts'
import { costStats, keepCosts, limitOf, projectFiles, usd, zoneOf } from './readout'
import type { CostEntry } from './readout'
import { DEFAULT_SETTINGS, findArgv, fromFind, GIT_LS, hash, initialSettings, isShallow, pickFiles, vaultProbe } from './workspace'
import { cameraDuringGesture, cellAspect, coachBusy, coachDone, coachFailed, GESTURE0, guessChrome, mapCells, mapGesture, mapWheel, openTarget, paneWidthPx, parseBox, parseGesture, plan, replayTick, STEP_MS, timerEffect, type Cells } from './view-controller'
import type { Drawn2d, DrawnFrames, FoldFacts, Step, TabSnapshot, ViewActions, ViewChild, ViewIntent, ViewProps, ViewRuntime, ViewSnapshot, ViewTag } from '../types/view'
import type { DashboardFeed, FactsWire, HostCommand, CommandReplies, CommandRefusal, LayoutWire, ServerEvent } from '../types/browser'
import type { SharedView } from '../types/view'
import { reduceSharedView, isSharedViewIntent } from './view-controller'
import { RelayRefusal, startRelay, type RelayClient } from '../hosts/relay/client'
import { relayBinary, relayIO } from '../hosts/native/io'
import { withNativeFile } from '../hosts/native/files'
import { applySettingsPatch } from './view-settings'
import { renderPane, TITLE, weather } from './views'

const COMMAND = 'brain-trail-v2'
const PANE = 'brain-trail-v2'
const CACHE_DIR = '.claude/brain-trail-v2'
const MAX_EVENTS = 2000
const maps = createMapRenderer()

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
// a file read inside the pane (the « Preview in Brain Trail » choice), or none
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
  const names = reported
  const gitArgv = windows
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        `${names.map(name => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`).join('; ')}; & git ${GIT_LS.slice(1).map(arg => `'${arg.replace(/'/g, "''")}'`).join(' ')}; exit $LASTEXITCODE`]
    : ['env', ...names.flatMap(name => ['-u', name]), ...GIT_LS]
  const git = valid ? await $.process.run(gitArgv, { cwd: root, timeoutMs: 20000 }).catch(() => undefined) : undefined
  let raw = git !== undefined && git.exitCode === 0 ? git.stdout : ''
  if (raw === '') {
    const argv = windows
      ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `$root=(Get-Location).Path; Get-ChildItem -File -Recurse ${shallow ? '-Depth 2' : ''} | ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\\','/') }`]
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

const refresh = async ($: EngineInterface) => {
  const root = await mapRoot($)
  const list = await listFiles($, root)
  if (layout !== undefined && I?.root === root && list.length === I.paths.length && list.every((p, i) => p === I!.paths[i])) return layout
  setLayout(root, list)
  linked.clear(); metaRead.clear()
  void $.fs.write(await cacheFile($, root), JSON.stringify({ root, files: list })).catch(() => {})
  queuePublish($)
  $.ui.invalidate('ui.render')
  return layout!
}

const load = ($: EngineInterface) => {
  if (layout !== undefined) return Promise.resolve(layout)
  if (packing === undefined) {
    packingSince = Date.now()
    packing = (async () => {
      const root = await mapRoot($)
      const cached = await $.fs.read(await cacheFile($, root)).then(t => JSON.parse(t) as { root: string; files: string[] }).catch(() => undefined)
      if (cached !== undefined && cached.root === root && cached.files.length > 0) {
        setLayout(root, cached.files)
        void refresh($).catch(() => {})
        queuePublish($)
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
const record = async ($: EngineInterface, list: TrailEvent[]) => {
  if (list.length === 0) return
  const first = list[0]!.at
  await update($, totals, t => ({ steps: t.steps + list.length, first: t.first ?? first }))
  await update($, events, l => [...l, ...list].slice(-MAX_EVENTS))
  queuePublish($)
}

// the main shell keeps its directory from one command to the next; a sub-agent's starts where the session does
let shellDir: string | undefined

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

// The portable relay registry is the authority for both surfaces.
let apps: string[] | undefined
let appDiscovery: Promise<string[]> | undefined
let appsFailed = false
let appsLoading = false
let appsEpoch = 0
const resetApps = () => {
  appsEpoch++
  apps = undefined; appDiscovery = undefined; appsFailed = false; appsLoading = false
}
const discoverApps = ($: EngineInterface) => {
  if (relay?.isClosed()) appsFailed = true
  if (apps !== undefined || appsFailed || appsLoading) return
  appsLoading = true
  const owner = appsEpoch
  void installedApps($).then(() => { if (owner === appsEpoch) appsFailed = false }, () => { if (owner === appsEpoch && apps === undefined) appsFailed = true }).finally(() => {
    if (owner !== appsEpoch) return
    appsLoading = false
    $.ui.invalidate('ui.render')
  })
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
    if (appsFailed) { appsFailed = false; $.ui.invalidate('ui.render') }
    if (apps === undefined) { apps = found; queuePublish($) }
    return apps
  } finally { if (appDiscovery === pending) appDiscovery = undefined }
}

const openFile = async ($: EngineInterface, p: string, out?: true) => {
  const ref = { p, ...(out ? { out: true as const } : {}) }
  const target = openTarget(await read($, settingsA), I, ref)
  await ensureRelay($)
  await checkSession($)
  const expected = generation
  if (target.kind === 'preview') {
    const operation = ++previewOperation
    const text = await secureFile($, expected, ref, { kind: 'preview' }, (client, id) => client.readFile(id))
    await serial(async () => {
      await checkSession($)
      if (generation !== expected || operation !== previewOperation) throw new Error('stale-generation')
      browserPreview = { p, out: !!out, text }
      await update($, previewA, () => target.ref)
      await update($, tabA, () => 'files')
      queuePublish($)
    })
    return
  }
  const launch = await secureFile($, expected, ref, { kind: 'open', app: target.app }, (client, id) => client.openFile(id, target.app === 'default' ? undefined : target.app, expected))
  void $.ui.toast(`Brain Trail: Launch ${launch.status}.`)
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

// ---- the map's pointer layer ----

// what the last map drawn shows, so a click or a hover can be matched to a file or a folder
let lastMap: { view: Drawn2d['view']; L: Layout; touched: Set<number> } | undefined

let gesture = GESTURE0
// Measurements are stamped with their pane and map sizes; other surfaces cannot
// clear them, and a late report from a previous resize cannot change the new frame.
const hitBoxes = new Map<string, { box: string; reach: number }>()
let mapChrome: { columns: number; chrome: Cells } | undefined
let bodyWindow: { stamp: string; dimensions: string; paneRows: number; tab: Tab; offset: number; viewport: number; measured: number; reach: number; end: boolean } | undefined
let bodyGeneration = 0
let chromeGeneration = 0
let measuredChrome: { shape: string; stamp: string; header: number; footer: number; headerReach: number; footerReach: number } | undefined
let mapVisible = false
const bodyLimit = () => bodyWindow === undefined ? 0 : Math.max(0, bodyWindow.measured + 1 - bodyWindow.viewport)
// Keep the requested offset across provisional or stale measurements; only the
// displayed window is clamped. A later measurement can reveal the saved position.
const visibleBodyOffset = () => {
  if (bodyWindow === undefined) return 0
  if (bodyWindow.measured === 0 || bodyWindow.viewport === 0) return bodyWindow.offset
  return bodyWindow.end ? bodyLimit() : Math.min(bodyWindow.offset, bodyLimit())
}
const moveBody = ($: EngineInterface, to: 'first' | 'previous' | 'next' | 'last' | number) => {
  if (bodyWindow === undefined) return
  const limit = bodyLimit()
  const page = Math.max(1, bodyWindow.viewport)
  const current = visibleBodyOffset()
  bodyWindow.end = to === 'last'
  bodyWindow.offset = Math.max(0, Math.min(limit, typeof to === 'number' ? current + to : to === 'first' ? 0 : to === 'last' ? limit : current + (to === 'next' ? page : -page)))
  $.ui.invalidate('ui.render')
}
const drawnFrames = (): DrawnFrames => ({
  d2: lastMap === undefined ? undefined : { view: lastMap.view, layout: lastMap.L, touched: lastMap.touched },
  d3: lastSpin === undefined ? undefined : { view: lastSpin.view, layout: lastSpin.L, touched: lastSpin.touched },
})
const applyStep = async ($: EngineInterface, step: Step) => {
  switch (step.key) {
    case 'tab': await update($, tabA, step.next); break
    case 'open': await update($, openA, step.next); break
    case 'zoomed': await update($, zoomed, step.next); break
    case 'camera': await update($, cameraA, step.next); break
    case 'play': await update($, playA, step.next); break
    case 'view3d': await update($, view3dA, step.next); break
    case 'cam3d': await update($, cam3dA, step.next); break
    case 'preview': await update($, previewA, step.next); break
  }
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
const nativeIntent = async ($: EngineInterface, intent: ViewIntent) => {
  const operation = intent.kind === 'preview' ? ++previewOperation : undefined
  await checkSession($)
  const expected = generation
  let text: string | undefined
  if (intent.kind === 'preview' && intent.ref !== null) {
    await ensureRelay($)
    text = await secureFile($, expected, intent.ref, { kind: 'preview' }, (client, id) => client.readFile(id))
  }
  return serial(async () => {
  await checkSession($)
  if (expected !== generation || (operation !== undefined && operation !== previewOperation)) return
  if (intent.kind === 'toggle-3d') gesture = GESTURE0
  if (isSharedViewIntent(intent)) {
    if (intent.kind === 'preview') browserPreview = intent.ref === null ? undefined : { p: intent.ref.p, out: !!intent.ref.out, text: text! }
    const count = sliceToStep(await read($, events), null, Date.now()).steps.length
    const next = reduceSharedView(await shared($), intent, count)
    await setShared($, next)
    if (timerEffect(intent) !== 'none') syncReplayClock($, next.play.playing)
    // Apply only surface-local effects here; shared fields were reduced above.
    for (const step of plan(intent, { now: 0, frames: drawnFrames() })) {
      if (step.key !== 'preview' && step.key !== 'zoomed' && step.key !== 'play') await applyStep($, step)
    }
  } else {
    const now = intent.kind === 'turn-3d' || intent.kind === 'spin-3d' ? await $.clock.now() : 0
    for (const step of plan(intent, { now, frames: drawnFrames() })) await applyStep($, step)
  }
  queuePublish($)
  })
}



const miniGauge = (P: Palette, pct: number) => {
  const at = Math.max(4, Math.min(60, (pct / 100) * 64))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 8" width="64" height="8">`
    + `<rect x=".5" y="2" width="63" height="4" rx="2" fill="none" stroke="${P.line}"/>`
    + `<rect x=".5" y="2" width="${at.toFixed(1)}" height="4" rx="2" fill="${P.fg}" fill-opacity=".85"/>`
    + `<line x1="32" y1="0" x2="32" y2="8" stroke="${P.fg}" stroke-opacity=".4"/><line x1="48" y1="0" x2="48" y2="8" stroke="${P.fg}" stroke-opacity=".4"/>`
    + `<circle cx="${at.toFixed(1)}" cy="4" r="3" fill="#35b0ff"/></svg>`
}


let opened = false

// Start the relay on demand for browser access or native app discovery.
let relay: RelayClient | undefined
let startingRelay: Promise<RelayClient> | undefined
let generation = 1
let sessionId: string | undefined
let revision = 0
let layoutRevision = 0
let lastLayout: Layout | undefined
let currentFeed: ReturnType<DashboardFeed['current']> | undefined
let browserPreview: { p: string; out: boolean; text: string } | undefined
const feedListeners = new Set<(event: ServerEvent) => void>()
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
const setShared = async ($: EngineInterface, value: SharedView) => {
  await update($, previewA, () => value.preview)
  await update($, zoomed, () => value.zoomed)
  await update($, playA, () => value.play)
}
const checkSession = async ($: EngineInterface) => {
  const id = await $.session.id()
  if (sessionId === undefined) sessionId = id
  else if (sessionId !== id) {
    sessionId = id
    generation++
    invalidateCoach($)
    resetApps()
    revision = 0
    lastLayout = undefined
    breakdown = undefined
    browserPreview = undefined
    syncReplayClock($, false)
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
  }
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
    assistant: 'Claude', lang: await read($, langA), meter: await read($, meter),
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
const secureFile = async <T,>($: EngineInterface, expected: number, ref: { p: string; out?: boolean }, action: { kind: 'preview' } | { kind: 'open'; app: string }, use: (client: RelayClient, id: string) => Promise<T>): Promise<T> => {
  if (!relay || !I) throw new Error('forbidden')
  const client = relay
  return withNativeFile($, client, { root: I.root, generation: expected, refreshGeneration: () => checkSession($), currentGeneration: () => generation, known: candidate => knownRef($, candidate), apps: await installedApps($) }, ref, action, id => use(client, id))
}
const invalidateTrail = ($: EngineInterface) => {
  generation++; revision = 0; lastLayout = undefined; browserPreview = undefined; breakdown = undefined
  invalidateCoach($)
  syncReplayClock($, false)
}
const clearTrailState = async ($: EngineInterface) => {
  await update($, events, () => [])
  await update($, totals, () => ({ steps: 0 }))
  await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
}
const executeCommand = async ($: EngineInterface, expected: number, command: HostCommand): Promise<CommandReplies[HostCommand['kind']] | CommandRefusal> => {
  await checkSession($)
  if (expected !== generation) return { ok: false, error: 'stale-generation' }
  try {
    const guard = async () => { await checkSession($); if (expected !== generation) throw new Error('stale-generation') }
    switch (command.kind) {
      case 'open': {
        const launch = await secureFile($, expected, command.ref, { kind: 'open', app: command.app }, (client, id) => client.openFile(id, command.app === 'default' ? undefined : command.app, expected))
        return { ok: true, launch }
      }
      case 'preview-read': {
        const text = await secureFile($, expected, command.ref, { kind: 'preview' }, (client, id) => client.readFile(id))
        return { ok: true, text }
      }
      case 'settings': {
        const allowed = await installedApps($)
        if (![command.patch.openMd, command.patch.openOther].every(app => app === undefined || app === 'default' || app === 'preview' || allowed.includes(app))) return { ok: false, error: 'forbidden' }
        await serial(async () => {
          await guard()
          const next = applySettingsPatch(await read($, settingsA), command.patch)
          await $.store.set('settings', next)
          await update($, settingsA, () => next)
        })
        break
      }
      case 'view': {
        const intent = command.intent
        const operation = intent.kind === 'preview' ? ++previewOperation : undefined
        let text: string | undefined
        if (intent.kind === 'preview' && intent.ref !== null) {
          text = await secureFile($, expected, intent.ref, { kind: 'preview' }, (client, id) => client.readFile(id))
        }
        await serial(async () => {
          await guard()
          if (operation !== undefined && operation !== previewOperation) throw new Error('stale-generation')
          if (intent.kind === 'preview') browserPreview = intent.ref === null ? undefined : { p: intent.ref.p, out: !!intent.ref.out, text: text! }
          const count = sliceToStep(await read($, events), null, Date.now()).steps.length
          const prior = await shared($)
          const next = reduceSharedView(prior, intent, count)
          await guard()
          await setShared($, next)
          if (intent.kind === 'follow' && !prior.zoomed && next.zoomed) await update($, cameraA, () => null)
          if (timerEffect(intent) !== 'none') syncReplayClock($, next.play.playing)
        })
        break
      }
      case 'lang':
        await serial(async () => { await guard(); await $.store.set('lang', command.lang); await update($, langA, () => command.lang) }); break
      case 'clear-trail':
        await serial(async () => { await guard(); await clearTrailState($) }); break
      case 'compact': {
        const result = await $.session.compact({}).catch(() => undefined)
        const outcome = result === undefined ? { kind: 'failed' as const } : 'skip' in result && result.skip !== undefined ? { kind: 'skipped' as const, reason: result.skip } : { kind: 'done' as const }
        await publish($)
        return { ok: true, outcome }
      }
      case 'refresh-meter': await refreshMeter($); break
      case 'retry-layout': failure = undefined; void load($).then(() => publish($)).catch(() => publish($)); break
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
        const result = await $.model.fork({ prompt: coachPrompt(lang, file, 'Claude') }).catch((err: unknown) => ({ isAnswered: false as const, reason: String(err) }))
        await serial(async () => {
          await guard()
          if (operation !== coachOperation) throw new Error('stale-generation')
          if (result.isAnswered) await update($, coachA, () => coachDone(result.text, Date.now()))
          else await update($, coachA, coachFailed('reason' in result ? String(result.reason) : 'unknown', strings(lang, 'Claude')))
        })
        break
      }
      case 'coach-apply': {
        const lang = await read($, langA), coach = await read($, coachA)
        const root = I?.root ?? await rootDir($)
        const file = await $.fs.exists(`${root}/AGENTS.md`).catch(() => false) ? 'AGENTS.md' : 'CLAUDE.md'
        if (!coach.patch) return { ok: false, error: 'invalid' }
        await guard()
        const filled = (await $.prompt.fill({ text: strings(lang, 'Claude').applyPrompt(file, coach.patch) }).catch(() => undefined)) !== undefined
        return { ok: true, filled }
      }
    }
    await publish($)
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
  if (reopen) { appsEpoch++; appsLoading = false; appDiscovery = undefined; appsFailed = false }
  if (relay?.isClosed()) {
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
          execute: <C extends HostCommand,>(g: number, c: C) => {
            if (c.kind === 'clear-trail' && g === generation) { invalidateTrail($); g = generation }
            return executeCommand($, g, c) as Promise<CommandReplies[C['kind']] | CommandRefusal>
          },
          subscribe: listener => { feedListeners.add(listener); return () => { feedListeners.delete(listener) } },
        }
        const binary = await relayBinary($)
        const client = await startRelay(relayIO($, owner => owner === generation), binary, `${$.plugin.root}/hosts/browser/dist`, feed)
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
const open3d = async ($: EngineInterface) => {
  const client = await ensureRelay($, true)
  await installedApps($)
  await publish($)
  await checkSession($)
  await client.openBrowser(generation)
  return true
}
const openPane = async ($: EngineInterface) => {
  if ((await $.session.surfaces()).length === 0) return false
  const r = await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
  opened ||= r !== undefined
  return r !== undefined
}
const el = <P extends ViewProps>(tag: ViewTag<P, RenderElement>, props: P | null, ...children: ViewChild<RenderElement>[]): RenderElement => {
  const node = h(tag, props, ...children)
  if (node === null || node === undefined || typeof node === 'string') throw new TypeError('Brain Trail: constructor returned no element')
  return node
}
const nativeRuntime = (ui: ElementTable, hitBox?: { box: string; reach: number }): ViewRuntime<RenderElement, UiPressArgument> => ({
  h: el, Box: ui.Box, Text: ui.Text, Button: ui.Button, Input: ui.Input, Link: ui.Link,
  Svg: 'Svg' in ui ? ui.Svg : undefined,
  Markdown: 'Markdown' in ui ? ui.Markdown : undefined,
  Code: 'Code' in ui ? ui.Code : undefined,
  Measure: 'Client' in ui ? props => <ui.Client key={`${props.kind}-probe`} module="./measure.tsx" props={props} width={0} height="100%" /> : undefined,
  MapHit: 'Client' in ui ? () => <ui.Client key="map-hit" module="./hit.tsx" props={{ tip: null, ...hitBox }} width="100%" height="100%" /> : undefined,
})
const nativeActions = ($: EngineInterface, snap: ViewSnapshot): ViewActions<UiPressArgument> => ({
  scrollBody: to => moveBody($, to),
  intent: i => nativeIntent($, i).catch(error => { void $.ui.toast(`Brain Trail: ${String(error)}`) }),
  openFile: ref => openFile($, ref.p, ref.out ? true : undefined).catch(error => { void $.ui.toast(`Brain Trail: ${String(error)}`) }),
  openIn: async (ref, app) => {
    try {
      await ensureRelay($); await checkSession($)
      const expected = generation
      const launch = await secureFile($, expected, ref, { kind: 'open', app }, (client, id) => client.openFile(id, app === 'default' ? undefined : app, expected))
      void $.ui.toast(`Brain Trail: Launch ${launch.status}.`)
    } catch (error) { void $.ui.toast(`Brain Trail: ${String(error)}`) }
  },
  copy: (text, press) => $.ui.copy({ text, surface: press.surface }).then(r => r !== undefined, () => false),
  toast: text => { void $.ui.toast(text) },
  compact: async () => {
    const result = await $.session.compact({}).catch(() => undefined)
    return result === undefined ? { kind: 'failed' } : 'skip' in result && result.skip !== undefined ? { kind: 'skipped', reason: result.skip } : { kind: 'done' }
  },
  refreshMeter: () => refreshMeter($).then(() => publish($)).catch(() => {}),
  saveSettings: patch => serial(async () => {
    const next = applySettingsPatch(await read($, settingsA), patch)
    await $.store.set('settings', next)
    await update($, settingsA, () => next)
    queuePublish($)
  }),
  setLang: lang => serial(async () => { await $.store.set('lang', lang); await update($, langA, () => lang); queuePublish($) }),
  clearTrail: () => { invalidateTrail($); return serial(async () => { await clearTrailState($); queuePublish($) }) },
  retryLayout: () => { failure = undefined; void load($).catch(() => {}) },
  open3d: () => open3d($).catch(error => { void $.ui.toast(`Brain Trail: ${String(error)}`); return false }),
  analyseCoach: async (lang, file) => {
    await checkSession($)
    const expected = generation
    const operation = await serial(async () => {
      await checkSession($)
      if (expected !== generation || (await read($, coachA)).busy) return undefined
      if (expected !== generation) return undefined
      const accepted = ++coachOperation
      await update($, coachA, coachBusy); queuePublish($)
      return accepted
    })
    if (operation === undefined) return
    const result = await $.model.fork({ prompt: coachPrompt(lang, file, snap.assistant) }).catch((err: unknown) => ({ isAnswered: false as const, reason: String(err) }))
    await serial(async () => {
      await checkSession($)
      if (expected !== generation || operation !== coachOperation) return
      if (result.isAnswered) await update($, coachA, () => coachDone(result.text, Date.now()))
      else await update($, coachA, coachFailed('reason' in result ? String(result.reason) : 'unknown', strings(lang, snap.assistant)))
      queuePublish($)
    })
  },
  applyCoach: async (file, patch) => (await $.prompt.fill({ text: strings(snap.lang, snap.assistant).applyPrompt(file, patch) }).catch(() => undefined)) !== undefined,
})

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false
  const defaultLang: Lang = options.language === 'fr' ? 'fr' : 'en'

  on('session.start', async ($, e, next) => {
    generation++; revision = 0; sessionId = await $.session.id(); lastLayout = undefined; breakdown = undefined
    invalidateCoach($)
    syncReplayClock($, false)
    resetApps()
    browserPreview = undefined
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
    await $.command.register({ name: COMMAND, description: 'Show what this session puts in its context, in a pane' })
    const saved = await $.store.get('lang').catch(() => undefined)
    await update($, langA, () => (saved === 'fr' || saved === 'en' ? saved : defaultLang))
    const savedSet = await $.store.get('settings').catch(() => undefined) as Partial<TrailSettings> | undefined
    const vault = await $.fs.exists(`${await mapRoot($)}/.obsidian`).catch(() => false)
    await update($, settingsA, () => initialSettings(vault, savedSet))
    void load($).catch(() => {})
    meterTimer?.cancel()
    meterTimer = $.clock.every(4000, () => { void refreshMeter($).then(() => publish($)).catch(() => {}) })
    if (autoOpen) await openPane($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    generation++
    invalidateCoach($)
    relay?.close(); relay = undefined; startingRelay = undefined
    resetApps()
    syncReplayClock($, false)
    meterTimer?.cancel(); meterTimer = undefined
    feedListeners.clear(); currentFeed = undefined; sessionId = undefined
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (autoOpen && !opened) await openPane($)
    return attached
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'clear' }, async ($, e, next) => {
    generation++; revision = 0; lastLayout = undefined; browserPreview = undefined; breakdown = undefined
    invalidateCoach($)
    syncReplayClock($, false)
    const result = await next(e)
    sessionId = await $.session.id()
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
    queuePublish($)
    return result
  })

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
    const at = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const tool = String(e.tool)
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
    if (e.element === 'header-probe' || e.element === 'footer-probe') {
      const data = e.data as { kind?: string; stamp?: string; rows?: number }
      if (measuredChrome === undefined || data.stamp !== measuredChrome.stamp || data.kind !== e.element.replace('-probe', '') || typeof data.rows !== 'number' || !Number.isSafeInteger(data.rows) || data.rows <= 0) return {}
      if (data.kind === 'header') {
        measuredChrome.header = data.rows
        if (data.rows >= measuredChrome.headerReach) measuredChrome.headerReach = Math.max(data.rows + 1, measuredChrome.headerReach * 2)
      } else {
        measuredChrome.footer = data.rows
        if (data.rows >= measuredChrome.footerReach) measuredChrome.footerReach = Math.max(data.rows + 1, measuredChrome.footerReach * 2)
      }
      $.ui.invalidate('ui.render')
      return {}
    }
    if (e.element === 'viewport-probe' || e.element === 'content-probe') {
      const data = e.data as { kind?: string; stamp?: string; rows?: number }
      if (bodyWindow === undefined || data.stamp !== bodyWindow.stamp || data.kind !== e.element.replace('-probe', '') || typeof data.rows !== 'number' || !Number.isFinite(data.rows) || data.rows <= 0) return {}
      const rows = Math.floor(data.rows)
      if (data.kind === 'viewport') bodyWindow.viewport = rows
      else {
        bodyWindow.measured = rows
        if (rows >= bodyWindow.reach) bodyWindow.reach = Math.max(bodyWindow.reach * 2, rows + 1)
      }
      $.ui.invalidate('ui.render')
      return {}
    }
    if (e.element !== 'map-hit') return next(e)
    if (e.surface === 'desktop' && !mapVisible) return {}
    const laid = parseBox(e.data)
    if (laid !== undefined) {
      if (e.surface !== 'desktop' || laid.for !== hitBoxes.get(e.surface)?.box) return {}
      const chrome = { columns: laid.pane.columns - laid.columns, rows: laid.pane.rows - laid.rows }
      if (laid.pane.columns !== mapChrome?.columns || chrome.columns !== mapChrome?.chrome.columns || chrome.rows !== mapChrome?.chrome.rows) {
        mapChrome = { columns: laid.pane.columns, chrome }
        $.ui.invalidate('ui.render')
      }
      return {}
    }
    const state = { view3d: await read($, view3dA), zoomed: await read($, zoomed), cam3d: await read($, cam3dA) }
    const settings = await read($, settingsA)
    const now = await $.clock.now()
    const result = mapGesture(parseGesture(e.data), state, gesture, drawnFrames(), { now, hoverNames: settings.hover })
    gesture = result.memory
    await serial(async () => {
      let sharedChanged = false
      for (const step of result.steps) {
        if (step.key === 'zoomed') {
          const prior = await read($, zoomed), nextZoomed = step.next(prior)
          if (nextZoomed !== prior) { await update($, zoomed, () => nextZoomed); sharedChanged = true }
        } else await applyStep($, step)
      }
      if (sharedChanged) queuePublish($)
    })
    if (result.open !== undefined) void openFile($, result.open.p, result.open.out ? true : undefined).catch(error => { void $.ui.toast(`Brain Trail: ${String(error)}`) })
    const hitBox = hitBoxes.get(e.surface)
    return { props: { tip: result.tip, ...hitBox } }
  }).catch(($, e, next) => next(e))

  // the wheel over the map zooms it, around the pointer in 2D; elsewhere in the pane it scrolls as usual
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && e.by !== 0 && bodyWindow !== undefined && e.contentRows === e.bodyRows && e.bodyRows === bodyWindow.paneRows && (await read($, tabA)) === bodyWindow.tab) {
      const by = Math.abs(e.by) >= e.bodyRows ? Math.sign(e.by) * Math.max(1, bodyWindow.viewport) : e.by
      moveBody($, by)
      return {}
    }
    if (!mapVisible || e.origin.kind !== 'person' || e.pointer === undefined || gesture.hover === undefined || e.by === 0) return next(e)
    if ((await read($, tabA)) !== 'map') return next(e)
    await serial(async () => {
      const steps = mapWheel(e.by, await read($, view3dA), gesture.hover!, drawnFrames())
      let sharedChanged = false
      for (const step of steps) {
        if (step.key === 'zoomed') {
          const prior = await read($, zoomed), nextZoomed = step.next(prior)
          if (nextZoomed !== prior) { await update($, zoomed, () => nextZoomed); sharedChanged = true }
        } else await applyStep($, step)
      }
      if (sharedChanged) queuePublish($)
    })
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
    const now = await $.clock.now()
    const lang = await read($, langA)
    const tab = await read($, tabA)
    const paletteValue = await palette($, now)
    const meterValue = await read($, meter)
    const list = await read($, events)
    void load($).catch(() => {})
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 48
    const widthPx = paneWidthPx(columns)
    const open = await read($, openA)
    const fold = (): FoldFacts => ({ index: I, linked, connected })
    let body: TabSnapshot
    if (tab === 'context') {
      const breakdown = await getBreakdown($, now)
      const history = await costHistory($)
      const settings = await read($, settingsA)
      body = { tab, breakdown, costHistory: history, settings }
    } else if (tab === 'files') {
      const breakdown = await getBreakdown($, now)
      await load($).catch(() => undefined)
      const ref = await read($, previewA)
      let preview: Extract<TabSnapshot, { tab: 'files' }>['preview'] = null
      if (ref !== null) {
        const text = browserPreview?.p === ref.p && browserPreview.out === !!ref.out ? browserPreview.text : undefined
        const settings = await read($, settingsA)
        discoverApps($)
        preview = { ref, text, settings, apps: apps ?? [], appsUnavailable: appsFailed }
      }
      body = { tab, breakdown, preview, fold: fold() }
    } else if (tab === 'map') {
      const L = layout, index = I
      if (L === undefined || index === undefined) {
        body = failure !== undefined ? { tab, kind: 'failed', message: failure } : { tab, kind: 'loading', seconds: packingSince ? Math.round((Date.now() - packingSince) / 1000) : 0 }
      } else {
        const isZoomed = await read($, zoomed)
        const camera = await read($, cameraA)
        const play = await read($, playA)
        await getBreakdown($, now)
        const view3d = await read($, view3dA)
        const cam3d = await read($, cam3dA)
        body = { tab, kind: 'ready', layout: L, shallow, fold: { index, linked, connected }, state: { zoomed: isZoomed, camera, play, view3d, cam3d: e.surface === 'desktop' ? cameraDuringGesture(cam3d, gesture) : cam3d } }
      }
    } else if (tab === 'goal') {
      body = { tab, connected }
    } else if (tab === 'coach') {
      const breakdown = await getBreakdown($, now)
      const coach = await read($, coachA)
      const root = I?.root ?? (await rootDir($))
      const instructionFile = (await $.fs.exists(`${root}/AGENTS.md`).catch(() => false)) ? 'AGENTS.md' : 'CLAUDE.md'
      body = { tab, breakdown, coach, instructionFile, fold: fold() }
    } else {
      const settings = await read($, settingsA)
      discoverApps($)
      body = { tab, settings, apps: apps ?? [], appsUnavailable: appsFailed }
    }
    const paneCells = { columns, rows: Math.max(0, e.props.scroll.bodyRows) }
    const chrome = mapChrome?.columns === columns ? mapChrome.chrome : guessChrome(columns)
    const mapBox = mapCells(paneCells, chrome)
    const mapAspect = cellAspect(mapBox)
    const fill = e.surface === 'desktop' && e.props.placement === 'dock'
    // The root's pane-height upper bound lets Desktop's flex holder shrink to
    // the allocated map; scrolling maps keep their natural height instead.
    const hitBox = fill ? { box: `${columns}x${paneCells.rows}/${mapBox.columns}x${mapBox.rows}`, reach: paneCells.rows } : undefined
    if (hitBox === undefined) hitBoxes.delete(e.surface)
    else hitBoxes.set(e.surface, hitBox)
    const dimensions = `${tab}/${columns}x${paneCells.rows}`
    if (fill && tab !== 'map') {
      if (bodyWindow?.dimensions !== dimensions) bodyWindow = { stamp: `${dimensions}/${++bodyGeneration}`, dimensions, paneRows: paneCells.rows, tab, offset: bodyWindow?.tab === tab ? bodyWindow.offset : 0, viewport: 0, measured: 0, reach: Math.max(1, paneCells.rows), end: bodyWindow?.tab === tab && bodyWindow.end }
    } else if (e.surface === 'desktop') bodyWindow = undefined
    const bodyFill = !fill || bodyWindow === undefined || tab === 'map' ? undefined : { stamp: bodyWindow.stamp, offset: visibleBodyOffset(), viewport: bodyWindow.viewport, content: bodyWindow.measured, reach: bodyWindow.reach }
    const chromeShape = JSON.stringify([columns, paneCells.rows, paneCells.rows < 24, tab, lang])
    if (fill && measuredChrome?.shape !== chromeShape) measuredChrome = { shape: chromeShape, stamp: `${++chromeGeneration}`, header: measuredChrome?.header ?? 0, footer: measuredChrome?.footer ?? 0, headerReach: Math.max(measuredChrome?.headerReach ?? 1, paneCells.rows), footerReach: Math.max(measuredChrome?.footerReach ?? 1, paneCells.rows) }
    const chromeFill = !fill || measuredChrome === undefined ? undefined : {
      stamp: measuredChrome.stamp, header: measuredChrome.header, footer: measuredChrome.footer,
      headerReach: measuredChrome.headerReach, footerReach: measuredChrome.footerReach,
      // Each measured height is rounded up; two root gaps occupy one compact row or two normal rows.
      notice: measuredChrome.header > 0 && measuredChrome.footer > 0
        ? measuredChrome.header + 1 + measuredChrome.footer + 1 + (paneCells.rows < 24 ? 1 : 2) >= paneCells.rows
        : paneCells.rows < 6,
    }
    const snap: ViewSnapshot = { now, widthPx, lang, assistant: 'Claude', costInfoCommand: '/cost', palette: paletteValue, meter: meterValue, events: list, open, body, ...(fill && { fill: { rows: paneCells.rows, mapAspect, body: bodyFill, chrome: chromeFill } }) }
    const out = renderPane(nativeRuntime(ui, hitBox), snap, nativeActions($, snap), maps)
    if (e.surface === 'desktop') {
      mapVisible = tab === 'map' && out.drawn !== undefined && chromeFill?.notice !== true
      if (!mapVisible) gesture = GESTURE0
    }
    if ('Client' in ui && 'Svg' in ui) {
      if (out.drawn?.kind === '2d') lastMap = { view: out.drawn.frame.view, L: out.drawn.frame.layout, touched: out.drawn.frame.touched }
      else if (out.drawn?.kind === '3d') lastSpin = { view: out.drawn.frame.view, L: out.drawn.frame.layout, touched: out.drawn.frame.touched }
    }
    return out.node
  })
}

const rank2 = (z: 'ok' | 'warn' | 'bad') => (z === 'ok' ? 0 : z === 'warn' ? 1 : 2)
