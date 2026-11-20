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
      await ui.press({ key: 'copy-browser-link' })
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
      expect(await ui.find({ key: 'copy-browser-link' })).toBeUndefined()
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
      await ui.press({ key: 'copy-browser-link' })
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
