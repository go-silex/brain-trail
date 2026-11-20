import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { LOGOS } from '../hooks/logos'
import { mountCommandOutput } from './fixtures/mounted'
import { CWD, mountReady, type ViewCase } from './fixtures/views'

const empty: ViewCase = {
  id: 'native-map',
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

const toolRead = { tool: 'Read', file_path: `${CWD}/src/app.ts` } as const

for (const isPlaced of [true, false]) {
  test(
    isPlaced
      ? 'Open Brain Trail shows a live map without starting the browser relay'
      : 'Open Brain Trail reports that Desktop did not place the pane',
    { timeoutMs: 10_000 },
    async ($, on: On) => {
      const opened: string[] = []
      on('ui.open', { id: 'brain-trail-live-map' }, (_$, event) => {
        opened.push(event.id)
        return {
          value: isPlaced
            ? { isPlaced: true }
            : { isPlaced: false, reason: 'no-surface' },
        }
      })
      on('tool.call', { tool: 'Read' }, () => ({ result: 'QA file' }))
      on('tool.call', { tool: 'mcp__linear__list_issues' }, () => ({
        result: 'QA MCP result',
      }))
      const { ui, host } = await mountReady($, on, empty)
      try {
        await $.session.start({
          cwd: CWD,
          surface: 'desktop',
          isInteractive: true,
        })
        await host.settled()
        await host.clock.settle()
        if (!isPlaced) {
          const command = await mountCommandOutput($)
          try {
            await command.press({ key: 'open-brain-trail' })
            expect(opened).toEqual(['brain-trail-live-map'])
            expect(host.notices).toContain(
              'Could not display Brain Trail. Use /brain-trail-v2, then Copy link to open the dashboard in a browser.',
            )
          } finally {
            await command.unmount()
          }
          return
        }
        await ui.press({ key: 'open-brain-trail' })
        expect(opened).toEqual(['brain-trail-live-map'])
        const pane = await $.ui.mount({
          plugin: 'brain-trail-v2',
          component: 'Pane',
          requestId: opened[0]!,
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
          const before = await pane.find({ type: 'Svg' })
          expect(before?.props.alt).toMatch(/0 files touched/)
          const recorded = host.waitForState((event) => event.key === 'events')
          await $.tool.call(toolRead)
          await recorded
          await host.clock.settle()
          const after = await pane.find({ type: 'Svg' })
          expect(after?.props.alt).toMatch(/1 files? touched/)
          expect(after?.props.source).not.toEqual(before?.props.source)

          await pane.press({ key: 'view-3d' })
          expect((await pane.find({ key: 'view-3d' }))?.props.label).toBe('2D')
          const projection = (await pane.find({ type: 'Svg' }))?.props.source
          expect(projection).toMatch(/>app\.ts<\/text>/)
          expect(projection).not.toEqual(after?.props.source)
          expect(await pane.find({ key: 'turn-left' })).toBeDefined()
          await pane.press({ key: 'follow' })
          await host.clock.settle()
          expect(
            (await pane.find({ type: 'Button', key: 'follow' }))?.props.label,
          ).toBe('Stop following')
          await pane.press({ key: 'turn-left' })
          expect((await pane.find({ type: 'Svg' }))?.props.source).not.toEqual(
            projection,
          )
          expect(
            (await pane.find({ type: 'Button', key: 'follow' }))?.props.label,
          ).toBe('Follow Claude')
          const nextRead = host.waitForState(
            ({ key, value }) =>
              key === 'events' && JSON.stringify(value).includes('notes/b.md'),
          )
          await $.tool.call({ tool: 'Read', file_path: `${CWD}/notes/b.md` })
          await nextRead
          await host.clock.settle()
          const liveProjection = await pane.find({ type: 'Svg' })
          expect(liveProjection?.props.source).toMatch(/>b<\/text>/)
          expect(liveProjection?.props.alt).toMatch(/2 files touched/)
          for (const count of [1, 2]) {
            const called = host.waitForState(
              ({ key, value }) =>
                key === 'events' &&
                (JSON.stringify(value).match(/"k":"mcp"/g)?.length ?? 0) ===
                  count,
            )
            await $.tool.call({ tool: 'mcp__linear__list_issues' })
            await called
            await host.clock.settle()
            const withMcp = await pane.find({ type: 'Svg' })
            expect(withMcp?.props.source).toMatch(
              new RegExp(`>Linear · ${count}</text>`),
            )
          }
          host.seed('events', [
            { k: 'mcp', server: 'unlisted-service', tool: 'list', at: 1 },
            { k: 'mcp', server: 'gmail', tool: 'list', at: 2 },
          ])
          await pane.redraw()
          const brands = (await pane.find({ type: 'Svg' }))?.props
            .source as string
          expect(brands).toContain(`<image href="${LOGOS.Gmail}"`)
          expect(brands).toMatch(
            /<title>Unlisted service<\/title><circle[^>]*\/><text[^>]*>U<\/text>/,
          )
          expect(brands).toMatch(/>Gmail · 1<\/text>/)
          expect(brands.length).toBeLessThanOrEqual(131_072)
          await pane.press({ key: 'view-3d' })

          await pane.press({ key: 't-context' })
          expect((await pane.find({ key: 't-context' }))?.props.variant).toBe(
            'primary',
          )
          await pane.press({ key: 't-map' })
          expect(await pane.find({ key: 'lg-btn-read' })).toBeDefined()
          await pane.press({ key: 'lg-btn-read' })
          expect((await pane.find({ key: 't-files' }))?.props.variant).toBe(
            'primary',
          )
          await pane.press({ key: 't-map' })

          host.seed('events', [
            ...Array.from({ length: 360 }, (_, i) => ({
              k: 'mcp',
              server: `service-${i}`,
              tool: 'list',
              at: i,
            })),
            { k: 'read', p: 'src/app.ts', at: 360 },
          ])
          await pane.redraw()
          const dense = (await pane.find({ type: 'Svg' }))?.props.source
          expect(dense).toMatch(/>app\.ts<\/text>/)
          expect((dense as string).length).toBeLessThanOrEqual(131_072)
          await pane.press({ key: 'view-3d' })
          const denseProjection = (await pane.find({ type: 'Svg' }))?.props
          expect(denseProjection?.source).toMatch(/>Service 359 · 1<\/text>/)
          expect(denseProjection?.alt).toMatch(/360 MCP calls/)

          expect(host.copyCalls).toEqual([])
          expect(host.relayStarted()).toBe(false)
        } finally {
          await pane.unmount()
        }
      } finally {
        await ui.unmount()
      }
    },
  )
}
