import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TrailEvent } from '../types'

const HOME = '/Users/me'
const VAULT = `${HOME}/vault`
const CWD = `${VAULT}/clients/acme`
const PANE = {
  plugin: 'brain-trail-v2',
  component: 'Pane',
  requestId: 'brain-trail-v2',
  props: {
    title: 'Brain Trail',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const FILES = [
  'notes/Plan.md',
  'notes/Ideas.md',
  'notes/Other.md',
  'notes/Secret.md',
  'clients/acme/brief.md',
]
const NOTES: Record<string, string> = { 'notes/Plan.md': 'See [[Ideas]]\n' }

type Run = { argv: string[]; cwd?: string }
const runs: Run[] = []
const outs: string[] = []

const altOf = (el: unknown) => {
  if (el === null || typeof el !== 'object' || !('props' in el)) return ''
  const props = el.props
  if (props === null || typeof props !== 'object' || !('alt' in props))
    return ''
  return typeof props.alt === 'string' ? props.alt : ''
}

const eventsOf = (raw: unknown): TrailEvent[] => {
  if (Array.isArray(raw)) return raw as TrailEvent[]
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'value' in raw &&
    Array.isArray(raw.value)
  )
    return raw.value as TrailEvent[]
  return []
}

const engine = (on: On) => {
  mock.clock(on, { now: 10_000 })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('config.list', () => ({
    value: [
      {
        key: 'theme',
        label: 'Theme',
        kind: 'choice',
        value: 'dark',
        provider: { plugin: 'engine', tier: 'core' },
        isLocked: false,
      },
    ],
  }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { window: 200000 } },
  }))
  on('fs.exists', (_$, e) => ({ value: e.path === `${VAULT}/.obsidian` }))
  on('fs.read', (_$, e) => {
    const rel = e.path.startsWith(`${VAULT}/`)
      ? e.path.slice(VAULT.length + 1)
      : ''
    return { value: NOTES[rel] ?? '' }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    runs.push({ argv, cwd: e.init?.cwd })
    const stdout =
      argv[0] === 'sh'
        ? HOME
        : argv[0] === 'find'
          ? FILES.map((p) => `./${p}`).join('\n')
          : ''
    return {
      value: {
        exitCode: argv[0] === 'sh' || argv[0] === 'find' ? 0 : 1,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', () => {
    const text = outs.shift() ?? ''
    return { result: text, text }
  })
}

const settled = (on: On, pred: (list: TrailEvent[]) => boolean) =>
  new Promise<TrailEvent[]>((resolve) => {
    on('state.set', async (_$, e, next) => {
      const applied = await next(e)
      if (e.key === 'events' && applied.value?.isSet && pred(eventsOf(e.value)))
        resolve(eventsOf(e.value))
      return applied
    })
  })

test('a tool call records a search, a connector, a read and a link, and a vault subfolder is the whole vault', async ($, on) => {
  engine(on)
  const ready = settled(on, (list) =>
    list.some((ev) => ev.k === 'read' && ev.p === 'notes/Secret.md'),
  )
  const call = async (
    input: Parameters<typeof $.tool.call>[0],
    text: string,
  ) => {
    outs.push(text)
    await $.tool.call(input)
  }
  await call(
    { tool: 'Read', file_path: `${VAULT}/notes/Plan.md` },
    'See [[Ideas]]\n',
  )
  await call({ tool: 'Bash', command: 'rg -l brief' }, 'brief.md\n')
  await call(
    { tool: 'mcp__notes__search', query: 'other' },
    `${VAULT}/notes/Other.md\n`,
  )
  await call({ tool: 'Bash', command: 'cd ../../notes' }, '')
  await call({ tool: 'Read', file_path: 'Secret.md' }, '# Secret\n')
  const events = await ready
  const found = runs.find((r) => r.argv[0] === 'find')
  expect(found?.cwd, 'find cwd is the vault').toBe(VAULT)
  expect(found?.argv.includes('-maxdepth'), 'vault find is not shallow').toBe(
    false,
  )
  expect(
    events.some(
      (ev) =>
        ev.k === 'seen' &&
        ev.via === 'link' &&
        ev.ps?.includes('notes/Ideas.md'),
    ),
    'wikilink seen',
  ).toBe(true)
  expect(
    events.some((ev) => ev.k === 'seen' && ev.ps?.includes('notes/Other.md')),
    'mcp absolute path seen',
  ).toBe(true)
  expect(
    events.some((ev) => ev.k === 'read' && ev.p === 'notes/Secret.md'),
    'relative read after cd',
  ).toBe(true)
  expect(
    events.some(
      (ev) => ev.k === 'seen' && ev.ps?.includes('clients/acme/brief.md'),
    ),
    'rg from cwd seen',
  ).toBe(true)

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const map = (await ui.findAll({ type: 'Svg' })).find((el) =>
    altOf(el).includes('files touched'),
  )
  expect(altOf(map)).toContain('vault:')
  expect(await ui.find({ key: 'play' })).toBeDefined()
  await ui.press({ key: 'play' })
  expect(await ui.find({ key: 'lg-btn-read', text: '1 read' })).toBeDefined()
  expect(await ui.find({ key: 'lg-mcp' })).toBeUndefined()
  await ui.press({ key: 't-files' })
  await ui.press({ key: 'kpi-open-read' })
  expect(await ui.find({ key: 'kd-open-notes/Plan.md' })).toBeDefined()
  expect(await ui.find({ key: 'kd-open-notes/Secret.md' })).toBeDefined()
  await ui.press({ key: 'kpi-open-linked' })
  expect(await ui.find({ key: 'kd-open-notes/Ideas.md' })).toBeDefined()
  await ui.press({ key: 'kpi-open-found' })
  expect(await ui.find({ key: 'kd-open-clients/acme/brief.md' })).toBeDefined()
  expect(await ui.find({ key: 'kd-open-notes/Other.md' })).toBeDefined()
  await ui.unmount()
})
