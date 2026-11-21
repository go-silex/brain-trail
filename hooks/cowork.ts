import type { TrailEvent } from '../types/model'
import { assembleCapture } from './acts'
import { splitMcp } from './mcp'

export type CoworkReceipt = {
  v: 1
  n: number
  at: number
  ev: 'tool' | 'start' | 'end'
  tool?: string
  ok?: boolean
  agent?: boolean
  files?: { p: string; k: 'read' | 'write' }[]
  seen?: string[]
  mcp?: { server: string; tool: string; source?: string }
}

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  new TextEncoder().encode(v).length <= max &&
  ![...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
const absolute = (v: unknown): v is string =>
  text(v, 4096) &&
  (/^\//.test(v) || /^[A-Za-z]:[\\/]/.test(v) || /^\\\\[^\\]+\\[^\\]+/.test(v))

// Rebuild the allowlisted shape rather than passing arbitrary server fields downstream.
export const parseCoworkReceipt = (
  value: unknown,
): CoworkReceipt | undefined => {
  if (
    !object(value) ||
    value.v !== 1 ||
    !Number.isSafeInteger(value.n) ||
    (value.n as number) < 1 ||
    !Number.isSafeInteger(value.at) ||
    (value.at as number) < 0 ||
    (value.ev !== 'tool' && value.ev !== 'start' && value.ev !== 'end')
  )
    return undefined
  const base: CoworkReceipt = {
    v: 1,
    n: value.n as number,
    at: value.at as number,
    ev: value.ev,
  }
  if (value.ev !== 'tool') return base
  if (
    !text(value.tool, 128) ||
    typeof value.ok !== 'boolean' ||
    typeof value.agent !== 'boolean'
  )
    return undefined
  base.tool = value.tool
  base.ok = value.ok
  base.agent = value.agent
  if (value.files !== undefined) {
    if (
      !Array.isArray(value.files) ||
      value.files.length > 200 ||
      !value.files.every(
        (f) =>
          object(f) && absolute(f.p) && (f.k === 'read' || f.k === 'write'),
      )
    )
      return undefined
    base.files = value.files.map((f) => ({
      p: f.p as string,
      k: f.k as 'read' | 'write',
    }))
  }
  if (value.seen !== undefined) {
    if (
      !Array.isArray(value.seen) ||
      value.seen.length > 200 ||
      !value.seen.every(absolute)
    )
      return undefined
    base.seen = [...value.seen]
  }
  if (value.mcp !== undefined) {
    const m = value.mcp
    if (
      !object(m) ||
      !text(m.server, 128) ||
      !text(m.tool, 128) ||
      (m.source !== undefined && !text(m.source, 128))
    )
      return undefined
    base.mcp = {
      server: m.server,
      tool: m.tool,
      ...(typeof m.source === 'string' ? { source: m.source } : {}),
    }
  }
  return base
}

const plumbing: Record<string, true> = {
  cowork: true,
  'cowork-onboarding': true,
  dispatch: true,
  plugins: true,
  session_info: true,
  skills: true,
  workspace: true,
  visualize: true,
  'claude-in-chrome': true,
  'mcp-registry': true,
  'scheduled-tasks': true,
}
const slash = (p: string) => p.replace(/\\/g, '/')
const directory = (p: string) => {
  const i = p.lastIndexOf('/')
  return i === 0 ? '/' : i === 2 && p[1] === ':' ? p.slice(0, 3) : p.slice(0, i)
}
const commonRoot = (paths: string[]) => {
  if (!paths.length) return ''
  let root = directory(paths[0]!)
  for (const p of paths.slice(1)) {
    const dir = directory(p)
    while (
      root &&
      dir !== root &&
      !dir.startsWith(root.endsWith('/') ? root : `${root}/`)
    ) {
      const next = directory(root.replace(/\/$/, ''))
      if (next === root) return ''
      root = next
    }
  }
  return root
}
const relative = (p: string, root: string) =>
  root && p.startsWith(root.endsWith('/') ? root : `${root}/`)
    ? p.slice(root.length + (root.endsWith('/') ? 0 : 1))
    : p
// Desktop keeps a task's own folders (outputs, uploads) under its session directory: show them as one short
// top-level folder instead of letting that deep Desktop path become the map's common root.
const TASK_DIR =
  /^.*\/local-agent-mode-sessions\/[^/]+\/[^/]+\/(?:agent\/)?local_[^/]+\/([^/]+)(\/.*)?$/
const taskPath = (p: string) => {
  const m = TASK_DIR.exec(p)
  return m ? `Cowork ${m[1]}${m[2] ?? ''}` : undefined
}

export const projectCowork = (
  receipts: readonly CoworkReceipt[],
): {
  root: string
  paths: string[]
  events: TrailEvent[]
  connected: [string, string[]][]
} => {
  const ordered = [...receipts].sort((a, b) => a.at - b.at || a.n - b.n)
  const all = ordered.flatMap((r) =>
    r.ev === 'tool' && r.ok
      ? [
          ...(r.files ?? []).map((f) => slash(f.p)),
          ...(r.seen ?? []).map(slash),
        ]
      : [],
  )
  const root = commonRoot(all.filter((p) => taskPath(p) === undefined))
  const place = (p: string) => {
    const s = slash(p)
    return taskPath(s) ?? relative(s, root)
  }
  const paths = [...new Set(all.map(place))].sort()
  const events: TrailEvent[] = []
  const connected = new Map<string, Set<string>>()
  for (const r of ordered) {
    if (r.ev !== 'tool' || !r.tool) continue
    const agent = r.agent ? { agent: true as const } : {}
    const found: TrailEvent[] = r.ok
      ? (r.files ?? []).map((f) => ({
          k: f.k,
          p: place(f.p),
          at: r.at,
          ...agent,
        }))
      : []
    const seen = r.ok ? [...new Set((r.seen ?? []).map(place))] : []
    if (seen.length)
      found.push({ k: 'seen', ps: seen, via: 'search', at: r.at, ...agent })
    const input = r.files?.[0] && r.ok ? { file_path: place(r.files[0].p) } : {}
    const capture = assembleCapture({
      tool: r.tool,
      input,
      output: '',
      at: r.at,
      ...agent,
      isError: !r.ok,
      touch: { found, metas: found.map(() => []) },
    })
    if (r.tool.startsWith('mcp__')) {
      const split = splitMcp(r.tool)
      const server = r.mcp?.server ?? split.server
      const tool = r.mcp?.tool ?? split.tool
      events.push(...capture.filter((e) => e.k !== 'mcp' && e.k !== 'plan'))
      if (server && tool && !Object.hasOwn(plumbing, server)) {
        if (!capture.some((e) => e.k === 'act'))
          events.push({ k: 'act', tool: r.tool, what: '', at: r.at, ...agent })
        events.push({
          k: 'mcp',
          server,
          tool,
          label: '',
          at: r.at,
          ...(!r.ok ? { err: true as const } : {}),
          ...agent,
        })
        const tools = connected.get(server) ?? new Set<string>()
        tools.add(tool)
        connected.set(server, tools)
      }
    } else events.push(...capture.filter((e) => e.k !== 'plan'))
  }
  return {
    root,
    paths,
    events,
    connected: [...connected].map(([server, tools]) => [server, [...tools]]),
  }
}
