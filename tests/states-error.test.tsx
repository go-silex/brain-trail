import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mapSource } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const ERROR: ViewCase = {
  id: 'error',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'error',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

test('a failed listing shows an error, and retry draws the map once files exist', async ($, on: On) => {
  const { ui, host } = await mountReady($, on, ERROR)
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(await mapSource(ui)).toBeUndefined()
  const failed = await ui.findAll({ type: 'Text' })
  expect(
    failed.some((el) => el.props.color === 'error' && el.text.length > 0),
  ).toBe(true)
  host.listing = 'files'
  await ui.press({ key: 'retry' })
  expect(await mapSource(ui)).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeUndefined()
  await ui.unmount()
})
