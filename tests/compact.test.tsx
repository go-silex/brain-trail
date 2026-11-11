import { expect, test } from 'claude-code/testing'

const PANE = { plugin: 'brain-trail-v2', component: 'Pane', requestId: 'brain-trail-v2', props: { title: 'Brain Trail', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

test('after a compaction, the gauge drops to the estimate instead of keeping the old figure', async ($, on) => {
  on('clock.now', () => ({ value: 10_000 }))
  on('config.list', () => ({ value: [{ key: 'theme', value: 'dark' }] }))
  on('session.surfaces', () => ({ value: [] }))
  on('ui.toast', () => ({ value: {} }))
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, breakdown: { totalTokens: 21000, mcpTools: [], memoryFiles: [], categories: [], skills: [], agents: [] } }, rateLimits: [] } }))
  const ctx = (percent?: number) => ({ context: { window: 200000, ...(percent !== undefined ? { tokens: percent * 2000, percent } : {}) }, rateLimits: [], changed: ['context'] }) as any
  await $.session.measure(ctx(62))
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /^62 %$/ })).toBeDefined()
  await ui.unmount()
  // the engine clears the fill on a compaction
  await $.session.measure(ctx(undefined))
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /≈ 11 %/ })).toBeDefined()
  await ui.unmount()
  // the next reply brings the real figure back
  await $.session.measure(ctx(14))
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /^14 %$/ })).toBeDefined()
  await ui.unmount()
})
