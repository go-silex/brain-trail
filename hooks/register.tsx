import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register, RenderElement, SessionContextBreakdown, UiPressArgument } from 'claude-code'

import type { Lang, Meter, TrailSettings, Tab, Totals, TrailEvent } from '../types/model'
import { MAX_SEEN, afterCd, describe, linksIn, makeIndex, pairKey, pathsIn, touchedBy } from './files'
import type { Index } from './files'
import { coachPrompt, strings } from './i18n'
import { DARK, LIGHT, createMapRenderer, packFiles } from './map'
import { isLocal, toolsByServer } from './mcp'
import { base3d, data3d, page3d } from './brain3d'
import { LOGOS } from './logos'
import { CAM0 } from './spin'
import type { Cam, SpinView } from './spin'
import type { Layout, Palette } from './map'
import { replay } from './fold'
import { assembleCapture, needsMcpScan, needsTouch } from './acts'
import { costStats, keepCosts, limitOf, usd, zoneOf } from './readout'
import type { CostEntry } from './readout'
import { appsArgv, appsIn, DEFAULT_SETTINGS, findArgv, fromFind, GIT_LS, hash, initialSettings, isShallow, openAttempts, pickFiles, vaultProbe } from './workspace'
import { absOf, cellAspect, coachBusy, coachDone, coachFailed, GESTURE0, guessChrome, mapCells, mapGesture, mapWheel, openTarget, paneWidthPx, parseBox, parseGesture, plan, replayTick, STEP_MS, timerEffect, type Cells } from './view-controller'
import type { Drawn2d, DrawnFrames, FoldFacts, Step, TabSnapshot, ViewActions, ViewChild, ViewIntent, ViewProps, ViewRuntime, ViewSnapshot, ViewTag } from '../types/view'
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
const folded = (list: readonly TrailEvent[]) => replay(list, I, linked, connected)

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
  const git = shallow ? undefined : await $.process.run(GIT_LS, { cwd: root, timeoutMs: 20000 }).catch(() => undefined)
  let raw = git !== undefined && git.exitCode === 0 ? git.stdout : ''
  if (raw === '') {
    const found = await $.process.run(findArgv(shallow), { cwd: root, timeoutMs: 30000 }).catch(() => undefined)
    raw = fromFind(found?.stdout ?? '')
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
let apps: string[] | undefined
const installedApps = async ($: EngineInterface) => {
  if (apps === undefined) {
    const h = await homeDir($)
    const r = await $.process.run(appsArgv(h)).catch(() => undefined)
    apps = appsIn(r?.stdout ?? '')
  }
  return apps
}

// opens a file with an app: Obsidian through its own link (a note of a vault opens in its vault), another app by name
const openWith = async ($: EngineInterface, abs: string, app: string) => {
  for (const argv of openAttempts(abs, app)) {
    const r = await $.process.run(argv).catch(() => undefined)
    if (r?.exitCode === 0) return
  }
}

const openFile = async ($: EngineInterface, p: string, out?: true) => {
  const target = openTarget(await read($, settingsA), I, { p, ...(out ? { out: true } : {}) })
  if (target.kind === 'preview') {
    await update($, previewA, () => target.ref)
    await update($, tabA, () => 'files')
    return
  }
  await openWith($, target.abs, target.app)
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
const nativeIntent = async ($: EngineInterface, intent: ViewIntent) => {
  const stop = () => { playTimer?.cancel(); playTimer = undefined }
  const effect = timerEffect(intent)
  if (effect !== 'none') stop()
  const now = intent.kind === 'turn-3d' || intent.kind === 'spin-3d' ? await $.clock.now() : 0
  for (const step of plan(intent, { now, frames: drawnFrames() })) await applyStep($, step)
  if (intent.kind === 'replay-play') {
    playTimer = $.clock.every(STEP_MS, () => {
      void update($, playA, p => {
        const next = replayTick(intent.steps)(p)
        if (!next.playing) stop()
        return next
      })
    })
  }
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
  await $.fs.write(`${live3d.dir}/data.js`, data3d(folded(list).trail, { v: key, logos: LOGOS, prompt: prompt?.k === 'prompt' ? prompt.text : undefined }))
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
  intent: i => nativeIntent($, i),
  openFile: ref => openFile($, ref.p, ref.out ? true : undefined),
  openIn: (ref, app) => openWith($, absOf(I, ref), app),
  copy: (text, press) => $.ui.copy({ text, surface: press.surface }).then(r => r !== undefined, () => false),
  toast: text => { void $.ui.toast(text) },
  compact: async () => {
    const result = await $.session.compact({}).catch(() => undefined)
    return result === undefined ? { kind: 'failed' } : 'skip' in result && result.skip !== undefined ? { kind: 'skipped', reason: result.skip } : { kind: 'done' }
  },
  refreshMeter: () => refreshMeter($).catch(() => {}),
  saveSettings: async next => { await update($, settingsA, () => next); await $.store.set('settings', next) },
  setLang: async lang => { await update($, langA, () => lang); await $.store.set('lang', lang) },
  clearTrail: async () => { await update($, events, () => []); await update($, totals, () => ({ steps: 0 })); await update($, playA, () => ({ step: null, playing: false })) },
  retryLayout: () => { failure = undefined; void load($).catch(() => {}) },
  open3d: () => open3d($).catch(() => false),
  analyseCoach: async (lang, file) => {
    await update($, coachA, coachBusy)
    const result = await $.model.fork({ prompt: coachPrompt(lang, file, snap.assistant) }).catch((err: unknown) => ({ isAnswered: false as const, reason: String(err) }))
    if (result.isAnswered) await update($, coachA, () => coachDone(result.text, Date.now()))
    else await update($, coachA, coachFailed('reason' in result ? String(result.reason) : 'unknown', strings(lang, snap.assistant)))
  },
  applyCoach: async (file, patch) => (await $.prompt.fill({ text: strings(snap.lang, snap.assistant).applyPrompt(file, patch) }).catch(() => undefined)) !== undefined,
})

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false
  const defaultLang: Lang = options.language === 'fr' ? 'fr' : 'en'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show what this session puts in its context, in a pane' })
    const saved = await $.store.get('lang').catch(() => undefined)
    await update($, langA, () => (saved === 'fr' || saved === 'en' ? saved : defaultLang))
    const savedSet = await $.store.get('settings').catch(() => undefined) as Partial<TrailSettings> | undefined
    const vault = await $.fs.exists(`${await mapRoot($)}/.obsidian`).catch(() => false)
    await update($, settingsA, () => initialSettings(vault, savedSet))
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
    for (const step of result.steps) await applyStep($, step)
    if (result.open !== undefined) void openFile($, result.open.p, result.open.out ? true : undefined)
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
    for (const step of mapWheel(e.by, await read($, view3dA), gesture.hover, drawnFrames())) await applyStep($, step)
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
        const text = await $.fs.read(absOf(I, ref)).catch(() => undefined)
        const settings = await read($, settingsA)
        const apps = await installedApps($)
        preview = { ref, text, settings, apps }
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
        body = { tab, kind: 'ready', layout: L, shallow, fold: { index, linked, connected }, state: { zoomed: isZoomed, camera, play, view3d, cam3d } }
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
      const apps = await installedApps($)
      body = { tab, settings, apps }
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
