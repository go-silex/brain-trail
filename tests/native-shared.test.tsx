import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { latestSnapshot, mountCommandOutput } from './fixtures/mounted'
import { CWD, mountReady, NOTE_BODY, type ViewCase } from './fixtures/views'

const scenario: ViewCase = {
  id: 'shared-feed',
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
  'native Chat pairing publishes installed apps without browser-link issuance',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.setAppCatalog(['Editor'])
    try {
      await ui.press({ key: 'pair-chat' })
      await host.browserReady
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.facts.apps).toEqual(['Editor'])
      expect(host.copyCalls.length).toBe(1)
      expect(JSON.parse(host.copyCalls[0]!.text).kind).toBe('chat')
      expect(host.copyCalls[0]!.text.includes('/launch/')).toBe(false)
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'pairing blocks conflicting actions until its clipboard copy completes',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    const command = await mountCommandOutput($)
    host.holdCopy()
    try {
      const pairing = ui.press({ key: 'pair-chat' })
      await host.copyStarted
      await ui.redraw()
      await command.redraw()
      for (const key of ['open-brain-trail', 'pair-chat', 'open-browser']) {
        expect(await ui.find({ key })).toBeUndefined()
      }
      for (const key of [
        'open-brain-trail',
        'pair-chat',
        'copy-browser-link',
      ]) {
        expect(await command.find({ key })).toBeUndefined()
      }
      expect(host.openRequests).toEqual([])
      expect(host.uiOpened).toEqual([])
      expect(host.copyCalls.length).toBe(1)
      expect(host.appRevocations).toEqual([])
      host.releaseCopy()
      await pairing
      await ui.redraw()
      expect(
        await ui.find({ type: 'Text', text: /pairing copied/i }),
      ).toBeDefined()
      expect(JSON.parse(host.copyCalls[0]!.text).kind).toBe('chat')
      expect(host.appRevocations).toEqual([])
      await ui.press({ key: 'open-browser' })
      expect(host.openRequests.length).toBe(1)
      expect(host.copyCalls.length).toBe(1)
      expect(host.appRevocations).toEqual([])
    } finally {
      host.releaseCopy()
      host.disconnectRelay()
      await command.unmount()
      await ui.unmount()
    }
  },
)

test(
  'known files can be previewed but unknown and stale references are refused',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const initial = latestSnapshot(host.browserEvents)!
      expect(initial).toBeDefined()
      expect(
        await host.command(initial.generation, {
          kind: 'preview-read',
          ref: { p: 'notes/a.md' },
        }),
      ).toEqual({ ok: true, text: NOTE_BODY })
      expect(
        await host.command(initial.generation, {
          kind: 'preview-read',
          ref: { p: '/outside/unknown.md', out: true },
        }),
      ).toEqual({ ok: false, error: 'forbidden' })
      host.setMemoryFiles([`${CWD}/CLAUDE.local.md`])
      expect(
        await host.command(initial.generation, {
          kind: 'preview-read',
          ref: { p: 'CLAUDE.local.md' },
        }),
      ).toEqual({ ok: true, text: '' })
      host.setMemoryFiles([])
      expect(
        await host.command(initial.generation, {
          kind: 'preview-read',
          ref: { p: 'CLAUDE.local.md' },
        }),
      ).toEqual({ ok: false, error: 'forbidden' })
      expect(host.attemptedFiles).toEqual([
        `${CWD}/notes/a.md`,
        `${CWD}/CLAUDE.local.md`,
      ])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'pending coach work does not block settings and is invalidated by clearing the trail',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.holdFork()
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const initial = latestSnapshot(host.browserEvents)!
      const coach = host.command(initial.generation, { kind: 'coach-analyse' })
      await host.forkStarted
      expect(
        await host.command(initial.generation, { kind: 'coach-analyse' }),
      ).toEqual({ ok: false, error: 'busy' })
      expect(
        await host.command(initial.generation, {
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
        await host.command(initial.generation, { kind: 'clear-trail' }),
      ).toEqual({ ok: true })
      host.releaseFork()
      expect(await coach).toEqual({ ok: false, error: 'stale-generation' })
      await host.clock.settle()
      const current = latestSnapshot(host.browserEvents)!
      expect(current.generation).toBeGreaterThan(initial.generation)
      expect(
        await host.command(current.generation, { kind: 'coach-analyse' }),
      ).toEqual({ ok: true })
    } finally {
      host.releaseFork()
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'shared follow and preview transitions are published to the browser feed',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const initial = latestSnapshot(host.browserEvents)!
      expect(
        await host.command(initial.generation, {
          kind: 'view',
          intent: { kind: 'follow', following: false },
        }),
      ).toEqual({ ok: true })
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.shared.zoomed).toBe(true)
      expect(
        await host.command(initial.generation, {
          kind: 'view',
          intent: { kind: 'whole' },
        }),
      ).toEqual({ ok: true })
      expect(
        await host.command(initial.generation, {
          kind: 'view',
          intent: { kind: 'preview', ref: { p: 'notes/a.md' } },
        }),
      ).toEqual({ ok: true })
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.shared.preview).toEqual({
        p: 'notes/a.md',
      })
      expect(
        await host.command(initial.generation, {
          kind: 'view',
          intent: { kind: 'preview', ref: null },
        }),
      ).toEqual({ ok: true })
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.shared.preview).toBeNull()
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'overlapping publications do not roll the browser feed back',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      host.holdPreviewRead()
      const reopening = ui.press({ key: 'open-browser' })
      await host.previewReadBlocked
      const change = host.command(generation, { kind: 'lang', lang: 'fr' })
      await host.langStored
      host.releasePreviewRead()
      await reopening
      expect(await change).toEqual({ ok: true })
      await host.clock.settle()
      const snapshots = host.browserEvents.filter(
        (
          event,
        ): event is {
          kind: 'snapshot'
          revision: number
          facts: { lang: string }
        } =>
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
  'application discovery recovers after failure and after a new session',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.setAppCatalog(null)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(latestSnapshot(host.browserEvents)?.facts.apps).toEqual([])
      host.setAppCatalog(['Editor'])
      expect(
        await host.command(generation, {
          kind: 'settings',
          patch: { openMd: 'Editor' },
        }),
      ).toEqual({ ok: true })
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.facts.apps).toEqual(['Editor'])
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await ui.press({ key: 'open-browser' })
      await host.clock.settle()
      expect(latestSnapshot(host.browserEvents)?.facts.apps).toEqual(['Editor'])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'an observed outside file remains eligible for preview and open without a new confirmation',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    const path = '/outside/observed.md'
    host.seed('events', [{ k: 'read', p: path, out: true, at: 1000 }])
    host.allowPreparedFile(path)
    try {
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(
        await host.command(generation, {
          kind: 'preview-read',
          ref: { p: path, out: true },
        }),
      ).toEqual({ ok: true, text: '' })
      expect(
        await host.command(generation, {
          kind: 'open',
          ref: { p: path, out: true },
          app: 'default',
        }),
      ).toEqual({ ok: true, launch: { status: 'dispatched' } })
      expect(host.preparedFiles).toEqual([path, path])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'current startup memory can be opened without a preceding read event',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const generation = latestSnapshot(host.browserEvents)!.generation
      expect(
        await host.command(generation, {
          kind: 'open',
          ref: { p: 'CLAUDE.md' },
          app: 'default',
        }),
      ).toEqual({ ok: true, launch: { status: 'dispatched' } })
      expect(host.preparedFiles).toEqual([`${CWD}/CLAUDE.md`])
      expect(host.readFiles).toEqual([])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'the browser feed carries captured goals, plan, files and context facts',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.press({ key: 'open-browser' })
      await host.browserReady
      const facts = latestSnapshot(host.browserEvents)!.facts
      expect(
        facts.events.some(
          (event) =>
            event.k === 'prompt' && event.text === 'Summarise the notes',
        ),
      ).toBe(true)
      expect(
        facts.events.some(
          (event) =>
            event.k === 'plan' &&
            event.items?.some((item) => item.t === 'Read the note') === true,
        ),
      ).toBe(true)
      expect(
        facts.events.some(
          (event) => event.k === 'read' && event.p === 'notes/a.md',
        ),
      ).toBe(true)
      expect(
        facts.breakdown?.memoryFiles.some(
          (file) => file.path === `${CWD}/CLAUDE.md`,
        ),
      ).toBe(true)
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)
