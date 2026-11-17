// One scenario, one fresh plugin module (parent copies this file and runs one
// wrapper per case). Capture waits on the listing operation, then redraws.
// Loading is the tree drawn while that operation is still held, not a discarded mount.
import type { On, RenderElement, UiCopyArgs } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'
import type { HostCommand } from '../../types/browser'

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
  ...SURFACES.map((surface) => ({
    ...band(surface, 'dark', 'en'),
    id: `band-meter-unavailable-${surface}-dark-en`,
    phase: 'meter-unavailable' as const,
  })),
]

export const viewCases: ViewCase[] = [
  // Native dashboard cases were retired; web cases still exercise the historical
  // browser capture against the new band entry without comparing unrelated trees.
  ...SURFACES.flatMap((surface) =>
    THEMES.flatMap((theme) => LANGS.map((lang) => band(surface, theme, lang))),
  ),
  // Four browser cases retain the complete theme/language matrix.
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
  { k: 'prompt', text: 'Check the final summary', at: 7_000 },
  { k: 'act', tool: 'Read', what: 'notes/b.md', at: 8_000 },
]

const SHAPES: Record<string, string> = {
  events: 'events-1',
  totals: 'totals-1',
  meter: 'meter-1',
  camera: 'camera-1',
  cam3d: 'cam3d-2',
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
  fixtureInput: unknown
  opened: string[][]
  logs: { text: string; to: 'transcript' | 'debug' }[]
  notices: string[]
  uiOpened: string[]
  waitForState: (
    predicate: (event: { key: string; value: unknown }) => boolean,
  ) => Promise<void>
  browserEvents: unknown[]
  browserReady: Promise<void>
  relayStarted: () => boolean
  preparedFiles: string[]
  attemptedFiles: string[]
  allowPreparedFile: (path: string) => void
  readFiles: string[]
  fileRead: Promise<void>
  filePrepared: Promise<void>
  command: (generation: number, command: HostCommand) => Promise<unknown>
  appCoach: (generation: number) => void
  cancelAppCoach: (generation: number) => void
  setForkResult: (text: string | null) => void
  promptFills: string[]
  copyCalls: UiCopyArgs[]
  setCopySuccess: (success: boolean) => void
  holdCopy: () => void
  copyStarted: Promise<void>
  releaseCopy: () => void
  setInvalidIndexCache: (enabled: boolean) => void
  setLinkResponse: (response: unknown) => void
  holdLink: () => void
  linkStarted: Promise<void>
  releaseLink: () => void
  disconnectRelay: () => void
  holdFork: () => void
  forkStarted: Promise<void>
  releaseFork: () => void
  holdPlayWrite: () => void
  playWriteBlocked: Promise<void>
  releasePlayWrite: () => void
  holdPreviewRead: () => void
  previewReadBlocked: Promise<void>
  releasePreviewRead: () => void
  langStored: Promise<void>
  listing: 'files' | 'empty'
  releaseList: () => void
  settled: () => Promise<void>
  forget: () => void
  seed: (key: string, value: unknown) => void
  setMemoryFiles: (paths: string[]) => void
  setAppCatalog: (apps: string[] | null) => void
  waitForAppRequests: (count: number) => Promise<void>
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
  if (cmd === 'git' && script === 'rev-parse')
    return {
      exitCode: 0,
      stdout: 'GIT_DIR\nGIT_WORK_TREE\nGIT_CONFIG\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }
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
  if ((cmd === 'env' && argv.includes('ls-files')) || cmd === 'find') {
    if (listing === 'empty')
      return {
        exitCode: cmd === 'env' ? 1 : 0,
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
  (argv[0] === 'env' && argv.includes('ls-files')) || argv[0] === 'find'

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
  const promptFills: string[] = []
  const copyCalls: UiCopyArgs[] = []
  let copySuccess = true
  let invalidIndexCache = false
  let copyHeld = false
  let resolveCopyStarted = () => {}
  let releaseCopy = () => {}
  const copyStarted = new Promise<void>((resolve) => {
    resolveCopyStarted = resolve
  })
  const copyGate = new Promise<void>((resolve) => {
    releaseCopy = resolve
  })
  let forkText: string | null = null
  const opened: string[][] = []
  const logs: { text: string; to: 'transcript' | 'debug' }[] = []
  const notices: string[] = []
  const uiOpened: string[] = []
  const stateWaiters: {
    predicate: (event: { key: string; value: unknown }) => boolean
    resolve: () => void
  }[] = []
  const browserEvents: unknown[] = []
  let appCatalog: string[] | null = []
  let appRequests = 0
  const appWaiters: { count: number; resolve: () => void }[] = []
  let relayStarted = false
  let resolveBrowserReady = () => {}
  const browserReady = new Promise<void>((resolve) => {
    resolveBrowserReady = resolve
  })
  const frames: string[] = []
  let wakeRelay = () => {}
  let relayEnded = false
  let commandId = 0
  const replies = new Map<string, (reply: unknown) => void>()
  let linkResponse: unknown
  let linkHeld = false
  let resolveLinkStarted = () => {}
  let releaseLink = () => {}
  const linkStarted = new Promise<void>((resolve) => {
    resolveLinkStarted = resolve
  })
  const linkGate = new Promise<void>((resolve) => {
    releaseLink = resolve
  })
  const sendFrame = (frame: string) => {
    frames.push(frame)
    wakeRelay()
  }
  const preparedFiles: string[] = []
  const attemptedFiles: string[] = []
  const allowedFiles = new Set<string>()
  let resolveFilePrepared = () => {}
  const filePrepared = new Promise<void>((resolve) => {
    resolveFilePrepared = resolve
  })
  const readFiles: string[] = []
  let resolveFileRead = () => {}
  const fileRead = new Promise<void>((resolve) => {
    resolveFileRead = resolve
  })
  const handles = new Map<string, string>()
  let forkHeld = false
  let resolveForkStarted = () => {}
  let releaseFork = () => {}
  const forkStarted = new Promise<void>((resolve) => {
    resolveForkStarted = resolve
  })
  const forkGate = new Promise<void>((resolve) => {
    releaseFork = resolve
  })
  let playWriteHeld = false
  let resolvePlayBlocked = () => {}
  let releasePlayWrite = () => {}
  const playWriteBlocked = new Promise<void>((resolve) => {
    resolvePlayBlocked = resolve
  })
  const playWriteGate = new Promise<void>((resolve) => {
    releasePlayWrite = resolve
  })
  let previewReadHeld = false
  let resolvePreviewBlocked = () => {}
  let releasePreviewRead = () => {}
  let resolveLangStored = () => {}
  const previewReadBlocked = new Promise<void>((resolve) => {
    resolvePreviewBlocked = resolve
  })
  const previewReadGate = new Promise<void>((resolve) => {
    releasePreviewRead = resolve
  })
  const langStored = new Promise<void>((resolve) => {
    resolveLangStored = resolve
  })
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
    if (e.key === 'preview' && previewReadHeld) {
      previewReadHeld = false
      resolvePreviewBlocked()
      await previewReadGate
    }
    const heldState = state.get(e.key)
    if (heldState === undefined)
      return { value: { value: undefined, version: 0 } }
    return { value: { value: heldState.value, version: heldState.version } }
  })
  on('state.set', async (_$, e, next) => {
    if (e.plugin !== 'brain-trail-v2') return next(e)
    if (e.key === 'play' && playWriteHeld) {
      playWriteHeld = false
      resolvePlayBlocked()
      await playWriteGate
    }
    const current = state.get(e.key)
    const version = current?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version)
      return { value: { isSet: false as const, version } }
    const nextVersion = version + 1
    state.set(e.key, { value: e.value, version: nextVersion })
    const forwarded = { ...e }
    delete forwarded.ifVersion
    await next(forwarded)
    for (let index = stateWaiters.length - 1; index >= 0; index--) {
      const waiter = stateWaiters[index]!
      if (waiter.predicate({ key: e.key, value: e.value })) {
        stateWaiters.splice(index, 1)
        waiter.resolve()
      }
    }
    return { value: { isSet: true as const, version: nextVersion } }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    if (e.key === 'lang') resolveLangStored()
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
  const usage = {
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
  }
  on('session.usage', () => usage)
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
    while (!relayEnded) {
      if (frames.length === 0)
        await new Promise<void>((resolve) => {
          wakeRelay = resolve
        })
      while (frames.length > 0)
        yield { stream: 'stdout' as const, text: frames.shift()! }
    }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e, next) => {
    if (!e.url.startsWith('http://localhost/h/')) return next(e)
    if (
      ![
        '/h/event',
        '/h/ready',
        '/h/reply',
        '/h/launch',
        '/h/generation',
        '/h/apps',
        '/h/app/approve',
        '/h/app/check',
        '/h/app/reply',
        '/h/app/revoke',
        '/h/file/prepare',
        '/h/file/read',
        '/h/file/open',
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
      open?: boolean
      link?: boolean
      body?: unknown
    }
    let response: unknown = { ok: true }
    if (e.url.endsWith('/h/app/check'))
      response = { v: 1, ok: true, value: { kind: 'operation' } }
    if (e.url.endsWith('/h/app/reply'))
      response = { v: 1, ok: true, value: null }
    if (e.url.endsWith('/h/app/approve')) {
      const body = request as unknown as {
        v: number
        owner: { host: string; sessionId: string }
        generation: number
        label: string
        approval: { kind: string; pairId: string }
      }
      if (
        body.v !== 1 ||
        body.owner?.host !== 'code' ||
        body.owner.sessionId !== 'synthetic-session' ||
        !Number.isSafeInteger(body.generation) ||
        body.generation < 1 ||
        typeof body.label !== 'string' ||
        body.approval?.kind !== 'chat' ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.approval.pairId)
      )
        throw new Error('Unexpected fixture app approval')
      const relay = {
        socket: '/tmp/brain-trail-fixture/relay.sock',
        relayId: 'A'.repeat(43),
      }
      const approval = { kind: 'chat', pairId: body.approval.pairId }
      const expiresAt = Date.now() + 60_000
      response = {
        v: 1,
        ok: true,
        value: {
          relay,
          approval,
          expiresAt,
          envelope: {
            v: 1,
            kind: 'chat',
            relay,
            pairId: approval.pairId,
            secret: 'A'.repeat(43),
            expiresAt,
          },
        },
      }
    }
    if (e.url.endsWith('/h/app/revoke')) {
      const body = request as unknown as {
        v?: unknown
        target?: {
          kind?: unknown
          owner?: { host?: unknown; sessionId?: unknown }
          generation?: unknown
        }
        reason?: unknown
      }
      const target = body.target
      if (
        JSON.stringify(Object.keys(body).sort()) !==
          JSON.stringify(['reason', 'target', 'v']) ||
        body.v !== 1 ||
        body.reason !== 'generation-ended' ||
        !target ||
        JSON.stringify(Object.keys(target).sort()) !==
          JSON.stringify(['generation', 'kind', 'owner']) ||
        target.kind !== 'generation' ||
        !target.owner ||
        JSON.stringify(Object.keys(target.owner).sort()) !==
          JSON.stringify(['host', 'sessionId']) ||
        target.owner.host !== 'code' ||
        target.owner.sessionId !== 'synthetic-session' ||
        !Number.isSafeInteger(target.generation) ||
        (target.generation as number) < 1
      )
        throw new Error('Unexpected fixture app revoke request')
      response = { v: 1, ok: true, value: null }
    }
    if (e.url.endsWith('/launch') && request.open === true)
      response = { ok: true, status: 'dispatched' }
    if (e.url.endsWith('/launch') && request.link === true) {
      resolveLinkStarted()
      if (linkHeld) await linkGate
      response = linkResponse ?? {
        ok: true,
        url: `http://127.0.0.1:4321/launch/${'a'.repeat(43)}`,
        expiresAt: Date.now() + 60_000,
      }
    }
    if (e.url.endsWith('/apps')) {
      appRequests++
      for (const waiter of appWaiters)
        if (appRequests >= waiter.count) waiter.resolve()
      response =
        appCatalog === null
          ? { ok: false, error: 'unsupported' }
          : { apps: appCatalog }
    }
    if (e.url.endsWith('/event')) browserEvents.push(request)
    if (e.url.endsWith('/reply') && request.id !== undefined) {
      replies.get(request.id)?.(request.body)
      replies.delete(request.id)
    }
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
      attemptedFiles.push(path)
      if (
        request.root !== CWD ||
        (!files.some((file) => path === `${CWD}/${file}`) &&
          !usage.value.context.breakdown.memoryFiles.some(
            (file) => file.path === path,
          ) &&
          !allowedFiles.has(path))
      )
        response = { ok: false, error: 'forbidden' }
      else {
        const id = String(handles.size + 1)
        handles.set(id, path)
        preparedFiles.push(path)
        resolveFilePrepared()
        response = { id, path, inside: path.startsWith(`${CWD}/`) }
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
    if (e.url.endsWith('/file/open'))
      response = handles.has(request.id ?? '')
        ? { ok: true, status: 'dispatched' }
        : { ok: false, error: 'forbidden' }
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
    value:
      invalidIndexCache && /\/layout-[^/]+\.json$/.test(e.path)
        ? JSON.stringify({ root: CWD, files: [null] })
        : e.path.endsWith('notes/a.md')
          ? NOTE_BODY
          : '',
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
  on('ui.log', (_$, e) => {
    logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    notices.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    uiOpened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.copy', async (_$, e) => {
    copyCalls.push({ text: e.text, surface: e.surface })
    resolveCopyStarted()
    if (copyHeld) await copyGate
    return {
      value: copySuccess
        ? { isCopied: true as const }
        : { isCopied: false as const, reason: 'refused' as const },
    }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('model.fork', async () => {
    resolveForkStarted()
    if (forkHeld) await forkGate
    return forkText === null
      ? {
          value: {
            isAnswered: false as const,
            reason: 'nothing-to-fork' as const,
          },
        }
      : {
          value: {
            isAnswered: true as const,
            text: forkText,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        }
  })
  on('prompt.fill', (_$, e) => {
    promptFills.push(e.text)
    return { isFilled: true }
  })

  const fixtureInput: unknown = JSON.parse(
    JSON.stringify({
      scenario,
      semantic,
      clock: NOW,
      cwd: CWD,
      home: HOME,
      files,
      noteBody: NOTE_BODY,
      listing: ctl.listing,
      state: Object.fromEntries(
        [...state].map(([key, heldState]) => [key, heldState.value]),
      ),
      store: Object.fromEntries(store),
      usage: usage.value,
    }),
  )
  return {
    clock,
    fixtureInput,
    writes,
    opened,
    logs,
    notices,
    uiOpened,
    waitForState: (predicate) =>
      new Promise<void>((resolve) => {
        stateWaiters.push({ predicate, resolve })
      }),
    browserEvents,
    copyCalls,
    setCopySuccess: (success) => {
      copySuccess = success
    },
    holdCopy: () => {
      copyHeld = true
    },
    copyStarted,
    releaseCopy,
    setInvalidIndexCache: (enabled) => {
      invalidIndexCache = enabled
    },
    browserReady,
    relayStarted: () => relayStarted,
    preparedFiles,
    attemptedFiles,
    allowPreparedFile: (path) => {
      allowedFiles.add(path)
    },
    readFiles,
    fileRead,
    filePrepared,
    command: (generation, command) =>
      new Promise((resolve) => {
        const id = String(++commandId)
        replies.set(id, resolve)
        sendFrame(
          `${JSON.stringify({ t: 'cmd', id, body: { v: 1, generation, command } })}\n`,
        )
      }),
    appCoach: (generation) => {
      const token = 'A'.repeat(43)
      const scope = {
        requestId: token,
        relayId: token,
        grantId: token,
        owner: { host: 'code', sessionId: 'synthetic-session' },
        generation,
        lease: { epoch: 1, id: token },
      }
      sendFrame(
        `${JSON.stringify({ v: 1, t: 'app-cmd', scope, request: { v: 1, generation, command: { kind: 'coach-analyse' } } })}\n`,
      )
    },
    cancelAppCoach: (generation) => {
      const token = 'A'.repeat(43)
      const scope = {
        requestId: token,
        relayId: token,
        grantId: token,
        owner: { host: 'code', sessionId: 'synthetic-session' },
        generation,
        lease: { epoch: 1, id: token },
      }
      sendFrame(`${JSON.stringify({ v: 1, t: 'app-cancel', scope })}\n`)
    },
    setForkResult: (text) => {
      forkText = text
    },
    promptFills,
    setLinkResponse: (response) => {
      linkResponse = response
    },
    holdLink: () => {
      linkHeld = true
    },
    linkStarted,
    releaseLink,
    disconnectRelay: () => {
      relayEnded = true
      wakeRelay()
    },
    holdFork: () => {
      forkHeld = true
    },
    forkStarted,
    releaseFork,
    holdPlayWrite: () => {
      playWriteHeld = true
    },
    playWriteBlocked,
    releasePlayWrite,
    holdPreviewRead: () => {
      previewReadHeld = true
    },
    previewReadBlocked,
    releasePreviewRead,
    setMemoryFiles: (paths) => {
      usage.value.context.breakdown.memoryFiles = paths.map((path) => ({
        path,
        type: 'Project' as const,
        tokens: 900,
      }))
    },
    setAppCatalog: (apps) => {
      appCatalog = apps
    },
    waitForAppRequests: (count) =>
      appRequests >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            appWaiters.push({ count, resolve })
          }),
    langStored,
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
  // Historical roots still render the native dashboard; the cutover root
  // renders a launcher and starts listing only when a link is requested.
  if (scenario.component === 'Pane' && hasKey(await ui.drawn(), 'launcher'))
    return
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
  candidate = false,
) => {
  const host = installHost(on, scenario, semantic)
  const actions: string[] = []
  const mounted =
    candidate && scenario.browser3d
      ? { ...scenario, component: 'AbovePrompt' as const }
      : scenario
  const ui = await $.ui.mount(mountTarget(mounted))
  await layoutChrome(mounted, ui)
  const launcher = candidate && scenario.component === 'Pane'
  if (host.copyCalls.length !== 0)
    throw new Error(
      `${scenario.id}: mounting copied without an explicit action`,
    )
  if (launcher) {
    if (scenario.browser3d) {
      await ui.press({ key: 'copy-browser-link' })
      actions.push('copy-browser-link')
      await host.browserReady
      const copied = host.copyCalls.slice()
      if (copied.length !== 1 || copied[0]?.surface !== scenario.surface)
        throw new Error(
          `${scenario.id}: explicit copy did not target the pressed surface`,
        )
      await ui.redraw()
    }
    const tree = await ui.drawn()
    if (JSON.stringify(tree).includes('/launch/'))
      throw new Error(`${scenario.id}: launcher rendered a capability URL`)
    return {
      id: scenario.id,
      fixture: { input: host.fixtureInput, actions },
      tree,
      svgs: svgsOf(tree),
      browserEvents: host.browserEvents,
      artifacts: artifactsOf(host.writes),
    }
  }
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
      fixture: { input: host.fixtureInput, actions },
      tree,
      svgs: svgsOf(tree),
      artifacts: artifactsOf(host.writes),
    }
  }
  await settleReady(scenario, host, ui)
  const press = async (key: string) => {
    await ui.press({ key })
    actions.push(key)
  }
  if (scenario.browser3d) await press('open-3d')
  if (scenario.browser3d && host.relayStarted()) await host.browserReady
  if (scenario.transition === 'follow') await press('follow')
  if (scenario.transition === 'replay') await press('play')
  if (scenario.phase === 'coach-error') await press('coach-run')
  if (
    scenario.browser3d ||
    scenario.transition !== 'none' ||
    scenario.phase === 'coach-error'
  )
    await ui.redraw()
  const tree = await ui.drawn()
  return {
    id: scenario.id,
    fixture: { input: host.fixtureInput, actions },
    tree,
    svgs: svgsOf(tree),
    browserEvents: host.browserEvents,
    artifacts: artifactsOf(host.writes),
  }
}

export const mountReady = async ($: Engine, on: On, scenario: ViewCase) => {
  const host = installHost(on, scenario)
  const ui = await $.ui.mount(
    mountTarget({ ...scenario, component: 'AbovePrompt' }),
  )
  await ui.redraw()
  return { ui, host }
}
