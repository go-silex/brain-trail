import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { ServerEvent } from '../types/browser'
import { mapSource, viewBoxOf } from './fixtures/mounted'
import {
  CWD,
  installHost,
  mountReady,
  mountTarget,
  NOTE_BODY,
  type ViewCase,
} from './fixtures/views'

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
  'a current startup memory reference reaches held-file preparation without a read event',
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
      await host.clock.settle()
      const current = snapshot(host.browserEvents)
      expect(current?.generation).toBeGreaterThan(initial!.generation)
      expect(
        await host.command(current!.generation, { kind: 'coach-analyse' }),
      ).toEqual({ ok: true })
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

test(
  '2D wheel changes the local camera without republishing inactive follow',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, MAP)
    try {
      await ui.press({ key: 'open-3d' })
      await host.browserReady
      await ui.press({ key: 'view-3d' })
      await host.clock.settle()
      await ui.redraw()
      expect(snapshot(host.browserEvents)?.shared.zoomed).toBe(false)
      const initial = snapshot(host.browserEvents)
      expect(initial).toBeDefined()
      const revision = initial!.revision
      await ui.resize({ columns: 80, rows: 24, in: 'map-hit' })
      await ui.pointer({ type: 'move', x: 20, y: 8, in: 'map-hit' })
      const before = viewBoxOf(await mapSource(ui))
      for (let i = 0; i < 2; i++) {
        await $.ui.scroll({
          component: 'Pane',
          requestId: 'brain-trail-v2',
          offset: 0,
          by: -1,
          bodyRows: 40,
          contentRows: 80,
          origin: { kind: 'person' },
          pointer: { column: 1, row: 1 },
        })
      }
      await host.clock.settle()
      await ui.redraw()
      const after = viewBoxOf(await mapSource(ui))
      expect(before).toBeDefined()
      expect(after!.w).toBeLessThan(before!.w)
      expect(snapshot(host.browserEvents)?.revision).toBe(revision)
      expect(
        await host.command(initial!.generation, {
          kind: 'preview-read',
          ref: { p: 'notes/a.md' },
        }),
      ).toEqual({ ok: true, text: NOTE_BODY })
      await host.clock.settle()
      expect(snapshot(host.browserEvents)?.revision).toBe(revision)
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

test(
  'a refused second Coach request does not invalidate the active request',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, MAP)
    host.holdFork()
    try {
      await ui.press({ key: 'open-3d' })
      await host.browserReady
      const initial = snapshot(host.browserEvents)
      expect(initial).toBeDefined()
      const first = host.command(initial!.generation, { kind: 'coach-analyse' })
      await host.forkStarted
      expect(
        await host.command(initial!.generation, { kind: 'coach-analyse' }),
      ).toEqual({ ok: false, error: 'busy' })
      host.releaseFork()
      expect(await first).toEqual({ ok: true })
    } finally {
      host.releaseFork()
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'Files opens current unindexed startup memory but rejects unknown and stale references',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const host = installHost(on, MAP)
    const settings = {
      openMd: 'preview',
      openOther: 'default',
      hover: true,
      band: true,
    }
    host.setMemoryFiles([`${CWD}/CLAUDE.local.md`])
    host.seed('settings', settings)
    host.store.set('settings', settings)
    const ui = await $.ui.mount(mountTarget(MAP))
    try {
      await host.settled()
      await ui.redraw()
      await ui.press({ key: 'open-3d' })
      await host.browserReady
      const initial = snapshot(host.browserEvents)
      expect(initial).toBeDefined()
      await ui.press({ key: 't-files' })
      await ui.redraw()
      await ui.press({ key: 'kpi-open-start' })
      await ui.redraw()
      await ui.press({ key: 'kd-open-CLAUDE.local.md' })
      await host.fileRead
      expect(host.readFiles).toEqual([`${CWD}/CLAUDE.local.md`])
      expect(host.preparedFiles).toEqual(host.readFiles)
      expect(
        await host.command(initial!.generation, {
          kind: 'preview-read',
          ref: { p: '/outside/unknown.md', out: true },
        }),
      ).toEqual({ ok: false, error: 'forbidden' })
      host.setMemoryFiles([])
      expect(
        await host.command(initial!.generation, {
          kind: 'preview-read',
          ref: { p: 'CLAUDE.local.md' },
        }),
      ).toEqual({ ok: false, error: 'forbidden' })
      expect(host.attemptedFiles).toEqual([`${CWD}/CLAUDE.local.md`])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'app discovery recovers after a later success and after a new session',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const scenario: ViewCase = { ...MAP, tab: 'settings' }
    const host = installHost(on, scenario)
    host.setAppCatalog(null)
    const ui = await $.ui.mount(mountTarget(scenario))
    try {
      await host.waitForAppRequests(1)
      await host.browserReady
      await host.clock.settle()
      await ui.redraw()
      expect(
        await ui.find({ type: 'Text', text: /App discovery is unavailable/ }),
      ).toBeDefined()
      const initial = snapshot(host.browserEvents)
      expect(initial).toBeDefined()
      host.setAppCatalog(['Editor'])
      expect(
        await host.command(initial!.generation, {
          kind: 'settings',
          patch: { band: false },
        }),
      ).toEqual({ ok: true })
      await host.clock.settle()
      await ui.redraw()
      expect(
        await ui.find({ type: 'Text', text: /App discovery is unavailable/ }),
      ).toBeUndefined()
      expect(await ui.find({ key: 'openMd-Editor' })).toBeDefined()

      host.setAppCatalog(null)
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await ui.redraw()
      await host.waitForAppRequests(3)
      await host.clock.settle()
      await ui.redraw()
      expect(
        await ui.find({ type: 'Text', text: /App discovery is unavailable/ }),
      ).toBeDefined()
      host.setAppCatalog(['Editor'])
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await ui.redraw()
      await host.waitForAppRequests(4)
      await host.clock.settle()
      await ui.redraw()
      expect(
        await ui.find({ type: 'Text', text: /App discovery is unavailable/ }),
      ).toBeUndefined()
      expect(await ui.find({ key: 'openMd-Editor' })).toBeDefined()
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)
