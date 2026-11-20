import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { latestSnapshot, mountCommandOutput } from './fixtures/mounted'
import { CWD, mountReady, type ViewCase } from './fixtures/views'

const scenario: ViewCase = {
  id: 'settings-feed',
  component: 'AbovePrompt',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'ready',
  view3d: false,
  browser3d: true,
  transition: 'none',
}

test(
  'language, band and hover persist across a session reload',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(
        await host.command(generation, { kind: 'lang', lang: 'fr' }),
      ).toEqual({ ok: true })
      expect(
        await host.command(generation, {
          kind: 'settings',
          patch: { band: false, hover: false },
        }),
      ).toEqual({ ok: true })
      host.forget()
      host.seed('meter', {
        window: 200_000,
        percent: 42,
        tokens: 84_000,
        usd: 1.2,
      })
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      const command = await mountCommandOutput($)
      await command.press({ key: 'copy-browser-link' })
      await command.unmount()
      await host.clock.settle()
      const current = latestSnapshot(host.browserEvents)!
      expect(current.facts.lang).toBe('fr')
      expect(current.facts.settings.band).toBe(false)
      expect(current.facts.settings.hover).toBe(false)
      await ui.redraw()
      expect(await ui.find({ key: 'open-browser' })).toBeUndefined()
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'concurrent settings commands preserve both fields',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(
        await Promise.all([
          host.command(generation, {
            kind: 'settings',
            patch: { band: false },
          }),
          host.command(generation, {
            kind: 'settings',
            patch: { hover: false },
          }),
        ]),
      ).toEqual([{ ok: true }, { ok: true }])
      expect(host.store.get('settings')).toEqual({
        openMd: 'default',
        openOther: 'default',
        hover: false,
        band: false,
      })
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'native display and built-in app settings work when app discovery fails',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.setAppCatalog(null)
    const pane = await $.ui.mount({
      plugin: 'brain-trail-v2',
      component: 'Pane',
      requestId: 'brain-trail-live-map',
      surface: 'desktop',
      props: {
        title: 'Brain Trail',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 22 },
        view: {},
      },
    })
    try {
      await pane.press({ key: 'settings' })
      await pane.press({ key: 'band-off' })
      await pane.press({ key: 'hover-off' })
      await pane.press({ key: 'openMd-preview' })
      expect(host.store.get('settings')).toEqual({
        openMd: 'preview',
        openOther: 'default',
        hover: false,
        band: false,
      })
    } finally {
      host.disconnectRelay()
      await pane.unmount()
      await ui.unmount()
    }
  },
)

test(
  'named app choices are checked against the installed catalog',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.setAppCatalog(['Editor'])
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(
        await host.command(generation, {
          kind: 'settings',
          patch: { openMd: 'Unknown', hover: false },
        }),
      ).toEqual({ ok: false, error: 'forbidden' })
      expect(host.store.get('settings')).toEqual({
        openMd: 'default',
        openOther: 'default',
        hover: true,
        band: true,
      })
      expect(
        await host.command(generation, {
          kind: 'settings',
          patch: { openMd: 'Editor' },
        }),
      ).toEqual({ ok: true })
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)
