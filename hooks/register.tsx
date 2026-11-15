import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown, UiPressArgument } from 'claude-code'

import type { Lang, Meter, TrailSettings, Totals, TrailEvent } from '../types/model'
import { MAX_SEEN, afterCd, describe, linksIn, makeIndex, pairKey, pathsIn, touchedBy } from './files'
import type { Index } from './files'
import { coachPrompt, strings } from './i18n'
import { DARK, LIGHT, packFiles } from './map'
import { isLocal, toolsByServer } from './mcp'
import type { Layout, Palette } from './map'
import { sliceToStep } from './fold'
import { assembleCapture, needsMcpScan, needsTouch } from './acts'
import { costStats, keepCosts, limitOf, projectFiles, usd, zoneOf } from './readout'
import type { CostEntry } from './readout'
import { DEFAULT_SETTINGS, findArgv, fromFind, nativeGitInventoryArgv, hash, initialSettings, isShallow, pickFiles, vaultProbe, windowsSystemRoot } from './workspace'
import { coachBusy, coachDone, coachFailed, replayTick, STEP_MS, timerEffect } from './view-controller'
import type { DashboardFeed, FactsWire, HostCommand, CommandReplies, CommandRefusal, LayoutWire, ServerEvent } from '../types/browser'
import type { SharedView } from '../types/view'
import { reduceSharedView } from './view-controller'
import { RelayRefusal, startRelay, type RelayClient } from '../hosts/relay/client'
import { relayBinary, relayIO } from '../hosts/native/io'
import { withNativeFile } from '../hosts/native/files'
import { applySettingsPatch } from './view-settings'
import { weather } from './views'

const COMMAND = 'brain-trail-v2'
const PANE = 'brain-trail-v2'
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
let launchSite: string | undefined
let launchOperation = 0
let launchExpiry: { cancel: () => void } | undefined
const resetLaunch = ($: EngineInterface, redraw = true) => {
  const visible = launchBusy || launchError || launchCopied !== undefined
  launchOperation++
  launchCopied = undefined
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
    resetLaunch($)
    invalidateCoach($)
    resetApps()
    revision = 0
    lastLayout = undefined
    breakdown = undefined
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
  return withNativeFile(client, { root: I.root, generation: expected, refreshGeneration: () => checkSession($), currentGeneration: () => generation, known: candidate => knownRef($, candidate), apps: await installedApps($) }, ref, action, id => use(client, id))
}
const invalidateTrail = ($: EngineInterface) => {
  generation++; revision = 0; lastLayout = undefined; breakdown = undefined
  resetLaunch($)
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
        if (intent.kind === 'preview' && intent.ref !== null) {
          await secureFile($, expected, intent.ref, { kind: 'preview' }, (client, id) => client.readFile(id))
        }
        await serial(async () => {
          await guard()
          if (operation !== undefined && operation !== previewOperation) throw new Error('stale-generation')
          const count = sliceToStep(await read($, events), null, Date.now()).steps.length
          const prior = await shared($)
          const next = reduceSharedView(prior, intent, count)
          await guard()
          await setShared($, next)
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
          execute: <C extends HostCommand,>(g: number, c: C) => {
            if (c.kind === 'clear-trail' && g === generation) { invalidateTrail($); g = generation }
            return executeCommand($, g, c) as Promise<CommandReplies[C['kind']] | CommandRefusal>
          },
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
        const client = await startRelay(io, binary, `${$.plugin.root}/hosts/browser/dist`, feed)
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
const copyLink = async ($: EngineInterface, press: UiPressArgument) => {
  if (launchBusy) return
  const operation = ++launchOperation
  launchSite = JSON.stringify([press.component, press.requestId, press.surface])
  launchBusy = true
  launchError = false
  launchCopied = undefined
  launchExpiry?.cancel()
  launchExpiry = undefined
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
const closeOwnPane = async ($: EngineInterface) => {
  try {
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
    await $.ui.close({ id: PANE })
    if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
  } catch {}
  const fr = await read($, langA).then(lang => lang === 'fr', () => false)
  $.ui.toast(fr ? 'Fermez l’ancien panneau Brain Trail manuellement.' : 'Close the old Brain Trail pane manually.')
}

export const register: Register = (on, options) => {
  const defaultLang: Lang = options.language === 'fr' ? 'fr' : 'en'

  on('session.start', async ($, e, next) => {
    void closeOwnPane($)
    generation++; revision = 0; sessionId = await $.session.id(); lastLayout = undefined; breakdown = undefined
    resetLaunch($)
    invalidateCoach($)
    syncReplayClock($, false)
    resetApps()
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
    await $.command.register({ name: COMMAND, description: 'Open Brain Trail in a browser' })
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
    generation++; revision = 0; lastLayout = undefined; breakdown = undefined
    resetLaunch($)
    invalidateCoach($)
    syncReplayClock($, false)
    const result = await next(e)
    sessionId = await $.session.id()
    await setShared($, { preview: null, zoomed: false, play: { step: null, playing: false } })
    queuePublish($)
    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    void closeOwnPane($)
    const fr = (await read($, langA)) === 'fr'
    return { text: fr ? 'Dans Claude Desktop, copiez le lien, puis collez-le dans la barre d’adresse du navigateur, pas dans la conversation.' : 'In Claude Desktop, copy the link, then paste it into the browser address bar, not the conversation.' }
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
    const active = launchSite === JSON.stringify([e.component, e.requestId, e.surface])
    const copied = active && relay?.isClosed() === false && launchCopied?.generation === generation && launchCopied.expiresAt > Date.now()
    return (
      <Box flexDirection="row" alignItems="center" columnGap="sm" flexWrap="wrap">
        {pct !== undefined && P !== undefined && 'Svg' in ui && <ui.Svg key="band-gauge" source={miniGauge(P, pct)} width={64} height={8} alt={`${pct} %`} />}
        {pct !== undefined && <Text size="caption" weight={zone === 'ok' ? undefined : 'medium'} tabular>{weather(pct)} {S.bandContext(pct)}</Text>}
        {m.usd !== undefined && <Text size="caption" dimColor tabular>· {S.bandCost(usd(m.usd))}</Text>}
        {limitOf(m, 'five_hour') !== undefined && <Text size="caption" dimColor tabular>· {S.band5h(Math.round(limitOf(m, 'five_hour')!.percentUsed))}</Text>}
        {limitOf(m, 'seven_day') !== undefined && <Text size="caption" dimColor tabular>· {S.band7d(Math.round(limitOf(m, 'seven_day')!.percentUsed))}</Text>}
        <Box flexGrow={1} />
        {e.surface === 'desktop' && !launchBusy && <Button key="copy-browser-link" label={fr ? 'Copier le lien' : 'Copy link'} onPress={press => copyLink($, press)} />}
        {e.surface === 'desktop' && launchBusy && <Text size="caption">{fr ? 'Copie…' : 'Copying…'}</Text>}
        {active && launchError && <Text size="caption">{fr ? 'Échec de la copie, réessayez.' : 'Copy failed; try again.'}</Text>}
        {copied && <Text size="caption">{fr ? 'Copié : collez dans la barre d’adresse.' : 'Copied: paste into the address bar.'}</Text>}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== COMMAND || e.surface !== 'desktop') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const fr = (await read($, langA)) === 'fr'
    const active = launchSite === JSON.stringify([e.component, e.requestId, e.surface])
    const copied = active && relay?.isClosed() === false && launchCopied?.generation === generation && launchCopied.expiresAt > Date.now()
    return (
      <Box flexDirection="row" alignItems="center" columnGap="sm" flexWrap="wrap">
        <Text>{fr ? 'Collez le lien dans la barre d’adresse du navigateur, pas dans la conversation.' : 'Paste the link into the browser address bar, not the conversation.'}</Text>
        {!launchBusy && <Button key="copy-browser-link" label={fr ? 'Copier le lien' : 'Copy link'} onPress={press => copyLink($, press)} />}
        {launchBusy && <Text>{fr ? 'Copie…' : 'Copying…'}</Text>}
        {active && launchError && <Text>{fr ? 'Échec de la copie, réessayez.' : 'Copy failed; try again.'}</Text>}
        {copied && <Text>{fr ? 'Copié.' : 'Copied.'}</Text>}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}

const rank2 = (z: 'ok' | 'warn' | 'bad') => (z === 'ok' ? 0 : z === 'warn' ? 1 : 2)
