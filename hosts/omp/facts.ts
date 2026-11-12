import type { ToolInfo } from '@oh-my-pi/pi-coding-agent'
import { resolve } from 'node:path'
import { assembleCapture } from '../../hooks/acts'
import { linksIn, pathsIn, touchedBy, type Index } from '../../hooks/files'
import { isLocal } from '../../hooks/mcp'
import type { TrailEvent } from '../../types/model'

export type CapturedTool = {
  name: string
  input: Record<string, unknown>
  output: string
  details: unknown
  isError: boolean
  at: number
  agent?: true
}

const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const names: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  task: 'Task',
}
const physicalPath = (p: string) =>
  p.replace(
    /:(?:raw|img|conflicts|(?:\d+-?\d*|-\d+)(?:,(?:\d+-?\d*|-\d+))?)(?::raw)?$/,
    '',
  )

export const connectedTools = (
  tools: readonly ToolInfo[],
  active: readonly string[],
): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>()
  const enabled = new Set(active)
  for (const tool of tools) {
    const server = tool.mcpServerName
    const name = tool.mcpToolName
    if (!enabled.has(tool.name) || !server || !name || isLocal(server)) continue
    const group = result.get(server) ?? new Set<string>()
    group.add(name)
    result.set(server, group)
  }
  return result
}

export const captureTool = (
  call: CapturedTool,
  tools: readonly ToolInfo[],
  index: Index | undefined,
  cwd: string,
  home: string,
): TrailEvent[] => {
  const meta = tools.find((tool) => tool.name === call.name)
  const mcp =
    meta?.mcpServerName && meta.mcpToolName
      ? { server: meta.mcpServerName, tool: meta.mcpToolName }
      : undefined
  const tool = mcp
    ? `mcp__${mcp.server}__${mcp.tool}`
    : (names[call.name] ??
      (call.name.startsWith('mcp__') ? `MCP tool ${call.name}` : call.name))
  const input: Record<string, unknown> = { ...call.input }
  const detail = object(call.details) ? call.details : undefined
  const paths: string[] = []
  if (
    tool === 'Read' &&
    !call.isError &&
    detail?.kind !== 'url' &&
    detail?.isDirectory !== true
  ) {
    if (Array.isArray(detail?.displayReadTargetLinks)) {
      for (const path of detail.displayReadTargetLinks)
        if (typeof path === 'string') paths.push(path)
    } else if (typeof detail?.resolvedPath === 'string')
      paths.push(detail.resolvedPath)
    else if (
      typeof detail?.displayTarget === 'string' &&
      !detail.displayTarget.includes('://')
    )
      paths.push(detail.displayTarget)
    else if (typeof input.path === 'string' && !input.path.includes('://'))
      paths.push(physicalPath(input.path))
  }
  if (
    tool === 'Write' &&
    typeof input.path === 'string' &&
    !input.path.includes('://')
  )
    paths.push(input.path)
  if (tool === 'Glob' && typeof input.path === 'string')
    input.pattern = input.path
  const start =
    tool === 'Bash' && typeof detail?.cwd === 'string'
      ? resolve(cwd, detail.cwd)
      : tool === 'Bash' && typeof input.cwd === 'string'
        ? resolve(cwd, input.cwd)
        : cwd
  if (tool === 'Edit' && !call.isError && detail) {
    if (Array.isArray(detail.perFileResults)) {
      for (const item of detail.perFileResults)
        if (
          object(item) &&
          item.isError !== true &&
          typeof item.path === 'string'
        )
          paths.push(item.path)
    } else if (typeof detail.path === 'string') paths.push(detail.path)
  }
  if (paths.length) input.file_path = paths[0]
  const touchInput =
    tool === 'Bash' &&
    typeof detail?.cwd === 'string' &&
    typeof input.cwd !== 'string' &&
    typeof input.command === 'string'
      ? {
          ...input,
          command: input.command.replace(
            /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)\s*/,
            '',
          ),
        }
      : input
  const found =
    index && !call.isError && !mcp
      ? touchedBy(
          index,
          tool,
          touchInput,
          call.output,
          [],
          call.at,
          start,
          home,
          call.agent,
        )
      : []
  if (index && paths.length > 1)
    for (const path of paths.slice(1))
      found.push(
        ...touchedBy(
          index,
          tool,
          { file_path: path },
          '',
          [],
          call.at,
          start,
          home,
          call.agent,
        ),
      )
  const result = assembleCapture({
    tool,
    input,
    output: call.output,
    at: call.at,
    agent: call.agent,
    isError: call.isError,
    ...(mcp && index && !call.isError
      ? { searchPaths: pathsIn(index, call.output, cwd, home) }
      : {}),
    ...(!mcp && index && !call.isError
      ? {
          touch: {
            found,
            metas: found.map((event) => {
              if (event.k !== 'read' || event.out || !event.p.endsWith('.md'))
                return []
              const id = index.ids.get(event.p)
              return id === undefined
                ? []
                : [...linksIn(index, id, call.output)].map(
                    (link) => index.paths[link]!,
                  )
            }),
          },
        }
      : {}),
  })
  return result
}
