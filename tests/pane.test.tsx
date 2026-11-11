import { expect, test } from 'claude-code/testing'

import { packFiles, tilt } from '../hooks/map'

const PANE = {
  plugin: 'brain-trail-v2',
  component: 'Pane',
  requestId: 'brain-trail-v2',
  props: { title: 'Brain Trail', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const STATE: Record<string, unknown> = {
  meter: { tokens: 120000, window: 200000, percent: 60, limits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: '2026-11-09T17:39:00' }, { kind: 'seven_day', percentUsed: 31, resetsAt: '2026-11-16T20:59:00' }] },
  lang: 'fr',
  events: [
    { k: 'prompt', text: 'Fais le point', at: 1 },
    { k: 'read', p: '/elsewhere/notes.md', out: true, at: 2 },
    { k: 'cost', tool: 'Read', label: '/elsewhere/notes.md', tokens: 4200, at: 2 },
    { k: 'mcp', server: 'linear', tool: 'list_issues', label: 'bugs', at: 3 },
    { k: 'read', p: 'notes/a.md', at: 4 },
    { k: 'seen', ps: ['src/app.ts'], via: 'search', at: 5 },
    { k: 'seen', ps: ['CLAUDE.md'], via: 'link', at: 6 },
  ],
}


// Each hook stands for the engine: a call on `$` is answered `{ value }`.
const engine = (on: any, tab: string, ran: string[][] = []) => {
  on('state.get', (_: unknown, e: { key: string }) => {
    const SHAPES: Record<string, string> = { meter: 'meter-1', events: 'events-1' }
    const raw = e.key === 'tab' ? tab : STATE[e.key]
    const value = raw !== undefined && SHAPES[e.key] !== undefined ? { shape: SHAPES[e.key], value: raw } : raw
    return { value: value === undefined ? { version: 0 } : { value, version: 1 } }
  })
  on('clock.now', () => ({ value: 10_000 }))
  on('config.list', () => ({ value: [{ key: 'theme', value: 'dark' }] }))
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { tokens: 120000, window: 200000, percent: 60, breakdown: {
    categories: [
      { name: 'System prompt', tokens: 3000, color: 'x', isDeferred: false, kind: 'used' },
      { name: 'Memory files', tokens: 9000, color: 'x', isDeferred: false, kind: 'used' },
      { name: 'Messages', tokens: 100000, color: 'x', isDeferred: false, kind: 'used' },
    ],
    totalTokens: 112000, maxTokens: 200000, rawMaxTokens: 200000, autocompactSource: 'auto', percentage: 56, gridRows: [], model: 'm',
    memoryFiles: [{ path: '/work/demo/CLAUDE.md', type: 'Project', tokens: 9000 }],
    mcpTools: [{ name: 'mcp__linear__list_issues', serverName: 'linear', tokens: 400, isLoaded: true }],
    agents: [], isAutoCompactEnabled: true, autoCompactThreshold: 180000, apiUsage: null,
  } } } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => (ran.push(e.argv), { value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'CLAUDE.md\nsrc/app.ts\nnotes/a.md\n' : '/Users/me', stderr: '', isStdoutTruncated: false } }))
  on('fs.read', () => ({ value: '# A note' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}

for (const tab of ['context', 'files', 'map', 'goal', 'settings'] as const) {
  test(`the ${tab} tab draws on the desktop`, async ($, on) => {
    engine(on, tab)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Unkillable Companies ·/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /60 %/ })).toBeDefined()
    if (tab === 'context') expect(await ui.find({ type: 'Text', text: /Au-delà de la moitié/ })).toBeDefined()
    if (tab === 'files') expect(await ui.find({ type: 'Button', key: 'kpi-open-found' })).toBeDefined()
    if (tab === 'context') expect(await ui.find({ type: 'Text', text: /COÛT DE LA SESSION/ })).toBeDefined()
    if (tab === 'context') expect(await ui.find({ type: 'Text', text: /TON FORFAIT CLAUDE/ })).toBeDefined()
    if (tab === 'context') expect(await ui.find({ type: 'Text', text: /31 % utilisés/ })).toBeDefined()
    if (tab === 'settings') expect(await ui.find({ type: 'Text', text: /Notes Markdown/ })).toBeDefined()
    await ui.unmount()
  })
}

test('the pane also draws on the terminal, without the map', async ($, on) => {
  engine(on, 'map')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Unkillable Companies ·/ })).toBeDefined()
  await ui.unmount()
})

test('a click on a note of the 2D map opens it', async ($, on) => {
  const opened: string[][] = []
  STATE.view3d = false
  engine(on, 'map', opened)
  // the first drawing starts packing the folder; the map is there on the next one
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the same packing as the pane's, and the frame the pane drew, to know where the note is
  const L = packFiles(['CLAUDE.md', 'notes/a.md', 'src/app.ts'], 'demo')
  const map = (await ui.findAll({ type: 'Svg' })).find((el: any) => String(el.props?.alt ?? '').includes('files touched'))
  const [vx, vy, vw, vh] = String((map?.props as { source?: string })?.source).match(/viewBox="([^"]+)"/)![1]!.split(' ').map(Number) as [number, number, number, number]
  const [x, y] = tilt(L).files[1]!
  await ui.post({ kind: 'click', fx: (x - vx) / vw, fy: (y - vy) / vh }, { in: 'map-hit' })
  expect(opened.some(a => a[0] === 'open' && String(a.at(-1)).endsWith('/work/demo/notes/a.md'))).toBe(true)
  await ui.unmount()
  delete STATE.view3d
})

test('the map colours each way a file entered the context, and its legend counts them', async ($, on) => {
  STATE.view3d = false
  engine(on, 'map')
  // the first drawing starts packing the folder; the map is there on the next one
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const label of [/^1 lus$/, /^1 vus dans un résultat$/, /^1 vus par un lien$/]) {
    expect(await ui.find({ type: 'Button', label })).toBeDefined()
  }
  // read in blue, seen in a result in violet, seen through a link in teal
  const map = (await ui.findAll({ type: 'Svg' })).find((el: any) => String(el.props?.alt ?? '').includes('files touched'))
  const source = String((map?.props as { source?: string })?.source)
  for (const colour of ['#3b82f6', '#a78bfa', '#2dd4bf']) expect(source).toContain(colour)
  await ui.unmount()
  delete STATE.view3d
})
