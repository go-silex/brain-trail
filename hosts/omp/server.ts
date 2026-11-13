import * as Bun from 'bun'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { DashboardFeed } from '../../types/browser'
import {
  startRelay,
  type RelayClient,
  type RelayIO,
  type LaunchOutcome,
  type RelayRefusal,
} from '../relay/client'

export type DashboardServer = RelayClient

export async function startDashboardServer(
  feed: DashboardFeed,
  onFailure: (error: RelayRefusal) => void,
  onLaunchOutcome: (outcome: LaunchOutcome) => void,
): Promise<DashboardServer> {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const binary = join(
    import.meta.dir,
    '..',
    'relay',
    'bin',
    `brain-trail-relay-${platform}-${arch}${process.platform === 'win32' ? '.exe' : ''}`,
  )
  const assets = join(import.meta.dir, '..', 'browser', 'dist')
  const io: RelayIO = {
    async start(executable, args, stdin, onChunk, onExit) {
      const child = Bun.spawn([executable, ...args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      })
      child.stdin.write(stdin)
      child.stdin.end()
      void (async () => {
        const reader = child.stdout.getReader()
        const decoder = new TextDecoder()
        try {
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            onChunk(decoder.decode(part.value, { stream: true }))
          }
          const last = decoder.decode()
          if (last) onChunk(last)
        } finally {
          reader.releaseLock()
        }
      })().catch(() => child.kill())
      void child.exited.then(onExit, onExit)
      return {
        close: () => {
          child.kill()
        },
      }
    },
    async request(socket, token, route, body) {
      const response = await fetch(`http://localhost${route}`, {
        method: 'POST',
        unix: socket,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body,
      } as RequestInit & { unix: string })
      return { status: response.status, body: await response.text() }
    },
    randomToken: () => randomBytes(32).toString('base64url'),
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    },
    onFailure,
    onLaunchOutcome,
    log: (message) => {
      process.stderr.write(`Brain Trail: ${message}\n`)
    },
  }
  return startRelay(io, binary, assets, feed)
}
