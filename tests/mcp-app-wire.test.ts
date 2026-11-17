import { expect, test } from 'claude-code/testing'
import { bootstrap, pulled, reply } from '../hosts/mcp-app/wire'

const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const build = 'a'.repeat(64)
const identity = {
  v: 1,
  wireRevision: 1,
  uiBuildId: build,
  assetDigest: build,
  serverEpoch: token,
  viewKey: token,
}
const state = {
  kind: 'attached',
  generation: 7,
  source: { owner: { host: 'code', sessionId: 's' }, label: 'session' },
}
const cursor = { generation: 7, revision: 3, layoutRev: 2 }
const layout = { v: 1, kind: 'layout', generation: 7, layout: { layoutRev: 2 } }
const snapshot = {
  v: 1,
  kind: 'snapshot',
  generation: 7,
  revision: 3,
  facts: {},
  shared: {},
}

test('accepts only exact bootstrap identity and canonical credentials', () => {
  expect(bootstrap(identity)).toBe(true)
  expect(bootstrap({ ...identity, extra: true })).toBe(false)
  expect(bootstrap({ ...identity, viewKey: `${token.slice(0, -1)}B` })).toBe(
    false,
  )
  expect(bootstrap({ ...identity, uiBuildId: build.toUpperCase() })).toBe(false)
})
test('requires one coherent ordered read for the attached generation', () => {
  expect(pulled({ state, cursor, events: [layout, snapshot] })).toBe(true)
  expect(pulled({ state, cursor, events: [snapshot, layout] })).toBe(false)
  expect(
    pulled({ state, cursor, events: [{ ...snapshot, generation: 8 }] }),
  ).toBe(false)
  expect(
    pulled({ state, cursor, events: [{ ...snapshot, revision: 2 }] }),
  ).toBe(false)
  expect(pulled({ state: { kind: 'detached' }, cursor, events: [] })).toBe(
    false,
  )
})
test('preserves refusals and rejects malformed reply branches', () => {
  const validate = (value: unknown): value is null => value === null
  expect(reply({ v: 1, ok: false, error: 'forbidden' }, validate)).toEqual({
    v: 1,
    ok: false,
    error: 'forbidden',
  })
  expect(reply({ v: 1, ok: false, error: 'other' }, validate)).toBe(undefined)
  expect(reply({ v: 1, ok: true, value: null, extra: true }, validate)).toBe(
    undefined,
  )
})
