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
    await page.clock.setFixedTime(new Date('2026-11-11T12:00:00.000Z'))
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
    const scanFiles = () =>
      canvas.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const tip = element.parentElement?.querySelector('.bt-tip')
        const found = new Map()
        for (let y = rect.top + 3; y < rect.bottom - 3; y += 6) {
          for (let x = rect.left + 3; x < rect.right - 3; x += 6) {
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
    const fittedFiles = await scanFiles()
    for (const name of layout.layout.paths)
      if (!fittedFiles.some(([file]) => file === name))
        throw new Error(`default scene did not fit pickable file ${name}`)
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
    const projected = () =>
      canvas.evaluate((element) =>
        [
          ...element.parentElement.querySelectorAll('.bt-scene-labels span'),
        ].map((label) => {
          const parent = label.parentElement.getBoundingClientRect()
          return {
            text: label.textContent,
            left: label.style.left,
            top: label.style.top,
            parent: [parent.x, parent.y, parent.width, parent.height],
            hidden: label.hidden,
          }
        }),
      )
    const settled = await canvas.evaluate(async (element) => {
      const sample = () =>
        JSON.stringify(
          [
            ...element.parentElement.querySelectorAll('.bt-scene-labels span'),
          ].map((label) => {
            const parent = label.parentElement.getBoundingClientRect()
            return [
              label.textContent,
              label.style.left,
              label.style.top,
              parent.x,
              parent.y,
              parent.width,
              parent.height,
              label.hidden,
            ]
          }),
        )
      let previous = ''
      let unchanged = 0
      for (let frame = 0; frame < 1200; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const current = sample()
        unchanged = current === previous ? unchanged + 1 : 0
        if (unchanged >= 30 && current !== '[]') return true
        previous = current
      }
      return false
    })
    if (!settled)
      throw new Error('projected WebGL labels did not settle after zoom')
    const projectionBefore = await projected()
    if (projectionBefore.length < 2)
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
    for (const client of clients)
      client.write(`data: ${JSON.stringify(layout)}\n\n`)
    for (const client of clients)
      client.write(`data: ${JSON.stringify(ordinary)}\n\n`)
    await page
      .getByText('43 %', { exact: false })
      .first()
      .waitFor({ state: 'visible' })
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
    for (const client of clients)
      client.write(`data: ${JSON.stringify(secondPublish)}\n\n`)
    await page
      .getByText('44 %', { exact: false })
      .first()
      .waitFor({ state: 'visible' })
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
    for (const client of clients) client.end()
    await page
      .getByText('Connection lost. Reopen from the host.')
      .waitFor({ state: 'visible' })
    if (!(await page.locator('#app').evaluate((element) => element.inert)))
      throw new Error('disconnected browser did not disable the application')
    if (errors.length) throw new Error(errors.join('; '))
    return { png, probe: { initial, resized, revealed } }
  } finally {
    await context.close()
    for (const client of clients) client.end()
    await new Promise((resolve) => server.close(resolve))
  }
}
