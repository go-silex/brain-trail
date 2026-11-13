// One scenario, one fresh plugin module (parent copies this file and runs one
// wrapper per case). Capture waits on the listing operation, then redraws.
// Loading is the tree drawn while that operation is still held, not a discarded mount.
import type { On, RenderElement } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

export const FILE_LIST = ['CLAUDE.md', 'notes/a.md', 'notes/b.md', 'src/app.ts']
export const NOTE_BODY = '# Note A\n\nSYNTHETIC_NOTE_BODY\n'
export const CWD = '/work/demo'
export const HOME = '/Users/me'
const NOW = 10_000

const TABS = ['map', 'goal', 'files', 'context', 'coach', 'settings'] as const
const THEMES = ['dark', 'light'] as const
const LANGS = ['en', 'fr'] as const
const SURFACES = ['desktop', 'terminal'] as const

export type ViewCase = {
  id: string
  component: 'Pane' | 'AbovePrompt'
  surface: 'desktop' | 'terminal'
  theme: 'dark' | 'light'
  lang: 'en' | 'fr'
  tab: (typeof TABS)[number]
  phase:
    | 'ready'
    | 'loading'
    | 'error'
    | 'empty'
    | 'meter-unavailable'
    | 'coach-error'
  view3d: boolean
  browser3d: boolean
  transition: 'none' | 'follow' | 'replay'
}

const pane = (
  tab: ViewCase['tab'],
  surface: ViewCase['surface'],
  theme: ViewCase['theme'],
  lang: ViewCase['lang'],
): ViewCase => ({
  id: `pane-${tab}-${surface}-${theme}-${lang}`,
  component: 'Pane',
  surface,
  theme,
  lang,
  tab,
  phase: 'ready',
  view3d: false,
  browser3d: false,
  transition: 'none',
})

const band = (
  surface: ViewCase['surface'],
  theme: ViewCase['theme'],
  lang: ViewCase['lang'],
): ViewCase => ({
  id: `band-${surface}-${theme}-${lang}`,
  component: 'AbovePrompt',
  surface,
  theme,
  lang,
  tab: 'map',
  phase: 'ready',
  view3d: false,
  browser3d: false,
  transition: 'none',
})

const inline3d = (
  theme: ViewCase['theme'],
  lang: ViewCase['lang'],
): ViewCase => ({
  id: `inline3d-desktop-${theme}-${lang}`,
  component: 'Pane',
  surface: 'desktop',
  theme,
  lang,
  tab: 'map',
  phase: 'ready',
  view3d: true,
  browser3d: false,
  transition: 'none',
})

const browser3d = (
  theme: ViewCase['theme'],
  lang: ViewCase['lang'],
): ViewCase => ({
  id: `browser3d-desktop-${theme}-${lang}`,
  component: 'Pane',
  surface: 'desktop',
  theme,
  lang,
  tab: 'map',
  phase: 'ready',
  view3d: true,
  browser3d: true,
  transition: 'none',
})

const targeted: ViewCase[] = [
  {
    id: 'pane-map-loading-desktop-dark-en',
    component: 'Pane',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'loading',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'pane-map-loading-terminal-dark-en',
    component: 'Pane',
    surface: 'terminal',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'loading',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'pane-map-error-desktop-dark-en',
    component: 'Pane',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'error',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'pane-map-empty-desktop-dark-en',
    component: 'Pane',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'empty',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'pane-meter-unavailable-desktop-dark-en',
    component: 'Pane',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'context',
    phase: 'meter-unavailable',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'band-meter-unavailable-desktop-dark-en',
    component: 'AbovePrompt',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'meter-unavailable',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'band-meter-unavailable-terminal-dark-en',
    component: 'AbovePrompt',
    surface: 'terminal',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'meter-unavailable',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'pane-coach-error-desktop-dark-en',
    component: 'Pane',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'coach',
    phase: 'coach-error',
    view3d: false,
    browser3d: false,
    transition: 'none',
  },
  {
    id: 'pane-map-follow-desktop-dark-en',
    component: 'Pane',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'ready',
    view3d: false,
    browser3d: false,
    transition: 'follow',
  },
  {
    id: 'pane-map-replay-desktop-dark-en',
    component: 'Pane',
    surface: 'desktop',
    theme: 'dark',
    lang: 'en',
    tab: 'map',
    phase: 'ready',
    view3d: false,
    browser3d: false,
    transition: 'replay',
  },
]

export const viewCases: ViewCase[] = [
  ...TABS.flatMap((tab) =>
    SURFACES.flatMap((surface) =>
      THEMES.flatMap((theme) =>
        LANGS.map((lang) => pane(tab, surface, theme, lang)),
      ),
    ),
  ),
  ...SURFACES.flatMap((surface) =>
    THEMES.flatMap((theme) => LANGS.map((lang) => band(surface, theme, lang))),
  ),
  ...THEMES.flatMap((theme) => LANGS.map((lang) => inline3d(theme, lang))),
  ...THEMES.flatMap((theme) => LANGS.map((lang) => browser3d(theme, lang))),
  ...targeted,
]

const ids = viewCases.map((c) => c.id)
if (new Set(ids).size !== ids.length) throw new Error('duplicate view case id')

const EVENTS = [
  { k: 'prompt', text: 'Summarise the notes', at: 1_000 },
  {
    k: 'plan',
    items: [
      { t: 'Read the note', s: 'completed' },
      { t: 'Write the summary', s: 'in_progress' },
    ],
    at: 1_500,
  },
  { k: 'read', p: 'notes/a.md', at: 2_000 },
  { k: 'act', tool: 'Read', what: 'notes/a.md', at: 2_000 },
  { k: 'write', p: 'src/app.ts', at: 3_000 },
  { k: 'act', tool: 'Edit', what: 'src/app.ts', at: 3_000 },
  { k: 'seen', ps: ['notes/b.md'], via: 'search', at: 4_000 },
  { k: 'mcp', server: 'linear', tool: 'list_issues', label: 'bugs', at: 5_000 },
  { k: 'done', at: 6_000 },
]

const SHAPES: Record<string, string> = {
  events: 'events-1',
  totals: 'totals-1',
  meter: 'meter-1',
  camera: 'camera-1',
  cam3d: 'cam3d-1',
  play: 'play-1',
  preview: 'preview-1',
  coach: 'coach-1',
  settings: 'settings-1',
}

const asHost = (key: string, value: unknown): unknown => {
  const shape = SHAPES[key]
  if (shape === undefined) return value
  if (
    value !== null &&
    typeof value === 'object' &&
    'shape' in value &&
    'value' in value &&
    value.shape === shape
  )
    return value
  return { shape, value }
}

const meterOf = (scenario: ViewCase) =>
  scenario.phase === 'meter-unavailable'
    ? { window: 200_000 }
    : {
        tokens: 84_000,
        window: 200_000,
        percent: 42,
        usd: 1.2,
        // Historical dates avoid today's special-case while retaining the
        // reviewed 2026 labels: the month, day and weekday are the same.
        limits: [
          {
            kind: 'five_hour',
            percentUsed: 31,
            resetsAt: '2020-11-09T17:39:00Z',
          },
          {
            kind: 'seven_day',
            percentUsed: 12,
            resetsAt: '2020-11-16T20:59:00Z',
          },
        ],
      }

const settingsOf = () => ({
  openMd: 'default',
  openOther: 'default',
  hover: true,
  band: true,
})

type Held = { value: unknown; version: number }

export type Host = {
  clock: MockClock
  writes: { path: string; text: string }[]
  opened: string[][]
  browserEvents: unknown[]
  browserReady: Promise<void>
  relayStarted: () => boolean
  preparedFiles: string[]
  readFiles: string[]
  fileRead: Promise<void>
  listing: 'files' | 'empty'
  releaseList: () => void
  settled: () => Promise<void>
  forget: () => void
  seed: (key: string, value: unknown) => void
  store: Map<string, unknown>
}

const runOf = (
  argv: readonly string[],
  listing: 'files' | 'empty',
  files: readonly string[],
): {
  exitCode: number
  stdout: string
  stderr: string
  isStdoutTruncated: false
  isStderrTruncated: false
} => {
  const cmd = argv[0] ?? ''
  const script = argv[1] ?? ''
  if (cmd === 'uname')
    return {
      exitCode: 0,
      stdout: 'Linux x86_64\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }
  if (cmd === 'sh' && script.includes('HOME'))
    return {
      exitCode: 0,
      stdout: HOME,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }
  if (cmd === 'sh')
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }
  if (cmd === 'git' || cmd === 'find') {
    if (listing === 'empty')
      return {
        exitCode: cmd === 'git' ? 1 : 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }
    return {
      exitCode: 0,
      stdout: `${files.join('\n')}\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }
  }
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  }
}

const isList = (argv: readonly string[]) =>
  argv[0] === 'git' || argv[0] === 'find'

export const installHost = (
  on: On,
  scenario: ViewCase,
  semantic = false,
): Host => {
  const clock = mock.clock(on, { now: NOW })
  const files = semantic ? [...FILE_LIST, 'notes/c.md'] : FILE_LIST
  const state = new Map<string, Held>()
  const store = new Map<string, unknown>()
  const writes: { path: string; text: string }[] = []
  const opened: string[][] = []
  const browserEvents: unknown[] = []
  let relayStarted = false
  let resolveBrowserReady = () => {}
  const browserReady = new Promise<void>((resolve) => {
    resolveBrowserReady = resolve
  })
  const holdRelay = new Promise<void>(() => {})
  const preparedFiles: string[] = []
  const readFiles: string[] = []
  let resolveFileRead = () => {}
  const fileRead = new Promise<void>((resolve) => {
    resolveFileRead = resolve
  })
  const handles = new Map<string, string>()
  const ctl = {
    listing:
      scenario.phase === 'error' ? ('empty' as const) : ('files' as const),
  }
  let packed = false
  let resolvePacked = () => {}
  const packedPromise = new Promise<void>((resolve) => {
    resolvePacked = resolve
  })
  const markPacked = () => {
    if (packed) return
    packed = true
    resolvePacked()
  }
  let releaseList = () => {}
  const held =
    scenario.phase === 'loading'
      ? new Promise<void>((resolve) => {
          releaseList = resolve
        })
      : Promise.resolve()

  const seed = (key: string, value: unknown) => {
    state.set(key, { value: asHost(key, value), version: 1 })
  }
  seed('tab', scenario.tab)
  seed('lang', scenario.lang)
  seed(
    'events',
    scenario.phase === 'empty'
      ? []
      : semantic
        ? [
            ...EVENTS,
            { k: 'read', p: 'notes/c.md', at: 2_500 },
            { k: 'seen', ps: ['CLAUDE.md'], via: 'link', at: 4_500 },
          ].sort((a, b) => a.at - b.at)
        : EVENTS,
  )
  seed('meter', meterOf(scenario))
  seed('settings', settingsOf())
  if (scenario.view3d) seed('view3d', true)
  store.set('lang', scenario.lang)
  store.set('settings', settingsOf())

  on('state.get', async (_$, e, next) => {
    if (e.plugin !== 'brain-trail-v2') return next(e)
    // The host subscribes the drawing on get. A later set redraws it only if this get reached the host.
    await next(e)
    const heldState = state.get(e.key)
    if (heldState === undefined)
      return { value: { value: undefined, version: 0 } }
    return { value: { value: heldState.value, version: heldState.version } }
  })
  on('state.set', async (_$, e, next) => {
    if (e.plugin !== 'brain-trail-v2') return next(e)
    const current = state.get(e.key)
    const version = current?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version)
      return { value: { isSet: false as const, version } }
    const nextVersion = version + 1
    state.set(e.key, { value: e.value, version: nextVersion })
    const forwarded = { ...e }
    delete forwarded.ifVersion
    await next(forwarded)
    return { value: { isSet: true as const, version: nextVersion } }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('config.list', () => ({
    value: [
      {
        key: 'theme',
        label: 'Theme',
        kind: 'choice' as const,
        value: scenario.theme,
        provider: { plugin: 'engine', tier: 'core' as const },
        isLocked: false,
      },
    ],
  }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'synthetic-session' }))
  on('session.surfaces', () => ({ value: [scenario.surface] }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 200_000,
        ...(scenario.phase === 'meter-unavailable'
          ? {}
          : { tokens: 84_000, percent: 42 }),
        breakdown: {
          categories: [
            {
              name: 'System prompt',
              tokens: 3000,
              color: 'x',
              isDeferred: false,
              kind: 'used' as const,
            },
            {
              name: 'Messages',
              tokens: 70_000,
              color: 'x',
              isDeferred: false,
              kind: 'used' as const,
            },
          ],
          totalTokens: 73_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          autocompactSource: 'auto' as const,
          percentage: 36,
          gridRows: [],
          model: 'synthetic',
          memoryFiles: [
            { path: `${CWD}/CLAUDE.md`, type: 'Project' as const, tokens: 900 },
          ],
          mcpTools: [
            {
              name: 'mcp__linear__list_issues',
              serverName: 'linear',
              tokens: 40,
              isLoaded: true,
            },
          ],
          agents: [],
          isAutoCompactEnabled: true,
          autoCompactThreshold: 180_000,
          apiUsage: null,
        },
      },
    },
  }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'open' || e.argv[0] === 'xdg-open')
      opened.push([...e.argv])
    if (isList(e.argv)) await held
    return { value: runOf(e.argv, ctl.listing, files) }
  })
  on('process.spawn', async function* (_$, e, next) {
    if (!e.argv[0]?.includes('brain-trail-relay')) return yield* next(e)
    relayStarted = true
    yield {
      stream: 'stdout' as const,
      text: '{"t":"hello","protocol":1,"socket":"/tmp/brain-trail-fixture/relay.sock"}\n',
    }
    if (scenario.browser3d)
      yield {
        stream: 'stdout' as const,
        text: '{"t":"clients","n":1,"seq":1}\n',
      }
    await holdRelay
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', (_$, e, next) => {
    if (!e.url.startsWith('http://localhost/h/')) return next(e)
    if (
      ![
        '/h/event',
        '/h/ready',
        '/h/launch',
        '/h/apps',
        '/h/file/prepare',
        '/h/file/read',
        '/h/file/verify',
        '/h/file/release',
      ].some((route) => e.url.endsWith(route))
    )
      throw new Error(`Unexpected fixture relay request: ${e.url}`)
    const request = JSON.parse(String(e.init?.body)) as {
      root?: string
      path?: string
      id?: string
      kind?: string
      seq?: number
    }
    let response: unknown = { ok: true }
    if (e.url.endsWith('/apps')) response = { apps: [] }
    if (e.url.endsWith('/event')) browserEvents.push(request)
    if (e.url.endsWith('/ready')) {
      const ready =
        scenario.browser3d &&
        request.seq === 1 &&
        browserEvents.some(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'kind' in event &&
            event.kind === 'snapshot',
        )
      response = { ok: ready }
      if (ready) resolveBrowserReady()
    }
    if (e.url.endsWith('/file/prepare')) {
      const path = request.path ?? ''
      if (
        request.root !== CWD ||
        !files.some((file) => path === `${CWD}/${file}`)
      )
        response = { ok: false, error: 'forbidden' }
      else {
        const id = String(handles.size + 1)
        handles.set(id, path)
        preparedFiles.push(path)
        response = { id, path, inside: true }
      }
    }
    if (e.url.endsWith('/file/read')) {
      const path = handles.get(request.id ?? '')
      if (!path) response = { ok: false, error: 'forbidden' }
      else {
        readFiles.push(path)
        resolveFileRead()
        response = { text: path.endsWith('/notes/a.md') ? NOTE_BODY : '' }
      }
    }
    if (e.url.endsWith('/file/verify') && !handles.has(request.id ?? ''))
      response = { ok: false, error: 'forbidden' }
    if (e.url.endsWith('/file/release')) handles.delete(request.id ?? '')
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify(response),
      },
    }
  })
  on('fs.read', (_$, e) => ({
    value: e.path.endsWith('notes/a.md') ? NOTE_BODY : '',
  }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.invalidate', (_$, e, next) => {
    if (e.event === 'ui.render') markPacked()
    return next(e)
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('model.fork', () => ({
    value: { isAnswered: false as const, reason: 'nothing-to-fork' as const },
  }))
  on('prompt.fill', () => ({ isFilled: true }))

  return {
    clock,
    writes,
    opened,
    browserEvents,
    browserReady,
    relayStarted: () => relayStarted,
    preparedFiles,
    readFiles,
    fileRead,
    get listing() {
      return ctl.listing
    },
    set listing(next) {
      ctl.listing = next
    },
    releaseList,
    settled: () => packedPromise,
    forget: () => {
      state.clear()
    },
    seed: (key, value) => {
      state.set(key, { value: asHost(key, value), version: 1 })
    },
    store,
  }
}

const paneProps = {
  title: 'Brain Trail',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}
const bandProps = {
  hasSurvey: false,
  isCollapsed: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
}

export const mountTarget = (scenario: ViewCase) =>
  scenario.component === 'Pane'
    ? {
        plugin: 'brain-trail-v2',
        component: 'Pane' as const,
        requestId: 'brain-trail-v2',
        surface: scenario.surface,
        props: paneProps,
      }
    : {
        plugin: 'brain-trail-v2',
        component: 'AbovePrompt' as const,
        requestId: 'band',
        surface: scenario.surface,
        props: bandProps,
        viewport: { columns: 80, rows: 8 },
      }

type Drawn = {
  type?: unknown
  key?: unknown
  text?: unknown
  props?: unknown
  children?: unknown
}

const walk = (node: unknown, visit: (el: Drawn) => void) => {
  if (node === null || typeof node !== 'object') return
  const el = node as Drawn
  visit(el)
  if (!Array.isArray(el.children)) return
  for (const child of el.children) walk(child, visit)
}

type Props = { key?: unknown; alt?: unknown; source?: unknown }
const propsOf = (el: Drawn): Props =>
  el.props !== null && typeof el.props === 'object' ? (el.props as Props) : {}

export const hasKey = (node: unknown, key: string) => {
  let found = false
  walk(node, (el) => {
    if (el.key === key || propsOf(el).key === key) found = true
  })
  return found
}

const texts = (node: unknown) => {
  const out: string[] = []
  walk(node, (el) => {
    if (typeof el.text === 'string') out.push(el.text)
    if (!Array.isArray(el.children)) return
    for (const child of el.children)
      if (typeof child === 'string') out.push(child)
  })
  return out.join('\n')
}

const viewBoxOf = (source: string) => /viewBox="([^"]+)"/.exec(source)?.[1]

const mapDrawn = (node: unknown) => {
  let found = false
  walk(node, (el) => {
    if (el.type !== 'Svg') return
    const alt = propsOf(el).alt
    const source = propsOf(el).source
    if (typeof alt !== 'string' || typeof source !== 'string') return
    if (alt.startsWith('Unkillable Companies')) return
    if (!alt.includes('files touched')) return
    if (viewBoxOf(source) === undefined) return
    found = true
  })
  return found
}

export const isPacking = (node: unknown) =>
  texts(node).includes('…') && !hasKey(node, 'retry') && !mapDrawn(node)

const svgsOf = (tree: RenderElement) => {
  const svgs: { alt: string; source: string }[] = []
  walk(tree, (el) => {
    const source = propsOf(el).source
    if (el.type !== 'Svg' || typeof source !== 'string') return
    const alt = propsOf(el).alt
    svgs.push({ alt: typeof alt === 'string' ? alt : '', source })
  })
  return svgs
}

const artifactsOf = (writes: { path: string; text: string }[]) =>
  writes
    .filter(
      (w) => w.path.endsWith('/index.html') || w.path.endsWith('/data.js'),
    )
    .map((w) => ({
      name: w.path.slice(w.path.lastIndexOf('/') + 1),
      text: w.text,
    }))
    .sort((a, z) => a.name.localeCompare(z.name))

const settleReady = async (
  scenario: ViewCase,
  host: Host,
  ui: { redraw: () => Promise<void>; drawn: () => Promise<RenderElement> },
) => {
  if (scenario.phase === 'loading') return
  // AbovePrompt never lists the folder. Only a Pane's render starts load, and load invalidates when packing ends.
  if (scenario.component === 'Pane') await host.settled()
  await ui.redraw()
  let tree = await ui.drawn()
  if (
    scenario.component === 'Pane' &&
    scenario.tab === 'map' &&
    scenario.phase !== 'error' &&
    isPacking(tree)
  ) {
    await host.settled()
    await ui.redraw()
    tree = await ui.drawn()
  }
  if (
    scenario.component === 'Pane' &&
    scenario.phase === 'ready' &&
    scenario.tab === 'map' &&
    scenario.surface === 'desktop' &&
    !mapDrawn(tree)
  ) {
    throw new Error(
      `${scenario.id}: map still absent after the listing barrier`,
    )
  }
  if (scenario.phase === 'error' && !hasKey(tree, 'retry')) {
    await ui.redraw()
    tree = await ui.drawn()
    if (!hasKey(tree, 'retry'))
      throw new Error(
        `${scenario.id}: pack error not drawn after the listing barrier`,
      )
  }
  return tree
}

// The test surface does not perform CSS layout. Start clients unmeasured, then
// give the chrome probes a small modeled region; later tests may resize them.
const layoutChrome = async (
  scenario: ViewCase,
  ui: {
    find: (query: { key: string }) => Promise<unknown>
    resize: (size: {
      columns: number
      rows: number
      in: string
    }) => Promise<void>
  },
) => {
  if (scenario.component !== 'Pane' || scenario.surface !== 'desktop') return
  if (await ui.find({ key: 'header-probe' }))
    await ui.resize({ columns: 0, rows: 4, in: 'header-probe' })
  if (await ui.find({ key: 'footer-probe' }))
    await ui.resize({ columns: 0, rows: 3, in: 'footer-probe' })
}

export const captureView = async (
  $: Engine,
  on: On,
  scenario: (typeof viewCases)[number],
  semantic = false,
) => {
  const host = installHost(on, scenario, semantic)
  const ui = await $.ui.mount(mountTarget(scenario))
  await layoutChrome(scenario, ui)
  if (scenario.phase === 'loading') {
    const tree = await ui.drawn()
    if (!isPacking(tree))
      throw new Error(
        `${scenario.id}: expected the packing tree while the listing was held`,
      )
    host.releaseList()
    await host.settled()
    return {
      id: scenario.id,
      tree,
      svgs: svgsOf(tree),
      artifacts: artifactsOf(host.writes),
    }
  }
  await settleReady(scenario, host, ui)
  if (scenario.browser3d) await ui.press({ key: 'open-3d' })
  if (scenario.browser3d && host.relayStarted()) await host.browserReady
  if (scenario.transition === 'follow') await ui.press({ key: 'follow' })
  if (scenario.transition === 'replay') await ui.press({ key: 'play' })
  if (scenario.phase === 'coach-error') await ui.press({ key: 'coach-run' })
  if (
    scenario.browser3d ||
    scenario.transition !== 'none' ||
    scenario.phase === 'coach-error'
  )
    await ui.redraw()
  const tree = await ui.drawn()
  return {
    id: scenario.id,
    tree,
    svgs: svgsOf(tree),
    browserEvents: host.browserEvents,
    artifacts: artifactsOf(host.writes),
  }
}

export const mountReady = async ($: Engine, on: On, scenario: ViewCase) => {
  const host = installHost(on, scenario)
  const ui = await $.ui.mount(mountTarget(scenario))
  await layoutChrome(scenario, ui)
  await settleReady(scenario, host, ui)
  return { ui, host }
}
