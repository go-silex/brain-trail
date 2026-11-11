import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'brain-trail-v2', component: 'Pane', requestId: 'brain-trail-v2',
  props: { title: 'Brain Trail', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const EVENTS = [
  { k: 'prompt', text: 'Prépare mon point de la semaine', at: 0 },
  { k: 'plan', items: [{ t: 'Lire les notes clés', s: 'completed' }, { t: "Consulter l'agenda", s: 'in_progress' }, { t: 'Résumer', s: 'pending' }], at: 1 },
  { k: 'act', tool: 'Read', what: 'Offer_Reference.md', at: 2 },
  { k: 'act', tool: 'Read', what: 'Decisions_Log.md', at: 3 },
  { k: 'act', tool: 'Grep', what: 'company brain', at: 4 },
  { k: 'act', tool: 'mcp__akiflow__get_schedule', what: '', at: 5 },
  { k: 'done', at: 180_000 },
  { k: 'prompt', text: 'Ajoute la décision au log', at: 190_000 },
  { k: 'act', tool: 'Edit', what: 'Decisions_Log.md', at: 195_000 },
]

test('the goal tab tells the session in plain words', async ($, on) => {
  on('state.get', (_: unknown, e: { key: string }, next: (e: unknown) => unknown) => {
    if (e.key === 'tab') return { value: { value: 'goal', version: 1 } }
    if (e.key === 'lang') return { value: { value: 'fr', version: 1 } }
    if (e.key === 'events') return { value: { value: { shape: 'events-1', value: EVENTS }, version: 1 } }
    return next(e)
  })
  on('clock.now', () => ({ value: 200_000 })); on('config.list', () => ({ value: [] })); on('session.cwd', () => ({ value: '/w' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'a.md\n', stderr: '', isStdoutTruncated: false } }))
  on('fs.read', () => ({ value: '' })); on('fs.exists', () => ({ value: false })); on('fs.write', () => ({ value: undefined })); on('ui.invalidate', () => ({ value: undefined }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the current goal is the last request, still at work; the history tells both, newest first
  expect(await ui.find({ type: 'Text', text: /En cours depuis moins d'une minute · 1 action/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^HISTORIQUE$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Prépare mon point de la semaine/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Met à jour « Decisions_Log.md »/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Objectifs précédents|OBJECTIFS PRÉCÉDENTS/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /PLAN DE CLAUDE · 1\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Lit 2 documents : « Offer_Reference.md », « Decisions_Log.md »/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cherche dans les documents : « company brain »/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Consulte Akiflow : get schedule/ })).toBeDefined()
  await ui.unmount()
})
