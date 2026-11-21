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
