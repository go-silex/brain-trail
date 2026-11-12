import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  createAgentSession,
  type ExtensionFactory,
} from '@oh-my-pi/pi-coding-agent'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp'
import { SqliteAuthCredentialStore } from '@oh-my-pi/pi-ai'
import {
  createMockModel,
  registerMockApi,
} from '@oh-my-pi/pi-ai/providers/mock'
import factory from '../hosts/omp/index.ts'
import { nameServer } from '../hooks/mcp.ts'
import type { FactsWire, ServerEvent } from '../hosts/omp/wire.ts'

const scratch = process.env.BRAIN_TRAIL_TEST_DIR
if (!scratch || !process.env.PI_CODING_AGENT_DIR)
  throw new Error('Run through bun scripts/omp-test.mjs for isolation')

async function until<T>(
  read: () => T | undefined,
  changed: () => Promise<void>,
): Promise<T> {
  for (;;) {
    const result = read()
    if (result !== undefined) return result
    await changed()
  }
}

{
  const cwd = join(scratch, 'workspace')
  const outside = join(scratch, 'outside.txt')
  const canary = join(scratch, 'outside-canary.txt')
  const canaryText = 'BRAIN_TRAIL_OUTSIDE_SECRET_CANARY'
  const outsideDirectory = join(scratch, 'outside-dir')
  await mkdir(outsideDirectory)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'root.txt'), 'root fixture')
  await writeFile(join(cwd, 'child.txt'), 'child fixture')
  await writeFile(outside, 'outside secret')
  await writeFile(canary, canaryText)
  await symlink(outside, join(cwd, 'escape.txt'))
  const serverName = '7d6e65a1-5b8a-4ced-b960-7abc11bcf456'
  // An explicit manager and an empty loader prevent all ambient MCP discovery.
  const manager = new MCPManager(cwd, null, async () => ({
    configs: {},
    exaApiKeys: [],
    sources: {},
  }))
  const loaded = await manager.connectServers(
    {
      [serverName]: {
        command: process.execPath,
        args: [join(import.meta.dir, 'omp-mcp-server.ts')],
        cwd,
        env: { BRAIN_TRAIL_TEST_DIR: scratch },
      },
    },
    {},
    undefined,
    10000,
  )
  await manager.waitForPendingConnections()
  assert.deepEqual([...loaded.errors], [])
  assert.ok(manager.getConnectedServers().includes(serverName))
  const mcpTools = manager.getTools()
  const connectorTool = mcpTools.find(
    (tool) =>
      tool.mcpServerName === serverName &&
      tool.mcpToolName === 'list_bank_accounts',
  )
  assert.ok(connectorTool)
  registerMockApi()
  let rootStep = 0
  let childStep = 0
  const childMarker = 'BRAIN_TRAIL_CHILD_FIXTURE_ASSIGNMENT'
  const mock = createMockModel({
    handler: (context) => {
      const users = context.messages.filter(
        (message) => message.role === 'user',
      )
      const lastUser = JSON.stringify(users.at(-1)?.content ?? '')
      if (lastUser.includes('(existing content):')) {
        return {
          content: [
            'Use a shorter instruction.\n```context\nKeep instructions concise.\n```',
          ],
        }
      }
      if (lastUser.includes(childMarker)) {
        if (childStep++ === 0) {
          return {
            content: [
              {
                type: 'toolCall',
                name: 'read',
                arguments: { path: join(cwd, 'child.txt') },
              },
            ],
          }
        }
        return { content: ['Child finished reading.'] }
      }
      if (
        !users.some((message) =>
          JSON.stringify(message.content).includes(
            'Read root.txt, then delegate the child file',
          ),
        )
      ) {
        throw new Error(
          'Unexpected model context; refusing unscripted response',
        )
      }
      switch (rootStep++) {
        case 0:
          return {
            content: [
              {
                type: 'toolCall',
                name: 'read',
                arguments: { path: join(cwd, 'root.txt') },
              },
            ],
          }
        case 1:
          return {
            content: [
              {
                type: 'toolCall',
                name: 'write',
                arguments: { path: outsideDirectory, content: 'must fail' },
              },
            ],
          }
        case 2:
          return {
            content: [
              {
                type: 'toolCall',
                name: 'task',
                arguments: {
                  context: 'Read the requested fixture.',
                  tasks: [
                    {
                      name: 'ProofChild',
                      agent: 'task',
                      task: `${childMarker}: Read ${join(cwd, 'child.txt')} and report its contents.`,
                      solutionSpace: 'Use the read tool.',
                    },
                  ],
                },
              },
            ],
          }
        case 3:
          return {
            content: [
              { type: 'toolCall', name: connectorTool.name, arguments: {} },
            ],
          }
        case 4:
          return {
            content: [
              { type: 'toolCall', name: 'read', arguments: { path: outside } },
            ],
          }
        default:
          return { content: ['Root finished.'] }
      }
    },
  })
  const auth = new AuthStorage(
    new SqliteAuthCredentialStore(new Database(':memory:')),
  )
  auth.keys.setRuntime('mock', 'sdk-mock-only')
  const registry = new ModelRegistry(auth, join(scratch, 'models.yml'), {
    ignoreLocalModelConfig: true,
  })
  registry.registerProvider('mock', {
    api: 'mock',
    baseUrl: 'mock://',
    apiKey: 'sdk-mock-only',
    streamSimple: (_model, context, options) =>
      mock.stream(mock, context, options),
    models: [
      {
        id: mock.id,
        name: mock.name,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32768,
      },
    ],
  })
  const trace: unknown[] = []
  const childFinished = Promise.withResolvers<string>()
  const observe: ExtensionFactory = (pi) => {
    pi.events.on('task:subagent:event', (payload) => {
      trace.push({ channel: 'task:subagent:event', payload })
    })
    pi.events.on('task:subagent:lifecycle', (payload) => {
      trace.push({ channel: 'task:subagent:lifecycle', payload })
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'id' in payload &&
        payload.id === 'ProofChild' &&
        'status' in payload &&
        typeof payload.status === 'string' &&
        payload.status !== 'started'
      )
        childFinished.resolve(payload.status)
    })
    pi.on('tool_result', (event, ctx) => {
      trace.push({ hook: 'tool_result', agent: ctx.agent, event })
    })
  }
  const errors: unknown[] = []
  const originalWrite = process.stderr.write
  let stderr = ''
  process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    stderr +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const encoding =
      typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8'
    const done =
      typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    return originalWrite.call(process.stderr, chunk, encoding, done)
  }
  let cancelReader: (() => Promise<void>) | undefined
  const sessionResult = await createAgentSession({
    cwd,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    authStorage: auth,
    modelRegistry: registry,
    model: mock,
    sessionManager: SessionManager.create(cwd, join(scratch, 'sessions')),
    settings: Settings.isolated({
      'memory.backend': 'off',
      'lsp.enabled': false,
      'task.workerThreads': 0,
      'task.agentModelOverrides': { task: 'mock/mock-model' },
    }),
    extensions: [factory, observe],
    disableExtensionDiscovery: true,
    enableMCP: true,
    mcpManager: manager,
    mcpTools,
    enableLsp: false,
    enableIrc: false,
    cacheWarming: false,
    autoApprove: true,
    skills: [],
    rules: [],
    contextFiles: [],
    noContextFiles: true,
    slashCommands: [],
    promptTemplates: [],
    toolNames: ['task', 'read', 'write', connectorTool.name],
  })
  const { session } = sessionResult
  try {
    assert.deepEqual(sessionResult.extensionsResult.errors, [])
    assert.ok(registry.find('mock', 'mock-model'))
    await initializeExtensions(session, {
      mode: 'print',
      reportSendError: (action, error) => errors.push({ action, error }),
      reportRuntimeError: (error) => errors.push(error),
    })
    const url = /Brain Trail: (http:\/\/127\.0\.0\.1:\d+\/s\/[^\s]+\/)/.exec(
      stderr,
    )?.[1]
    if (!url)
      throw new Error('Root session did not print its headless dashboard URL')
    const origin = new URL(url).origin
    const response = await fetch(new URL('events', url))
    assert.equal(response.status, 200)
    assert.ok(response.body)
    const reader = response.body.getReader()
    cancelReader = () => reader.cancel()
    const events: ServerEvent[] = []
    let latest: Extract<ServerEvent, { kind: 'snapshot' }> | undefined
    let buffer = ''
    let notify: (() => void) | undefined
    const changed = () => {
      const gate = Promise.withResolvers<void>()
      notify = gate.resolve
      return gate.promise
    }
    const pump = (async () => {
      const decoder = new TextDecoder()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        while (true) {
          const end = buffer.indexOf('\n\n')
          if (end === -1) break
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (!frame.startsWith('data: ')) continue
          const event = JSON.parse(frame.slice(6)) as ServerEvent
          events.push(event)
          if (event.kind === 'snapshot') latest = event
          if (event.kind === 'snapshot')
            trace.push({
              snapshot: {
                generation: event.generation,
                revision: event.revision,
                events: event.facts.events,
              },
            })
          notify?.()
          notify = undefined
        }
      }
    })()
    const snapshot = () => latest
    const post = (
      generation: number,
      command: object,
      requestOrigin = origin,
    ) =>
      fetch(new URL('command', url), {
        method: 'POST',
        headers: { origin: requestOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, generation, command }),
      })
    const initial = await until(snapshot, changed)
    await until(
      () =>
        snapshot()?.facts.workspace.kind === 'ready' ? snapshot() : undefined,
      changed,
    )
    await session.prompt(
      'Read root.txt, then delegate the child file to a task agent.',
    )
    const readEvents = (facts: FactsWire) =>
      facts.events.filter(
        (e) => e.k === 'read' && (e.p === 'root.txt' || e.p === 'child.txt'),
      )
    const observed = await until(() => {
      const s = snapshot()
      return s && readEvents(s.facts).length >= 2 ? s : undefined
    }, changed)
    const reads = readEvents(observed.facts)
    assert.equal(
      reads.filter((e) => e.k === 'read' && e.p === 'root.txt' && !e.agent)
        .length,
      1,
    )
    assert.equal(
      reads.filter(
        (e) => e.k === 'read' && e.p === 'child.txt' && e.agent === true,
      ).length,
      1,
    )
    assert.equal(reads.length, 2)
    assert.equal(await childFinished.promise, 'completed')
    const connector = await until(() => {
      const s = snapshot()
      return s?.facts.events.some(
        (e) =>
          e.k === 'mcp' &&
          e.server === serverName &&
          e.tool === 'list_bank_accounts',
      )
        ? s
        : undefined
    }, changed)
    assert.equal(
      connector.facts.events.filter(
        (e) =>
          e.k === 'mcp' &&
          e.server === serverName &&
          e.tool === 'list_bank_accounts',
      ).length,
      1,
    )
    const projected = connector.facts.connected.find(
      ([server]) => server === serverName,
    )
    assert.ok(projected)
    assert.deepEqual(projected[1], ['list_bank_accounts'])
    assert.equal(nameServer(projected[0], new Set(projected[1])), 'Qonto')
    assert.ok(
      session.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'toolResult' &&
            entry.message.toolName === connectorTool.name &&
            !entry.message.isError &&
            JSON.stringify(entry.message.content).includes(canary),
        ),
    )
    assert.equal(
      (
        await post(connector.generation, {
          kind: 'preview-read',
          ref: { p: canary, out: true },
        })
      ).status,
      403,
    )
    assert.ok(
      session.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'toolResult' &&
            entry.message.toolName === 'write' &&
            entry.message.isError,
        ),
    )
    assert.ok(
      events.some(
        (e) =>
          e.kind === 'snapshot' &&
          e.facts.events.some(
            (v) => v.k === 'read' && v.p === 'child.txt' && v.agent,
          ),
      ),
    )
    let generation = observed.generation
    const firstGeneration = generation
    const preview = await post(generation, {
      kind: 'preview-read',
      ref: { p: 'root.txt' },
    })
    assert.equal(preview.status, 200)
    assert.deepEqual(await preview.json(), { ok: true, text: 'root fixture' })
    assert.equal(
      (
        await post(generation, {
          kind: 'preview-read',
          ref: { p: '../outside.txt' },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await post(generation, {
          kind: 'preview-read',
          ref: { p: 'escape.txt' },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await post(generation, {
          kind: 'preview-read',
          ref: { p: outside, out: true },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await post(generation, {
          kind: 'preview-read',
          ref: { p: outsideDirectory, out: true },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await post(
          generation,
          { kind: 'refresh-meter' },
          'https://foreign.invalid',
        )
      ).status,
      403,
    )
    assert.equal(
      (await post(generation, { kind: 'execute', prompt: 'arbitrary prompt' }))
        .status,
      400,
    )
    const instruction = join(cwd, 'CLAUDE.md')
    assert.equal(snapshot()?.facts.instructionFile, 'CLAUDE.md')
    await symlink(canary, instruction)
    const callsBeforeAttack = mock.calls.length
    const attacked = await post(generation, { kind: 'coach-analyse' })
    assert.ok(attacked.status === 200 || attacked.status === 403)
    const rejected = await until(() => {
      const s = snapshot()
      return s && !s.facts.coach.busy && s.facts.coach.error ? s : undefined
    }, changed)
    assert.ok(rejected.facts.coach.error)
    assert.equal(mock.calls.length, callsBeforeAttack)
    assert.ok(
      !JSON.stringify(mock.calls.map((call) => call.context.messages)).includes(
        canaryText,
      ),
    )
    await unlink(instruction)
    await writeFile(instruction, 'Local instruction.')
    const before = session.sessionManager.getBranch().map((entry) => entry.id)
    assert.equal(
      (await post(generation, { kind: 'coach-analyse' })).status,
      200,
    )
    const coached = await until(() => {
      const s = snapshot()
      return s && !s.facts.coach.busy && s.facts.coach.patch ? s : undefined
    }, changed)
    assert.equal(coached.facts.coach.text, 'Use a shorter instruction.')
    assert.equal(coached.facts.coach.patch, 'Keep instructions concise.')
    assert.deepEqual(
      session.sessionManager.getBranch().map((entry) => entry.id),
      before,
    )
    const coachCall = mock.calls.at(-1)
    assert.equal((coachCall?.context.tools ?? []).length, 0)
    const calls = mock.calls.length
    const apply = await post(generation, {
      kind: 'coach-apply',
      prompt: 'run arbitrary browser prompt',
    })
    if (apply.status === 200)
      assert.deepEqual(await apply.json(), { ok: true, filled: false })
    else assert.equal(apply.status, 400)
    assert.equal(mock.calls.length, calls)
    assert.deepEqual(
      session.sessionManager.getBranch().map((entry) => entry.id),
      before,
    )
    const outsideHistory = await until(() => {
      const s = snapshot()
      return s?.facts.events.some(
        (e) => e.k === 'read' && e.p === outside && e.out,
      )
        ? s
        : undefined
    }, changed)
    assert.equal(outsideHistory.generation, generation)
    await unlink(outside)
    await symlink(canary, outside)
    await session.sessionManager.flush()
    await session.reload()
    const deadline = AbortSignal.timeout(15000)
    const timeout = Promise.withResolvers<never>()
    deadline.addEventListener(
      'abort',
      () =>
        timeout.reject(
          new Error(
            'Timed out waiting for restored root, child and outside read history',
          ),
        ),
      { once: true },
    )
    const outsideResumed = await Promise.race([
      until(() => {
        const s = snapshot()
        if (
          !s ||
          s.generation <= generation ||
          s.facts.workspace.kind !== 'ready'
        )
          return undefined
        const history = s.facts.events
        return history.some(
          (e) => e.k === 'read' && e.p === outside && e.out,
        ) &&
          history.some(
            (e) => e.k === 'read' && e.p === 'root.txt' && !e.agent,
          ) &&
          history.some((e) => e.k === 'read' && e.p === 'child.txt' && e.agent)
          ? s
          : undefined
      }, changed),
      timeout.promise,
    ])
    assert.ok(
      outsideResumed.facts.events.some(
        (e) => e.k === 'read' && e.p === outside && e.out,
      ),
    )
    assert.equal(
      (await post(generation, { kind: 'refresh-meter' })).status,
      409,
    )
    generation = outsideResumed.generation
    assert.equal(
      (
        await post(generation, {
          kind: 'preview-read',
          ref: { p: outside, out: true },
        })
      ).status,
      403,
    )
    assert.equal((await post(generation, { kind: 'clear-trail' })).status, 200)
    await until(
      () => (snapshot()?.facts.events.length === 0 ? snapshot() : undefined),
      changed,
    )
    await session.sessionManager.flush()
    await session.reload()
    const resumed = await until(() => {
      const s = snapshot()
      return s && s.generation > generation ? s : undefined
    }, changed)
    assert.deepEqual(resumed.facts.events, [])
    const rebuilt = await until(() => {
      const s = snapshot()
      return s &&
        s.generation === resumed.generation &&
        s.facts.workspace.kind === 'ready'
        ? s
        : undefined
    }, changed)
    assert.deepEqual(rebuilt.facts.events, [])
    assert.equal(
      (await post(generation, { kind: 'refresh-meter' })).status,
      409,
    )
    assert.equal(initial.generation, firstGeneration)
    assert.deepEqual(errors, [])
    await reader.cancel()
    await pump
  } catch (error) {
    console.error(
      'OMP journey failure trace:',
      JSON.stringify(
        {
          trace,
          journal: session.sessionManager.getBranch(),
          mockCalls: mock.calls.map((call) => ({
            messages: call.context.messages,
            tools: call.context.tools?.map((tool) => tool.name),
          })),
          errors,
        },
        null,
        2,
      ),
    )
    throw error
  } finally {
    await cancelReader?.().catch(() => {})
    await session.dispose()
    await manager.disconnectAll()
    auth.close()
    process.stderr.write = originalWrite
  }
}
console.log('OMP SDK journey passed')
