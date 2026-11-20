import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import {
  latestSnapshot,
  mockPaneRegistry,
  mountCommandOutput,
  renderedContains,
} from './fixtures/mounted'
import { CWD, mountReady, type ViewCase } from './fixtures/views'
import { waitWallTime } from './fixtures/wall-time.mjs'

const scenario: ViewCase = {
  id: 'launcher',
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
const url = (letter: string) =>
  `http://127.0.0.1:4321/launch/${letter.repeat(43)}`
const link = (letter: string) => ({
  ok: true,
  url: url(letter),
  expiresAt: Date.now() + 60_000,
})

test(
  'only an explicit press copies a fresh link to the press surface; the pane never exposes it',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    mockPaneRegistry(on, [])
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await ui.redraw()
      expect(host.copyCalls).toEqual([])
      expect(host.relayStarted()).toBe(false)
      await $.command.run({
        command: 'brain-trail-v2',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 80 },
      })
      await host.clock.settle()
      expect(host.copyCalls).toEqual([])
      expect(host.relayStarted()).toBe(false)
      host.setLinkResponse(link('a'))
      await ui.press({ key: 'copy-browser-link' })
      await host.browserReady
      await ui.redraw()
      expect(host.copyCalls).toEqual([{ text: url('a'), surface: 'desktop' }])
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeDefined()
      expect(await renderedContains(ui, url('a'))).toBe(false)
      expect(await ui.find({ type: 'Link' })).toBeUndefined()
      expect(host.opened).toEqual([])
      expect(host.uiOpened).toEqual([])
      host.setLinkResponse(link('b'))
      await ui.press({ key: 'copy-browser-link' })
      await ui.redraw()
      expect(host.copyCalls).toEqual([
        { text: url('a'), surface: 'desktop' },
        { text: url('b'), surface: 'desktop' },
      ])
      expect(await renderedContains(ui, url('a'))).toBe(false)
      expect(JSON.stringify(host.logs).includes(url('a'))).toBe(false)
      expect(await renderedContains(ui, url('b'))).toBe(false)
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(host.copyCalls.length).toBe(2)
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'copy refusal and launch errors fail closed without displaying the capability',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      host.setLinkResponse({ ok: false, error: url('x') })
      await ui.press({ key: 'copy-browser-link' })
      await ui.redraw()
      expect(host.copyCalls).toEqual([])
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(
        await ui.find({ type: 'Text', text: /copy failed/i }),
      ).toBeDefined()
      expect(await renderedContains(ui, url('x'))).toBe(false)
      host.setLinkResponse({ ...link('a'), expiresAt: Date.now() - 1 })
      await ui.press({ key: 'copy-browser-link' })
      expect(host.copyCalls).toEqual([])
      host.setLinkResponse(link('b'))
      host.setCopySuccess(false)
      expect(JSON.stringify(host.logs).includes(url('x'))).toBe(false)
      await ui.press({ key: 'copy-browser-link' })
      await ui.redraw()
      expect(host.copyCalls.length).toBe(1)
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(
        await ui.find({ type: 'Text', text: /copy failed/i }),
      ).toBeDefined()
      expect(await renderedContains(ui, url('b'))).toBe(false)
      host.setCopySuccess(true)
      host.setLinkResponse(link('c'))
      await ui.press({ key: 'copy-browser-link' })
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeDefined()
      expect(
        await ui.find({ type: 'Text', text: /copy failed/i }),
      ).toBeUndefined()
      expect(await renderedContains(ui, url('c'))).toBe(false)
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'a link arriving after a new session is never copied',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    const command = await mountCommandOutput($)
    host.holdLink()
    try {
      const preparing = command.press({ key: 'copy-browser-link' })
      await host.linkStarted
      await ui.redraw()
      expect(await ui.find({ key: 'copy-browser-link' })).toBeUndefined()
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      host.releaseLink()
      await preparing
      await ui.redraw()
      expect(host.copyCalls).toEqual([])
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(await ui.find({ key: 'copy-browser-link' })).toBeDefined()
      expect(await renderedContains(ui, url('a'))).toBe(false)
    } finally {
      host.releaseLink()
      host.disconnectRelay()
      await command.unmount()
      await ui.unmount()
    }
  },
)

test(
  'a successful copy completing after a session change cannot claim success',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.holdCopy()
    try {
      const copying = ui.press({ key: 'copy-browser-link' })
      await host.copyStarted
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      host.releaseCopy()
      await copying
      await ui.redraw()
      expect(host.copyCalls.length).toBe(1)
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(await renderedContains(ui, url('a'))).toBe(false)
    } finally {
      host.releaseCopy()
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'terminal exposes no capability and relay loss clears copied status',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    const terminal = await $.ui.mount({
      plugin: 'brain-trail-v2',
      component: 'AbovePrompt',
      requestId: 'terminal-band',
      surface: 'terminal',
      props: {
        hasSurvey: false,
        isCollapsed: false,
        isWorking: false,
        maxRows: 8,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 8 },
        view: {},
      },
    })
    try {
      await ui.press({ key: 'copy-browser-link' })
      await host.browserReady
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeDefined()
      await terminal.redraw()
      expect(await terminal.find({ key: 'copy-browser-link' })).toBeUndefined()
      expect(
        await terminal.find({ type: 'Text', text: /copied/i }),
      ).toBeUndefined()
      expect(await renderedContains(terminal, url('a'))).toBe(false)
      host.disconnectRelay()
      await host.clock.settle()
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(
        await ui.find({ type: 'Text', text: /copy failed/i }),
      ).toBeUndefined()
      expect(await ui.find({ key: 'copy-browser-link' })).toBeDefined()
      expect(host.copyCalls.length).toBe(1)
    } finally {
      host.disconnectRelay()
      await terminal.unmount()
      await ui.unmount()
    }
  },
)

test(
  'relay loss during copy cannot claim success when the copy completes',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.holdCopy()
    try {
      const copying = ui.press({ key: 'copy-browser-link' })
      await host.copyStarted
      host.disconnectRelay()
      await host.clock.settle()
      host.releaseCopy()
      await copying
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(
        await ui.find({ type: 'Text', text: /copy failed/i }),
      ).toBeDefined()
      expect(await renderedContains(ui, url('a'))).toBe(false)
      expect(host.copyCalls.length).toBe(1)
    } finally {
      host.releaseCopy()
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'an indexing failure can be retried for the same workspace and session',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    host.setInvalidIndexCache(true)
    try {
      const before = (await ui.findAll({ type: 'Text' })).map((el) => el.text)
      await ui.press({ key: 'copy-browser-link' })
      await ui.redraw()
      expect(host.copyCalls).toEqual([])
      expect(host.relayStarted()).toBe(false)
      const failure = (await ui.findAll({ type: 'Text' }))
        .map((el) => el.text)
        .filter((text) => text.trim() !== '' && !before.includes(text))
      expect(failure.length).toBeGreaterThan(0)
      expect(await ui.find({ key: 'copy-browser-link' })).toBeDefined()
      host.setInvalidIndexCache(false)
      await ui.press({ key: 'copy-browser-link' })
      await host.browserReady
      await ui.redraw()
      expect(host.copyCalls.length).toBe(1)
      expect(latestSnapshot(host.browserEvents)?.facts.workspace.kind).toBe(
        'ready',
      )
      const after = (await ui.findAll({ type: 'Text' })).map((el) => el.text)
      expect(failure.every((text) => !after.includes(text))).toBe(true)
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'the command row offers explicit App, Chat and browser entry when the band is hidden',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    const survey = await $.ui.mount({
      plugin: 'brain-trail-v2',
      component: 'AbovePrompt',
      requestId: 'survey',
      surface: 'desktop',
      props: {
        hasSurvey: true,
        isCollapsed: false,
        isWorking: false,
        maxRows: 8,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 8 },
        view: {},
      },
    })
    try {
      expect(await ui.find({ key: 'copy-browser-link' })).toBeDefined()
      expect(await survey.find({ key: 'copy-browser-link' })).toBeUndefined()
      host.seed('settings', {
        openMd: 'default',
        openOther: 'default',
        hover: true,
        band: false,
      })
      await ui.redraw()
      expect(await ui.find({ key: 'copy-browser-link' })).toBeUndefined()
      expect(await survey.find({ key: 'copy-browser-link' })).toBeUndefined()
      expect(await ui.find({ key: 'open-brain-trail' })).toBeUndefined()
      expect(await ui.find({ key: 'pair-chat' })).toBeUndefined()
      expect(await survey.find({ key: 'open-brain-trail' })).toBeUndefined()
      expect(await survey.find({ key: 'pair-chat' })).toBeUndefined()
      const command = await mountCommandOutput($)
      const terminal = await mountCommandOutput(
        $,
        'terminal',
        'terminal-command',
      )
      try {
        expect(host.copyCalls).toEqual([])
        expect(host.relayStarted()).toBe(false)
        expect(await command.find({ key: 'open-brain-trail' })).toBeDefined()
        expect(await command.find({ key: 'pair-chat' })).toBeDefined()
        expect(await terminal.find({ key: 'open-brain-trail' })).toBeUndefined()
        expect(await terminal.find({ key: 'pair-chat' })).toBeUndefined()
        expect(await command.find({ key: 'copy-browser-link' })).toBeDefined()
        expect(
          await terminal.find({ key: 'copy-browser-link' }),
        ).toBeUndefined()
        await command.press({ key: 'copy-browser-link' })
        await host.browserReady
        await command.redraw()
        await ui.redraw()
        expect(host.copyCalls.length).toBe(1)
        expect(
          await command.find({ type: 'Text', text: /copied/i }),
        ).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
        expect(await renderedContains(command, host.copyCalls[0]!.text)).toBe(
          false,
        )
        expect(await renderedContains(terminal, host.copyCalls[0]!.text)).toBe(
          false,
        )
      } finally {
        await terminal.unmount()
        await command.unmount()
      }
    } finally {
      host.disconnectRelay()
      await survey.unmount()
      await ui.unmount()
    }
  },
)

for (const trigger of ['start', 'attach', 'command'] as const) {
  test(
    `${trigger} removes only the obsolete pane without opening another`,
    { timeoutMs: 20_000 },
    async ($, on: On) => {
      const registry = mockPaneRegistry(on, ['brain-trail-v2', 'other-pane'])
      const { ui, host } = await mountReady($, on, scenario)
      try {
        if (trigger === 'start')
          await $.session.start({
            cwd: CWD,
            surface: 'desktop',
            isInteractive: true,
          })
        else if (trigger === 'attach')
          await $.session.attach({
            surface: 'desktop',
            clientId: 'desktop-test',
          })
        else {
          const command = await mountCommandOutput($)
          await command.unmount()
        }
        await host.clock.settle()
        expect([...registry.panes]).toEqual(['other-pane'])
        expect(registry.closed).toEqual(['brain-trail-v2'])
        expect(host.copyCalls).toEqual([])
        expect(host.relayStarted()).toBe(false)
        expect(host.opened).toEqual([])
        expect(host.uiOpened).toEqual([])
      } finally {
        host.disconnectRelay()
        await ui.unmount()
      }
    },
  )
}

test(
  'a denied obsolete-pane close reports the problem while command and capture continue',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const registry = mockPaneRegistry(
      on,
      ['brain-trail-v2', 'other-pane'],
      true,
    )
    on('tool.call', () => ({ result: '# Note', text: '# Note' }))
    const { ui, host } = await mountReady($, on, scenario)
    const recorded = host.waitForState(
      ({ key, value }) =>
        key === 'events' && JSON.stringify(value).includes('notes/a.md'),
    )
    try {
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await host.clock.settle()
      expect(registry.panes.has('brain-trail-v2')).toBe(true)
      expect(registry.panes.has('other-pane')).toBe(true)
      expect(host.notices.some((notice) => notice.trim().length > 0)).toBe(true)
      const command = await mountCommandOutput($)
      try {
        expect(await command.find({ key: 'copy-browser-link' })).toBeDefined()
        await $.tool.call({ tool: 'Read', file_path: `${CWD}/notes/a.md` })
        await recorded
        await command.press({ key: 'copy-browser-link' })
        await host.browserReady
        expect(
          latestSnapshot(host.browserEvents)?.facts.events.some(
            (event) => event.k === 'read' && event.p === 'notes/a.md',
          ),
        ).toBe(true)
      } finally {
        await command.unmount()
      }
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'expired copied status disappears without changing the clipboard',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    try {
      host.setLinkResponse({ ...link('e'), expiresAt: Date.now() + 5000 })
      await ui.press({ key: 'copy-browser-link' })
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeDefined()
      await waitWallTime(5100)
      await host.clock.advance(1000)
      await ui.redraw()
      expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
      expect(host.copyCalls).toEqual([{ text: url('e'), surface: 'desktop' }])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'copy feedback stays at the render instance that received the press',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    const command = await mountCommandOutput($)
    const other = await mountCommandOutput($, 'desktop', 'other-command')
    try {
      host.holdLink()
      const bandCopy = ui.press({ key: 'copy-browser-link' })
      await host.linkStarted
      await ui.redraw()
      await command.redraw()
      expect(await ui.find({ key: 'copy-browser-link' })).toBeUndefined()
      expect(await command.find({ key: 'copy-browser-link' })).toBeUndefined()
      host.releaseLink()
      await bandCopy
      await ui.redraw()
      await command.redraw()
      expect(host.copyCalls).toEqual([{ text: url('a'), surface: 'desktop' }])
      expect(await ui.find({ key: 'browser-copy-success' })).toBeDefined()
      expect(
        await command.find({ key: 'browser-copy-success' }),
      ).toBeUndefined()
      expect(await command.find({ key: 'copy-browser-link' })).toBeDefined()
      await command.press({ key: 'copy-browser-link' })
      await ui.redraw()
      await command.redraw()
      await other.redraw()
      expect(await ui.find({ key: 'browser-copy-success' })).toBeUndefined()
      expect(await command.find({ key: 'browser-copy-success' })).toBeDefined()
      expect(await other.find({ key: 'browser-copy-success' })).toBeUndefined()
      expect(await ui.find({ key: 'copy-browser-link' })).toBeDefined()
      expect(await other.find({ key: 'copy-browser-link' })).toBeDefined()
      expect(host.copyCalls).toEqual([
        { text: url('a'), surface: 'desktop' },
        { text: url('a'), surface: 'desktop' },
      ])
    } finally {
      host.releaseLink()
      host.disconnectRelay()
      await other.unmount()
      await command.unmount()
      await ui.unmount()
    }
  },
)

test(
  'cleanup leaves unrelated panes alone when no obsolete pane exists',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const registry = mockPaneRegistry(on, ['other-pane'])
    const { ui, host } = await mountReady($, on, scenario)
    try {
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await $.session.attach({ surface: 'desktop', clientId: 'desktop-test' })
      const command = await mountCommandOutput($)
      await command.unmount()
      await host.clock.settle()
      expect([...registry.panes]).toEqual(['other-pane'])
      expect(registry.closed).toEqual([])
      expect(host.uiOpened).toEqual([])
      expect(host.copyCalls).toEqual([])
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

test(
  'terminal command directs the user to Desktop without issuing or copying a capability',
  { timeoutMs: 20_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, {
      ...scenario,
      surface: 'terminal',
    })
    try {
      const result = await $.command.run({
        command: 'brain-trail-v2',
        args: '',
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 80 },
      })
      const guidance = result.text ?? ''
      expect(guidance.trim().length).toBeGreaterThan(0)
      expect(/https?:\/\//i.test(guidance)).toBe(false)
      const terminal = await mountCommandOutput(
        $,
        'terminal',
        'terminal-guidance',
      )
      try {
        expect(
          await terminal.find({ key: 'copy-browser-link' }),
        ).toBeUndefined()
        expect(await terminal.find({ key: 'open-brain-trail' })).toBeUndefined()
        expect(await terminal.find({ key: 'pair-chat' })).toBeUndefined()
        expect(await terminal.find({ type: 'Link' })).toBeUndefined()
        expect(await renderedContains(terminal, 'http://127.0.0.1')).toBe(false)
        expect(host.copyCalls).toEqual([])
        expect(host.relayStarted()).toBe(false)
        expect(host.uiOpened).toEqual([])
      } finally {
        await terminal.unmount()
      }
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)

for (const lifecycle of ['clear', 'end'] as const) {
  test(
    `${lifecycle} removes mounted copy feedback without a forced redraw`,
    { timeoutMs: 20_000 },
    async ($, on: On) => {
      if (lifecycle === 'clear')
        on('command.run', { command: 'clear' }, () => ({ text: '' }))
      else on('session.end', (_, e) => ({ sessionId: e.sessionId }))
      const { ui, host } = await mountReady($, on, scenario)
      try {
        await ui.press({ key: 'copy-browser-link' })
        expect(await ui.find({ type: 'Text', text: /copied/i })).toBeDefined()
        if (lifecycle === 'clear')
          await $.command.run({
            command: 'clear',
            args: '',
            origin: { kind: 'composer' },
            presentation: { isFullscreen: false, columns: 80 },
          })
        else
          await $.session.end({
            reason: 'other',
            sessionId: 'synthetic-session',
            resume: { id: 'synthetic-session' },
          })
        expect(await ui.find({ type: 'Text', text: /copied/i })).toBeUndefined()
        expect(host.copyCalls.length).toBe(1)
      } finally {
        host.disconnectRelay()
        await ui.unmount()
      }
    },
  )
}
