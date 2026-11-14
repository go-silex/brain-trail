import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TrailEvent } from '../types'

const HOME = '/Users/me'
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

const DEEP = Array.from({ length: 11_999 }, (_, i) => `d/f${i}.md`)
const FILES = ['kept.md', ...DEEP, 'a/b/deep.md']
const runs: { argv: string[]; cwd?: string }[] = []

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
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
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
  on('session.cwd', () => ({ value: HOME }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { window: 200000 } },
  }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
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
  on('tool.call', () => ({ result: '# note\n', text: '# note\n' }))
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

test('a session in the home folder lists only its first levels, and a large index keeps the shallowest files', async ($, on) => {
  engine(on)
  const ready = settled(on, (list) =>
    list.some(
      (ev) =>
        ev.k === 'cost' &&
        ev.tool === 'Read' &&
        ev.label === `${HOME}/a/b/deep.md`,
    ),
  )
  await $.tool.call({ tool: 'Read', file_path: `${HOME}/kept.md` })
  await $.tool.call({ tool: 'Read', file_path: `${HOME}/a/b/deep.md` })
  const events = await ready

  const found = runs.find((r) => r.argv[0] === 'find')
  expect(found?.cwd, 'find cwd is home').toBe(HOME)
  expect(found?.argv, 'home find argv').toContain('-maxdepth')
  const readOf = (p: string) =>
    events.some((ev) => ev.k === 'read' && ev.p === p)
  expect(readOf('kept.md'), 'kept.md read').toBe(true)
  expect(readOf('a/b/deep.md'), 'deep.md dropped from the capped index').toBe(
    false,
  )

  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /home folder/ })).toBeDefined()
  const map = (await ui.findAll({ type: 'Svg' })).find((el) =>
    altOf(el).includes('files touched'),
  )
  expect(altOf(map), 'map alt').toMatch(/me: \d+ files touched/)
  await ui.unmount()
})
