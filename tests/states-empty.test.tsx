import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const EMPTY: ViewCase = {
  id: 'empty',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'empty',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

test('a session with no events still draws the map, with the empty mark', async ($, on: On) => {
  const { ui } = await mountReady($, on, EMPTY)
  expect(await mapSource(ui)).toBeDefined()
  expect(await ui.find({ key: 'map-empty' })).toBeDefined()
  await ui.unmount()
})
