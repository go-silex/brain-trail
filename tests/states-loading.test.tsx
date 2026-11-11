import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource } from './fixtures/mounted'
import {
  installHost,
  isPacking,
  mountTarget,
  type ViewCase,
} from './fixtures/views'

const LOADING: ViewCase = {
  id: 'loading',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'loading',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

test('the map stays on the packing tree until the listing finishes, then draws', async ($, on: On) => {
  const host = installHost(on, LOADING)
  const ui = await $.ui.mount(mountTarget(LOADING))
  const held = await ui.drawn()
  expect(isPacking(held)).toBe(true)
  expect(await mapSource(ui)).toBeUndefined()
  host.releaseList()
  await host.settled()
  await ui.redraw()
  expect(await mapSource(ui)).toBeDefined()
  expect(isPacking(await ui.drawn())).toBe(false)
  await ui.unmount()
})
