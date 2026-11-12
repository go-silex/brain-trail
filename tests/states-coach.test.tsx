import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mountReady, type ViewCase } from './fixtures/views'

const COACH: ViewCase = {
  id: 'coach-error',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'coach',
  phase: 'coach-error',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

test('a refused analysis is drawn as an error, not a silent button', async ($, on: On) => {
  const { ui } = await mountReady($, on, COACH)
  await ui.press({ key: 'coach-run' })
  const texts = await ui.findAll({ type: 'Text' })
  expect(
    texts.some((el) => el.props.color === 'error' && el.text.length > 0),
  ).toBe(true)
  expect(await ui.find({ key: 'coach-run' })).toBeDefined()
  await ui.unmount()
})
