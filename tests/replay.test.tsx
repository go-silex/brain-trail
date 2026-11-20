import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { latestSnapshot } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const scenario: ViewCase = {
  id: 'replay-feed',
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

for (const action of ['replay-pause', 'replay-live'] as const) {
  test(
    `a queued replay tick cannot revive playback after ${action}`,
    { timeoutMs: 20_000 },
    async ($, on: On) => {
      const { ui, host } = await mountReady($, on, scenario)
      try {
        await ui.press({ key: 'copy-browser-link' })
        await host.browserReady
        const generation = latestSnapshot(host.browserEvents)!.generation
        expect(
          await host.command(generation, {
            kind: 'view',
            intent: { kind: 'replay-play', steps: 100 },
          }),
        ).toEqual({ ok: true })
        await host.clock.settle()
        expect(latestSnapshot(host.browserEvents)?.shared.play).toEqual({
          step: 0,
          playing: true,
        })
        host.holdPlayWrite()
        const stopping = host.command(generation, {
          kind: 'view',
          intent: { kind: action },
        })
        await host.playWriteBlocked
        await host.clock.advance(900)
        host.releasePlayWrite()
        expect(await stopping).toEqual({ ok: true })
        await host.clock.settle()
        expect(latestSnapshot(host.browserEvents)?.shared.play).toEqual({
          step: action === 'replay-live' ? null : 0,
          playing: false,
        })
      } finally {
        host.releasePlayWrite()
        host.disconnectRelay()
        await ui.unmount()
      }
    },
  )
}

test(
  'replay advances on its clock and clearing returns to live',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'copy-browser-link' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(
        await host.command(generation, {
          kind: 'view',
          intent: { kind: 'replay-play', steps: 100 },
        }),
      ).toEqual({ ok: true })
      await host.clock.advance(899)
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.shared.play.step).toBe(0)
      await host.clock.advance(1)
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.shared.play.step).toBe(1)
      expect(await host.command(generation, { kind: 'clear-trail' })).toEqual({
        ok: true,
      })
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.shared.play).toEqual({
        step: null,
        playing: false,
      })
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)
