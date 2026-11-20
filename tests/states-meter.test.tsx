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

test('desktop browser opening remains available before the first context measurement', async ($, on: On) => {
  const { ui, host } = await mountReady($, on, scenario)
  try {
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    expect(await ui.find({ type: 'Button', key: 'open-browser' })).toBeDefined()
    expect(host.copyCalls).toEqual([])
    await ui.press({ key: 'open-browser' })
    await host.browserReady
    expect(host.copyCalls).toEqual([])
  } finally {
    host.disconnectRelay()
    await ui.unmount()
  }
})
