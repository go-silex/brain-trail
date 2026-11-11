import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'brain-trail-v2',
  component: 'Pane',
  requestId: 'brain-trail-v2',
  props: { title: 'Brain Trail', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The engine, with the map tab open; every other value goes to the kit's own state, so writes are read back.
const engine = (on: any) => {
  on('state.get', (_: unknown, e: { key: string }, next: (e: unknown) => unknown) => (e.key === 'tab' ? { value: { value: 'map', version: 1 } } : next(e)))
  on('clock.now', () => ({ value: 10_000 }))
  on('config.list', () => ({ value: [{ key: 'theme', value: 'dark' }] }))
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.id', () => ({ value: 's' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200000 } } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'CLAUDE.md\nsrc/app.ts\nnotes/a.md\nnotes/b.md\n' : '/Users/me', stderr: '', isStdoutTruncated: false } }))
  on('fs.read', () => ({ value: '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}

const viewBox = async (ui: any) => {
  const svgs = await ui.findAll({ type: 'Svg' })
  const map = svgs.find((s: any) => String(s.props?.alt ?? '').includes('files touched'))
  return /viewBox="([^"]+)"/.exec(String(map?.props?.source ?? ''))?.[1]
}

test('the + button zooms the map in', async ($, on) => {
  engine(on)
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = await viewBox(ui)
  expect(before).toBeDefined()
  await ui.press({ key: 'zoom-in' })
  const after = await viewBox(ui)
  expect(after).toBeDefined()
  expect(after).not.toBe(before)
  await ui.unmount()
})
