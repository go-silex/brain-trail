import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { latestSnapshot } from './fixtures/mounted'
import { mountReady, type ViewCase } from './fixtures/views'

const scenario: ViewCase = {
  id: 'coach-feed',
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
  'coach analysis is published and a refused overlapping request leaves the first active',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.setForkResult(
      '## Your requests\nBe specific.\n## Add to CLAUDE.md\n```context\n- Offers are in 01_COMPANY/Offer.\n```',
    )
    host.holdFork()
    try {
      await ui.press({ key: 'copy-browser-link' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      const first = host.command(generation, { kind: 'coach-analyse' })
      await host.forkStarted
      expect(await host.command(generation, { kind: 'coach-analyse' })).toEqual(
        { ok: false, error: 'busy' },
      )
      host.releaseFork()
      expect(await first).toEqual({ ok: true })
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.facts.coach.busy).toBe(false)
      expect(await host.command(generation, { kind: 'coach-apply' })).toEqual({
        ok: true,
        filled: true,
      })
      expect(host.promptFills[0]).toContain('01_COMPANY/Offer')
      expect(
        latestSnapshot(host.browserEvents)?.facts.coach.text.length,
      ).toBeGreaterThan(0)
    } finally {
      host.releaseFork()
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'a refused coach analysis publishes an error and allows retry',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'copy-browser-link' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(await host.command(generation, { kind: 'coach-analyse' })).toEqual(
        { ok: true },
      )
      await host.clock.settle()
      expect(
        latestSnapshot(host.browserEvents)?.facts.coach.error,
      ).toBeDefined()
      host.setForkResult('Analysis completed')
      expect(await host.command(generation, { kind: 'coach-analyse' })).toEqual(
        { ok: true },
      )
      await host.clock.settle()
      expect(
        latestSnapshot(host.browserEvents)?.facts.coach.error,
      ).toBeUndefined()
      expect(latestSnapshot(host.browserEvents)?.facts.coach.text).toBe(
        'Analysis completed',
      )
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)
