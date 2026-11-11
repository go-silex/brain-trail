import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'brain-trail-v2',
  component: 'Pane',
  requestId: 'brain-trail-v2',
  props: { title: 'Brain Trail', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const EVENTS = [
  { k: 'prompt', text: 'Fais le point', at: 1 },
  { k: 'read', p: 'notes/a.md', at: 2 },
  { k: 'read', p: 'notes/b.md', at: 3 },
  { k: 'mcp', server: 'linear', tool: 'list_issues', label: 'bugs', at: 4 },
]

const engine = (on: any) => {
  on('state.get', (_: unknown, e: { key: string }, next: (e: unknown) => unknown) => {
    if (e.key === 'tab') return { value: { value: 'map', version: 1 } }
    if (e.key === 'lang') return { value: { value: 'fr', version: 1 } }
    if (e.key === 'events') return { value: { value: { shape: 'events-1', value: EVENTS }, version: 1 } }
    return next(e)
  })
  on('clock.now', () => ({ value: 10_000 }))
  on('config.list', () => ({ value: [{ key: 'theme', value: 'dark' }] }))
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.id', () => ({ value: 's' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200000 } } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'notes/a.md\nnotes/b.md\nsrc/app.ts\n' : '/Users/me', stderr: '', isStdoutTruncated: false } }))
  on('fs.read', () => ({ value: '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}

test('the replay steps through the session, laid over the map', async ($, on) => {
  engine(on)
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // live: the play button and its label, nothing under the map
  expect(await ui.find({ type: 'Button', key: 'play' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fichier en cours|Dernier appel/ })).toBeUndefined()
  await ui.press({ key: 'play' })
  expect(await ui.find({ type: 'Text', text: /^1\/3$/ })).toBeDefined()
  await ui.press({ key: 'fwd' })
  expect(await ui.find({ type: 'Text', text: /^2\/3$/ })).toBeDefined()
  await ui.press({ key: 'live' })
  expect(await ui.find({ type: 'Button', key: 'play' })).toBeDefined()
  await ui.unmount()
})
