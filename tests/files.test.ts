import { expect, test } from 'claude-code/testing'

import { afterCd, describe, keepFile, linksIn, makeIndex, pathsIn, touchedBy } from '../hooks/files'

const ROOT = '/work/my vault'
const HOME = '/Users/me'
const I = makeIndex(ROOT, ['AGENTS.md', 'notes/Plan.md', 'notes/Ideas.md', 'src/app.ts', 'docs/README.md', 'docs/sub/README.md'])

test('a Read inside the folder is a read, outside it is a read of an outside file', async () => {
  const inside = touchedBy(I, 'Read', { file_path: `${ROOT}/notes/Plan.md` }, '', [], 1, ROOT, HOME)
  expect(inside).toEqual([{ k: 'read', p: 'notes/Plan.md', at: 1 }])
  const outside = touchedBy(I, 'Read', { file_path: `${HOME}/.claude/CLAUDE.md` }, '', [], 2, ROOT, HOME)
  expect(outside).toEqual([{ k: 'read', p: `${HOME}/.claude/CLAUDE.md`, at: 2, out: true }])
})

test('an Edit is a write, by a sub-agent when it says so', async () => {
  const w = touchedBy(I, 'Edit', { file_path: `${ROOT}/src/app.ts` }, '', [], 3, ROOT, HOME, true)
  expect(w).toEqual([{ k: 'write', p: 'src/app.ts', at: 3, agent: true }])
})

test('a Bash cat follows the cd and the quotes', async () => {
  const found = touchedBy(I, 'Bash', { command: 'cd notes && cat "Ideas.md" | head -5' }, '', [], 4, ROOT, HOME)
  expect(found.filter(e => e.k === 'read').map(e => (e as { p: string }).p)).toEqual(['notes/Ideas.md'])
})

test('a redirection is a write, an ls reads nothing', async () => {
  const w = touchedBy(I, 'Bash', { command: 'echo hi >> notes/Plan.md' }, '', [], 5, ROOT, HOME)
  expect(w.map(e => e.k)).toEqual(['write'])
  const l = touchedBy(I, 'Bash', { command: 'ls notes/Plan.md' }, '', [], 6, ROOT, HOME)
  expect(l.filter(e => e.k === 'read' || e.k === 'write')).toEqual([])
})

test('names printed by a search are seen, not read: one event for the whole result', async () => {
  const out = 'notes/Plan.md:12:the plan\nsrc/app.ts:3:import x'
  const hits = touchedBy(I, 'Grep', { pattern: 'plan' } as never, out, [], 7, ROOT, HOME)
  expect(hits).toEqual([{ k: 'seen', ps: ['notes/Plan.md', 'src/app.ts'], via: 'search', at: 7 }])
})

test('a sub-agent report and a connector result name files too', async () => {
  const report = touchedBy(I, 'Agent', { prompt: 'find' } as never, `I looked at ${ROOT}/notes/Ideas.md and docs/README.md.`, [], 8, ROOT, HOME)
  expect(report).toEqual([{ k: 'seen', ps: ['notes/Ideas.md', 'docs/README.md'], via: 'search', at: 8 }])
  const json = '{"results":[{"path":"notes/Plan.md","score":0.9},{"path":"docs/sub/README.md"}],"see":"[[Ideas]]"}'
  expect(pathsIn(I, json, ROOT, HOME)).toEqual(['notes/Plan.md', 'docs/sub/README.md', 'notes/Ideas.md'])
})

test('a wide search keeps its names up to the cap, a file read in the same call is not counted twice', async () => {
  const many = makeIndex(ROOT, Array.from({ length: 500 }, (_, i) => `n/${i}.md`))
  expect(pathsIn(many, Array.from({ length: 500 }, (_, i) => `n/${i}.md`).join('\n'), ROOT, HOME).length).toBe(300)
  const both = touchedBy(I, 'Bash', { command: 'grep -l plan notes/Plan.md notes/Ideas.md' }, 'notes/Plan.md\nnotes/Ideas.md', [], 9, ROOT, HOME)
  expect(both.filter(e => e.k === 'seen')).toEqual([])
})

test('the shell keeps its last cd', async () => {
  expect(afterCd('cd notes', ROOT, HOME)).toBe(`${ROOT}/notes`)
  expect(afterCd('cd ..', `${ROOT}/notes`, HOME)).toBe(ROOT)
  expect(afterCd('cd', ROOT, HOME)).toBe(HOME)
})

test('wikilinks and relative links resolve, an ambiguous bare name does not', async () => {
  const plan = I.ids.get('notes/Plan.md')!
  const links = linksIn(I, plan, 'See [[Ideas]] and [the agents](../AGENTS.md) and [[README]]')
  expect([...links].map(n => I.paths[n]).sort()).toEqual(['AGENTS.md', 'notes/Ideas.md'])
})

test('a file says what it is through its front matter, its heading or its first comment', async () => {
  expect(describe('---\ndescription: The plan for Q4\n---\n# Title')).toBe('The plan for Q4')
  expect(describe('Intro\n## Roadmap 2026\ntext')).toBe('Roadmap 2026')
  expect(describe('// Packs the folder into one disc\nexport const x = 1')).toBe('Packs the folder into one disc')
})

test('media and heavy folders stay out of the map', async () => {
  expect(keepFile('a/photo.png')).toBe(false)
  expect(keepFile('node_modules/x/index.js')).toBe(false)
  expect(keepFile('.claude/settings.json')).toBe(true)
  expect(keepFile('notes/Plan.md')).toBe(true)
})
