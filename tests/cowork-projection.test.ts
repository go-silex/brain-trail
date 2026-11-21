import { expect, test } from 'claude-code/testing'
import {
  parseCoworkReceipt,
  projectCowork,
  type CoworkReceipt,
} from '../hooks/cowork'

const receipt = (
  n: number,
  at: number,
  tool: string,
  extra: Partial<CoworkReceipt> = {},
): CoworkReceipt => ({
  v: 1,
  n,
  at,
  ev: 'tool',
  tool,
  ok: true,
  agent: false,
  ...extra,
})

test('validates and allowlists untrusted receipt fields', async () => {
  const raw = {
    ...receipt(1, 42, 'Read', { files: [{ p: '/work/a.md', k: 'read' }] }),
    prompt: 'private',
    files: [{ p: '/work/a.md', k: 'read', content: 'private' }],
  }
  expect(parseCoworkReceipt(raw)).toEqual(
    receipt(1, 42, 'Read', { files: [{ p: '/work/a.md', k: 'read' }] }),
  )
  expect(parseCoworkReceipt({ ...raw, n: 0 })).toBe(undefined)
  expect(
    parseCoworkReceipt({ ...raw, files: [{ p: 'relative', k: 'read' }] }),
  ).toBe(undefined)
  expect(parseCoworkReceipt({ ...raw, tool: 'x\nsecret' })).toBe(undefined)
  expect(parseCoworkReceipt({ ...raw, seen: Array(201).fill('/a') })).toBe(
    undefined,
  )
})

test('drops connector source and validates partial receipt coverage', async () => {
  const raw = {
    ...receipt(1, 42, 'mcp__drive__read'),
    mcp: { server: 'drive', tool: 'read', source: { private: 'ignored' } },
  }
  const parsed = parseCoworkReceipt(raw)
  expect(parsed?.mcp).toEqual({ server: 'drive', tool: 'read' })
  expect(parseCoworkReceipt({ ...raw, part: 'true' })).toBe(undefined)
  expect(parseCoworkReceipt({ ...raw, part: false })).toEqual(parsed)
  const partial = parseCoworkReceipt({ ...raw, part: true })
  if (!parsed || !partial) throw new Error('Expected valid receipts')
  expect(projectCowork([parsed]).partialInventory).toBe(false)
  expect(projectCowork([partial]).partialInventory).toBe(true)
})

test('orders receipts and projects observed paths relative to their common directory', async () => {
  const result = projectCowork([
    receipt(3, 20, 'Grep', {
      seen: ['/work/sub/c.md', '/work/a.md', '/work/sub/c.md'],
    }),
    receipt(2, 10, 'Edit', {
      files: [{ p: '/work/sub/b.md', k: 'write' }],
      agent: true,
    }),
    receipt(1, 10, 'Read', { files: [{ p: '/work/a.md', k: 'read' }] }),
  ])
  expect(result.root).toBe('/work')
  expect(result.paths).toEqual(['a.md', 'sub/b.md', 'sub/c.md'])
  expect(
    result.events.filter(
      (e) => e.k === 'read' || e.k === 'write' || e.k === 'seen',
    ),
  ).toEqual([
    { k: 'read', p: 'a.md', at: 10 },
    { k: 'write', p: 'sub/b.md', at: 10, agent: true },
    { k: 'seen', ps: ['sub/c.md', 'a.md'], via: 'search', at: 20 },
  ])
  expect(
    result.events.some(
      (e) => e.k === 'cost' || e.k === 'plan' || e.k === 'prompt',
    ),
  ).toBe(false)
})

test('only exact Cowork plumbing is excluded and connector failures remain visible', async () => {
  const result = projectCowork([
    receipt(1, 1, 'mcp__workspace__run', {
      mcp: { server: 'workspace', tool: 'run' },
    }),
    receipt(2, 2, 'mcp__workspace-extra__read', {
      mcp: { server: 'workspace-extra', tool: 'read' },
      ok: false,
      files: [{ p: '/secret', k: 'read' }],
    }),
    receipt(3, 3, 'mcp__visualize-extra__go', {
      mcp: { server: 'visualize-extra', tool: 'go' },
    }),
    receipt(4, 4, 'mcp__uuid__read', {
      mcp: { server: 'Google_Drive', tool: 'read_file_content' },
    }),
  ])
  expect(result.paths).toEqual([])
  expect(result.connected).toEqual([
    ['workspace-extra', ['read']],
    ['visualize-extra', ['go']],
    ['Google_Drive', ['read_file_content']],
  ])
  expect(result.events.filter((e) => e.k === 'mcp')).toEqual([
    {
      k: 'mcp',
      server: 'workspace-extra',
      tool: 'read',
      label: '',
      at: 2,
      err: true,
    },
    { k: 'mcp', server: 'visualize-extra', tool: 'go', label: '', at: 3 },
    {
      k: 'mcp',
      server: 'Google_Drive',
      tool: 'read_file_content',
      label: '',
      at: 4,
    },
  ])
})

test('handles empty and Windows paths without leaking lifecycle events', async () => {
  expect(projectCowork([{ v: 1, n: 1, at: 1, ev: 'end' }])).toEqual({
    root: '',
    paths: [],
    events: [],
    connected: [],
    partialInventory: false,
  })
  const result = projectCowork([
    receipt(1, 1, 'Read', { files: [{ p: 'C:\\work\\a.md', k: 'read' }] }),
  ])
  expect(result.root).toBe('C:/work')
  expect(result.paths).toEqual(['a.md'])
})

test("a task's own Desktop folders do not drag the map root up to the home directory", async () => {
  const session =
    '/home/u/.config/Claude/local-agent-mode-sessions/acct/org/local_abc'
  const result = projectCowork([
    receipt(1, 1, 'Read', {
      files: [{ p: '/home/u/Documents/Client/brief.md', k: 'read' }],
    }),
    receipt(2, 2, 'Write', {
      files: [{ p: `${session}/outputs/report.md`, k: 'write' }],
    }),
    receipt(3, 3, 'Read', {
      files: [
        {
          p: '/home/u/.config/Claude/local-agent-mode-sessions/acct/org/agent/local_ditto_x/uploads/in.md',
          k: 'read',
        },
      ],
    }),
  ])
  expect(result.root).toBe('/home/u/Documents/Client')
  expect(result.paths).toEqual([
    'Cowork outputs/report.md',
    'Cowork uploads/in.md',
    'brief.md',
  ])
  expect(result.events.filter((e) => e.k === 'write')).toEqual([
    { k: 'write', p: 'Cowork outputs/report.md', at: 2 },
  ])
})

test('preserves distinct identities across aliases and literal POSIX backslashes', async () => {
  const base = '/home/u/.config/Claude/local-agent-mode-sessions/acct/org'
  const result = projectCowork([
    receipt(1, 1, 'Grep', {
      seen: [
        '/work/Cowork outputs/report.md',
        '/work/a\\b.md',
        '/work/a/b.md',
        '/work/x/../a/b.md',
        `${base}/local_abcdefgh1/outputs/report.md`,
        `${base}/local_abcdefgh2/outputs/report.md`,
      ],
    }),
  ])
  expect(result.paths).toEqual([
    'Cowork outputs · abcdefgh · 2/report.md',
    'Cowork outputs · abcdefgh/report.md',
    'Cowork outputs/report.md',
    'a/b.md',
    'a\\b.md',
  ])
  const seen = result.events.find((event) => event.k === 'seen')
  expect(seen?.k === 'seen' && new Set(seen.ps).size).toBe(5)
})

test('caps displayed inventory and reports partial coverage', async () => {
  const paths = Array.from({ length: 12001 }, (_, n) => `/work/file-${n}.md`)
  const result = projectCowork(
    paths.map((p, n) =>
      receipt(n + 1, n, 'Read', { files: [{ p, k: 'read' }] }),
    ),
  )
  expect(result.paths.length).toBe(12000)
  expect(result.partialInventory).toBe(true)
  expect(result.events.filter((event) => event.k === 'read').length).toBe(12000)
  expect(result.paths.includes('file-12000.md')).toBe(false)
})
