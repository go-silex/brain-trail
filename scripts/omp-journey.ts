import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
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
import { brain } from '../hooks/scene3d.ts'
import type { FactsWire, ServerEvent } from '../types/browser.ts'
import { findScenePoint, svgFilePoint } from './scene-picking.mjs'

type BrowserDom = {
  DOMParser: new () => {
    parseFromString: (
      source: string,
      type: string,
    ) => { documentElement: { getAttribute: (name: string) => string | null } }
  }
  document: {
    querySelector: (selector: string) => {
      getAttribute: (name: string) => string | null
    } | null
  }
}

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
  let browser: Browser | undefined
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
    const launchFile = /^Brain Trail launch file: (.+)$/m.exec(stderr)?.[1]
    if (!launchFile)
      throw new Error('Root session did not provide its headless launch file')
    browser = await chromium.launch({
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
    })
    const page = await browser.newPage()
    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    page.on('requestfailed', (request) => {
      browserErrors.push(
        `browser request failed: ${new URL(request.url()).pathname.replace(/\/(?:s|launch)\/[^/]+/g, '/[private]')} ${request.failure()?.errorText ?? ''}`,
      )
    })
    await page.route('**/*', (route) => {
      const target = new URL(route.request().url())
      if (
        target.protocol === 'file:' ||
        target.protocol === 'data:' ||
        target.protocol === 'blob:' ||
        (target.protocol === 'http:' && target.hostname === '127.0.0.1')
      )
        return route.continue()
      browserErrors.push('browser requested an external resource')
      return route.abort()
    })
    await page.goto(pathToFileURL(launchFile).href)
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/s\/[^/]+\/$/)
    const url = page.url()
    const origin = new URL(url).origin
    const reuse = await browser.newPage()
    const refusedLaunch = reuse.waitForResponse((response) =>
      new URL(response.url()).pathname.startsWith('/launch/'),
    )
    await reuse.goto(pathToFileURL(launchFile).href)
    assert.equal((await refusedLaunch).status(), 404)
    await reuse.close()
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
    const refused = async (
      generation: number,
      command: object,
      error: string,
    ) => {
      const response = await post(generation, command)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: false, error })
    }
    const succeeded = async (generation: number, command: object) => {
      const response = await post(generation, command)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
    }
    const initial = await until(snapshot, changed)
    const ready = await until(
      () =>
        snapshot()?.facts.workspace.kind === 'ready' ? snapshot() : undefined,
      changed,
    )
    if (ready.facts.workspace.kind !== 'ready')
      throw new Error('workspace is not ready')
    const readyLayoutRev = ready.facts.workspace.layoutRev
    const inventory = await until(
      () =>
        events.findLast(
          (event) =>
            event.kind === 'layout' &&
            event.generation === ready.generation &&
            event.layout.layoutRev === readyLayoutRev,
        ),
      changed,
    )
    if (inventory.kind !== 'layout') throw new Error('workspace layout missing')
    assert.deepEqual(inventory.layout.paths, ['child.txt', 'root.txt'])
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
    await page.locator('.bt-scene3d canvas').waitFor({ state: 'visible' })
    await page.locator('button[data-key="follow"]').click()
    await until(
      () => (snapshot()?.shared.zoomed ? snapshot() : undefined),
      changed,
    )
    await page.locator('button[data-key="play"]').click()
    const playing = await until(
      () => (snapshot()?.shared.play.step !== null ? snapshot() : undefined),
      changed,
    )
    assert.ok(playing.shared.play.playing)
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('replay cadence proof exceeded 400ms')),
              400,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    let previousStart: number | undefined
    let firstStart = 0
    let baselineStep: number | undefined
    let progressed = false
    for (let pulse = 0; pulse < 12; pulse++) {
      await page.waitForTimeout(160)
      const started = performance.now()
      if (previousStart !== undefined)
        assert.ok(
          started - previousStart < 400,
          'replay pulse gap exceeded 400ms',
        )
      else firstStart = started
      previousStart = started
      const revision = snapshot()?.revision ?? 0
      const expectedZoomed = pulse % 2 === 1
      const published = await bounded(
        (async () => {
          await succeeded(playing.generation, {
            kind: 'view',
            intent: { kind: 'follow', following: !expectedZoomed },
          })
          return until(() => {
            const current = snapshot()
            return current &&
              current.revision > revision &&
              current.shared.zoomed === expectedZoomed
              ? current
              : undefined
          }, changed)
        })(),
      )
      assert.ok(
        performance.now() - started < 400,
        'replay pulse exceeded 400ms',
      )
      const step = published.shared.play.step
      if (typeof step !== 'number')
        throw new Error('replay stopped during cadence proof')
      if (pulse === 0) baselineStep = step
      else if (pulse >= 2 && baselineStep !== undefined && step > baselineStep)
        progressed = true
    }
    assert.ok(
      performance.now() - firstStart > 900,
      'replay proof window too short',
    )
    assert.ok(
      progressed,
      'unrelated view intents restarted the host replay clock',
    )
    await page.locator('button[data-key="live"]').click()
    await until(
      () => (snapshot()?.shared.play.step === null ? snapshot() : undefined),
      changed,
    )
    await page.locator('button[data-key="settings"]').click()
    await page.locator('button[data-key="hover-off"]').click()
    await until(
      () =>
        snapshot()?.facts.settings.hover === false ? snapshot() : undefined,
      changed,
    )
    const budget = page.locator('[data-key="plan-usd"] input')
    await budget.fill('123')
    await budget.press('ArrowLeft')
    assert.equal(await budget.inputValue(), '123')
    await page.locator('button[data-key="hover-on"]').click()
    await until(
      () =>
        snapshot()?.facts.settings.hover === true ? snapshot() : undefined,
      changed,
    )
    await page.locator('button[data-key="openOther-preview"]').click()
    await until(
      () =>
        snapshot()?.facts.settings.openOther === 'preview'
          ? snapshot()
          : undefined,
      changed,
    )
    await page.locator('button[data-key="t-map"]').click()
    await page.locator('.bt-scene3d canvas').waitFor({ state: 'visible' })
    if (snapshot()?.shared.zoomed) {
      await page.locator('button[data-key="follow"]').click()
      await until(
        () => (snapshot()?.shared.zoomed === false ? snapshot() : undefined),
        changed,
      )
    }
    const spin = page.locator('button[data-key="spin"]')
    if ((await spin.textContent())?.trim() === '❚❚') await spin.click()
    const scan = await findScenePoint(
      page.locator('.bt-scene3d canvas'),
      'root.txt',
    )
    if (!scan.point) {
      const event = events.findLast((entry) => entry.kind === 'layout')
      const geometry = event?.layout.layout
      const shape = geometry && brain(geometry)
      const screenshotDir = join(process.cwd(), '.artifacts', 'omp-journey')
      await mkdir(screenshotDir, { recursive: true })
      await page.screenshot({
        path: join(screenshotDir, 'picking-failure.png'),
      })
      console.error(
        'OMP picking diagnostics:',
        JSON.stringify({
          scan,
          shared: snapshot()?.shared,
          settings: snapshot()?.facts.settings,
          layout: geometry && {
            size: geometry.size,
            files: geometry.files.map((file, index) => ({
              file,
              xyz: shape && [shape.X[index], shape.Y[index], shape.Z[index]],
            })),
          },
          screenshot: '.artifacts/omp-journey/picking-failure.png',
        }),
      )
    }
    assert.ok(
      scan.point,
      `real WebGL picking did not find root.txt: ${JSON.stringify(scan)}`,
    )
    await page.mouse.click(scan.point.x, scan.point.y)
    await until(
      () =>
        snapshot()?.shared.preview?.p === 'root.txt' ? snapshot() : undefined,
      changed,
    )
    await page.locator('button[data-key="t-map"]').click()
    await page.locator('button[data-key="view-3d"]').click()
    const image = page.locator('img[data-key="map"]')
    await image.waitFor({ state: 'visible' })
    await succeeded(observed.generation, {
      kind: 'view',
      intent: { kind: 'follow', following: false },
    })
    await until(
      () => (snapshot()?.shared.zoomed ? snapshot() : undefined),
      changed,
    )
    const imageBounds = await image.boundingBox()
    assert.ok(imageBounds)
    await page.mouse.move(
      imageBounds.x + imageBounds.width / 2,
      imageBounds.y + imageBounds.height / 2,
    )
    await page.mouse.wheel(0, -280)
    await until(
      () => (snapshot()?.shared.zoomed === false ? snapshot() : undefined),
      changed,
    )
    const viewBox = () =>
      image.evaluate((element) => {
        const source = element.getAttribute('src')
        if (!source?.startsWith('data:image/svg+xml,')) return null
        const { DOMParser } = globalThis as unknown as BrowserDom
        return new DOMParser()
          .parseFromString(
            decodeURIComponent(source.slice('data:image/svg+xml,'.length)),
            'image/svg+xml',
          )
          .documentElement.getAttribute('viewBox')
      })
    const manualView = await viewBox()
    assert.ok(manualView)
    await succeeded(observed.generation, {
      kind: 'view',
      intent: { kind: 'follow', following: false },
    })
    await until(
      () => (snapshot()?.shared.zoomed ? snapshot() : undefined),
      changed,
    )
    await page.waitForFunction((before) => {
      const { document, DOMParser } = globalThis as unknown as BrowserDom
      const source = document
        .querySelector('img[data-key="map"]')
        ?.getAttribute('src')
      if (!source?.startsWith('data:image/svg+xml,')) return false
      const svg = new DOMParser().parseFromString(
        decodeURIComponent(source.slice('data:image/svg+xml,'.length)),
        'image/svg+xml',
      )
      return svg.documentElement.getAttribute('viewBox') !== before
    }, manualView)
    const latestLayout = events.findLast((entry) => entry.kind === 'layout')
    assert.ok(latestLayout && latestLayout.kind === 'layout')
    const childFile = latestLayout.layout.layout.files.find(
      ([name]) => name === 'child.txt',
    )
    assert.ok(childFile, 'child.txt is absent from the published layout')
    const point2d = await svgFilePoint(image, {
      x: childFile[1],
      y: childFile[2],
    })
    await page.mouse.click(point2d.x, point2d.y)
    await until(
      () =>
        snapshot()?.shared.preview?.p === 'child.txt' ? snapshot() : undefined,
      changed,
    )
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
    await refused(
      connector.generation,
      {
        kind: 'preview-read',
        ref: { p: canary, out: true },
      },
      'forbidden',
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
    await refused(
      generation,
      { kind: 'preview-read', ref: { p: '../outside.txt' } },
      'forbidden',
    )
    await refused(
      generation,
      { kind: 'preview-read', ref: { p: 'escape.txt' } },
      'forbidden',
    )
    await refused(
      generation,
      { kind: 'preview-read', ref: { p: outside, out: true } },
      'forbidden',
    )
    await refused(
      generation,
      { kind: 'preview-read', ref: { p: outsideDirectory, out: true } },
      'forbidden',
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
    await refused(
      generation,
      { kind: 'execute', prompt: 'arbitrary prompt' },
      'invalid',
    )
    const instruction = join(cwd, 'CLAUDE.md')
    assert.equal(snapshot()?.facts.instructionFile, 'CLAUDE.md')
    await symlink(canary, instruction)
    const callsBeforeAttack = mock.calls.length
    await succeeded(generation, { kind: 'coach-analyse' })
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
    await succeeded(generation, { kind: 'coach-analyse' })
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
    await refused(
      generation,
      {
        kind: 'coach-apply',
        prompt: 'run arbitrary browser prompt',
      },
      'invalid',
    )
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
    await succeeded(generation, {
      kind: 'view',
      intent: { kind: 'preview', ref: { p: outside, out: true } },
    })
    await until(
      () =>
        snapshot()?.shared.preview?.p === outside ? snapshot() : undefined,
      changed,
    )
    await page.locator('button[data-key="t-files"]').click()
    await page
      .locator('[data-key="preview-back"]')
      .waitFor({ state: 'visible' })
    await page.getByText(/cannot be read|impossible de lire/i).waitFor({
      state: 'visible',
    })
    await page.locator('[data-key="preview-back"]').click()
    await until(
      () => (snapshot()?.shared.preview === null ? snapshot() : undefined),
      changed,
    )
    await page
      .locator('[data-key="kpi-open-start"]')
      .waitFor({ state: 'visible' })
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
    await refused(generation, { kind: 'refresh-meter' }, 'stale-generation')
    generation = outsideResumed.generation
    await refused(
      generation,
      { kind: 'preview-read', ref: { p: outside, out: true } },
      'forbidden',
    )
    await succeeded(generation, { kind: 'clear-trail' })
    const cleared = await until(() => {
      const s = snapshot()
      return s && s.generation > generation && s.facts.events.length === 0
        ? s
        : undefined
    }, changed)
    await refused(generation, { kind: 'refresh-meter' }, 'stale-generation')
    generation = cleared.generation
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
    await refused(generation, { kind: 'refresh-meter' }, 'stale-generation')
    assert.equal(initial.generation, firstGeneration)
    assert.deepEqual(errors, [])
    assert.deepEqual(browserErrors, [])
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
      ).replace(
        /http:\/\/127\.0\.0\.1:\d+\/(?:s|launch)\/[^\s"'\\)]+/g,
        '[private browser URL]',
      ),
    )
    throw new Error(
      (error instanceof Error ? error.message : String(error)).replace(
        /http:\/\/127\.0\.0\.1:\d+\/(?:s|launch)\/[^\s"'\\)]+/g,
        '[private browser URL]',
      ),
    )
  } finally {
    await cancelReader?.().catch(() => {})
    await browser?.close()
    await session.dispose()
    await manager.disconnectAll()
    auth.close()
    process.stderr.write = originalWrite
  }
}
console.log('OMP SDK journey passed')
