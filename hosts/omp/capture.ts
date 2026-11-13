import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@oh-my-pi/pi-coding-agent'
import type { SubagentEventPayload } from '@oh-my-pi/pi-coding-agent/task/types'
import { realpath, stat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { makeIndex, linksIn, pairKey, type Index } from '../../hooks/files'
import { isStep } from '../../hooks/fold'
import { coachPrompt, strings } from '../../hooks/i18n'
import { packFiles } from '../../hooks/map'
import {
  coachBusy,
  coachDone,
  coachFailed,
  reduceSharedView,
  replayTick,
  sharedView,
  STEP_MS,
  timerEffect,
  VIEW_STATE0,
} from '../../hooks/view-controller'
import { applySettingsPatch } from '../../hooks/view-settings'
import {
  DEFAULT_SETTINGS,
  findArgv,
  fromFind,
  GIT_LS,
  hash,
  initialSettings,
  isShallow,
  pickFiles,
  vaultProbe,
} from '../../hooks/workspace'
import type { PreviewRef, TrailEvent, TrailSettings } from '../../types/model'
import { RelayRefusal, type RelayClient } from '../relay/client'
import { captureTool, connectedTools, type CapturedTool } from './facts'
import { TrailStore } from './store'
import type {
  CommandRefusal,
  CommandReplies,
  DashboardFeed,
  FactsWire,
  HostCommand,
  LayoutWire,
  ServerEvent,
} from '../../types/browser'

type Lifecycle = {
  onRootStart(
    ctx: ExtensionContext,
    feed: DashboardFeed,
    autoOpen: boolean,
  ): Promise<void>
  onRootStop(): Promise<void>
  authority(): Promise<RelayClient>
}
const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const textOf = (x: unknown): string =>
  Array.isArray(x)
    ? x
        .flatMap((part) =>
          object(part) && part.type === 'text' && typeof part.text === 'string'
            ? [part.text]
            : [],
        )
        .join('\n')
    : typeof x === 'string'
      ? x
      : ''
const refusal = (error: CommandRefusal['error']): CommandRefusal => ({
  ok: false,
  error,
})

export function registerCapture(
  pi: ExtensionAPI,
  lifecycle: Lifecycle,
): DashboardFeed & { refreshApps(): Promise<void> } {
  let ctx: ExtensionContext | undefined
  let store: TrailStore | undefined
  let generation = 0,
    revision = 0,
    layoutRev = 0
  let abort = new AbortController()
  let timer: ReturnType<ExtensionContext['setInterval']> | undefined
  let unsubscribe: (() => void) | undefined
  let index: Index | undefined, layout: LayoutWire | undefined
  let replayTimer: ReturnType<ExtensionContext['setInterval']> | undefined
  let replayEpoch = 0
  let shared = sharedView(VIEW_STATE0)
  let root = ''
  let connected = new Map<string, Set<string>>()
  let linked = new Set<string>()
  let accessed = new Set<string>()
  let calls = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >()
  let completed = new Set<string>()
  let captureEpoch = 0
  let ready: Promise<void> = Promise.resolve()
  let appsReady: Promise<void> = Promise.resolve()
  let compactCount = 0
  let pending: Promise<void> = Promise.resolve()
  const listeners = new Set<(event: ServerEvent) => void>()
  let facts: FactsWire = {
    assistant: 'OMP',
    lang: 'en',
    meter: { window: 0 },
    events: [],
    settings: DEFAULT_SETTINGS,
    coach: { text: '', at: 0, busy: false },
    workspace: { kind: 'loading', since: Date.now() },
    linked: [],
    connected: [],
    costHistory: { median: undefined, count: 0, monthUsd: 0 },
    apps: [],
    instructionFile: 'CLAUDE.md',
  }
  const emit = (event: ServerEvent) => {
    for (const listener of listeners) listener(event)
  }
  const publish = () => {
    revision++
    emit({
      v: 1,
      kind: 'snapshot',
      generation,
      revision,
      facts: { ...facts },
      shared,
    })
  }
  const current = (g: number) =>
    generation === g && !abort.signal.aborted && ctx !== undefined
  const enqueue = (work: () => Promise<void>) => {
    pending = pending.then(work, work).catch((error) => {
      pi.logger.error('Brain Trail capture failed', { error: String(error) })
    })
  }
  const enqueueEvent = (g: number, epoch: number, work: () => void) =>
    enqueue(async () => {
      await ready
      if (current(g) && epoch === captureEpoch) work()
    })
  const append = (events: TrailEvent[]) => {
    if (events.length) {
      facts = { ...facts, events: [...facts.events, ...events].slice(-2000) }
      publish()
    }
  }
  const usage = () => {
    if (!ctx || !store) return
    const usage = ctx.getContextUsage(),
      session = ctx.sessionManager.getSessionId(),
      branch = ctx.sessionManager.getBranch()
    const measured = branch.some(
      (entry) =>
        entry.type === 'model_usage' ||
        (entry.type === 'message' && entry.message.role === 'assistant'),
    )
    const side = store.side(session)
    const usd = measured
      ? ctx.sessionManager.getUsageStatistics().cost + side.usd
      : side.measured
        ? side.usd
        : undefined
    facts = {
      ...facts,
      meter: {
        window: usage?.contextWindow ?? 0,
        ...(usage
          ? {
              tokens: usage.tokens,
              percent: Math.round(usage.percent),
              estimated: true,
            }
          : {}),
        ...(usd !== undefined ? { usd } : {}),
      },
    }
    if (measured)
      store.saveCost(
        session,
        new Date().toISOString().slice(0, 10),
        ctx.sessionManager.getUsageStatistics().cost,
        facts.events.filter((e) => e.k === 'prompt').length,
      )
    facts.costHistory = store.history(
      session,
      new Date().toISOString().slice(0, 7),
    )
  }
  const load = async (g: number, publishReady = true) => {
    const context = ctx
    if (!context) return
    const signal = abort.signal,
      home = homedir()
    try {
      let chosen = context.cwd
      for (const dir of vaultProbe(context.cwd, home)) {
        try {
          if ((await stat(join(dir, '.obsidian'))).isDirectory()) {
            chosen = dir
            break
          }
        } catch {
          /* no vault here */
        }
      }
      const canonical = await realpath(chosen)
      const isVault = await stat(join(canonical, '.obsidian')).then(
        (s) => s.isDirectory(),
        () => false,
      )
      const shallow = isShallow(canonical, home)
      let raw = ''
      if (!shallow) {
        const git = await pi.exec(GIT_LS[0]!, GIT_LS.slice(1), {
          cwd: canonical,
          timeout: 20000,
          signal,
        })
        if (git.code === 0) raw = git.stdout
      }
      if (!raw.trim()) {
        const args = findArgv(shallow)
        const result = await pi.exec(args[0]!, args.slice(1), {
          cwd: canonical,
          timeout: 20000,
          signal,
        })
        if (result.code !== 0 && !result.stdout)
          throw new Error(result.stderr || 'Workspace listing failed')
        raw = fromFind(result.stdout)
      }
      const paths = pickFiles(raw, isVault, canonical)
      const cacheDir = join(getAgentDir(), 'brain-trail'),
        cache = join(cacheDir, `layout-${hash(canonical)}.json`)
      let packed = packFiles(paths, canonical.split('/').pop() || canonical)
      try {
        const cached: unknown = JSON.parse(await readFile(cache, 'utf8'))
        if (
          object(cached) &&
          cached.root === canonical &&
          Array.isArray(cached.paths) &&
          cached.paths.length === paths.length &&
          cached.paths.every((p, i) => p === paths[i]) &&
          object(cached.layout)
        )
          packed = cached.layout as typeof packed
      } catch {
        /* cache is optional */
      }
      if (!current(g)) return
      root = canonical
      const saved = store?.read('settings')
      if (isVault && (!object(saved) || saved.openMd === undefined))
        facts = {
          ...facts,
          settings: { ...facts.settings, openMd: 'Obsidian' },
        }
      index = makeIndex(root, paths)
      linked = new Set()
      layout = { layoutRev: ++layoutRev, root, paths, layout: packed }
      if (publishReady)
        facts = {
          ...facts,
          workspace: { kind: 'ready', layoutRev, shallow },
          linked: [],
        }
      emit({ v: 1, kind: 'layout', generation, layout })
      if (publishReady) publish()
      await mkdir(cacheDir, { recursive: true })
      if (current(g))
        await writeFile(cache, JSON.stringify({ root, paths, layout: packed }))
      return shallow
    } catch (error) {
      if (current(g)) {
        facts = {
          ...facts,
          workspace: { kind: 'failed', message: String(error) },
        }
        publish()
      }
    }
  }
  const capture = async (
    call: CapturedTool,
    key: string,
    g: number,
    epoch = captureEpoch,
  ) => {
    await ready
    if (!current(g) || epoch !== captureEpoch || completed.has(key) || !ctx)
      return
    completed.add(key)
    const context = ctx
    if (call.at <= (store?.clearAt(context.sessionManager.getSessionId()) ?? 0))
      return
    store?.saveCapture(
      context.sessionManager.getSessionId(),
      key,
      context.sessionManager.getLeafId(),
      JSON.stringify(call),
    )
    const result = captureTool(
      call,
      pi.getAllTools(),
      index,
      context.cwd,
      homedir(),
    )
    if (
      !call.isError &&
      ['read', 'write', 'edit'].includes(call.name) &&
      !pi.getAllTools().find((tool) => tool.name === call.name)?.mcpServerName
    ) {
      for (const event of result)
        if (
          (event.k === 'read' || event.k === 'write') &&
          event.out &&
          isAbsolute(event.p)
        )
          accessed.add(event.p)
    }
    if (!current(g) || epoch !== captureEpoch) return
    if (index)
      for (const event of result)
        if (event.k === 'read' && !event.out && event.p.endsWith('.md')) {
          const n = index.ids.get(event.p)
          if (n !== undefined)
            for (const other of linksIn(index, n, call.output))
              linked.add(pairKey(n, other))
        }
    facts = { ...facts, linked: [...linked] }
    append(result)
  }
  const rebuild = (
    context: ExtensionContext,
    entries = context.sessionManager.getBranch(),
    saved = store?.captures(context.sessionManager.getSessionId()) ?? [],
  ) => {
    const session = context.sessionManager.getSessionId(),
      leaf = store?.clearLeaf(session)
    const cut = leaf ? entries.findIndex((entry) => entry.id === leaf) : -1
    const cutoff = store?.clearAt(session) ?? 0
    const selected = (cut < 0 ? entries : entries.slice(cut + 1)).filter(
      (entry) => (Date.parse(entry.timestamp) || 0) > cutoff,
    )
    const branchIds = new Set(selected.map((entry) => entry.id))
    const events: TrailEvent[] = [],
      starts = new Map<
        string,
        { name: string; input: Record<string, unknown> }
      >()
    const savedCalls = new Map(
      saved
        .filter((row) => row.leaf === null || branchIds.has(row.leaf))
        .map((row) => [row.scope, row]),
    )
    for (const entry of selected) {
      const at = Date.parse(entry.timestamp) || Date.now()
      if (entry.type === 'compaction') {
        events.push({ k: 'compact', at })
        continue
      }
      if (entry.type !== 'message') continue
      const m = entry.message
      if (m.role === 'user') {
        const text = textOf(m.content).trim()
        if (text && !text.startsWith('<') && !text.startsWith('/'))
          events.push({ k: 'prompt', text: text.slice(0, 220), at })
      }
      if (m.role === 'assistant') {
        for (const part of m.content)
          if (part.type === 'toolCall')
            starts.set(part.id, { name: part.name, input: part.arguments })
        if (m.stopReason === 'stop') events.push({ k: 'done', at })
      }
      if (m.role === 'toolResult') {
        const start = starts.get(m.toolCallId)
        if (start && !savedCalls.has(`root:${m.toolCallId}`)) {
          completed.add(`root:${m.toolCallId}`)
          const captured = captureTool(
            {
              ...start,
              output: textOf(m.content),
              details: m.details,
              isError: m.isError,
              at,
            },
            pi.getAllTools(),
            index,
            context.cwd,
            homedir(),
          )
          events.push(...captured)
          if (index && !m.isError)
            for (const event of captured)
              if (event.k === 'read' && !event.out && event.p.endsWith('.md')) {
                const id = index.ids.get(event.p)
                if (id !== undefined)
                  for (const other of linksIn(index, id, textOf(m.content)))
                    linked.add(pairKey(id, other))
              }
          if (
            !m.isError &&
            ['read', 'write', 'edit'].includes(start.name) &&
            !pi.getAllTools().find((tool) => tool.name === start.name)
              ?.mcpServerName
          )
            for (const event of captured)
              if (
                (event.k === 'read' || event.k === 'write') &&
                event.out &&
                isAbsolute(event.p)
              )
                accessed.add(event.p)
        }
      }
    }
    for (const row of savedCalls.values()) {
      try {
        const value: unknown = JSON.parse(row.payload)
        if (
          !object(value) ||
          typeof value.name !== 'string' ||
          !object(value.input) ||
          typeof value.output !== 'string' ||
          typeof value.isError !== 'boolean' ||
          typeof value.at !== 'number' ||
          value.at <= (store?.clearAt(session) ?? 0)
        )
          continue
        const call: CapturedTool = {
          name: value.name,
          input: value.input,
          output: value.output,
          details: value.details,
          isError: value.isError,
          at: value.at,
          ...(value.agent === true ? { agent: true } : {}),
        }
        completed.add(row.scope)
        const captured = captureTool(
          call,
          pi.getAllTools(),
          index,
          context.cwd,
          homedir(),
        )
        events.push(...captured)
        if (index && !call.isError)
          for (const event of captured)
            if (event.k === 'read' && !event.out && event.p.endsWith('.md')) {
              const id = index.ids.get(event.p)
              if (id !== undefined)
                for (const other of linksIn(index, id, call.output))
                  linked.add(pairKey(id, other))
            }
        if (
          !call.isError &&
          ['read', 'write', 'edit'].includes(call.name) &&
          !pi.getAllTools().find((tool) => tool.name === call.name)
            ?.mcpServerName
        )
          for (const event of captured)
            if (
              (event.k === 'read' || event.k === 'write') &&
              event.out &&
              isAbsolute(event.p)
            )
              accessed.add(event.p)
      } catch (error) {
        pi.logger.error('Brain Trail saved capture is unreadable', {
          error: String(error),
        })
      }
    }
    events.sort((a, b) => a.at - b.at)
    facts = { ...facts, events: events.slice(-2000), linked: [...linked] }
  }
  const restoreChildren = async (
    context: ExtensionContext,
    entries: ReturnType<ExtensionContext['sessionManager']['getBranch']>,
    g: number,
  ) => {
    const sessionFile = context.sessionManager.getSessionFile()
    if (!sessionFile?.endsWith('.jsonl')) return
    const cutoff = store?.clearAt(context.sessionManager.getSessionId()) ?? 0
    const childIds = (details: unknown, completion = false): string[] => {
      if (!object(details)) return []
      const ids = new Set<string>()
      const add = (value: unknown) => {
        if (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value))
          ids.add(value)
      }
      if (completion) {
        if (Array.isArray(details.jobs))
          for (const job of details.jobs)
            if (object(job) && job.type === 'task') add(job.agentId)
      } else {
        for (const list of [details.results, details.progress])
          if (Array.isArray(list))
            for (const item of list) if (object(item)) add(item.id)
        // Async job IDs can be collision-suffixed and are not necessarily agent IDs.
        // Use the job ID only when genuine progress/result metadata corroborates it.
        if (
          object(details.async) &&
          details.async.type === 'task' &&
          typeof details.async.jobId === 'string' &&
          ids.has(details.async.jobId)
        )
          add(details.async.jobId)
      }
      return [...ids]
    }
    const visited = new Set<string>()
    const visit = async (
      dir: string,
      id: string,
      depth: number,
    ): Promise<void> => {
      if (!current(g) || depth > 8) return
      const visitKey = join(dir, id)
      if (visited.has(visitKey)) return
      visited.add(visitKey)
      const file = join(dir, `${id}.jsonl`)
      let source: string
      try {
        const info = await stat(file)
        if (!info.isFile() || info.size > 16 * 1024 * 1024) return
        source = await readFile(file, {
          encoding: 'utf8',
          signal: abort.signal,
        })
      } catch {
        return
      }
      if (!current(g)) return
      const rows: Record<string, unknown>[] = []
      for (const line of source.split('\n')) {
        try {
          const entry: unknown = JSON.parse(line)
          if (object(entry)) rows.push(entry)
        } catch {
          /* skip malformed journal record */
        }
      }
      const byId = new Map(
        rows.flatMap((row) =>
          typeof row.id === 'string' ? [[row.id, row] as const] : [],
        ),
      )
      const branch: Record<string, unknown>[] = []
      let cursor = [...rows].reverse().find((row) => typeof row.id === 'string')
      const seen = new Set<string>()
      while (cursor && typeof cursor.id === 'string' && !seen.has(cursor.id)) {
        seen.add(cursor.id)
        branch.push(cursor)
        cursor =
          typeof cursor.parentId === 'string'
            ? byId.get(cursor.parentId)
            : undefined
      }
      branch.reverse()
      const callsById = new Map<
        string,
        { name: string; input: Record<string, unknown> }
      >()
      for (const entry of branch) {
        if (!current(g) || entry.type !== 'message' || !object(entry.message))
          continue
        const message = entry.message
        const at =
          typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : 0
        if (
          message.role === 'custom' &&
          message.customType === 'async-result'
        ) {
          for (const child of childIds(message.details, true))
            await visit(join(dir, id), child, depth + 1)
          continue
        }
        if (message.role === 'assistant' && Array.isArray(message.content)) {
          for (const part of message.content)
            if (
              object(part) &&
              part.type === 'toolCall' &&
              typeof part.id === 'string' &&
              typeof part.name === 'string' &&
              object(part.arguments)
            )
              callsById.set(part.id, { name: part.name, input: part.arguments })
        }
        if (
          message.role !== 'toolResult' ||
          typeof message.toolCallId !== 'string'
        )
          continue
        const start = callsById.get(message.toolCallId),
          key = `task:${id}:${message.toolCallId}`
        if (start && at > cutoff && !completed.has(key)) {
          await capture(
            {
              ...start,
              output: textOf(message.content),
              details: message.details,
              isError: message.isError === true,
              at,
              agent: true,
            },
            key,
            g,
          )
        }
        for (const child of childIds(message.details))
          await visit(join(dir, id), child, depth + 1)
      }
    }
    for (const entry of entries) {
      if (entry.type !== 'message') continue
      const message = entry.message
      if (message.role === 'toolResult' && message.toolName === 'task') {
        for (const id of childIds(message.details))
          await visit(sessionFile.slice(0, -6), id, 0)
      } else if (
        message.role === 'custom' &&
        message.customType === 'async-result'
      ) {
        for (const id of childIds(message.details, true))
          await visit(sessionFile.slice(0, -6), id, 0)
      }
    }
  }
  const bind = async (context: ExtensionContext, first: boolean) => {
    if (context.agent.kind !== 'main') return
    replayEpoch++
    if (replayTimer !== undefined && ctx) ctx.clearTimer(replayTimer)
    replayTimer = undefined
    shared = sharedView(VIEW_STATE0)
    abort.abort()
    abort = new AbortController()
    generation++
    revision = 0
    ctx = context
    index = undefined
    layout = undefined
    root = context.cwd
    linked = new Set()
    accessed = new Set()
    calls = new Map()
    completed = new Set()
    captureEpoch++
    if (!store) store = new TrailStore(getAgentDir())
    const savedLang = store.read('lang'),
      savedSettings = store.read('settings')
    connected = connectedTools(pi.getAllTools(), pi.getActiveTools())
    facts = {
      assistant: 'OMP',
      lang: savedLang === 'fr' ? 'fr' : 'en',
      meter: { window: 0 },
      events: [],
      settings: initialSettings(
        false,
        object(savedSettings)
          ? (savedSettings as Partial<TrailSettings>)
          : undefined,
      ),
      coach: { text: '', at: 0, busy: false },
      workspace: { kind: 'loading', since: Date.now() },
      linked: [],
      connected: [...connected].map(([k, v]) => [k, [...v]]),
      costHistory: { median: undefined, count: 0, monthUsd: 0 },
      apps: [],
      instructionFile: 'CLAUDE.md',
    }
    const g = generation
    const branchAtBind = context.sessionManager.getBranch(),
      capturesAtBind = store.captures(context.sessionManager.getSessionId())
    rebuild(context, branchAtBind, capturesAtBind)
    usage()
    publish()
    const initialEvents = facts.events
    const bindEpoch = captureEpoch
    ready = load(g, false).then((shallow) => {
      if (!current(g)) return
      if (bindEpoch === captureEpoch) {
        const live = facts.events.slice(initialEvents.length)
        rebuild(context, branchAtBind, capturesAtBind)
        if (live.length)
          facts = { ...facts, events: [...facts.events, ...live].slice(-2000) }
      }
      if (shallow !== undefined)
        facts = { ...facts, workspace: { kind: 'ready', layoutRev, shallow } }
      publish()
    })
    enqueue(async () => {
      await ready
      if (!current(g) || bindEpoch !== captureEpoch) return
      await restoreChildren(context, branchAtBind, g)
      if (current(g) && bindEpoch === captureEpoch) {
        facts = {
          ...facts,
          events: [...facts.events].sort((a, b) => a.at - b.at),
        }
        publish()
      }
    })
    const bindSignal = abort.signal
    appsReady = lifecycle
      .authority()
      .then((authority) => authority.listApps())
      .then((apps) => {
        if (ctx === context && !bindSignal.aborted) {
          facts = { ...facts, apps }
          publish()
        }
      })
      .catch((error) => {
        pi.logger.error('Brain Trail app discovery failed', {
          error: String(error),
        })
      })
    void stat(join(context.cwd, 'AGENTS.md')).then(
      () => {
        if (ctx === context && !bindSignal.aborted) {
          facts = { ...facts, instructionFile: 'AGENTS.md' }
          publish()
        }
      },
      () => {},
    )
    if (first) {
      unsubscribe = pi.events.on('task:subagent:event', (data) => {
        if (!object(data) || typeof data.id !== 'string' || !object(data.event))
          return
        const payload = data as unknown as SubagentEventPayload,
          event = payload.event,
          scope = `task:${payload.id}`
        if (event.type === 'tool_execution_start' && object(event.args))
          calls.set(`${scope}:${event.toolCallId}`, {
            name: event.toolName,
            input: event.args,
          })
        if (event.type === 'tool_execution_end') {
          const key = `${scope}:${event.toolCallId}`,
            start = calls.get(key),
            result: unknown = event.result
          if (start && object(result)) {
            const g = generation,
              epoch = captureEpoch
            const call: CapturedTool = {
              ...start,
              output: textOf(result.content),
              details: result.details,
              isError: event.isError === true,
              at: Date.now(),
              agent: true,
            }
            enqueue(() => capture(call, key, g, epoch))
          }
        }
      })
      timer = context.setInterval(() => {
        if (ctx) {
          usage()
          publish()
        }
      }, 4000)
      await lifecycle.onRootStart(
        context,
        feed,
        store.read('autoOpen') !== false && context.hasUI,
      )
    }
  }
  const resolveRef = (ref: PreviewRef): string | undefined => {
    if (!root) return undefined
    if (ref.out)
      return isAbsolute(ref.p) && accessed.has(ref.p) ? ref.p : undefined
    if (
      isAbsolute(ref.p) ||
      ref.p.split(/[\\/]/).includes('..') ||
      (!index?.ids.has(ref.p) &&
        !facts.events.some(
          (event) =>
            (event.k === 'read' || event.k === 'write') &&
            !event.out &&
            event.p === ref.p,
        ))
    )
      return undefined
    return resolve(root, ref.p)
  }
  const run = async (
    g: number,
    command: HostCommand,
  ): Promise<CommandReplies[HostCommand['kind']] | CommandRefusal> => {
    if (!current(g) || !ctx || !store) return refusal('stale-generation')
    const context = ctx,
      signal = abort.signal,
      epoch = captureEpoch
    const valid = () => current(g) && epoch === captureEpoch
    switch (command.kind) {
      case 'open':
      case 'preview-read': {
        const path = resolveRef(command.ref)
        if (!path) return refusal('forbidden')
        if (command.kind === 'open' && command.app !== 'default') {
          await appsReady
          if (!valid()) return refusal('stale-generation')
        }
        let authority: RelayClient | undefined
        let handle: string | undefined
        try {
          authority = await lifecycle.authority()
          if (!valid()) return refusal('stale-generation')
          if (command.kind === 'open' && command.app !== 'default') {
            const apps = await authority.listApps()
            if (!valid()) return refusal('stale-generation')
            facts = { ...facts, apps }
            publish()
            if (!apps.includes(command.app)) return refusal('forbidden')
          }
          const file = await authority.prepareFile(root, path)
          handle = file.id
          if (!valid()) return refusal('stale-generation')
          if (!command.ref.out && !file.inside) return refusal('forbidden')
          if (!file.inside || command.kind === 'open') {
            if (!context.hasUI) return refusal('forbidden')
            const app = command.kind === 'open' ? ` with ${command.app}` : ''
            const approved = await context.ui.confirm(
              'Brain Trail file access',
              `${command.kind === 'open' ? 'Open' : 'Preview'} ${file.path}${app}?`,
            )
            if (!valid()) return refusal('stale-generation')
            if (approved !== true) return refusal('forbidden')
          }
          if (command.kind === 'preview-read') {
            const text = await authority.readFile(file.id)
            if (!valid()) return refusal('stale-generation')
            return { ok: true, text: text.slice(0, 40001) }
          }
          const verified = await authority.verifyFile(file.id)
          if (!valid()) return refusal('stale-generation')
          if (!verified) return refusal('forbidden')
          const launch = await authority.openFile(
            file.id,
            command.app === 'default' ? undefined : command.app,
            g,
          )
          return { ok: true, launch }
        } catch (error) {
          if (!valid()) return refusal('stale-generation')
          if (error instanceof RelayRefusal) {
            if (error.code === 'missing' && command.kind === 'preview-read')
              return { ok: true, text: null }
            if (error.code === 'missing') return refusal('forbidden')
            if (error.code === 'http') return refusal('disconnected')
            return refusal(error.code)
          }
          return refusal('forbidden')
        } finally {
          if (authority && handle)
            await authority.releaseFile(handle).catch(() => {})
        }
      }
      case 'settings': {
        const next = applySettingsPatch(facts.settings, command.patch)
        const allowed = ['default', 'preview', ...facts.apps]
        if (
          (command.patch.openMd !== undefined &&
            !allowed.includes(command.patch.openMd)) ||
          (command.patch.openOther !== undefined &&
            !allowed.includes(command.patch.openOther))
        )
          return refusal('forbidden')
        store.save('settings', next)
        facts = { ...facts, settings: next }
        publish()
        return { ok: true }
      }
      case 'view': {
        if (
          command.intent.kind === 'preview' &&
          command.intent.ref &&
          !resolveRef(command.intent.ref)
        )
          return refusal('forbidden')
        shared = reduceSharedView(
          shared,
          command.intent,
          facts.events.filter(isStep).length,
        )
        const effect = timerEffect(command.intent)
        if (effect !== 'none') {
          replayEpoch++
          if (replayTimer !== undefined) context.clearTimer(replayTimer)
          replayTimer = undefined
          if (effect === 'start' && shared.play.playing) {
            const clockEpoch = replayEpoch
            replayTimer = context.setInterval(() => {
              if (!current(g) || clockEpoch !== replayEpoch) return
              shared = {
                ...shared,
                play: replayTick(facts.events.filter(isStep).length)(
                  shared.play,
                ),
              }
              if (!shared.play.playing && replayTimer !== undefined) {
                context.clearTimer(replayTimer)
                replayTimer = undefined
                replayEpoch++
              }
              publish()
            }, STEP_MS)
          }
        }
        publish()
        return { ok: true }
      }
      case 'lang':
        store.save('lang', command.lang)
        facts = { ...facts, lang: command.lang }
        publish()
        return { ok: true }
      case 'clear-trail':
        replayEpoch++
        if (replayTimer !== undefined) context.clearTimer(replayTimer)
        replayTimer = undefined
        shared = sharedView(VIEW_STATE0)
        generation++
        revision = 0
        if (layout) emit({ v: 1, kind: 'layout', generation, layout })
        captureEpoch++
        store.setClearLeaf(
          context.sessionManager.getSessionId(),
          context.sessionManager.getLeafId(),
        )
        store.setClearAt(context.sessionManager.getSessionId(), Date.now())
        facts = { ...facts, events: [] }
        linked.clear()
        accessed.clear()
        facts.linked = []
        if (facts.workspace.kind === 'loading') {
          const nextGeneration = generation
          ready = load(nextGeneration).then(() => {})
        }
        publish()
        return { ok: true }
      case 'compact': {
        const before = compactCount
        try {
          await context.compact()
          if (!current(g)) return refusal('stale-generation')
          return {
            ok: true,
            outcome:
              compactCount > before
                ? { kind: 'done' }
                : { kind: 'skipped', reason: 'No compaction was performed' },
          }
        } catch {
          if (!valid()) return refusal('stale-generation')
          return { ok: true, outcome: { kind: 'failed' } }
        }
      }
      case 'refresh-meter':
        usage()
        publish()
        return { ok: true }
      case 'retry-layout':
        facts = { ...facts, workspace: { kind: 'loading', since: Date.now() } }
        publish()
        void load(g)
        return { ok: true }
      case 'coach-analyse': {
        if (!context.runEphemeralTurn) {
          facts = {
            ...facts,
            coach: coachFailed(
              'Side turns are unavailable',
              strings(facts.lang, 'OMP'),
            )(facts.coach),
          }
          publish()
          return refusal('forbidden')
        }
        const lang = facts.lang,
          file = facts.instructionFile,
          session = context.sessionManager.getSessionId(),
          runTurn = context.runEphemeralTurn
        facts = { ...facts, coach: coachBusy(facts.coach) }
        publish()
        void (async () => {
          try {
            let source = ''
            try {
              const authority = await lifecycle.authority()
              if (!valid()) return
              const held = await authority.prepareFile(
                root,
                join(context.cwd, file),
              )
              try {
                if (!valid()) return
                if (!held.inside) throw new Error('forbidden')
                source = (await authority.readFile(held.id)).slice(0, 40000)
              } finally {
                await authority.releaseFile(held.id).catch(() => {})
              }
            } catch (error) {
              if (!(error instanceof RelayRefusal && error.code === 'missing'))
                throw error
            }
            if (!valid()) return
            const reply = await runTurn({
              promptText: `${coachPrompt(lang, file, 'OMP')}\n\n${file} (existing content):\n${source.slice(0, 40000)}`,
              tools: false,
              signal,
              onUsage: (message) => {
                store?.addSide(
                  session,
                  new Date().toISOString().slice(0, 10),
                  message.usage.cost.total,
                )
              },
            })
            if (valid()) {
              facts = {
                ...facts,
                coach: coachDone(reply.replyText, Date.now()),
              }
              usage()
              publish()
            }
          } catch (error) {
            if (valid()) {
              facts = {
                ...facts,
                coach: coachFailed(
                  String(error),
                  strings(lang, 'OMP'),
                )(facts.coach),
              }
              usage()
              publish()
            }
          }
        })()
        return { ok: true }
      }
      case 'coach-apply': {
        const patch = facts.coach.patch
        if (!patch || !context.hasUI || !context.ui.supportsEditor)
          return { ok: true, filled: false }
        context.ui.setEditorText(
          strings(facts.lang, 'OMP').applyPrompt(facts.instructionFile, patch),
        )
        return { ok: true, filled: true }
      }
    }
  }
  const feed: DashboardFeed & { refreshApps(): Promise<void> } = {
    current: () => ({ generation, revision, facts, layout, shared }),
    async refreshApps() {
      const g = generation
      const authority = await lifecycle.authority()
      if (!current(g)) return
      const apps = await authority.listApps()
      if (!current(g)) return
      facts = { ...facts, apps }
      publish()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    execute: async <C extends HostCommand>(g: number, command: C) =>
      (await run(g, command)) as CommandReplies[C['kind']] | CommandRefusal,
  }
  pi.on('session_start', async (_event, context) => {
    await bind(context, true)
  })
  pi.on('session_switch', async (_event, context) => {
    await bind(context, false)
  })
  pi.on('session_branch', async (_event, context) => {
    await bind(context, false)
  })
  pi.on('session_tree', async (_event, context) => {
    await bind(context, false)
  })
  pi.on('session_compact', (_event, context) => {
    if (context.agent.kind === 'main' && ctx) {
      const g = generation,
        epoch = captureEpoch,
        at = Date.now()
      compactCount++
      enqueueEvent(g, epoch, () => {
        append([{ k: 'compact', at }])
        usage()
      })
    }
  })
  pi.on('before_agent_start', (event, context) => {
    if (context.agent.kind === 'main' && ctx && event.reason === 'prompt') {
      const text = event.prompt.trim(),
        g = generation,
        epoch = captureEpoch,
        at = Date.now()
      if (text && !text.startsWith('<') && !text.startsWith('/'))
        enqueueEvent(g, epoch, () =>
          append([{ k: 'prompt', text: text.slice(0, 220), at }]),
        )
    }
  })
  pi.on('agent_end', (event, context) => {
    if (context.agent.kind === 'main' && ctx && !event.willContinue) {
      const g = generation,
        epoch = captureEpoch,
        at = Date.now()
      enqueueEvent(g, epoch, () => {
        append([{ k: 'done', at }])
        usage()
        publish()
      })
    }
  })
  pi.on('tool_result', (event, context) => {
    if (
      !ctx ||
      (context.agent.kind !== 'main' && context.agent.id !== 'advisor')
    )
      return
    const g = generation,
      epoch = captureEpoch,
      scope = context.agent.id === 'advisor' ? 'advisor' : 'root'
    const call: CapturedTool = {
      name: event.toolName,
      input: event.input,
      output: textOf(event.content),
      details: event.details,
      isError: event.isError,
      at: Date.now(),
      ...(scope === 'advisor' ? { agent: true } : {}),
    }
    enqueue(() => capture(call, `${scope}:${event.toolCallId}`, g, epoch))
  })
  pi.on('session_shutdown', async (_event, context) => {
    if (context.agent.kind !== 'main' || !ctx) return
    abort.abort()
    if (timer) context.clearTimer(timer)
    replayEpoch++
    if (replayTimer !== undefined) context.clearTimer(replayTimer)
    replayTimer = undefined
    unsubscribe?.()
    emit({ v: 1, kind: 'ended', generation })
    ctx = undefined
    await Promise.race([
      lifecycle.onRootStop(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ])
    store?.close()
    store = undefined
  })
  return feed
}
