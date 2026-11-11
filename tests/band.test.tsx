import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'brain-trail-v2',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 8,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 8 },
    view: {},
  },
} as const

const engine = (on: On, percent: number, opened: string[] = []) => {
  // the meter and the language are set; every other value goes to the kit's own state
  on('state.get', (_, e, next) => {
    if (e.key === 'meter')
      return {
        value: {
          value: {
            shape: 'meter-1',
            value: {
              tokens: 1,
              window: 200000,
              percent,
              usd: 1.2,
              limits: [
                {
                  kind: 'five_hour',
                  percentUsed: 31,
                  resetsAt: '2026-11-09T17:39:00',
                },
                { kind: 'seven_day', percentUsed: 12 },
              ],
            },
          },
          version: 1,
        },
      }
    if (e.key === 'lang') return { value: { value: 'fr', version: 1 } }
    return next(e)
  })
  on('clock.now', () => ({ value: 10_000 }))
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
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the band shows the context and the cost, on the ${surface}`, async ($, on) => {
    engine(on, 42)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Contexte 42 %/ })).toBeDefined()
    expect(
      await ui.find({ type: 'Text', text: /session \$1\.20/ }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5 h 31 %/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /semaine 12 %/ })).toBeDefined()
    await ui.unmount()
  })
}

test('past three quarters, the band shows a storm and offers to change session', async ($, on) => {
  const opened: string[] = []
  engine(on, 82, opened)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'band-handoff' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⛈️ Contexte 82 %/ })).toBeDefined()
  await ui.press({ key: 'band-handoff' })
  expect(opened).toContain('brain-trail-v2')
  await ui.unmount()
})
