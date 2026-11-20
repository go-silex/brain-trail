import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { LOGOS } from '../hooks/logos'
import {
  createMapRenderer,
  DARK,
  kindColors,
  LIGHT,
  packFiles,
  type Layout,
} from '../hooks/map'
import { brain, CAM0 } from '../hooks/scene3d'
import { drawSpin, pickSpin } from '../hooks/spin'
import type { Trail } from '../types/model'
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

test('native map SVG keeps neutral and seen files above folder fills in both themes', async () => {
  const layout = packFiles(['notes/a.md', 'notes/b.md', 'notes/c.md'], 'notes')
  const trail: Trail = {
    state: new Map([
      [1, { k: 'hit', count: 1 }],
      [2, { k: 'link', count: 1 }],
    ]),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  for (const palette of [DARK, LIGHT]) {
    const { svg } = createMapRenderer().draw(layout, trail, palette, {
      zoomed: false,
      widthPx: 800,
      now: 0,
      outside: 0,
      filesWord: 'files',
      services: [],
    })
    const colors = kindColors(palette)
    const folder = svg.lastIndexOf('<ellipse class="e')
    expect(folder).toBeGreaterThanOrEqual(0)
    for (const color of [colors.node, colors.hit, colors.link]) {
      expect(svg.indexOf(`stroke="${color}"`)).toBeGreaterThan(folder)
    }
  }
})

test('native 3D preserves category colors and depth in still and spinning SVG', async () => {
  const layout = packFiles(['notes/a.md', 'notes/b.md', 'notes/c.md'], 'notes')
  const trail: Trail = {
    state: new Map([
      [1, { k: 'hit', count: 1 }],
      [2, { k: 'link', count: 1 }],
    ]),
    moves: [],
    calls: [],
    perSvc: new Map(),
  }
  for (const palette of [DARK, LIGHT]) {
    for (const spin of [false, true]) {
      const { svg } = drawSpin(layout, trail, palette, {
        widthPx: 800,
        now: 0,
        cam: { ...CAM0, spin },
        follow: false,
        filesWord: 'files',
        outside: 0,
        dark: palette === DARK,
      })
      expect(svg).toContain('<path class="hit"')
      expect(svg).toContain('<path class="link"')
      expect(svg).toContain(`.hit{stroke:${kindColors(palette).hit}`)
      if (spin) expect(svg).toContain('<animateMotion calcMode="linear"')
      else expect(svg).toMatch(/<path class="d1" style="stroke-opacity:/)
      expect(svg.length).toBeLessThanOrEqual(131_072)
    }
  }
})

test('3D picking follows bounded activity-first sampling', async () => {
  const files: Layout['files'] = Array.from({ length: 9001 }, (_, i) => [
    `${i}.md`,
    i === 0 ? 100 : i === 1 ? 1700 : 900,
    i === 0 ? 100 : i === 1 ? 1700 : 900,
  ])
  const layout: Layout = {
    size: 1800,
    dot: 2,
    files,
    groups: [],
    title: 'sample',
  }
  const b = brain(layout)
  for (const kind of ['hit', 'link'] as const) {
    const trail: Trail = {
      state: new Map([[1, { k: kind, count: 1 }]]),
      moves: [],
      calls: [],
      perSvc: new Map(),
    }
    const { svg, view } = drawSpin(layout, trail, DARK, {
      widthPx: 800,
      now: 0,
      cam: { ...CAM0, spin: false },
      follow: false,
      filesWord: 'files',
      outside: 0,
      dark: true,
    })
    const pick = (n: number) => {
      const phi = b.a[n]! + view.yaw
      const x = b.u[n]! * Math.cos(phi)
      const y = -b.v[n]! * view.ce - b.u[n]! * Math.sin(phi) * view.se
      return pickSpin(
        layout,
        view,
        0,
        (x - view.vx) / view.vw,
        (y - view.vy) / view.vh,
        new Set(),
      )
    }
    expect(svg).toContain(`<path class="${kind}"`)
    expect(svg.length).toBeLessThanOrEqual(131_072)
    expect(view.painted?.size).toBe(9000)
    expect(pick(1)).toBe(1)
    expect(pick(0)).toBeUndefined()
  }
})
