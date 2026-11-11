import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'brain-trail-v2',
  component: 'Pane',
  requestId: 'brain-trail-v2',
  props: { title: 'Brain Trail', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The engine, with the map tab open and Claude on notes/a.md; other values go to the kit's own state, so writes are read back.
const engine = (on: any, ran: string[][]) => {
  on('state.get', (_: unknown, e: { key: string }, next: (e: unknown) => unknown) => {
    if (e.key === 'tab') return { value: { value: 'map', version: 1 } }
    if (e.key === 'events') return { value: { value: { shape: 'events-1', value: [{ k: 'prompt', text: 'Point', at: 1 }, { k: 'read', p: 'CLAUDE.md', at: 2 }, { k: 'read', p: 'notes/a.md', at: 3 }] }, version: 1 } }
    return next(e)
  })
  on('clock.now', () => ({ value: 10_000 }))
  on('config.list', () => ({ value: [{ key: 'theme', value: 'dark' }] }))
  on('session.cwd', () => ({ value: '/work/demo' }))
  on('session.id', () => ({ value: 's' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200000 } } }))
  on('process.run', (_: unknown, e: { argv: string[] }) => (ran.push(e.argv), { value: { exitCode: 0, stdout: e.argv[0] === 'git' ? 'CLAUDE.md\nsrc/app.ts\nnotes/a.md\nnotes/b.md\n' : '/Users/me', stderr: '', isStdoutTruncated: false } }))
  on('fs.read', () => ({ value: '' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}
const source = async (ui: any) => {
  const map = (await ui.findAll({ type: 'Svg' })).find((s: any) => String(s.props?.alt ?? '').includes('files touched'))
  return String(map?.props?.source ?? '')
}

test('the 3D button shows the brain in the pane: it turns, follows Claude, and a click on the note opens it', async ($, on) => {
  const ran: string[][] = []
  engine(on, ran)
  const first = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await first.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the map opens flat; the 3D button turns it into the brain
  expect(await source(ui)).not.toContain('class="b"')
  await ui.press({ key: 'view-3d' })
  // turning by itself: one keyframe list, slices with their own delay, and it stays under the Svg limit
  let svg = await source(ui)
  expect(svg).toContain('@keyframes s')
  expect(svg).toContain('class="b"')
  expect(svg.length).toBeLessThan(131072)
  expect(await ui.find({ key: 'view-3d' })).toBeDefined()
  // following Claude: still, the note it is on in front, and a click on it opens it
  await ui.press({ key: 'follow' })
  svg = await source(ui)
  expect(svg).not.toContain('@keyframes s')
  const [vx, vy, vw, vh] = /viewBox="([^"]+)"/.exec(svg)![1]!.split(' ').map(Number) as [number, number, number, number]
  const m = /<g transform="translate\(([-\d.]+),([-\d.]+)\)"><circle r="[\d.]+" fill="url\(#g3\)"><animate attributeName="r"/.exec(svg)
  expect(m).not.toBeNull()
  await ui.post({ kind: 'click', fx: (Number(m![1]) - vx) / vw, fy: (Number(m![2]) - vy) / vh }, { in: 'map-hit' })
  expect(ran.some(a => a[0] === 'open' && String(a.at(-1)).endsWith('/work/demo/notes/a.md'))).toBe(true)
  // a drag turns it and stops the turn while held; letting go turns it again
  await ui.press({ key: 'follow' })
  await ui.post({ kind: 'drag', fx: 0.6, fy: 0.5, sfx: 0.4, sfy: 0.5 }, { in: 'map-hit' })
  expect(await source(ui)).not.toContain('@keyframes s')
  await ui.post({ kind: 'dragend' }, { in: 'map-hit' })
  expect(await source(ui)).toContain('@keyframes s')
  // the 2D button brings the flat map back
  await ui.press({ key: 'view-3d' })
  expect(await source(ui)).not.toContain('class="b"')
  await ui.unmount()
})
