import {
  parseCommand,
  type DashboardFeed,
  type ServerEvent,
} from '../../types/browser'

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
  open(path: string, app?: string): Promise<void>
  randomToken(): string
  log(message: string): void
}

export interface RelayClient {
  close(): void
  isClosed(): boolean
  listApps(): Promise<string[]>
  prepareBrowser(): Promise<string>
  openBrowser(): Promise<void>
  prepareFile(
    root: string,
    path: string,
  ): Promise<{ id: string; path: string; inside: boolean }>
  readFile(id: string): Promise<string>
  verifyFile(id: string): Promise<boolean>
  releaseFile(id: string): Promise<void>
  openFile(id: string, app?: string): Promise<void>
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
  const request = async (route: string, body: unknown): Promise<unknown> => {
    if (stopped || !socket) throw terminalFailure ?? disconnected()
    const encoded = ascii(body)
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
      result = JSON.parse(response.body)
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
      message === 'disconnected'
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
  const event = async (value: ServerEvent) => {
    await request('event', value)
  }
  const flush = (): Promise<void> => {
    if (publishing) return publishing
    publishing = (async () => {
      while (!stopped && clients > 0 && published !== version) {
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
    })().then(
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
  const changed = (value?: ServerEvent) => {
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
      do {
        await flush()
      } while (!stopped && clients > 0 && published !== version)
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
        frame(JSON.parse(line))
      }
      if (buffer.length > lineLimit)
        throw new RelayRefusal('too-large', 'Relay frame too large')
    } catch (error) {
      fail(error, 'Relay protocol error', 'invalid')
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
    prepareBrowser,
    async openBrowser() {
      await io.open(await prepareBrowser())
    },
    async prepareFile(root, path) {
      const result = await request('file/prepare', { root, path })
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
    async openFile(id, app) {
      await request('file/open', { id, ...(app === undefined ? {} : { app }) })
    },
  }
}
