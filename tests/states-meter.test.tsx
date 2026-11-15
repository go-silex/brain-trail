import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { mountReady, type ViewCase } from './fixtures/views'

const scenario: ViewCase = {
  id: 'meter-unavailable',
  component: 'AbovePrompt',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'context',
  phase: 'meter-unavailable',
  view3d: false,
  browser3d: true,
  transition: 'none',
}

test('desktop Copy remains available before the first context measurement', async ($, on: On) => {
  const { ui, host } = await mountReady($, on, scenario)
  try {
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    expect(
      await ui.find({ type: 'Button', key: 'copy-browser-link' }),
    ).toBeDefined()
    expect(host.copyCalls).toEqual([])
    await ui.press({ key: 'copy-browser-link' })
    await host.browserReady
    expect(host.copyCalls.length).toBe(1)
  } finally {
    host.disconnectRelay()
    await ui.unmount()
  }
})
