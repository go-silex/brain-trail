import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { mountReady, type ViewCase } from './fixtures/views'

const MAP: ViewCase = {
  id: 'browser3d',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'ready',
  view3d: true,
  browser3d: false,
  transition: 'none',
}

test('opening the browser brain writes the page and the session, then opens that page', async ($, on: On) => {
  const { ui, host } = await mountReady($, on, MAP)
  await ui.press({ key: 'open-3d' })
  const page = host.writes.find((w) => w.path.endsWith('/index.html'))
  const data = host.writes.find((w) => w.path.endsWith('/data.js'))
  expect(page?.path).toMatch(
    /\/\.claude\/brain-trail-v2\/3d-[a-z0-9]+\/index\.html$/,
  )
  expect(page?.text).toContain('<!doctype html>')
  expect(page?.text).toContain('canvas')
  expect(page?.text).toContain('notes/a.md')
  expect(data?.text).toContain('window.BT_DATA=')
  expect(
    host.opened.some(
      (argv) =>
        argv[0] === 'open' && argv.some((part) => part.endsWith('/index.html')),
    ),
  ).toBe(true)
  await ui.unmount()
})
