import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mountReady, mountTarget, type ViewCase } from './fixtures/views'

const desktop: ViewCase = {
  id: 'pane',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'ready',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

test('each tab draws a different body, and the terminal draws no Svg', async ($, on: On) => {
  const { ui } = await mountReady($, on, desktop)
  expect(await ui.find({ key: 'zoom-in' })).toBeDefined()
  await ui.press({ key: 't-goal' })
  await ui.redraw()
  expect(await ui.find({ key: 'zoom-in' })).toBeUndefined()
  await ui.press({ key: 't-files' })
  await ui.redraw()
  expect(await ui.find({ key: 'dir-notes' })).toBeDefined()
  await ui.press({ key: 't-coach' })
  await ui.redraw()
  expect(await ui.find({ key: 'coach-run' })).toBeDefined()
  await ui.press({ key: 'settings' })
  await ui.redraw()
  expect(await ui.find({ key: 'lang-en' })).toBeDefined()
  await ui.press({ key: 't-context' })
  await ui.redraw()
  expect(await ui.find({ key: 'lang-en' })).toBeUndefined()
  await ui.unmount()

  const term = await $.ui.mount(
    mountTarget({ ...desktop, id: 'pane-terminal', surface: 'terminal' }),
  )
  expect(await term.findAll({ type: 'Svg' })).toEqual([])
  expect((await term.drawn()).type).toBe('Box')
  await term.unmount()
})
