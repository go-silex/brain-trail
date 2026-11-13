import type { EngineInterface } from 'claude-code'
import type { RelayIO } from '../relay/client'

// The SDK has no Node globals; all process and socket I/O goes through its port.
export async function relayBinary($: EngineInterface): Promise<string> {
  const windows =
    (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  let os: string, arch: string
  if (windows) {
    os = 'windows'
    arch =
      (await $.env.get('PROCESSOR_ARCHITEW6432').catch(() => undefined)) ??
      (await $.env.get('PROCESSOR_ARCHITECTURE').catch(() => undefined)) ??
      ''
  } else {
    const result = await $.process.run(['uname', '-sm'])
    if (result.exitCode !== 0)
      throw new Error('Cannot determine relay platform')
    const parts = result.stdout.trim().split(/\s+/)
    os = parts[0]?.toLowerCase() ?? ''
    arch = parts[1] ?? ''
  }
  const cpu = /^(x86_64|amd64)$/i.test(arch)
    ? 'amd64'
    : /^(aarch64|arm64)$/i.test(arch)
      ? 'arm64'
      : ''
  if (!['linux', 'darwin', 'windows'].includes(os) || !cpu)
    throw new Error('Unsupported relay platform')
  return `${$.plugin.root}/hosts/relay/bin/brain-trail-relay-${os}-${cpu}${windows ? '.exe' : ''}`
}

export function relayIO($: EngineInterface, binary: string): RelayIO {
  return {
    async start(executable, args, stdin, onChunk, onExit) {
      const stream = $.process.spawn({
        argv: [executable, ...args],
        input: stdin,
      })
      void stream.result.catch(() => {})
      let closed = false
      void (async () => {
        try {
          for await (const chunk of stream)
            if (chunk.stream === 'stdout') onChunk(chunk.text)
        } catch {
          // EOF and spawn failure both disconnect the relay.
        } finally {
          if (!closed) {
            onExit()
            void $.ui.toast(
              'Brain Trail browser disconnected. Reopen it from the pane.',
            )
          }
        }
      })()
      return {
        close() {
          closed = true
          void stream.return({ code: null, signal: null }).catch(() => {})
        },
      }
    },
    async request(socket, token, route, body) {
      const result = await $.http.fetch(`http://localhost${route}`, {
        method: 'POST',
        socketPath: socket,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body,
      })
      return { status: result.status, body: result.text }
    },
    async open(path) {
      const result = await $.process.run([binary, 'open', path])
      if (result.exitCode !== 0) throw new Error('Unable to open browser')
    },
    schedule(callback, ms) {
      const timer = $.clock.after(ms, callback)
      return () => timer.cancel()
    },
    onFailure(error) {
      const detail =
        error.code === 'too-large'
          ? 'Session data exceeds the browser relay limit.'
          : `Browser relay failed (${error.code}).`
      void $.ui.toast(`Brain Trail: ${detail} Reopen it from the pane.`)
    },
    randomToken() {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      let result = '',
        bits = 0,
        value = 0
      for (const byte of bytes) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 6) {
          bits -= 6
          result += alphabet[(value >>> bits) & 63]
        }
      }
      if (bits) result += alphabet[(value << (6 - bits)) & 63]
      return result
    },
    log(message) {
      $.ui.log(message, { to: 'debug' })
    },
  }
}
