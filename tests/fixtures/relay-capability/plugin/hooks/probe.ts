// Disposable real-SDK capability evidence, not a product bridge.
import type { Register } from 'claude-code'

export const register: Register = (on) => {
  let roundtripPassed = false
  let active = false
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'relay-capability',
      description: 'Run the disposable native relay capability probe',
    })
    // Optional driver mode: schedule only after session.start has returned.
    const auto = await $.fs
      .read(`${$.plugin.root}/auto-run.txt`)
      .catch(() => '')
    if (auto.trim() === 'auto') {
      $.clock.after(250, () => {
        void $.command
          .run({ command: 'relay-capability' })
          .catch(async (error) => {
            const cwd = await $.session.cwd()
            await $.fs
              .write(
                `${cwd}/probe-report.json`,
                JSON.stringify({
                  phase: 'failed',
                  error: String(error).slice(0, 500),
                }),
              )
              .catch(() => {})
          })
      })
    }
    return result
  })

  on('command.run', { command: 'relay-capability' }, async ($) => {
    if (active)
      return {
        text: JSON.stringify({
          phase: 'failed',
          error: 'probe already started',
        }),
      }
    active = true
    const cwd = await $.session.cwd()
    let socketPath = ''
    let pid = 0
    let privacy:
      | {
          kind: string
          directory: {
            ownerSelf: boolean
            protected: boolean
            allowedEntries: number
            unexpectedEntries: number
          }
          socket: {
            ownerSelf: boolean
            allowedEntries: number
            unexpectedEntries: number
          }
        }
      | undefined
    const acknowledgements: Array<{
      id: string
      status: string
      value: unknown
    }> = []
    let resolveCompletion: () => void = () => {}
    let rejectCompletion: (error: unknown) => void = () => {}
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    let timer: { cancel: () => void } | undefined
    try {
      const binary = (
        await $.fs.read(`${$.plugin.root}/relay-binary.txt`)
      ).trim()
      if (binary !== 'relay-capability' && binary !== 'relay-capability.exe')
        throw new Error('invalid binary selection')
      void (async () => {
        let buffer = ''
        try {
          const stream = $.process.spawn({
            argv: [`${$.plugin.root}/${binary}`],
          })
          for await (const chunk of stream) {
            if (chunk.stream !== 'stdout') continue
            buffer += chunk.text
            if (buffer.length > 8192) throw new Error('frame buffer exceeded')
            for (;;) {
              if (buffer.length < 5) break
              if (!/^\d{4}:/.test(buffer))
                throw new Error('invalid frame header')
              const size = Number(buffer.slice(0, 4))
              if (size < 1 || size > 4096)
                throw new Error('invalid frame length')
              if (buffer.length < 5 + size) break
              const frame = JSON.parse(buffer.slice(5, 5 + size))
              buffer = buffer.slice(5 + size)
              if (frame.type === 'hello') {
                if (
                  socketPath ||
                  typeof frame.socketPath !== 'string' ||
                  !frame.socketPath.includes('é😀') ||
                  !/^[1-9]\d*$/.test(frame.pid)
                )
                  throw new Error('invalid hello')
                socketPath = frame.socketPath
                pid = Number(frame.pid)
                if (frame.privacyError)
                  throw new Error(
                    `privacy inspection: ${String(frame.privacyError).slice(0, 400)}`,
                  )
                if (frame.privacy) privacy = JSON.parse(frame.privacy)
                if (
                  binary.endsWith('.exe') &&
                  (privacy?.kind !== 'windows' ||
                    privacy.directory?.ownerSelf !== true ||
                    privacy.directory?.protected !== true ||
                    privacy.directory?.allowedEntries !== 2 ||
                    privacy.directory?.unexpectedEntries !== 0 ||
                    privacy.socket?.ownerSelf !== true ||
                    privacy.socket?.allowedEntries !== 2 ||
                    privacy.socket?.unexpectedEntries !== 0)
                )
                  throw new Error(
                    `privacy mismatch: ${JSON.stringify(privacy)}`,
                  )
                // Preserve cleanup coordinates even if the subsequent transport fails.
                await $.fs.write(
                  `${cwd}/probe-report.json`,
                  JSON.stringify({
                    phase: 'running',
                    pid,
                    socketPath,
                    privacy,
                    acknowledgements,
                  }),
                )
                continue
              }
              if (
                !socketPath ||
                frame.type !== 'command' ||
                (frame.id !== 'valid' && frame.id !== 'stale')
              )
                throw new Error('invalid command')
              let status = 'refused-generation'
              let value = await $.store.get('relay-capability-value')
              if (
                frame.id === 'valid' &&
                frame.generation === 'probe-generation-1' &&
                frame.value === 'é😀'
              ) {
                await $.store.set('relay-capability-value', frame.value)
                value = await $.store.get('relay-capability-value')
                status = value === 'é😀' ? 'saved' : 'readback-mismatch'
              }
              const ack = { id: frame.id, status, value }
              const response = await $.http.fetch('http://localhost/ack', {
                method: 'POST',
                socketPath,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(ack),
              })
              if (!response.ok) throw new Error(`ack HTTP ${response.status}`)
              acknowledgements.push(ack)
              if (frame.id === 'stale') {
                if (
                  acknowledgements.length !== 2 ||
                  acknowledgements[0]?.id !== 'valid' ||
                  status !== 'refused-generation' ||
                  value !== 'é😀'
                )
                  throw new Error('invalid stale result')
                resolveCompletion()
              }
            }
          }
          if (!roundtripPassed)
            rejectCompletion(new Error('relay stream ended before completion'))
        } catch (error) {
          rejectCompletion(error)
        }
      })()
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timer = $.clock.after(30000, () =>
            reject(new Error('probe timed out')),
          )
        }),
      ])
      roundtripPassed = true
      const report = {
        phase: 'passed-awaiting-session-end',
        pid,
        socketPath,
        privacy,
        acknowledgements,
      }
      await $.fs.write(`${cwd}/probe-report.json`, JSON.stringify(report))
      return { text: JSON.stringify(report) }
    } catch (error) {
      const report = {
        phase: 'failed',
        pid,
        socketPath,
        privacy,
        acknowledgements,
        error: String(error).slice(0, 500),
      }
      await $.fs
        .write(`${cwd}/probe-report.json`, JSON.stringify(report))
        .catch(() => {})
      return { text: JSON.stringify(report) }
    } finally {
      timer?.cancel()
    }
  })

  on('session.end', async ($, e, next) => {
    const cwd = await $.session.cwd()
    const value = await $.store.get('relay-capability-value')
    await $.fs.write(
      `${cwd}/probe-end.json`,
      JSON.stringify({ phase: 'session-end', value, roundtripPassed }),
    )
    return next(e)
  })
}
