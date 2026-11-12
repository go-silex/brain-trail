import * as Bun from 'bun'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { parseCommand, type DashboardFeed, type ServerEvent } from './wire'

export type DashboardServer = { url: string; stop(): Promise<void> }

const PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Brain Trail</title><link rel="stylesheet" href="app.css"></head><body><main id="app"></main><div id="status" role="status" aria-live="polite"></div><div id="toast" role="status" aria-live="polite"></div><script type="module" src="app.js"></script></body></html>'
const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
const THREE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
const MAX_BODY = 65536
const encoder = new TextEncoder()

export async function startDashboardServer(
  feed: DashboardFeed,
): Promise<DashboardServer> {
  const token = randomBytes(32).toString('base64url')
  const tokenBytes = encoder.encode(token)
  const assetDir = join(import.meta.dir, 'browser', 'dist')
  const js = Bun.file(join(assetDir, 'app.js'))
  const css = Bun.file(join(assetDir, 'app.css'))
  if (!(await js.exists()) || !(await css.exists()))
    throw new Error(
      'Brain Trail browser assets are missing; build the OMP dashboard assets',
    )
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: ServerEvent,
  ) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  const unsubscribe = feed.subscribe((event) => {
    for (const client of clients) {
      try {
        send(client, event)
      } catch {
        clients.delete(client)
      }
    }
  })
  let stopped = false
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: MAX_BODY,
    async fetch(request, server) {
      const host = `127.0.0.1:${server.port}`
      const origin = `http://${host}`
      const headers = (csp = DASHBOARD_CSP) => ({
        'Content-Security-Policy': csp,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      const reply = (
        body: ConstructorParameters<typeof Response>[0],
        status: number,
        contentType = 'text/plain; charset=utf-8',
        csp = DASHBOARD_CSP,
      ) =>
        new Response(body, {
          status,
          headers: { ...headers(csp), 'Content-Type': contentType },
        })
      if (request.headers.get('host') !== host) return reply('Forbidden', 403)
      const url = new URL(request.url)
      const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname)
      const supplied = encoder.encode(match?.[1] ?? '')
      if (
        supplied.length !== tokenBytes.length ||
        !timingSafeEqual(supplied, tokenBytes)
      )
        return reply('Not found', 404)
      const path = match?.[2]
      if (request.method === 'POST' && request.headers.get('origin') !== origin)
        return reply('Forbidden', 403)
      if (request.method === 'GET' && (path === undefined || path === '/3d'))
        return new Response(null, {
          status: 302,
          headers: {
            ...headers(),
            Location: path === undefined ? `/s/${token}/` : `/s/${token}/3d/`,
          },
        })
      if (request.method === 'POST') {
        if (path !== '/command') return reply('Not found', 404)
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            request.headers.get('content-type') ?? '',
          )
        )
          return reply('Invalid content type', 415)
        const size = Number(request.headers.get('content-length') ?? '0')
        if (!Number.isFinite(size) || size > MAX_BODY)
          return reply('Request too large', 413)
        let body: unknown
        try {
          const bytes = await request.arrayBuffer()
          if (bytes.byteLength > MAX_BODY)
            return reply('Request too large', 413)
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          return reply('Invalid JSON', 400)
        }
        const parsed = parseCommand(body)
        if (parsed === undefined)
          return reply(
            JSON.stringify({ ok: false, error: 'invalid' }),
            400,
            'application/json; charset=utf-8',
          )
        try {
          const result = await feed.execute(parsed.generation, parsed.command)
          const status = result.ok
            ? 200
            : result.error === 'stale-generation'
              ? 409
              : result.error === 'forbidden'
                ? 403
                : result.error === 'unsupported'
                  ? 501
                  : 400
          return reply(
            JSON.stringify(result),
            status,
            'application/json; charset=utf-8',
          )
        } catch (error) {
          return reply(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : 'Command failed',
            }),
            500,
            'application/json; charset=utf-8',
          )
        }
      }
      if (request.method !== 'GET') return reply('Method not allowed', 405)
      if (path === '/') return reply(PAGE, 200, 'text/html; charset=utf-8')
      if (path === '/app.js')
        return reply(js, 200, 'text/javascript; charset=utf-8')
      if (path === '/app.css') return reply(css, 200, 'text/css; charset=utf-8')
      if (path === '/3d/' || path === '/3d/data.js') {
        const data = feed.threeD()
        if (data === undefined)
          return reply(
            '3D view is not available',
            404,
            'text/plain; charset=utf-8',
            THREE_CSP,
          )
        return reply(
          path === '/3d/' ? data.page : data.data,
          200,
          path === '/3d/'
            ? 'text/html; charset=utf-8'
            : 'text/javascript; charset=utf-8',
          THREE_CSP,
        )
      }
      if (path === '/events') {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
            const current = feed.current()
            if (current.layout !== undefined)
              send(c, {
                v: 1,
                kind: 'layout',
                generation: current.generation,
                layout: current.layout,
              })
            send(c, {
              v: 1,
              kind: 'snapshot',
              generation: current.generation,
              revision: current.revision,
              facts: current.facts,
            })
            clients.add(c)
          },
          cancel() {
            if (controller !== undefined) clients.delete(controller)
          },
        })
        return new Response(stream, {
          headers: {
            ...headers(),
            'Content-Type': 'text/event-stream; charset=utf-8',
            'X-Accel-Buffering': 'no',
          },
        })
      }
      return reply('Not found', 404)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/s/${token}/`,
    async stop() {
      if (stopped) return
      stopped = true
      unsubscribe()
      for (const client of clients) {
        try {
          client.close()
        } catch {
          /* client already disconnected */
        }
      }
      clients.clear()
      await server.stop(true)
    },
  }
}
