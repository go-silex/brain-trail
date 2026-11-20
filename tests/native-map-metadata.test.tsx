import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { CWD, mountReady, type ViewCase } from './fixtures/views'

const scenario: ViewCase = {
  id: 'native-map-metadata',
  component: 'AbovePrompt',
  surface: 'desktop',
  theme: 'dark',
  lang: 'en',
  tab: 'map',
  phase: 'empty',
  view3d: false,
  browser3d: false,
  transition: 'none',
}

test(
  'a freshly mounted map identifies anonymous connectors from context metadata',
  { timeoutMs: 10_000 },
  async ($, on: On) => {
    const { ui, host } = await mountReady($, on, scenario)
    const server = '12345678-1234-1234-1234-123456789abc'
    host.setMcpTools([`mcp__${server}__list_bank_accounts`])
    try {
      await $.session.start({
        cwd: CWD,
        surface: 'desktop',
        isInteractive: true,
      })
      await host.settled()
      host.seed('events', [{ k: 'mcp', server, tool: 'other', at: 1 }])
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
        await pane.press({ key: 'view-3d' })
        expect((await pane.find({ type: 'Svg' }))?.props.source).toMatch(
          />Qonto · 1<\/text>/,
        )
      } finally {
        await pane.unmount()
      }
    } finally {
      host.disconnectRelay()
      await ui.unmount()
    }
  },
)
