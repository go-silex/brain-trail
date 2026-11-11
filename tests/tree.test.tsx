import { expect, test } from 'claude-code/testing'

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

const EVENTS = [
  { k: 'prompt', text: 'Point', at: 1 },
  { k: 'read', p: 'notes/a.md', at: 2 },
  { k: 'read', p: 'notes/deep/b.md', at: 3 },
  { k: 'write', p: 'src/app.ts', at: 4 },
  { k: 'hit', p: 'notes/c.md', at: 5 },
]

test('the files tab shows figures, the folders as a tree, and a file in the pane', async ($, on) => {
  on('state.get', (_$, e, next) => {
    if (e.key === 'lang') return { value: { value: 'fr', version: 1 } }
    if (e.key === 'events')
      return {
        value: { value: { shape: 'events-1', value: EVENTS }, version: 1 },
      }
    if (e.key === 'settings')
      return {
        value: {
          value: {
            shape: 'settings-1',
            value: { openMd: 'preview', openOther: 'default', hover: true },
          },
          version: 1,
        },
      }
    return next(e)
  })
  on('clock.now', () => ({ value: 10_000 }))
  on('config.list', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { window: 200000 } },
  }))
  on('process.run', (_$, e) => ({
    value: {
      exitCode: 0,
      stdout:
        e.argv[0] === 'git'
          ? 'notes/a.md\nnotes/deep/b.md\nnotes/c.md\nsrc/app.ts\n'
          : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.read', (_: unknown, e: { path: string }) => ({
    value: String(e.path).endsWith('a.md') ? '# Note A\n\nHello' : '',
  }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 't-files' })
  // the figures: 2 read, 1 written, 1 seen in a search
  expect(await ui.find({ type: 'Button', key: 'kpi-open-read' })).toBeDefined()
  // a figure opens the list of its files: the two notes read, not the file written
  await ui.press({ key: 'kpi-open-read' })
  expect(
    await ui.find({ type: 'Button', key: 'kd-open-notes/a.md' }),
  ).toBeDefined()
  expect(
    await ui.find({ type: 'Button', key: 'kd-open-notes/deep/b.md' }),
  ).toBeDefined()
  expect(
    await ui.find({ type: 'Button', key: 'kd-open-src/app.ts' }),
  ).toBeUndefined()
  // another figure replaces it
  await ui.press({ key: 'kpi-open-written' })
  expect(
    await ui.find({ type: 'Button', key: 'kd-open-src/app.ts' }),
  ).toBeDefined()
  expect(
    await ui.find({ type: 'Button', key: 'kd-open-notes/a.md' }),
  ).toBeUndefined()
  // pressed again, it closes
  await ui.press({ key: 'kpi-open-written' })
  expect(
    await ui.find({ type: 'Button', key: 'kd-open-src/app.ts' }),
  ).toBeUndefined()
  // the tree: folders, then their files
  expect(await ui.find({ type: 'Button', key: 'dir-notes' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'dir-notes/deep' })).toBeDefined()
  await ui.press({ key: 'open-notes/a.md' })
  // the settings say: preview in the pane, and the note's own text is what is drawn
  expect(await ui.find({ type: 'Button', key: 'preview-back' })).toBeDefined()
  expect(await ui.find({ text: /Hello/ })).toBeDefined()
  await ui.unmount()
})
