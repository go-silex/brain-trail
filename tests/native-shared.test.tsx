import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { ServerEvent } from '../types/browser'
import { CWD, mountReady, type ViewCase } from './fixtures/views'

const MAP: ViewCase = {
  id: 'native-shared',
  component: 'Pane',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'ready',
  view3d: true,
  browser3d: true,
  transition: 'none',
}

const snapshot = (events: unknown[]) =>
  [...events]
    .reverse()
    .find(
      (event): event is Extract<ServerEvent, { kind: 'snapshot' }> =>
        typeof event === 'object' &&
        event !== null &&
        'kind' in event &&
        event.kind === 'snapshot',
    )

test(
  'a current startup memory file reaches held-file consent without a read event',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, {
      ...MAP,
      tab: 'context',
      view3d: false,
      browser3d: false,
    })
    try {
      await ui.press({ key: 'more-context' })
      await ui.redraw()
      await ui.press({ key: `open-mem-${CWD}/CLAUDE.md` })
      await host.filePrepared
      expect(host.preparedFiles).toEqual([`${CWD}/CLAUDE.md`])
      expect(host.readFiles).toEqual([])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'native settings and its non-relay actions survive relay loss',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, MAP)
    try {
      await ui.press({ key: 'open-3d' })
      await host.browserReady
      host.disconnectRelay()
      await host.clock.settle()
      await ui.press({ key: 'settings' })
      await ui.redraw()
      expect(await ui.find({ key: 'lang-fr' })).toBeDefined()
      await ui.press({ key: 'lang-fr' })
      await ui.redraw()
      expect((await ui.find({ key: 't-map' }))?.text).toBe('CARTE')
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'a pending browser coach request does not block native navigation or settings',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, MAP)
    host.holdFork()
    try {
      await ui.press({ key: 'open-3d' })
      await host.browserReady
      const initial = snapshot(host.browserEvents)
      expect(initial).toBeDefined()
      const coach = host.command(initial!.generation, { kind: 'coach-analyse' })
      await host.forkStarted
      await ui.press({ key: 't-goal' })
      await ui.redraw()
      expect(await ui.find({ key: 'zoom-in' })).toBeUndefined()
      expect(
        await host.command(initial!.generation, {
          kind: 'settings',
          patch: { hover: false },
        }),
      ).toEqual({ ok: true })
      expect(host.store.get('settings')).toEqual({
        openMd: 'default',
        openOther: 'default',
        hover: false,
        band: true,
      })
      expect(
        await host.command(initial!.generation, { kind: 'clear-trail' }),
      ).toEqual({ ok: true })
      host.releaseFork()
      expect(await coach).toEqual({ ok: false, error: 'stale-generation' })
    } finally {
      host.releaseFork()
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  '2D zoom stops shared follow and a remote follow reactivates it',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, MAP)
    try {
      await ui.press({ key: 'open-3d' })
      await host.browserReady
      const initial = snapshot(host.browserEvents)
      expect(initial).toBeDefined()
      await ui.press({ key: 'view-3d' })
      await ui.redraw()
      const idle = (await ui.find({ key: 'follow' }))?.text
      expect(idle).toBeDefined()
      await ui.press({ key: 'follow' })
      await host.clock.settle()
      await ui.redraw()
      const following = (await ui.find({ key: 'follow' }))?.text
      expect(following).toBeDefined()
      expect(following).not.toBe(idle)
      expect(snapshot(host.browserEvents)?.shared.zoomed).toBe(true)
      await ui.press({ key: 'zoom-in' })
      await host.clock.settle()
      await ui.redraw()
      expect((await ui.find({ key: 'follow' }))?.text).toBe(idle)
      expect(snapshot(host.browserEvents)?.shared.zoomed).toBe(false)
      expect(
        await host.command(initial!.generation, {
          kind: 'view',
          intent: { kind: 'follow', following: false },
        }),
      ).toEqual({ ok: true })
      await host.clock.settle()
      await ui.redraw()
      expect(snapshot(host.browserEvents)?.shared.zoomed).toBe(true)
      expect((await ui.find({ key: 'follow' }))?.text).toBe(following)
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

for (const action of ['pause', 'live'] as const) {
  test(
    `a replay tick queued behind ${action} cannot revive playback`,
    { timeoutMs: 20_000 },
    async ($, on: On) => {
      const { ui, host } = await mountReady($, on, {
        ...MAP,
        view3d: false,
        browser3d: false,
      })
      try {
        await ui.press({ key: 'play' })
        await ui.redraw()
        host.holdPlayWrite()
        const stopped = ui.press({ key: action })
        await host.playWriteBlocked
        await host.clock.advance(900)
        host.releasePlayWrite()
        await stopped
        await host.clock.settle()
        await ui.redraw()
        expect(await ui.find({ key: 'pause' })).toBeUndefined()
        if (action === 'pause') {
          expect(
            await ui.find({ type: 'Text', text: /^1\/\d+$/ }),
          ).toBeDefined()
          await ui.press({ key: 'live' })
        } else {
          expect(await ui.find({ key: 'live' })).toBeUndefined()
          expect(await ui.find({ key: 'play' })).toBeDefined()
        }
      } finally {
        host.releasePlayWrite()
        await ui.unmount()
      }
    },
  )
}

test(
  'overlapping publications never roll the browser feed back',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, MAP)
    try {
      await ui.press({ key: 'open-3d' })
      await host.browserReady
      const initial = snapshot(host.browserEvents)
      expect(initial).toBeDefined()
      host.holdPreviewRead()
      const reopening = ui.press({ key: 'open-3d' })
      await host.previewReadBlocked
      const change = host.command(initial!.generation, {
        kind: 'lang',
        lang: 'fr',
      })
      await host.langStored
      host.releasePreviewRead()
      await reopening
      expect(await change).toEqual({ ok: true })
      await host.clock.settle()
      const snapshots = host.browserEvents.filter(
        (event): event is Extract<ServerEvent, { kind: 'snapshot' }> =>
          typeof event === 'object' &&
          event !== null &&
          'kind' in event &&
          event.kind === 'snapshot',
      )
      expect(snapshots.length).toBeGreaterThan(1)
      expect(
        snapshots.every(
          (event, i) => i === 0 || event.revision >= snapshots[i - 1]!.revision,
        ),
      ).toBe(true)
      expect(snapshots[snapshots.length - 1]?.facts.lang).toBe('fr')
    } finally {
      host.releasePreviewRead()
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)
