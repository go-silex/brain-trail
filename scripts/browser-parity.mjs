import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Replay the actual adapter's captured feed through the built application. Commands
// are deliberately refused: this transport does not stand in for a live host.
export async function captureBrowserScene(
  browser,
  root,
  captured,
  scenario,
  semantic = false,
) {
  const events = captured.browserEvents
  if (!Array.isArray(events))
    throw new Error('native adapter did not capture browser events')
  const layout = events.findLast((e) => e.kind === 'layout')
  const snapshot = events.findLast((e) => e.kind === 'snapshot')
  if (
    !layout ||
    !snapshot ||
    layout.generation !== snapshot.generation ||
    snapshot.facts?.workspace?.kind !== 'ready' ||
    snapshot.facts.workspace.layoutRev !== layout.layout?.layoutRev
  )
    throw new Error(
      'native adapter did not publish a matching ready layout and snapshot',
    )
  if (
    !Array.isArray(layout.layout.paths) ||
    !layout.layout.paths.includes('notes/a.md') ||
    !snapshot.facts.events.some(
      (e) => e.k === 'read' && e.p === 'notes/a.md',
    ) ||
    !snapshot.facts.events.some((e) => e.k === 'write' && e.p === 'src/app.ts')
  )
    throw new Error(
      'captured native feed is missing fixture files or trail semantics',
    )
  const geometry = layout.layout.layout
  if (
    snapshot.facts.lang !== scenario.lang ||
    !Number.isFinite(geometry?.size) ||
    geometry.size <= 0 ||
    !Number.isFinite(geometry.dot) ||
    geometry.dot <= 0 ||
    !Array.isArray(geometry.files) ||
    geometry.files.length !== layout.layout.paths.length ||
    new Set(layout.layout.paths).size !== layout.layout.paths.length ||
    new Set(geometry.files.map((file) => file[0])).size !==
      geometry.files.length ||
    geometry.files.some(
      (file) =>
        !Array.isArray(file) ||
        file.length !== 3 ||
        typeof file[0] !== 'string' ||
        !layout.layout.paths.includes(file[0]) ||
        !Number.isFinite(file[1]) ||
        !Number.isFinite(file[2]),
    )
  )
    throw new Error('captured adapter layout geometry or language is invalid')
  const assets = new Map(
    await Promise.all(
      ['app.js', 'app.css'].map(async (name) => [
        name,
        await readFile(path.join(root, 'hosts/browser/dist', name)),
      ]),
    ),
  )
  const clients = new Set()
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      })
      clients.add(res)
      req.on('close', () => clients.delete(res))
      for (const event of [layout, snapshot])
        res.write(`data: ${JSON.stringify(event)}\n\n`)
    } else if (req.url === '/app.js' || req.url === '/app.css') {
      const name = req.url.slice(1)
      res.writeHead(200, {
        'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/css',
      })
      res.end(assets.get(name))
    } else if (req.url === '/command') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"unsupported"}')
    } else if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app"></main><div id="status" role="status"></div><div id="toast" role="status"></div><script type="module" src="app.js"></script>',
      )
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: scenario.lang === 'fr' ? 2 : 1,
    colorScheme: scenario.theme === 'light' ? 'light' : 'dark',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('requestfailed', (r) =>
    errors.push(
      `request failed: ${new URL(r.url()).pathname} ${r.failure()?.errorText ?? ''}`,
    ),
  )
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (
      !url.startsWith(`${origin}/`) &&
      !url.startsWith('data:') &&
      !url.startsWith('blob:')
    ) {
      errors.push('disallowed external request')
      return route.abort()
    }
    return route.continue()
  })
  try {
    await page.clock.install({ time: new Date('2026-11-11T12:00:00.000Z') })
    await page.goto(origin, { waitUntil: 'load' })
    await page.waitForSelector('.bt-scene3d canvas', { state: 'visible' })
    for (const category of ['read', 'written', 'found', 'linked', 'missing'])
      await page
        .locator(`[data-key="lg-btn-${category}"]`)
        .waitFor({ state: 'visible' })
    const counts = semantic
      ? { read: 2, written: 1, found: 1, linked: 1, missing: 1 }
      : { read: 1, written: 1, found: 1, linked: 0, missing: 0 }
    for (const [category, expected] of Object.entries(counts)) {
      const text = await page
        .locator(`[data-key="lg-btn-${category}"]`)
        .innerText()
      if (!text.startsWith(`${expected} `))
        throw new Error(`unexpected ${category} count: ${text}`)
    }
    const palette =
      scenario.theme === 'light'
        ? [
            'rgb(37, 99, 235)',
            'rgb(217, 119, 6)',
            'rgb(139, 92, 246)',
            'rgb(13, 148, 136)',
            'rgb(225, 29, 72)',
          ]
        : [
            'rgb(59, 130, 246)',
            'rgb(245, 158, 11)',
            'rgb(167, 139, 250)',
            'rgb(45, 212, 191)',
            'rgb(244, 63, 94)',
          ]
    for (const [index, category] of [
      'read',
      'written',
      'found',
      'linked',
      'missing',
    ].entries()) {
      const color = await page
        .locator(`[data-key="lg-dot-${category}"]`)
        .evaluate((element) => getComputedStyle(element).color)
      if (color !== palette[index])
        throw new Error(`unexpected ${category} palette: ${color}`)
    }
    await page.locator('button[data-key="spin"]').click()
    const canvas = await page.locator('.bt-scene3d canvas').elementHandle()
    const scanFiles = (target = canvas) =>
      target.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const tip = element.parentElement?.querySelector('.bt-tip')
        const found = new Map()
        for (let y = Math.ceil(rect.top); y < rect.bottom; y++) {
          for (let x = Math.ceil(rect.left); x < rect.right; x++) {
            element.dispatchEvent(
              new PointerEvent('pointermove', {
                clientX: x,
                clientY: y,
                bubbles: true,
              }),
            )
            if (tip && !tip.hidden && tip.textContent) {
              const points = found.get(tip.textContent) ?? []
              points.push({ x, y })
              found.set(tip.textContent, points)
            }
          }
        }
        return [...found].map(([name, points]) => {
          const mean = points.reduce(
            (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
            { x: 0, y: 0 },
          )
          mean.x /= points.length
          mean.y /= points.length
          const point = points.reduce((best, candidate) =>
            Math.hypot(candidate.x - mean.x, candidate.y - mean.y) <
            Math.hypot(best.x - mean.x, best.y - mean.y)
              ? candidate
              : best,
          )
          return [name, point]
        })
      })
    // Settle the damping tail, then sample picks and pixels on the same frame.
    // The screenshot uses the compositor and does not await a page rAF.
    const pixelTime = await page.evaluate(() => Date.now() + 1000)
    await page.clock.pauseAt(pixelTime)
    const fittedFiles = await scanFiles()
    for (const name of layout.layout.paths)
      if (!fittedFiles.some(([file]) => file === name))
        throw new Error(`default scene did not fit pickable file ${name}`)
    // The compositor screenshot observes what a user sees; copying the WebGL
    // drawing buffer here can instead read a discarded, transparent frame.
    // Locate the known read file with the existing raycast scan, and exclude
    // DOM labels and the tooltip rather than counting their pixels as points.
    const readPoint = fittedFiles.find(([name]) => name === 'notes/a.md')[1]
    await page.mouse.move(readPoint.x, readPoint.y)
    await page.mouse.move(0, 0)
    const clip = {
      x: Math.floor(readPoint.x) - 20,
      y: Math.floor(readPoint.y) - 20,
      width: 40,
      height: 40,
    }
    const overlays = () =>
      canvas.evaluate((element, point) => {
        const bounds = element.getBoundingClientRect()
        if (
          point.x - 20 < bounds.left ||
          point.x + 20 > bounds.right ||
          point.y - 20 < bounds.top ||
          point.y + 20 > bounds.bottom
        )
          throw new Error('Read file pixel probe is too close to canvas edge')
        const result = []
        for (const overlay of element.parentElement.querySelectorAll(
          '.bt-scene-labels span, .bt-tip',
        )) {
          const style = getComputedStyle(overlay)
          if (
            overlay.hidden ||
            style.display === 'none' ||
            style.visibility !== 'visible' ||
            Number(style.opacity) === 0
          )
            continue
          const rect = overlay.getBoundingClientRect()
          result.push({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          })
        }
        for (let y = Math.floor(point.y - 4); y <= Math.ceil(point.y + 4); y++)
          for (
            let x = Math.floor(point.x - 4);
            x <= Math.ceil(point.x + 4);
            x++
          )
            if (document.elementFromPoint(x, y) !== element)
              throw new Error(
                'Read file pixel probe is covered by a DOM element',
              )
        return result
      }, readPoint)
    const beforeOverlays = await overlays()
    const screenshot = await page.screenshot({
      type: 'png',
      scale: 'css',
      clip,
    })
    const afterOverlays = await overlays()
    await page.clock.resume()
    const pixels = await page.evaluate(
      async ({ image, point, clip, overlays }) => {
        const bitmap = new Image()
        bitmap.src = image
        await bitmap.decode()
        const copy = document.createElement('canvas')
        copy.width = bitmap.naturalWidth
        copy.height = bitmap.naturalHeight
        const context = copy.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Could not decode scene screenshot')
        context.drawImage(bitmap, 0, 0)
        const { data, width, height } = context.getImageData(
          0,
          0,
          copy.width,
          copy.height,
        )
        const sx = width / clip.width
        const sy = height / clip.height
        const core = []
        const surround = [[], [], []]
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const px = clip.x + (x + 0.5) / sx
            const py = clip.y + (y + 0.5) / sy
            const distance = Math.hypot(px - point.x, py - point.y)
            const covered = overlays.some(
              (rect) =>
                px >= rect.left &&
                px < rect.right &&
                py >= rect.top &&
                py < rect.bottom,
            )
            if (covered && distance <= 4)
              throw new Error(
                'Read file pixel probe overlaps a label or tooltip',
              )
            if (covered) continue
            const offset = (y * width + x) * 4
            if (distance <= 4)
              core.push([data[offset], data[offset + 1], data[offset + 2]])
            else if (distance >= 12 && distance <= 18)
              for (let channel = 0; channel < 3; channel++)
                surround[channel].push(data[offset + channel])
          }
        }
        if (core.length < 3 || surround[0].length < 100)
          throw new Error(
            'Read file pixel probe has insufficient unobscured samples',
          )
        const background = surround.map((values) => {
          values.sort((a, b) => a - b)
          return values[Math.floor(values.length / 2)]
        })
        const contrasting = core.filter((pixel) =>
          pixel.some(
            (value, channel) => Math.abs(value - background[channel]) >= 20,
          ),
        ).length
        return {
          point,
          background,
          contrasting,
          samples: core.length,
          scale: [sx, sy],
        }
      },
      {
        image: `data:image/png;base64,${screenshot.toString('base64')}`,
        point: readPoint,
        clip,
        overlays: [...beforeOverlays, ...afterOverlays],
      },
    )
    if (pixels.contrasting < 3)
      throw new Error(
        `WebGL read file has no visible canvas contrast: ${JSON.stringify(pixels)}`,
      )
    const measure = async () =>
      page.evaluate(() => {
        const bounds = (s) => {
          const r = document.querySelector(s)?.getBoundingClientRect()
          return (
            r && {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              bottom: r.bottom,
            }
          )
        }
        const c = document.querySelector('.bt-scene3d canvas')
        const gl = c && (c.getContext('webgl2') || c.getContext('webgl'))
        return {
          header: bounds('[data-key="pane-header"]'),
          footer: bounds('[data-key="pane-footer"]'),
          canvas: bounds('.bt-scene3d canvas'),
          live: !!gl && !gl.isContextLost(),
          width: innerWidth,
          height: innerHeight,
        }
      })
    const initial = await measure()
    if (
      !initial.live ||
      !initial.header ||
      !initial.footer ||
      !initial.canvas ||
      initial.canvas.width <= 0 ||
      initial.canvas.height <= 0 ||
      initial.header.y < 0 ||
      initial.footer.bottom > initial.height + 1 ||
      initial.canvas.y < initial.header.bottom - 1 ||
      initial.canvas.bottom > initial.footer.y + 1
    )
      throw new Error(
        `invalid initial browser layout: ${JSON.stringify(initial)}`,
      )
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('WebGL canvas has no bounds')
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    )
    await page.mouse.wheel(0, -360)
    // OrbitControls retains sub-CSSOM damping after spin stops. Pause actual
    // animation frames only for the publication comparison, not the gesture.
    const pauseTime = await page.evaluate(() => Date.now() + 1000)
    await page.clock.pauseAt(pauseTime)
    const frozenTime = await page.evaluate(() => performance.now())
    const projected = () =>
      canvas.evaluate((element) =>
        [
          ...element.parentElement.querySelectorAll('.bt-scene-labels span'),
        ].map((label) => {
          const parent = label.parentElement.getBoundingClientRect()
          return {
            text: label.textContent,
            left: label.hidden ? null : label.style.left,
            top: label.hidden ? null : label.style.top,
            parent: [parent.x, parent.y, parent.width, parent.height],
            hidden: label.hidden,
          }
        }),
      )
    const waitMeter = (value) => {
      let timer
      const observed = page.evaluate(
        (text) =>
          new Promise((resolve) => {
            const app = document.querySelector('#app')
            const observer = new MutationObserver(() => {
              if (app?.textContent?.includes(text)) {
                observer.disconnect()
                resolve()
              }
            })
            observer.observe(app, {
              childList: true,
              subtree: true,
              characterData: true,
            })
            if (app.textContent.includes(text)) {
              observer.disconnect()
              resolve()
            }
          }),
        `${value} %`,
      )
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`meter update ${value} did not render`)),
          10000,
        )
      })
      return Promise.race([observed, timeout]).finally(() =>
        clearTimeout(timer),
      )
    }
    const projectionBefore = await projected()
    if (projectionBefore.filter((label) => !label.hidden).length < 2)
      throw new Error(
        'WebGL camera proof needs at least two projected landmarks',
      )
    const pickedFiles = await scanFiles()
    if (
      !pickedFiles.length ||
      !pickedFiles.some(([name, point]) => {
        const before = fittedFiles.find(([file]) => file === name)?.[1]
        return before && Math.hypot(point.x - before.x, point.y - before.y) > 8
      })
    )
      throw new Error(
        'WebGL zoom did not move the camera away from default fit',
      )
    const spinControl = await page
      .locator('button[data-key="spin"]')
      .textContent()
    const inspectPicks = () =>
      canvas.evaluate((element, coordinates) => {
        const tip = element.parentElement?.querySelector('.bt-tip')
        return coordinates.map(([name, point]) => ({
          name,
          point,
          neighbors: [
            [0, 0],
            [-2, 0],
            [2, 0],
            [0, -2],
            [0, 2],
          ].map(([dx, dy]) => {
            element.dispatchEvent(
              new PointerEvent('pointermove', {
                clientX: point.x + dx,
                clientY: point.y + dy,
                bubbles: true,
              }),
            )
            return { dx, dy, hit: tip && !tip.hidden ? tip.textContent : null }
          }),
        }))
      }, pickedFiles)
    const stale = {
      ...snapshot,
      generation: snapshot.generation - 1,
      revision: snapshot.revision + 100,
      facts: {
        ...snapshot.facts,
        meter: { ...snapshot.facts.meter, percent: 99 },
      },
    }
    for (const client of clients)
      client.write(`data: ${JSON.stringify(stale)}\n\n`)
    const ordinary = {
      ...snapshot,
      revision: snapshot.revision + 1,
      facts: {
        ...snapshot.facts,
        meter: { ...snapshot.facts.meter, percent: 43 },
      },
    }
    const meter43 = waitMeter(43)
    for (const client of clients)
      client.write(`data: ${JSON.stringify(layout)}\n\n`)
    for (const client of clients)
      client.write(`data: ${JSON.stringify(ordinary)}\n\n`)
    await meter43
    if (!(await page.getByText('43 %', { exact: false }).first().isVisible()))
      throw new Error('43% meter update was not visible')
    if ((await page.evaluate(() => performance.now())) !== frozenTime)
      throw new Error('browser clock advanced during first publication')
    if (!(await canvas.evaluate((el) => el.isConnected)))
      throw new Error('ordinary update replaced the WebGL canvas')
    const cameraStable = await canvas.evaluate((element, coordinates) => {
      const tip = element.parentElement?.querySelector('.bt-tip')
      return coordinates.every(([name, point]) => {
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: point.x,
            clientY: point.y,
            bubbles: true,
          }),
        )
        return tip && !tip.hidden && tip.textContent === name
      })
    }, pickedFiles)
    const projectionAfter = await projected()
    if (
      !cameraStable ||
      JSON.stringify(projectionBefore) !== JSON.stringify(projectionAfter)
    ) {
      const rescanned = await scanFiles()
      throw new Error(
        `ordinary meter update changed camera/picking: ${JSON.stringify({
          pickedFiles,
          rescanned,
          projectionBefore,
          projectionAfter,
          spinControl,
          action: 'wheel zoom then equal-layout and meter snapshot',
          neighborhoods: await inspectPicks(),
        })}`,
      )
    }
    const second = await fetch(`${origin}/events`)
    if (!second.ok || !second.body)
      throw new Error('second SSE client could not connect')
    for (const client of clients)
      client.write(`data: ${JSON.stringify(layout)}\n\n`)
    const secondPublish = {
      ...ordinary,
      revision: ordinary.revision + 1,
      facts: {
        ...ordinary.facts,
        meter: { ...ordinary.facts.meter, percent: 44 },
      },
    }
    const meter44 = waitMeter(44)
    for (const client of clients)
      client.write(`data: ${JSON.stringify(secondPublish)}\n\n`)
    await meter44
    if (!(await page.getByText('44 %', { exact: false }).first().isVisible()))
      throw new Error('44% meter update was not visible')
    if ((await page.evaluate(() => performance.now())) !== frozenTime)
      throw new Error('browser clock advanced during second publication')
    const secondStable = await canvas.evaluate((element, coordinates) => {
      const tip = element.parentElement?.querySelector('.bt-tip')
      return coordinates.every(([name, point]) => {
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: point.x,
            clientY: point.y,
            bubbles: true,
          }),
        )
        return tip && !tip.hidden && tip.textContent === name
      })
    }, pickedFiles)
    const projectionSecond = await projected()
    if (
      !secondStable ||
      JSON.stringify(projectionBefore) !== JSON.stringify(projectionSecond)
    )
      throw new Error(
        `second SSE client publication changed camera/picking: ${JSON.stringify(
          {
            pickedFiles,
            rescanned: await scanFiles(),
            projectionBefore,
            projectionSecond,
            spinControl,
            action: 'wheel zoom then second SSE publication',
            neighborhoods: await inspectPicks(),
          },
        )}`,
      )
    await page.clock.resume()
    await second.body.cancel()
    const hiddenNames = {
      ...ordinary,
      revision: ordinary.revision + 2,
      facts: {
        ...ordinary.facts,
        settings: { ...ordinary.facts.settings, hover: false },
      },
    }
    for (const client of clients)
      client.write(`data: ${JSON.stringify(hiddenNames)}\n\n`)
    await page.waitForFunction(
      () => document.querySelector('.bt-tip')?.hidden === true,
    )
    const restoredNames = {
      ...ordinary,
      revision: ordinary.revision + 3,
      facts: {
        ...ordinary.facts,
        settings: { ...ordinary.facts.settings, hover: true },
      },
    }
    for (const client of clients)
      client.write(`data: ${JSON.stringify(restoredNames)}\n\n`)
    const [pickedName, pickedPoint] = pickedFiles[0]
    await page.waitForFunction(
      ({ name, point }) => {
        const element = document.querySelector('.bt-scene3d canvas')
        const tip = element?.parentElement?.querySelector('.bt-tip')
        element?.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: point.x,
            clientY: point.y,
            bubbles: true,
          }),
        )
        return tip && !tip.hidden && tip.textContent === name
      },
      { name: pickedName, point: pickedPoint },
    )
    if (!(await canvas.evaluate((el) => el.isConnected)))
      throw new Error('ordinary settings update replaced the WebGL canvas')
    if (
      !snapshot.facts.breakdown?.memoryFiles?.some(
        (file) => file.path === '/work/demo/CLAUDE.md' && file.tokens === 900,
      )
    )
      throw new Error('native feed omitted the host startup memory breakdown')
    await page.locator('[data-key="t-context"]').click()
    await page.locator('button[data-key="more-context"]').click()
    await page
      .locator('[data-key="open-mem-/work/demo/CLAUDE.md"]')
      .waitFor({ state: 'visible' })
    await page.locator('[data-key="t-files"]').click()
    const start = page.locator('[data-key="kpi-start"]')
    if (!/\b1\b/.test(await start.innerText()))
      throw new Error('Files did not count the host startup memory file')
    await page.locator('[data-key="kpi-open-start"]').click()
    await page
      .locator('[data-key="kd-open-CLAUDE.md"]')
      .waitFor({ state: 'visible' })
    await page.locator('[data-key="t-map"]').click()
    await page.waitForSelector('.bt-scene3d canvas', { state: 'visible' })
    await page.setViewportSize({ width: 700, height: 900 })
    await page.waitForTimeout(100)
    const resized = await measure()
    if (
      !resized.live ||
      !resized.canvas ||
      resized.canvas.width <= 0 ||
      resized.canvas.height <= 0 ||
      !resized.footer ||
      resized.footer.bottom > resized.height + 1
    )
      throw new Error(
        `invalid resized browser layout: ${JSON.stringify(resized)}`,
      )
    await page.locator('[data-key="t-goal"]').click()
    await page.locator('[data-key="t-map"]').click()
    await page.waitForSelector('.bt-scene3d canvas', { state: 'visible' })
    const revealed = await measure()
    if (
      !revealed.live ||
      !revealed.canvas ||
      revealed.canvas.width <= 0 ||
      revealed.canvas.height <= 0
    )
      throw new Error('WebGL scene did not survive hide/reveal')
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.waitForTimeout(100)
    if (errors.length) throw new Error(errors.join('; '))
    const png = await page.screenshot({ type: 'png', scale: 'css' })
    // Exercise the real Chromium touch boundary after the visual screenshot: the
    // captured host feed refuses commands, but requests still expose attempted opens.
    const touchCanvas = await page.locator('.bt-scene3d canvas').elementHandle()
    const touchFiles = await scanFiles(touchCanvas)
    const touchTarget = touchFiles.find(([name]) => name === 'notes/a.md')
    if (!touchTarget) throw new Error('touch proof needs a pickable file')
    const [, point] = touchTarget
    const touchBounds = await touchCanvas.boundingBox()
    if (!touchBounds) throw new Error('touch proof needs canvas bounds')
    const other = {
      x:
        point.x + (point.x + 40 < touchBounds.x + touchBounds.width ? 40 : -40),
      y: point.y,
      id: 1,
    }
    const file = { x: point.x, y: point.y, id: 2 }
    if (
      other.x <= touchBounds.x ||
      other.x >= touchBounds.x + touchBounds.width
    )
      throw new Error('touch proof needs room for two distinct contacts')
    const touchEvents = []
    await page.exposeFunction('__brainTrailTouchProof', (event) =>
      touchEvents.push(event),
    )
    await touchCanvas.evaluate((element) => {
      for (const type of ['pointerdown', 'pointerup'])
        element.addEventListener(
          type,
          (event) => {
            if (event.pointerType === 'touch')
              void window.__brainTrailTouchProof({
                type: event.type,
                pointerId: event.pointerId,
                trusted: event.isTrusted,
              })
          },
          true,
        )
    })
    const opens = []
    const isOpen = (request) => {
      if (new URL(request.url()).pathname !== '/command') return false
      const command = request.postDataJSON()?.command
      return (
        command?.kind === 'open' ||
        (command?.kind === 'view' &&
          command.intent?.kind === 'preview' &&
          command.intent.ref !== null)
      )
    }
    page.on('request', (request) => {
      if (isOpen(request)) opens.push(request.postDataJSON().command)
    })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 2,
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [other],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [other, file],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [other],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
    await page.clock.runFor(350)
    await page.waitForTimeout(100)
    if (
      touchEvents.length !== 4 ||
      touchEvents.some((event) => !event.trusted) ||
      touchEvents[0].type !== 'pointerdown' ||
      touchEvents[1].type !== 'pointerdown' ||
      touchEvents[2].type !== 'pointerup' ||
      touchEvents[3].type !== 'pointerup' ||
      touchEvents[0].pointerId !== touchEvents[2].pointerId ||
      touchEvents[1].pointerId !== touchEvents[3].pointerId ||
      touchEvents[0].pointerId === touchEvents[1].pointerId
    )
      throw new Error(
        `touch proof did not deliver trusted first-contact-first release: ${JSON.stringify(touchEvents)}`,
      )
    if (opens.length !== 0)
      throw new Error(
        `two-finger gesture attempted to open a file: ${JSON.stringify(opens)}`,
      )
    const positiveOpen = page.waitForEvent('request', {
      predicate: isOpen,
      timeout: 5000,
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [file],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
    await page.clock.runFor(350)
    const positive = (await positiveOpen).postDataJSON().command
    const openedPath =
      positive.kind === 'open' ? positive.ref?.p : positive.intent?.ref?.p
    if (openedPath !== 'notes/a.md')
      throw new Error(
        `single touch opened the wrong file: ${JSON.stringify(positive)}`,
      )
    await cdp.detach()
    for (const client of clients) client.end()
    await page
      .getByText('Connection lost. Reopen from the host.')
      .waitFor({ state: 'visible' })
    if (!(await page.locator('#app').evaluate((element) => element.inert)))
      throw new Error('disconnected browser did not disable the application')
    if (errors.length) throw new Error(errors.join('; '))
    return {
      png,
      probe: { initial, resized, revealed, readFilePixels: pixels },
    }
  } finally {
    await context.close()
    for (const client of clients) client.end()
    await new Promise((resolve) => server.close(resolve))
  }
}
