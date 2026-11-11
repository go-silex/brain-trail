import { expect, test } from 'claude-code/testing'

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
  ],
}


// Each hook stands for the engine: a call on `$` is answered `{ value }`.
const written = new Map<string, string>()
const engine = (on: any, tab: string, ran: string[][] = []) => {
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('ui.toast', () => ({ value: undefined }))
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
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { written.set(e.path, e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}


test('the 3D button writes the page and the session next to the cache, and opens it', async ($, on) => {
  const ran: string[][] = []
  // the browser button sits on the 3D map
  STATE.view3d = true
  engine(on, 'map', ran)
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-3d' })
  const page = [...written.keys()].find(p => p.endsWith('/index.html'))
  const data = [...written.keys()].find(p => p.endsWith('/data.js'))
  expect(page).toMatch(/\/\.claude\/brain-trail-v2\/3d-[a-z0-9]+\/index\.html$/)
  expect(written.get(page!)).toContain('three@0.160.0')
  expect(written.get(page!)).toContain('notes/a.md')
  expect(written.get(data!)).toMatch(/^window\.BT_DATA=/)
  expect(ran.some(a => a[0] === 'open' && String(a[1]).endsWith('/index.html'))).toBe(true)
  await ui.unmount()
})
