import {
  isCursor,
  isExactObject,
  isGuard,
  isLabel,
  isOwner,
  isToken,
  parseChatEnvelope,
  parseStrictJSON,
} from '../../types/apps'
import type {
  Approved,
  Checked,
  Guard,
  HostApprove,
  HostCheck,
  HostRevoke,
  Owner,
  CurrentEvent,
  Cursor,
} from '../../types/apps'
import {
  parseCommand,
  type DashboardFeed,
  type ServerEvent,
  type LaunchReceipt,
} from '../../types/browser'

export type LaunchOutcome = { id: string; generation: number; code: number }
export type AppNativeHost = {
  current(): Promise<{ owner: Owner; generation: number; label: string }>
}

export interface RelayIO {
  start(
    binary: string,
    args: string[],
    stdin: string,
    onChunk: (chunk: string) => void,
    onExit: () => void,
  ): Promise<{ close(): void }>
  request(
    socket: string,
    token: string,
    route: string,
    body: string,
  ): Promise<{ status: number; body: string }>
  schedule(callback: () => void, ms: number): () => void
  onFailure(error: RelayRefusal): void
  onLaunchOutcome(outcome: LaunchOutcome): void
  randomToken(): string
  log(message: string): void
}

export interface RelayClient {
  close(): void
  isClosed(): boolean
  listApps(): Promise<string[]>
  approveApp(request: HostApprove): Promise<Approved>
  checkApp(request: HostCheck): Promise<Checked>
  revokeApp(request: HostRevoke): Promise<void>
  prepareBrowser(): Promise<string>
  prepareBrowserLink(
    generation: number,
  ): Promise<{ url: string; expiresAt: number }>
  openBrowser(generation: number): Promise<LaunchReceipt>
  prepareFile(
    root: string,
    path: string,
    appScope?: Guard,
  ): Promise<{ id: string; path: string; inside: boolean }>
  readFile(id: string): Promise<string>
  verifyFile(id: string): Promise<boolean>
  releaseFile(id: string): Promise<void>
  openFile(
    id: string,
    app: string | undefined,
    generation: number,
  ): Promise<LaunchReceipt>
}

const lineLimit = 256 * 1024
const requestLimit = 4_194_304
const responseLimit = 2 * 1024 * 1024
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
// The transport limits are byte limits. Escaping non-ASCII makes string length equal byte length.
const ascii = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
export class RelayRefusal extends Error {
  constructor(
    readonly code:
      | 'too-large'
      | 'invalid'
      | 'http'
      | 'disconnected'
      | 'missing'
      | 'forbidden'
      | 'unsupported'
      | 'busy'
      | 'timeout'
      | 'launch-failed'
      | 'stale-generation',
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'RelayRefusal'
  }
}

const disconnected = () =>
  new RelayRefusal('disconnected', 'Relay disconnected')
const timeoutMs = 15_000

export async function startRelay(
  io: RelayIO,
  binary: string,
  assets: string,
  feed: DashboardFeed,
  appHost?: AppNativeHost,
): Promise<RelayClient> {
  const token = io.randomToken()
  let socket = ''
  let process: { close(): void } | undefined
  let stopped = false
  let buffer = ''
  let clients = 0
  let clientSequence = 0
  let version = 0
  let published = 0
  let publishing: Promise<void> | undefined
  const launches = new Map<string, number>()
  const appOperations = new Map<
    string,
    { guard: Guard; controller: AbortController }
  >()
  let linkSequence = 0
  let linkQueue: Promise<unknown> = Promise.resolve()
  let stateQueue: Promise<unknown> = Promise.resolve()
  const serializeState = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = stateQueue.then(operation)
    stateQueue = next.catch(() => {})
    return next
  }
  let notifiedGeneration: number | undefined
  let notifiedEnd = false
  let ended: Extract<ServerEvent, { kind: 'ended' }> | undefined
  let unsubscribe = () => {}
  let resolveHello!: () => void
  let rejectHello!: (error: Error) => void
  // The SDK targets ES2023, before Promise.withResolvers.
  const hello = new Promise<void>((resolve, reject) => {
    resolveHello = resolve
    rejectHello = reject
  })
  void hello.catch(() => {})
  let greeted = false
  let endedGeneration: number | undefined
  let terminalFailure: RelayRefusal | undefined
  let rejectClosed!: (error: Error) => void
  const closed = new Promise<never>((_, reject) => {
    rejectClosed = reject
  })
  void closed.catch(() => {})
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let cancel = () => {}
    try {
      return await Promise.race([
        operation,
        closed,
        new Promise<never>((_, reject) => {
          cancel = io.schedule(() => reject(disconnected()), timeoutMs)
        }),
      ])
    } finally {
      cancel()
    }
  }

  const close = () => {
    if (stopped) return
    stopped = true
    launches.clear()
    for (const operation of appOperations.values()) operation.controller.abort()
    appOperations.clear()
    rejectClosed(terminalFailure ?? disconnected())
    unsubscribe()
    process?.close()
    if (!greeted) rejectHello(new Error('Relay disconnected before hello'))
  }
  const fail = (
    error: unknown,
    context: string,
    code: 'invalid' | 'disconnected' = 'disconnected',
  ) => {
    if (stopped) return
    terminalFailure =
      error instanceof RelayRefusal
        ? error
        : new RelayRefusal(code, `${context}: ${String(error)}`)
    io.log(`${context}: ${String(error)}`)
    try {
      io.onFailure(terminalFailure)
    } catch (callbackError) {
      io.log(`Relay failure notification failed: ${String(callbackError)}`)
    } finally {
      close()
    }
  }
  const request = async (
    route: string,
    body: unknown,
    serialized?: string,
  ): Promise<unknown> => {
    if (stopped || !socket) throw terminalFailure ?? disconnected()
    const encoded = serialized ?? ascii(body)
    if (encoded.length > requestLimit)
      throw new RelayRefusal('too-large', 'Relay request too large')
    let response: { status: number; body: string }
    try {
      response = await bounded(
        io.request(socket, token, `/h/${route}`, encoded),
      )
    } catch (error) {
      const refusal = error instanceof RelayRefusal ? error : disconnected()
      fail(refusal, 'Relay transport failed')
      throw terminalFailure ?? refusal
    }
    if (new TextEncoder().encode(response.body).byteLength > responseLimit)
      throw new RelayRefusal(
        'too-large',
        'Relay response too large',
        response.status,
      )
    let result: unknown
    try {
      result = parseStrictJSON(response.body)
    } catch {
      if (response.status < 200 || response.status >= 300)
        throw new RelayRefusal(
          response.status === 413
            ? 'too-large'
            : response.status === 400
              ? 'invalid'
              : 'http',
          `Relay HTTP ${response.status}`,
          response.status,
        )
      throw new RelayRefusal(
        'invalid',
        'Invalid relay response',
        response.status,
      )
    }
    const message =
      object(result) && typeof result.error === 'string'
        ? result.error
        : `Relay HTTP ${response.status}`
    const code =
      message === 'too-large' ||
      message === 'invalid' ||
      message === 'missing' ||
      message === 'forbidden' ||
      message === 'unsupported' ||
      message === 'busy' ||
      message === 'timeout' ||
      message === 'stale-generation' ||
      message === 'disconnected' ||
      message === 'launch-failed'
        ? message
        : response.status === 413
          ? 'too-large'
          : response.status === 400
            ? 'invalid'
            : 'http'
    if (
      response.status < 200 ||
      response.status >= 300 ||
      (route !== 'ready' && object(result) && result.ok === false)
    )
      throw new RelayRefusal(code, message, response.status)
    return result
  }
  const appResult = async (route: string, body: unknown): Promise<unknown> => {
    const result = await request(`app/${route}`, body)
    if (
      !isExactObject(result, ['v', 'ok', 'value']) ||
      result.v !== 1 ||
      result.ok !== true
    )
      throw new RelayRefusal('invalid', 'Invalid app relay response')
    return result.value
  }
  const checkApp = async (body: HostCheck): Promise<Checked> => {
    const value = await appResult('check', body)
    if (isExactObject(value, ['kind']) && value.kind === 'operation')
      return { kind: 'operation' }
    if (
      isExactObject(value, ['kind', 'state', 'grantId', 'expiresAt']) &&
      value.kind === 'approval' &&
      ['missing', 'pending', 'claimed', 'revoked', 'expired'].includes(
        value.state as string,
      ) &&
      (value.grantId === null || isToken(value.grantId)) &&
      (value.expiresAt === null ||
        (Number.isSafeInteger(value.expiresAt) &&
          (value.expiresAt as number) > 0)) &&
      (value.state !== 'missing' ||
        (value.grantId === null && value.expiresAt === null)) &&
      (value.state !== 'pending' ||
        (value.grantId === null && value.expiresAt !== null)) &&
      (value.state !== 'claimed' ||
        (value.grantId !== null && value.expiresAt !== null))
    )
      return value as Checked
    throw new RelayRefusal('invalid', 'Invalid app check response')
  }
  const revokeApp = async (body: HostRevoke): Promise<void> => {
    if ((await appResult('revoke', body)) !== null)
      throw new RelayRefusal('invalid', 'Invalid app revoke response')
  }
  const approveApp = (body: HostApprove): Promise<Approved> =>
    serializeState(() => approveAppLocked(body))
  const approveAppLocked = async (body: HostApprove): Promise<Approved> => {
    await nativeCurrent(body.generation, body.owner)
    const synced = await request('generation', {
      generation: body.generation,
      ended: false,
    })
    if (!isExactObject(synced, ['ok']) || synced.ok !== true)
      throw new RelayRefusal('invalid', 'Invalid relay generation response')
    sentGeneration = Math.max(sentGeneration, body.generation)
    await nativeCurrent(body.generation, body.owner)
    const value = await appResult('approve', body)
    if (
      !isExactObject(value, ['relay', 'approval', 'expiresAt', 'envelope']) ||
      !isExactObject(value.relay, ['socket', 'relayId']) ||
      typeof value.relay.socket !== 'string' ||
      !value.relay.socket ||
      !isToken(value.relay.relayId) ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= 0 ||
      !isExactObject(
        value.approval,
        body.approval.kind === 'code' ? ['kind', 'openId'] : ['kind', 'pairId'],
      ) ||
      value.approval.kind !== body.approval.kind ||
      (body.approval.kind === 'code'
        ? value.approval.openId !== body.approval.openId ||
          value.envelope !== null
        : value.approval.pairId !== body.approval.pairId ||
          !parseChatEnvelope(value.envelope))
    )
      throw new RelayRefusal('invalid', 'Invalid app approval response')
    const envelope =
      value.envelope === null ? null : parseChatEnvelope(value.envelope)
    if (
      envelope &&
      (envelope.pairId !==
        (body.approval.kind === 'chat' ? body.approval.pairId : '') ||
        envelope.relay.socket !== value.relay.socket ||
        envelope.relay.relayId !== value.relay.relayId ||
        envelope.expiresAt !== value.expiresAt)
    )
      throw new RelayRefusal('invalid', 'Invalid app approval response')
    try {
      await nativeCurrent(body.generation, body.owner)
    } catch (error) {
      try {
        await revokeApp({
          v: 1,
          target: {
            kind: 'approval',
            approval:
              body.approval.kind === 'code'
                ? { kind: 'code', openId: body.approval.openId }
                : { kind: 'chat', pairId: body.approval.pairId },
          },
          reason: 'generation-ended',
        })
      } catch {
        close()
      }
      throw error
    }
    return value as Approved
  }
  let sentGeneration = 0
  const event = async (value: ServerEvent) => {
    if (value.generation < sentGeneration) return
    await request('event', value)
    sentGeneration = value.generation
  }
  const flush = (): Promise<void> => {
    if (publishing) return publishing
    publishing = serializeState(async () => {
      if (!stopped && clients > 0 && published !== version) {
        const target = version
        const pendingEnd = ended
        ended = undefined
        if (pendingEnd) await event(pendingEnd)
        const current = feed.current()
        if (current.generation !== endedGeneration) {
          if (current.layout !== undefined)
            await event({
              v: 1,
              kind: 'layout',
              generation: current.generation,
              layout: current.layout,
            })
          await event({
            v: 1,
            kind: 'snapshot',
            generation: current.generation,
            revision: current.revision,
            facts: current.facts,
            shared: current.shared,
          })
        }
        published = target
        if (!stopped && clients > 0) {
          const seq = clientSequence
          const result = await request('ready', { seq })
          if (!object(result) || typeof result.ok !== 'boolean')
            throw new RelayRefusal('invalid', 'Invalid relay ready response')
        }
      }
    }).then(
      () => {
        publishing = undefined
        if (!stopped && clients > 0 && published !== version)
          void flush().catch((error: unknown) =>
            fail(error, 'Relay publication failed'),
          )
      },
      (error: unknown) => {
        publishing = undefined
        throw error
      },
    )
    return publishing
  }
  const clearStaleLaunches = (generation: number) => {
    for (const [id, current] of launches) {
      if (current !== generation) launches.delete(id)
    }
  }
  const changed = (value?: ServerEvent) => {
    if (
      value &&
      !stopped &&
      socket &&
      (value.generation !== notifiedGeneration ||
        (value.kind === 'ended' && !notifiedEnd))
    ) {
      notifiedGeneration = value.generation
      notifiedEnd = value.kind === 'ended'
      const changedEvent = value
      void serializeState(async () => {
        if (changedEvent.kind === 'ended') {
          await event(changedEvent)
          if (ended === changedEvent) ended = undefined
        } else {
          await request('generation', {
            generation: changedEvent.generation,
            ended: false,
          })
          sentGeneration = Math.max(sentGeneration, changedEvent.generation)
        }
      }).catch((error: unknown) =>
        fail(error, 'Relay generation update failed'),
      )
    }
    if (value)
      clearStaleLaunches(value.kind === 'ended' ? -1 : value.generation)
    if (value?.kind === 'ended') {
      ended = value
      endedGeneration = value.generation
    }
    version++
    if (clients > 0)
      void flush().catch((error: unknown) =>
        fail(error, 'Relay publication failed'),
      )
  }
  const command = async (id: string, body: unknown) => {
    let reply: unknown = { ok: false, error: 'invalid' }
    try {
      await flush()
      if (stopped || clients === 0) reply = { ok: false, error: 'disconnected' }
      else {
        const parsed = parseCommand(body)
        if (parsed)
          reply = await feed.execute(parsed.generation, parsed.command)
      }
    } catch (error) {
      io.log(`Relay command failed: ${String(error)}`)
      reply = { ok: false, error: 'disconnected' }
    }
    try {
      await request('reply', { id, body: reply })
    } catch (error) {
      fail(error, 'Relay reply failed')
    }
  }
  const sameOwner = (a: Owner, b: Owner) =>
    a.host === b.host && a.sessionId === b.sessionId
  const nativeCurrent = async (generation: number, owner?: Owner) => {
    if (!appHost)
      throw new RelayRefusal('forbidden', 'Native authority unavailable')
    const current = await appHost.current()
    if (
      !isOwner(current.owner) ||
      !isLabel(current.label) ||
      current.generation !== generation ||
      feed.current().generation !== generation ||
      endedGeneration === generation ||
      (owner && !sameOwner(owner, current.owner))
    )
      throw new RelayRefusal('stale-generation', 'Native authority changed')
    return current
  }
  const appFrame = async (
    frame:
      | { t: 'app-current'; scope: Guard; cursor: Cursor | null }
      | { t: 'app-cmd'; scope: Guard; request: unknown },
    controller: AbortController,
  ) => {
    const guard = frame.scope
    const scope = {
      guard,
      signal: controller.signal,
      assertCurrent: async () => {
        if (controller.signal.aborted)
          throw new RelayRefusal('forbidden', 'Operation no longer current')
        await nativeCurrent(guard.generation, guard.owner)
        if (controller.signal.aborted)
          throw new RelayRefusal('forbidden', 'Operation no longer current')
        const checked = await checkApp({
          v: 1,
          target: { kind: 'operation', scope: guard },
        })
        if (controller.signal.aborted)
          throw new RelayRefusal('forbidden', 'Operation no longer current')
        if (checked.kind !== 'operation')
          throw new RelayRefusal('forbidden', 'Operation no longer current')
        await nativeCurrent(guard.generation, guard.owner)
        if (controller.signal.aborted)
          throw new RelayRefusal('forbidden', 'Operation no longer current')
      },
    }
    let sending = false
    try {
      await scope.assertCurrent()
      let posts: string[]
      if (frame.t === 'app-current') {
        const current = feed.current()
        if (current.generation !== guard.generation)
          throw new RelayRefusal('stale-generation', 'Native authority changed')
        const cursor = {
          generation: current.generation,
          revision: current.revision,
          layoutRev: current.layout?.layoutRev ?? null,
        }
        const events: CurrentEvent[] = []
        if (
          current.layout &&
          (!frame.cursor ||
            frame.cursor.generation !== cursor.generation ||
            frame.cursor.layoutRev !== cursor.layoutRev)
        )
          events.push({
            v: 1,
            kind: 'layout',
            generation: current.generation,
            layout: current.layout,
          })
        if (
          !frame.cursor ||
          frame.cursor.generation !== cursor.generation ||
          frame.cursor.revision !== cursor.revision
        )
          events.push({
            v: 1,
            kind: 'snapshot',
            generation: current.generation,
            revision: current.revision,
            facts: current.facts,
            shared: current.shared,
          })
        const parts = events.length === 2 ? 2 : 1
        posts = Array.from({ length: parts }, (_, part) =>
          ascii({
            v: 1,
            scope: guard,
            result: {
              ok: true,
              value: {
                kind: 'current',
                chunk: {
                  readId: guard.requestId,
                  part,
                  parts,
                  cursor,
                  events: events[part] ? [events[part]] : [],
                },
              },
            },
          }),
        )
      } else {
        const parsed = parseCommand(frame.request)
        const oversized = ascii(frame.request).length > 65_536
        const reply = oversized
          ? { ok: false as const, error: 'too-large' as const }
          : parsed && parsed.generation === guard.generation
            ? await feed.execute(parsed.generation, parsed.command, scope)
            : { ok: false as const, error: 'invalid' as const }
        posts = [
          ascii({
            v: 1,
            scope: guard,
            result:
              reply.ok === false
                ? reply
                : { ok: true, value: { kind: 'command', reply } },
          }),
        ]
      }
      if (posts.some((post) => post.length > responseLimit))
        posts = [
          ascii({
            v: 1,
            scope: guard,
            result: { ok: false, error: 'too-large' },
          }),
        ]
      for (const post of posts) {
        await scope.assertCurrent()
        sending = true
        const result = await request('app/reply', null, post)
        if (
          !isExactObject(result, ['v', 'ok', 'value']) ||
          result.v !== 1 ||
          result.ok !== true ||
          result.value !== null
        )
          throw new RelayRefusal('invalid', 'Invalid app reply response')
      }
    } catch (error) {
      if (!sending && !controller.signal.aborted) {
        try {
          if (appHost) await scope.assertCurrent()
          else
            await checkApp({
              v: 1,
              target: { kind: 'operation', scope: guard },
            })
          if (controller.signal.aborted) return
          const code =
            error instanceof RelayRefusal &&
            error.code !== 'http' &&
            error.code !== 'missing'
              ? error.code
              : 'disconnected'
          await appResult('reply', {
            v: 1,
            scope: guard,
            result: { ok: false, error: code },
          })
        } catch {
          /* A retired request cannot receive a reply. */
        }
      }
    }
  }
  const admitApp = (
    frame:
      | { t: 'app-current'; scope: Guard; cursor: Cursor | null }
      | { t: 'app-cmd'; scope: Guard; request: unknown },
  ) => {
    const guard = frame.scope
    if (appOperations.has(guard.requestId)) return
    if (appOperations.size >= 16) {
      void (async () => {
        try {
          await nativeCurrent(guard.generation, guard.owner)
          const checked = await checkApp({
            v: 1,
            target: { kind: 'operation', scope: guard },
          })
          if (checked.kind !== 'operation') return
          await nativeCurrent(guard.generation, guard.owner)
          await appResult('reply', {
            v: 1,
            scope: guard,
            result: { ok: false, error: 'busy' },
          })
        } catch {
          /* Retired or unavailable operations cannot receive a reply. */
        }
      })()
      return
    }
    const operation = { guard, controller: new AbortController() }
    appOperations.set(guard.requestId, operation)
    void appFrame(frame, operation.controller).finally(() => {
      if (appOperations.get(guard.requestId) === operation)
        appOperations.delete(guard.requestId)
    })
  }
  const pairFrame = async (requestId: string, generation: number) => {
    let result: unknown
    try {
      const current = await nativeCurrent(generation)
      const pairId = io.randomToken()
      if (!isToken(pairId))
        throw new RelayRefusal('invalid', 'Invalid pairing identifier')
      await nativeCurrent(generation, current.owner)
      result = { ok: true, value: { ...current, pairId } }
    } catch {
      result = { ok: false, error: 'stale-generation' }
    }
    try {
      await appResult('browser-pair-reply', { v: 1, requestId, result })
    } catch {
      /* Request already retired or transport failed; never retry issuance. */
    }
  }
  const frame = (value: unknown) => {
    if (!object(value) || typeof value.t !== 'string')
      throw new Error('Invalid relay frame')
    if (value.t === 'hello') {
      if (
        greeted ||
        value.protocol !== 1 ||
        typeof value.socket !== 'string' ||
        !value.socket
      )
        throw new Error('Invalid relay hello')
      socket = value.socket
      greeted = true
      resolveHello()
    } else if (!greeted) throw new Error('Relay frame before hello')
    else if (value.t === 'clients') {
      if (
        !Number.isSafeInteger(value.n) ||
        (value.n as number) < 0 ||
        !Number.isSafeInteger(value.seq) ||
        (value.seq as number) < clientSequence ||
        ((value.n as number) > 0 && (value.seq as number) === 0)
      )
        throw new Error('Invalid relay client count')
      clients = value.n as number
      clientSequence = value.seq as number
      if (clients > 0) changed()
    } else if (value.t === 'cmd') {
      if (typeof value.id !== 'string' || !value.id)
        throw new Error('Invalid relay command id')
      void command(value.id, value.body)
    } else if (value.t === 'app-current') {
      if (
        !isExactObject(value, ['v', 't', 'scope', 'cursor']) ||
        value.v !== 1 ||
        !isGuard(value.scope) ||
        (value.cursor !== null && !isCursor(value.cursor))
      )
        throw new Error('Invalid app current frame')
      admitApp({
        t: 'app-current',
        scope: value.scope,
        cursor: value.cursor,
      })
    } else if (value.t === 'app-cmd') {
      if (
        !isExactObject(value, ['v', 't', 'scope', 'request']) ||
        value.v !== 1 ||
        !isGuard(value.scope)
      )
        throw new Error('Invalid app command frame')
      admitApp({
        t: 'app-cmd',
        scope: value.scope,
        request: value.request,
      })
    } else if (value.t === 'app-cancel') {
      if (
        !isExactObject(value, ['v', 't', 'scope']) ||
        value.v !== 1 ||
        !isGuard(value.scope)
      )
        throw new Error('Invalid app cancellation frame')
      const guard = value.scope
      const operation = appOperations.get(guard.requestId)
      const active = operation?.guard
      if (
        active &&
        active.relayId === guard.relayId &&
        active.grantId === guard.grantId &&
        active.generation === guard.generation &&
        sameOwner(active.owner, guard.owner) &&
        active.lease.epoch === guard.lease.epoch &&
        active.lease.id === guard.lease.id
      )
        operation.controller.abort()
    } else if (value.t === 'app-pair') {
      if (
        !isExactObject(value, ['v', 't', 'requestId', 'generation']) ||
        value.v !== 1 ||
        !isToken(value.requestId) ||
        !Number.isSafeInteger(value.generation) ||
        (value.generation as number) <= 0
      )
        throw new Error('Invalid app pair frame')
      void pairFrame(value.requestId, value.generation as number)
    } else if (value.t === 'launch-exit') {
      if (
        typeof value.id !== 'string' ||
        !Number.isSafeInteger(value.generation) ||
        !Number.isInteger(value.code)
      )
        throw new Error('Invalid launch outcome')
      const generation = launches.get(value.id)
      launches.delete(value.id)
      if (
        generation === value.generation &&
        generation === feed.current().generation &&
        value.code !== 0
      ) {
        try {
          io.onLaunchOutcome({
            id: value.id,
            generation,
            code: value.code as number,
          })
        } catch (error) {
          io.log(`Launch outcome notification failed: ${String(error)}`)
        }
      }
    } else if (value.t !== 'ping') throw new Error('Unknown relay frame')
  }
  const onChunk = (chunk: string) => {
    if (stopped) return
    try {
      if (/[\u0080-\uffff]/.test(chunk))
        throw new Error('Non-ASCII relay frame')
      buffer += chunk
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        if (end > lineLimit)
          throw new RelayRefusal('too-large', 'Relay frame too large')
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        frame(parseStrictJSON(line))
      }
      if (buffer.length > lineLimit)
        throw new RelayRefusal('too-large', 'Relay frame too large')
    } catch (error) {
      fail(
        error instanceof RelayRefusal
          ? error
          : new RelayRefusal('invalid', 'Invalid relay frame'),
        'Relay protocol error',
        'invalid',
      )
    }
  }

  unsubscribe = feed.subscribe(changed)
  try {
    const starting = io.start(
      binary,
      ['serve', assets],
      ascii({ v: 1, hostToken: token }),
      onChunk,
      () => fail(disconnected(), 'Relay process exited'),
    )
    void starting.then(
      (child) => {
        if (stopped) child.close()
      },
      () => {},
    )
    process = await bounded(starting)
    await bounded(hello)
    if (stopped) throw disconnected()
  } catch (error) {
    close()
    throw error
  }

  const prepareBrowser = async (): Promise<string> => {
    const result = await request('launch', {})
    if (!object(result) || result.ok !== true)
      throw new RelayRefusal('invalid', 'Invalid relay launch response')
    const separator = Math.max(
      socket.lastIndexOf('/'),
      socket.lastIndexOf('\\'),
    )
    if (separator < 0)
      throw new RelayRefusal('invalid', 'Invalid relay socket path')
    return `${socket.slice(0, separator + 1)}open.html`
  }
  const checkLinkGeneration = (generation: number) => {
    if (stopped) throw terminalFailure ?? disconnected()
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      feed.current().generation !== generation ||
      endedGeneration === generation
    )
      throw new RelayRefusal('stale-generation', 'Stale launch generation')
  }
  const prepareBrowserLink = (
    generation: number,
  ): Promise<{ url: string; expiresAt: number }> => {
    checkLinkGeneration(generation)
    const sequence = ++linkSequence
    const operation = linkQueue.then(() =>
      serializeState(async () => {
        checkLinkGeneration(generation)
        if (sequence !== linkSequence)
          throw new RelayRefusal('stale-generation', 'Launch link replaced')
        const result = await request('launch', { link: true, generation })
        sentGeneration = Math.max(sentGeneration, generation)
        checkLinkGeneration(generation)
        if (sequence !== linkSequence)
          throw new RelayRefusal('stale-generation', 'Launch link replaced')
        if (
          !object(result) ||
          result.ok !== true ||
          typeof result.url !== 'string' ||
          typeof result.expiresAt !== 'number' ||
          !Number.isSafeInteger(result.expiresAt)
        )
          throw new RelayRefusal('invalid', 'Invalid relay launch response')
        const match =
          /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/launch\/[A-Za-z0-9_-]{43}$/.exec(
            result.url,
          )
        const now = Date.now()
        if (
          !match ||
          Number(match[1]) > 65535 ||
          result.expiresAt <= now ||
          result.expiresAt > now + 121_000
        )
          throw new RelayRefusal('invalid', 'Invalid relay launch response')
        return { url: result.url, expiresAt: result.expiresAt }
      }),
    )
    linkQueue = operation.catch(() => {})
    return operation
  }
  const launch = async (
    route: string,
    generation: number,
    body: (id: string) => object,
  ): Promise<LaunchReceipt> => {
    if (feed.current().generation !== generation)
      throw new RelayRefusal('stale-generation', 'Stale launch generation')
    clearStaleLaunches(generation)
    if (launches.size >= 32)
      throw new RelayRefusal('busy', 'Too many active launch observers')
    const id = io.randomToken()
    if (!id || launches.has(id))
      throw new RelayRefusal('invalid', 'Invalid launch correlation')
    launches.set(id, generation)
    try {
      const result = await request(route, body(id))
      if (
        !object(result) ||
        result.ok !== true ||
        (result.status !== 'spawned' && result.status !== 'dispatched')
      )
        throw new RelayRefusal('invalid', 'Invalid relay launch receipt')
      if (result.status === 'dispatched') launches.delete(id)
      return { status: result.status }
    } catch (error) {
      launches.delete(id)
      throw error
    }
  }

  return {
    close,
    isClosed: () => stopped,
    async listApps() {
      const result = await request('apps', {})
      if (
        !object(result) ||
        !Array.isArray(result.apps) ||
        !result.apps.every((app: unknown) => typeof app === 'string')
      )
        throw new RelayRefusal('invalid', 'Invalid relay apps response')
      return result.apps as string[]
    },
    approveApp,
    checkApp,
    revokeApp,
    prepareBrowser,
    prepareBrowserLink,
    async openBrowser(generation) {
      return launch('launch', generation, (id) => ({
        open: true,
        id,
        generation,
      }))
    },
    async prepareFile(root, path, appScope) {
      const result = await request('file/prepare', {
        root,
        path,
        ...(appScope ? { appScope } : {}),
      })
      if (
        !object(result) ||
        typeof result.id !== 'string' ||
        typeof result.path !== 'string' ||
        typeof result.inside !== 'boolean'
      )
        throw new RelayRefusal('invalid', 'Invalid relay prepare response')
      return { id: result.id, path: result.path, inside: result.inside }
    },
    async readFile(id) {
      const result = await request('file/read', { id })
      if (!object(result) || typeof result.text !== 'string')
        throw new RelayRefusal('invalid', 'Invalid relay read response')
      return result.text
    },
    async verifyFile(id) {
      try {
        const result = await request('file/verify', { id })
        if (!object(result) || typeof result.ok !== 'boolean')
          throw new RelayRefusal('invalid', 'Invalid relay verify response')
        return result.ok
      } catch (error) {
        if (
          error instanceof RelayRefusal &&
          (error.code === 'missing' || error.code === 'forbidden')
        )
          return false
        throw error
      }
    },
    async releaseFile(id) {
      await request('file/release', { id })
    },
    async openFile(id, app, generation) {
      return launch('file/open', generation, (launchId) => ({
        id,
        launchId,
        generation,
        ...(app === undefined ? {} : { app }),
      }))
    },
  }
}
