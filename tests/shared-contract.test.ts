import { expect, test } from 'claude-code/testing'

import {
  reduceSharedView,
  sharedView,
  VIEW_STATE0,
} from '../hooks/view-controller'
import { applySettingsPatch } from '../hooks/view-settings'
import { parseCommand } from '../types/browser'

const request = (command: unknown) => ({ v: 1, generation: 1, command })

test('browser commands accept targeted settings and reject extra authority', () => {
  const clear = request({ kind: 'settings', patch: { planUsd: null } })
  expect(parseCommand(clear)).toEqual(clear)
  expect(parseCommand(request({ kind: 'settings', patch: {} }))).toBeUndefined()
  expect(
    parseCommand(request({ kind: 'settings', patch: { planUsd: -1 } })),
  ).toBeUndefined()
  expect(
    parseCommand(
      request({ kind: 'settings', patch: { band: false, root: '/other' } }),
    ),
  ).toBeUndefined()
  expect(
    parseCommand(
      request({ kind: 'preview-read', ref: { p: 'a.md', root: '/other' } }),
    ),
  ).toBeUndefined()
  expect(
    parseCommand(request({ kind: 'clear-trail', extra: true })),
  ).toBeUndefined()
  expect(parseCommand({ ...clear, generation: 0 })).toBeUndefined()
})

test('clearing a cost plan preserves unrelated settings', () => {
  const current = {
    openMd: 'preview',
    openOther: 'default',
    hover: true,
    band: false,
    planUsd: 30,
  }
  expect(applySettingsPatch(current, { planUsd: null })).toEqual({
    openMd: 'preview',
    openOther: 'default',
    hover: true,
    band: false,
  })
  expect(current.planUsd).toBe(30)
})

test('shared replay uses host event bounds even when the command claims more steps', () => {
  const initial = sharedView(VIEW_STATE0)
  const started = reduceSharedView(
    initial,
    { kind: 'replay-play', steps: 1000 },
    3,
  )
  expect(started.play).toEqual({ step: 0, playing: true })
  const last = reduceSharedView(
    { ...started, play: { step: 2, playing: true } },
    { kind: 'replay-step', by: 1, steps: 1000 },
    3,
  )
  expect(last.play).toEqual({ step: 2, playing: false })
  expect(
    reduceSharedView(last, { kind: 'replay-play', steps: 1000 }, 0).play,
  ).toEqual({ step: null, playing: false })
})

test('shared preview and follow do not project another surface tab or camera', () => {
  const surface = {
    ...VIEW_STATE0,
    tab: 'settings' as const,
    camera: { x: 10, y: 20, side: 30 },
  }
  const preview = reduceSharedView(
    sharedView(surface),
    { kind: 'preview', ref: { p: 'notes/a.md' } },
    2,
  )
  const following = reduceSharedView(
    preview,
    { kind: 'follow', following: false },
    2,
  )
  expect(following).toEqual({
    preview: { p: 'notes/a.md' },
    zoomed: true,
    play: { step: null, playing: false },
  })
  expect(Object.keys(following).sort()).toEqual(['play', 'preview', 'zoomed'])
  expect(surface.tab).toBe('settings')
  expect(surface.camera).toEqual({ x: 10, y: 20, side: 30 })
})
