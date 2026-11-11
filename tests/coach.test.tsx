import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'brain-trail-v2', component: 'Pane', requestId: 'brain-trail-v2',
  props: { title: 'Brain Trail', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// a short request that made Claude search six times and read the same note three times
const EVENTS = [
  { k: 'prompt', text: 'Fais le point', at: 1 },
  ...Array.from({ length: 6 }, (_, i) => ({ k: 'act', tool: 'Grep', what: `q${i}`, at: 2 + i })),
  ...Array.from({ length: 3 }, (_, i) => ({ k: 'read', p: 'notes/a.md', at: 10 + i })),
  ...Array.from({ length: 3 }, (_, i) => ({ k: 'act', tool: 'Read', what: 'a.md', at: 10 + i })),
]

test('the coach turns the session into tips, and fills the prompt box to apply them', async ($, on) => {
  const filled: string[] = []
  on('state.get', (_: unknown, e: { key: string }, next: (e: unknown) => unknown) => {
    if (e.key === 'lang') return { value: { value: 'fr', version: 1 } }
    if (e.key === 'events') return { value: { value: { shape: 'events-1', value: EVENTS }, version: 1 } }
    if (e.key === 'meter') return { value: { value: { shape: 'meter-1', value: { tokens: 1, window: 200000, percent: 60 } }, version: 1 } }
    return next(e)
  })
  on('clock.now', () => ({ value: 10_000 })); on('config.list', () => ({ value: [] })); on('session.cwd', () => ({ value: '/w' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200000 } } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'notes/a.md\n', stderr: '', isStdoutTruncated: false } }))
  on('fs.read', () => ({ value: '' })); on('fs.exists', (_: unknown, e: { path: string }) => ({ value: String(e.path).endsWith('AGENTS.md') })); on('fs.write', () => ({ value: undefined })); on('ui.invalidate', () => ({ value: undefined }))
  on('model.fork', () => ({ value: { isAnswered: true, text: '## Tes demandes\nPrécise le format.\n## À ajouter à AGENTS.md\nVoici.\n```context\n- Les offres sont dans 01_COMPANY/Offer.\n```', usage: {} } }))
  on('prompt.fill', (_: unknown, e: { text: string }) => { filled.push(e.text); return { isFilled: true } })
  on('ui.toast', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 't-coach' })
  expect(await ui.find({ type: 'Text', text: /Claude a cherché 6 fois avant de trouver/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /a.md a été ouvert 3 fois/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /« Fais le point » a laissé Claude deviner/ })).toBeDefined()
  // no technical word in the tips
  expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeUndefined()
  await ui.press({ key: 'coach-run' })
  expect(await ui.find({ type: 'Text', text: /À AJOUTER À AGENTS.MD/ })).toBeDefined()
  await ui.press({ key: 'coach-apply' })
  expect(filled[0]).toContain('Ajoute ces lignes à AGENTS.md')
  expect(filled[0]).toContain('01_COMPANY/Offer')
  await ui.unmount()
})
