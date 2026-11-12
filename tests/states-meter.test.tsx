import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mountReady, mountTarget, type ViewCase } from './fixtures/views'

const METER: ViewCase = {
  id: 'meter',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'context',
  phase: 'meter-unavailable',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

test('a meter with no percent draws a dash and leaves the band to the host', async ($, on: On) => {
  const pane = await mountReady($, on, METER)
  expect(await pane.ui.find({ type: 'Text', text: '–' })).toBeDefined()
  expect(await pane.ui.find({ key: 'hdr-compact' })).toBeUndefined()
  const band = await $.ui.mount(
    mountTarget({ ...METER, id: 'band', component: 'AbovePrompt' }),
  )
  expect(await band.findAll({ type: 'Svg' })).toEqual([])
  expect(
    await band.find({ type: 'Button', key: 'band-handoff' }),
  ).toBeUndefined()
  await band.unmount()
  await pane.ui.unmount()
})
