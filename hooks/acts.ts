// Claude tool tables: capture, plan, goal sentences, coach rules. Not a generic host.
import type { TrailEvent } from '../types/model'
import { replay, type FoldIndex } from './fold'
import { isLocal, nameServer, splitMcp, toolsByServer } from './mcp'
import { estimate, fmt, type ContextView } from './readout'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const host = (u: string) => {
  const m = /^https?:\/\/([^/]+)/.exec(u)
  return m?.[1] ?? u
}
const fileName = (p: string) => p.split('/').pop() ?? p

const LABEL_KEYS = [
  'query',
  'q',
  'search',
  'subject',
  'title',
  'name',
  'url',
  'prompt',
]
const callLabel = (input: Record<string, unknown>) => {
  for (const k of LABEL_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim() !== '' && !v.includes('@'))
      return v.split(/\s+/).join(' ').slice(0, 80)
  }
  return ''
}

// what an action was about, kept short: a file name, a search, the description Claude gave its command
export const whatOf = (tool: string, input: Record<string, unknown>) => {
  const file = str(input.file_path) || str(input.notebook_path)
  if (file !== '') return fileName(file)
  if (tool === 'Grep' || tool === 'Glob') return str(input.pattern)
  if (tool === 'Bash')
    return str(input.description) || str(input.command).slice(0, 60)
  if (tool === 'WebFetch') return host(str(input.url))
  if (tool === 'WebSearch') return str(input.query)
  if (tool === 'Agent' || tool === 'Task')
    return str(input.description) || str(input.subagent_type)
  if (tool === 'Skill') return str(input.skill) || str(input.command)
  if (tool === 'AskUserQuestion')
    return str(
      (input.questions as { question?: string }[] | undefined)?.[0]?.question,
    )
  if (tool.startsWith('mcp__')) return callLabel(input)
  return ''
}

// the plan Claude keeps: TodoWrite, the task tools, or the app's own task list
export const planOf = (
  tool: string,
  input: Record<string, unknown>,
  at: number,
): TrailEvent | undefined => {
  if (tool === 'TodoWrite' && Array.isArray(input.todos))
    return {
      k: 'plan',
      items: (input.todos as { content?: string; status?: string }[]).map(
        (x) => ({ t: str(x.content), s: str(x.status) }),
      ),
      at,
    }
  if (tool === 'TaskCreate')
    return { k: 'plan', add: { id: '', t: str(input.subject) }, at }
  if (tool === 'TaskUpdate')
    return {
      k: 'plan',
      upd: {
        id: str(input.taskId),
        ...(input.status ? { s: str(input.status) } : {}),
        ...(input.subject ? { t: str(input.subject) } : {}),
      },
      at,
    }
  if (tool.endsWith('__update_plan')) {
    if (Array.isArray(input.items))
      return {
        k: 'plan',
        items: (input.items as { content?: string; status?: string }[]).map(
          (x) => ({ t: str(x.content), s: str(x.status) }),
        ),
        at,
      }
    if (input.advance === true) return { k: 'plan', adv: true, at }
    if (Array.isArray(input.done) || typeof input.start === 'number')
      return {
        k: 'plan',
        done: (input.done as number[] | undefined) ?? [],
        ...(typeof input.start === 'number' ? { start: input.start } : {}),
        at,
      }
  }
  return undefined
}

export type PlanItem = { id: string; t: string; s: string }

// the plan as it stands after every change
export const planNow = (list: readonly TrailEvent[]): PlanItem[] => {
  let items: PlanItem[] = []
  for (const ev of list) {
    if (ev.k !== 'plan') continue
    if (ev.items)
      items = ev.items.map((x, i) => ({ id: String(i + 1), t: x.t, s: x.s }))
    else if (ev.add)
      items = [
        ...items,
        { id: String(items.length + 1), t: ev.add.t, s: 'pending' },
      ]
    else if (ev.upd) {
      const upd = ev.upd
      items = items
        .map((x) =>
          x.id === upd.id ? { ...x, s: upd.s ?? x.s, t: upd.t ?? x.t } : x,
        )
        .filter((x) => x.s !== 'deleted')
    } else if (ev.adv) {
      const cur = items.findIndex((x) => x.s === 'in_progress')
      items = items.map((x, i) =>
        i === cur
          ? { ...x, s: 'completed' }
          : i ===
                (cur === -1
                  ? items.findIndex((y) => y.s === 'pending')
                  : cur + 1) && x.s === 'pending'
            ? { ...x, s: 'in_progress' }
            : x,
      )
    } else if (ev.done || ev.start !== undefined) {
      items = items.map((x, i) =>
        ev.done?.includes(i + 1)
          ? { ...x, s: 'completed' }
          : ev.start === i + 1
            ? { ...x, s: 'in_progress' }
            : x,
      )
    }
  }
  return items
}

const agentOf = (agent?: true) => (agent ? { agent } : {})

export const needsMcpScan = (tool: string, isError: boolean, output: string) =>
  tool.startsWith('mcp__') &&
  !isLocal(splitMcp(tool).server) &&
  !isError &&
  output !== ''

export const needsTouch = (tool: string, isError: boolean) =>
  !tool.startsWith('mcp__') && !isError

export type CaptureFacts = {
  tool: string
  input: Record<string, unknown>
  output: string
  at: number
  agent?: true
  isError: boolean
  // set only after the scan branch ran and the index was ready; omitted means no seen-search event
  searchPaths?: string[]
  touch?: {
    found: readonly TrailEvent[]
    metas: readonly (readonly string[])[]
  }
}

// Events of one tool call, in the order the pane records them. The host still runs load and readMeta before this.
export const assembleCapture = (f: CaptureFacts): TrailEvent[] => {
  const out: TrailEvent[] = []
  const plan = planOf(f.tool, f.input, f.at)
  if (plan !== undefined) out.push(plan)
  else if (
    !(f.tool.startsWith('mcp__') && isLocal(splitMcp(f.tool).server)) &&
    f.tool !== 'ToolSearch'
  ) {
    out.push({
      k: 'act',
      tool: f.tool,
      what: whatOf(f.tool, f.input),
      at: f.at,
      ...agentOf(f.agent),
    })
  }
  // what the result added to the main context; a sub-agent's results stay in its own
  if (!f.agent && f.output.length > 0) {
    const fp =
      typeof f.input.file_path === 'string' ? f.input.file_path : undefined
    const label = f.tool.startsWith('mcp__')
      ? splitMcp(f.tool).tool
      : fp !== undefined
        ? fp
        : typeof f.input.command === 'string'
          ? f.input.command.slice(0, 90)
          : typeof f.input.pattern === 'string'
            ? f.input.pattern
            : typeof f.input.url === 'string'
              ? f.input.url
              : typeof f.input.description === 'string'
                ? f.input.description
                : ''
    out.push({
      k: 'cost',
      tool: f.tool,
      label,
      tokens: estimate(f.output),
      at: f.at,
    })
  }
  if (f.tool.startsWith('mcp__')) {
    const { server, tool: t } = splitMcp(f.tool)
    if (!isLocal(server)) {
      out.push({
        k: 'mcp',
        server,
        tool: t,
        label: callLabel(f.input),
        at: f.at,
        ...(f.isError ? { err: true as const } : {}),
        ...agentOf(f.agent),
      })
      if (
        !f.isError &&
        f.output !== '' &&
        f.searchPaths !== undefined &&
        f.searchPaths.length > 0
      ) {
        out.push({
          k: 'seen',
          ps: f.searchPaths,
          via: 'search',
          at: f.at,
          ...agentOf(f.agent),
        })
      }
    }
  } else if (!f.isError && f.touch !== undefined) {
    const { found, metas } = f.touch
    out.push(...found)
    const touched = new Set(
      found.flatMap((ev) =>
        ev.k === 'read' || ev.k === 'write' ? [ev.p] : [],
      ),
    )
    const viaLink = [
      ...new Set(found.flatMap((ev, j) => (ev.k === 'read' ? metas[j]! : []))),
    ].filter((p) => !touched.has(p))
    if (viaLink.length > 0)
      out.push({
        k: 'seen',
        ps: viaLink,
        via: 'link',
        at: f.at,
        ...agentOf(f.agent),
      })
  }
  return out
}

export const mcpServerRows = (
  tools: readonly { name: string; tokens: number; isLoaded: boolean }[],
) => {
  const byServer = toolsByServer(tools.map((t) => t.name))
  const mcpServers = new Map<
    string,
    { tools: number; tokens: number; loaded: number }
  >()
  for (const t of tools) {
    const server = splitMcp(t.name).server
    const name = nameServer(server, byServer.get(server) ?? new Set())
    const s = mcpServers.get(name) ?? { tools: 0, tokens: 0, loaded: 0 }
    s.tools++
    s.tokens += t.tokens
    if (t.isLoaded) s.loaded++
    mcpServers.set(name, s)
  }
  return { byServer, mcpServers }
}

export const toolLabel = (
  tool: string,
  byServer: ReadonlyMap<string, Set<string>>,
) => {
  if (!tool.startsWith('mcp__')) return tool
  const { server, tool: t } = splitMcp(tool)
  return `${nameServer(server, byServer.get(server) ?? new Set([t]))} · ${t}`
}

// what a service's tool does, from its name: look something up, add, update, send, remove
const verbOf = (
  tool: string,
): 'look' | 'add' | 'update' | 'send' | 'remove' | 'use' => {
  const t = tool.toLowerCase().replace(/^(slack_|notion-)/, '')
  if (
    /^(get|list|search|read|fetch|query|find|load|lookup|semantic|view|download|inspect|check)/.test(
      t,
    )
  )
    return 'look'
  if (/^(create|add|upsert|insert|new|upload|import)/.test(t)) return 'add'
  if (
    /^(update|edit|set|change|modify|apply|mark|move|rename|configure|reorder)/.test(
      t,
    )
  )
    return 'update'
  if (/^(send|post|reply|forward|publish|invite|share|schedule)/.test(t))
    return 'send'
  if (/^(delete|trash|remove|cancel|archive)/.test(t)) return 'remove'
  return 'use'
}

export type GoalPhrases = {
  read: (x: string[]) => string
  write: (x: string[]) => string
  edit: (x: string[]) => string
  search: (x: string[]) => string
  run: (x: string[]) => string
  web: (x: string[]) => string
  websearch: (x: string[]) => string
  agent: (x: string[]) => string
  skill: (x: string[]) => string
  ask: (x: string[]) => string
  service: (svc: string, verb: string, x: string[]) => string
  other: (x: string[]) => string
  byAgent: (t: string) => string
}

type Told = {
  key: string
  items: string[]
  tell: (items: string[]) => string
  agent?: true
}

// each action becomes a sentence; actions of the same kind in a row become one sentence
export const tell = (
  events: readonly TrailEvent[],
  g: GoalPhrases,
  names: ReadonlyMap<string, string>,
) => {
  const out: Told[] = []
  for (const ev of events) {
    if (ev.k !== 'act') continue
    let key = ev.tool,
      item = ev.what,
      phrase: (items: string[]) => string
    if (ev.tool === 'Read') phrase = g.read
    else if (ev.tool === 'Write') phrase = g.write
    else if (['Edit', 'MultiEdit', 'NotebookEdit'].includes(ev.tool)) {
      key = 'Edit'
      phrase = g.edit
    } else if (ev.tool === 'Grep' || ev.tool === 'Glob') {
      key = 'search'
      phrase = g.search
    } else if (ev.tool === 'Bash') phrase = g.run
    else if (ev.tool === 'WebFetch') phrase = g.web
    else if (ev.tool === 'WebSearch') phrase = g.websearch
    else if (ev.tool === 'Agent' || ev.tool === 'Task') phrase = g.agent
    else if (ev.tool === 'Skill') phrase = g.skill
    else if (ev.tool === 'AskUserQuestion') phrase = g.ask
    else if (ev.tool.startsWith('mcp__')) {
      const { server, tool } = splitMcp(ev.tool)
      const svc = names.get(server) ?? nameServer(server, new Set([tool]))
      const verb = verbOf(tool)
      key = `mcp:${svc}:${verb}`
      item = ev.what || tool.replace(/[_-]+/g, ' ')
      phrase = (items) => g.service(svc, verb, items)
    } else {
      key = `other:${ev.tool}`
      item = ev.tool
      phrase = g.other
    }
    const last = out.at(-1)
    if (last !== undefined && last.key === key && last.agent === ev.agent) {
      if (item !== '' && !last.items.includes(item)) last.items.push(item)
      continue
    }
    out.push({
      key,
      items: item !== '' ? [item] : [],
      tell: phrase,
      ...(ev.agent ? { agent: true as const } : {}),
    })
  }
  return out.map((t) =>
    t.agent ? g.byAgent(t.tell(t.items)) : t.tell(t.items),
  )
}

export type DurationCopy = { lessMin: string; mins: (m: number) => string }
export const dur = (ms: number, S: DurationCopy) => {
  const m = Math.round(ms / 60000)
  return m < 1 ? S.lessMin : S.mins(m)
}

// the time a request was made, as the clock on the wall reads it
export const hhmm = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export type GoalBlock = {
  prompt: string
  at: number
  end?: number
  events: TrailEvent[]
}

export const goalBlocks = (list: readonly TrailEvent[]): GoalBlock[] => {
  const blocks: GoalBlock[] = []
  for (const ev of list) {
    if (ev.k === 'prompt') {
      blocks.push({ prompt: ev.text, at: ev.at, events: [] })
      continue
    }
    const b = blocks.at(-1)
    if (b === undefined) continue
    if (ev.k === 'done') b.end = ev.at
    else {
      b.events.push(ev)
      if (ev.k === 'act') b.end = undefined
    }
  }
  return blocks
}

export type CoachCopy = {
  tipBigRead: (f: string, t: string) => { title: string; body: string }
  tipReread: (f: string, n: number) => { title: string; body: string }
  tipSearch: (n: number) => { title: string; body: string }
  tipShort: (p: string, n: number) => { title: string; body: string }
  tipLinks: (n: number) => { title: string; body: string }
  tipMcp: (s: number, u: number, t: string) => { title: string; body: string }
  tipMemory: (t: string) => { title: string; body: string }
  tipWindow: (p: number) => { title: string; body: string }
}

export type CoachFold = {
  index: FoldIndex | undefined
  linked: { has(key: string): boolean; keys(): Iterable<string> }
  connected: ReadonlyMap<string, Set<string>>
}

// what the session's own figures say, with no model call
export const coachTips = (
  list: readonly TrailEvent[],
  b: ContextView | undefined,
  percent: number | undefined,
  S: CoachCopy,
  fold: CoachFold,
) => {
  const tips: { title: string; body: string }[] = []
  // a whole file read when a part would have done
  const big = list
    .flatMap((ev) =>
      ev.k === 'cost' && ev.tool === 'Read' && ev.tokens > 8000 ? [ev] : [],
    )
    .sort((a, z) => z.tokens - a.tokens)[0]
  if (big !== undefined)
    tips.push(S.tipBigRead(fileName(big.label), fmt(big.tokens)))
  // the same note read again and again: its essentials belong in the instructions
  const reads = new Map<string, number>()
  for (const ev of list)
    if (ev.k === 'read' && !ev.agent)
      reads.set(ev.p, (reads.get(ev.p) ?? 0) + 1)
  const again = [...reads].sort((a, z) => z[1] - a[1])[0]
  if (again !== undefined && again[1] >= 3)
    tips.push(S.tipReread(fileName(again[0]), again[1]))
  // many searches for one request: Claude did not know where things are
  let searches = 0,
    most = 0
  for (const ev of list) {
    if (ev.k === 'prompt') {
      most = Math.max(most, searches)
      searches = 0
    }
    if (ev.k === 'act' && (ev.tool === 'Grep' || ev.tool === 'Glob')) searches++
  }
  most = Math.max(most, searches)
  if (most >= 5) tips.push(S.tipSearch(most))
  // a short request that took many actions: the goal was not clear enough
  const blocks: { text: string; acts: number }[] = []
  for (const ev of list) {
    if (ev.k === 'prompt') blocks.push({ text: ev.text, acts: 0 })
    else if (ev.k === 'act' && blocks.length > 0) blocks.at(-1)!.acts++
  }
  const vague = blocks.find((x) => x.text.length < 40 && x.acts >= 8)
  if (vague !== undefined) tips.push(S.tipShort(vague.text, vague.acts))
  // notes chained with no link between them
  const gaps = replay(list, fold.index, fold.linked, fold.connected).gaps.length
  if (gaps >= 3) tips.push(S.tipLinks(gaps))
  // what is loaded before the first message
  const mcpTokens = (b?.mcpTools ?? [])
    .filter((t) => t.isLoaded)
    .reduce((a, t) => a + t.tokens, 0)
  const servers = new Set(
    (b?.mcpTools ?? [])
      .map((t) => splitMcp(t.name).server)
      .filter((s) => !isLocal(s)),
  ).size
  const used = new Set(
    list.flatMap((ev) => (ev.k === 'mcp' ? [ev.server] : [])),
  ).size
  if (mcpTokens > 15000 && servers > used + 3)
    tips.push(S.tipMcp(servers, used, fmt(mcpTokens)))
  const memory = (b?.memoryFiles ?? []).reduce((a, f) => a + f.tokens, 0)
  if (memory > 12000) tips.push(S.tipMemory(fmt(memory)))
  if ((percent ?? 0) >= 50) tips.push(S.tipWindow(percent ?? 0))
  return tips
}
