import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function rendererFailureProof(browser, root) {
  const temp = await mkdtemp(path.join(tmpdir(), 'renderer-failure-'))
  const dependencies = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../node_modules',
  )
  const link = path.join(root, 'node_modules')
  let linked = false
  try {
    await symlink(dependencies, link, 'dir')
    linked = true
    const output = path.join(temp, 'fixture.js')
    await execFileAsync(
      'bun',
      [
        'build',
        path.join(root, 'scripts/fixtures/renderer-failure.ts'),
        '--target=browser',
        `--outfile=${output}`,
      ],
      { cwd: root },
    )
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.setContent('<!doctype html><body></body>')
      await page.addScriptTag({ content: await readFile(output, 'utf8') })
      return await page.evaluate(() => window.rendererFailureProof())
    } finally {
      await context.close()
    }
  } finally {
    if (linked) await rm(link, { force: true })
    await rm(temp, { recursive: true, force: true })
  }
}

async function deniedWebGLProof(
  browser,
  origin,
  clients,
  layout,
  snapshot,
  lang,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  })
  try {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext
      window.__glAttempts = 0
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (['webgl2', 'webgl', 'experimental-webgl'].includes(kind)) {
          window.__glAttempts++
          return null
        }
        return original.call(this, kind, ...args)
      }
    })
    await page.goto(origin, { waitUntil: 'load' })
    const notice = page.locator('.bt-scene3d-unavailable[role="status"]')
    await notice.waitFor({ state: 'visible' })
    const text = await notice.innerText()
    if (
      !/webgl/i.test(text) ||
      !/2D/.test(text) ||
      !(lang === 'fr' ? /indisponible/i : /unavailable/i).test(text)
    )
      throw new Error(`unavailable notice is not localized or honest: ${text}`)
    const attempts = await page.evaluate(() => window.__glAttempts)
    if (!attempts) throw new Error('WebGL context denial was not exercised')
    const assertLayout = async () => {
      await page.evaluate(() => {
        window.__btUnavailableSample = undefined
      })
      await page.waitForFunction(
        () => {
          const header = document.querySelector('[data-key="pane-header"]')
          const footer = document.querySelector('[data-key="pane-footer"]')
          const notice = document.querySelector('.bt-scene3d-unavailable')
          if (!header || !footer || !notice) return false
          const h = header.getBoundingClientRect()
          const f = footer.getBoundingClientRect()
          const n = notice.getBoundingClientRect()
          const values = [
            h.top,
            h.bottom,
            f.left,
            f.top,
            f.right,
            f.bottom,
            n.left,
            n.top,
            n.right,
            n.bottom,
            document.documentElement.scrollWidth,
            document.documentElement.scrollHeight,
            document.body.scrollWidth,
            document.body.scrollHeight,
          ]
          const previous = window.__btUnavailableSample
          const stable =
            previous &&
            values.every(
              (value, index) => Math.abs(value - previous.values[index]) < 0.1,
            )
          const count = stable ? previous.count + 1 : 0
          window.__btUnavailableSample = { values, count }
          return count >= 3
        },
        null,
        { polling: 'raf' },
      )
      const geometry = await page.evaluate(() => {
        const header = document.querySelector('[data-key="pane-header"]')
        const footer = document.querySelector('[data-key="pane-footer"]')
        const notice = document.querySelector('.bt-scene3d-unavailable')
        const rect = (element) => {
          const bounds = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            left: bounds.left,
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            width: bounds.width,
            height: bounds.height,
            visible:
              style.display !== 'none' &&
              style.visibility === 'visible' &&
              Number(style.opacity) > 0,
          }
        }
        return {
          header: rect(header),
          footer: rect(footer),
          notice: rect(notice),
          width: innerWidth,
          height: innerHeight,
          scrollWidth: Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          ),
          scrollHeight: Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
          ),
          scrollX,
          scrollY,
        }
      })
      const { header, footer, notice, width, height } = geometry
      if (
        !header.visible ||
        !footer.visible ||
        !notice.visible ||
        footer.width <= 0 ||
        footer.height <= 0 ||
        notice.width <= 0 ||
        notice.height <= 0 ||
        footer.left < -1 ||
        footer.right > width + 1 ||
        footer.top < -1 ||
        footer.bottom > height + 1 ||
        notice.left < -1 ||
        notice.right > width + 1 ||
        notice.top < header.bottom - 1 ||
        notice.bottom > footer.top + 1 ||
        geometry.scrollWidth > width + 1 ||
        geometry.scrollHeight > height + 1 ||
        geometry.scrollX !== 0 ||
        geometry.scrollY !== 0
      )
        throw new Error(
          `invalid unavailable WebGL layout: ${JSON.stringify(geometry)}`,
        )
      return geometry
    }
    const unavailableLayouts = [await assertLayout()]
    for (const [index, width] of [900, 1100, 1280].entries()) {
      await page.setViewportSize({ width, height: 720 })
      const event = {
        ...snapshot,
        revision: snapshot.revision + index + 1,
        facts: {
          ...snapshot.facts,
          meter: { ...snapshot.facts.meter, percent: 51 + index },
        },
      }
      for (const client of clients) {
        client.write(`data: ${JSON.stringify(layout)}\n\n`)
        client.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      await page
        .getByText(`${51 + index} %`, { exact: false })
        .first()
        .waitFor({ state: 'visible' })
      const state = await page.evaluate(() => ({
        roots: document.querySelector('#app')?.children.length,
        headers: document.querySelectorAll('[data-key="pane-header"]').length,
        footers: document.querySelectorAll('[data-key="pane-footer"]').length,
        notices: document.querySelectorAll('.bt-scene3d-unavailable').length,
        attempts: window.__glAttempts,
      }))
      if (
        state.roots !== 1 ||
        state.headers !== 1 ||
        state.footers !== 1 ||
        state.notices !== 1 ||
        state.attempts !== attempts
      )
        throw new Error(
          `denied WebGL update leaked roots or retried: ${JSON.stringify(state)}`,
        )
      unavailableLayouts.push(await assertLayout())
    }
    for (const [tab, landmark] of [
      ['t-goal', '[data-key="plan-0"]'],
      ['t-files', '[data-key="kpi-start"]'],
      ['t-context', 'button[data-key="more-context"]'],
      ['t-coach', '[data-key="coach-run"]'],
      ['settings', '[data-key="lang-en"]'],
    ]) {
      await page.locator(`[data-key="${tab}"]`).click()
      await page.locator(landmark).waitFor({ state: 'visible' })
    }
    const langRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === '/command' &&
        request.postDataJSON()?.command?.kind === 'lang',
    )
    await page
      .locator(`[data-key="lang-${lang === 'fr' ? 'en' : 'fr'}"]`)
      .click()
    await langRequest
    await page.locator('[data-key="t-map"]').click()
    await notice.waitFor({ state: 'visible' })
    await page.locator('[data-key="view-3d"]').click()
    await page
      .locator('[data-key="map-wrap"] .bt-svg')
      .waitFor({ state: 'visible' })
    if (
      (await page.locator('[data-key="view-3d"]').innerText()).trim() !== '3D'
    )
      throw new Error('explicit 2D control did not switch dimensions')
    if (errors.length)
      throw new Error(`denied WebGL caused page errors: ${errors.join('; ')}`)
    return {
      notice: text,
      initialContextAttempts: attempts,
      layouts: unavailableLayouts,
      updates: 3,
      tabs: 5,
      explicit2D: true,
    }
  } finally {
    await context.close()
  }
}

// Replay the actual adapter's captured feed through the built application. Commands
// are deliberately refused: this transport does not stand in for a live host.
export async function captureBrowserScene(
  browser,
  root,
  captured,
  scenario,
  semantic = false,
  candidate = false,
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
  const dist = path.join(root, 'hosts/browser/dist')
  const assets = new Map(
    await Promise.all(
      ['app.js', 'app.css'].map(async (name) => [
        name,
        await readFile(path.join(dist, name)),
      ]),
    ),
  )
  let shell
  if (candidate) {
    shell = await readFile(path.join(dist, 'index.html'))
  } else {
    // The historical relay serves its Go raw-string page directly at the
    // session root; use that revision's source, not a reconstructed shell.
    const relay = await readFile(path.join(root, 'hosts/relay/main.go'), 'utf8')
    const match = /^const page = `([^`]*)`$/m.exec(relay)
    if (!match) throw new Error('historical relay production page not found')
    shell = match[1]
  }
  const clients = new Set()
  let deferWhole = false
  let wholeArrived = () => {}
  let releaseWhole
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
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const command = JSON.parse(body).command
        res.writeHead(200, { 'content-type': 'application/json' })
        if (
          deferWhole &&
          command?.kind === 'view' &&
          command.intent?.kind === 'whole'
        ) {
          deferWhole = false
          releaseWhole = () => res.end('{"ok":true}')
          wholeArrived()
        } else res.end('{"ok":false,"error":"unsupported"}')
      })
    } else if (req.url === '/pair') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"v":1,"ok":false,"error":"unsupported"}')
    } else if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(shell)
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
    const failureProof =
      candidate && semantic ? await rendererFailureProof(browser, root) : null
    const unavailableProof =
      candidate && semantic
        ? await deniedWebGLProof(
            browser,
            origin,
            clients,
            layout,
            snapshot,
            scenario.lang,
          )
        : null
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
    // Screenshot the composited canvas during real Chromium input. Hide DOM
    // labels/tooltip so their motion cannot masquerade as changed WebGL pixels.
    const dragStyle = await page.addStyleTag({
      content: '.bt-scene-labels, .bt-tip { visibility: hidden !important }',
    })
    const dragBounds = await canvas.boundingBox()
    if (!dragBounds) throw new Error('held drag needs visible canvas bounds')
    const dragClip = {
      x: Math.ceil(dragBounds.x),
      y: Math.ceil(dragBounds.y),
      width: Math.floor(dragBounds.width) - 1,
      height: Math.floor(dragBounds.height) - 1,
    }
    await canvas.evaluate((element) => {
      window.__btHeldMoves = []
      element.addEventListener('pointermove', (event) => {
        if (event.isTrusted && event.buttons === 1)
          window.__btHeldMoves.push([event.clientX, event.clientY])
      })
    })
    const frame = async () => {
      await page.clock.runFor(180)
      return page.screenshot({ type: 'png', scale: 'css', clip: dragClip })
    }
    const x = dragBounds.x + dragBounds.width * 0.5
    const y = dragBounds.y + dragBounds.height * 0.5
    await page.mouse.move(x, y)
    const beforeWheel = await frame()
    await page.mouse.wheel(0, 220)
    const afterWheel = await frame()
    const beforeDragProjection = await projected()
    await page.mouse.down()
    await page.mouse.move(x + 55, y + 15, { steps: 5 })
    const heldFirst = await frame()
    const firstDragProjection = await projected()
    await page.mouse.move(x + 115, y + 35, { steps: 5 })
    const heldSecond = await frame()
    const secondDragProjection = await projected()
    const heldMoves = await page.evaluate(() => window.__btHeldMoves.length)
    // Both screenshots were captured above while the primary button was held.
    await page.mouse.up()
    await dragStyle.evaluate((element) => element.remove())
    const pixelChanges = await page.evaluate(
      async (sources) => {
        const buffers = []
        for (const source of sources) {
          const image = new Image()
          image.src = source
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const context = canvas.getContext('2d')
          if (!context) throw new Error('cannot decode gesture screenshots')
          context.drawImage(image, 0, 0)
          buffers.push(
            context.getImageData(0, 0, canvas.width, canvas.height).data,
          )
        }
        return buffers.slice(1).map((right, index) => {
          const left = buffers[index]
          let changed = 0
          for (let i = 0; i < right.length; i += 4)
            if (
              left[i] !== right[i] ||
              left[i + 1] !== right[i + 1] ||
              left[i + 2] !== right[i + 2]
            )
              changed++
          return changed
        })
      },
      [beforeWheel, afterWheel, heldFirst, heldSecond].map(
        (png) => `data:image/png;base64,${png.toString('base64')}`,
      ),
    )
    if (
      heldMoves < 2 ||
      pixelChanges.some((count) => count < 20) ||
      JSON.stringify(beforeDragProjection) ===
        JSON.stringify(firstDragProjection) ||
      JSON.stringify(firstDragProjection) ===
        JSON.stringify(secondDragProjection)
    )
      throw new Error(
        `wheel/held drag did not paint distinct frames: ${JSON.stringify({ heldMoves, pixelChanges })}`,
      )
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
    const compactMeasurements = []
    for (const height of [430, 320, 430]) {
      await page.setViewportSize({ width: 700, height })
      // Playwright polls a synchronous predicate. An async predicate returns a
      // truthy Promise before its animation-frame samples have completed.
      await page.evaluate(() => {
        window.__btCompactSample = undefined
      })
      await page.waitForFunction((expected) => {
        const app = document.querySelector('#app')
        const brand = !!document.querySelector('[data-key="brand"]')
        const canvas = document.querySelector('.bt-scene3d canvas')
        const header = document.querySelector('[data-key="pane-header"]')
        const footer = document.querySelector('[data-key="pane-footer"]')
        const wantsBrand = app?.clientHeight >= 408
        if (
          !app ||
          app.clientHeight <= 0 ||
          app.getBoundingClientRect().bottom > expected + 1 ||
          brand !== wantsBrand ||
          !canvas ||
          !header ||
          !footer
        ) {
          window.__btCompactSample = undefined
          return false
        }
        const c = canvas.getBoundingClientRect()
        const h = header.getBoundingClientRect()
        const f = footer.getBoundingClientRect()
        const values = [
          c.left,
          c.top,
          c.width,
          c.height,
          h.bottom,
          f.top,
          f.bottom,
        ]
        const fits =
          c.width > 0 &&
          c.height > 0 &&
          c.top >= h.bottom - 1 &&
          c.bottom <= f.top + 1 &&
          f.bottom <= innerHeight + 1
        const previous = window.__btCompactSample
        const stable =
          fits &&
          previous &&
          values.every(
            (value, index) => Math.abs(value - previous.values[index]) < 0.1,
          )
        const count = stable ? previous.count + 1 : 0
        window.__btCompactSample = { values, count }
        return count >= 3
      }, height)
      const compact = await page.evaluate(() => {
        const app = document.querySelector('#app')
        const canvas = document.querySelector('.bt-scene3d canvas')
        const header = document.querySelector('[data-key="pane-header"]')
        const footer = document.querySelector('[data-key="pane-footer"]')
        const c = canvas?.getBoundingClientRect()
        const h = header?.getBoundingClientRect()
        const f = footer?.getBoundingClientRect()
        return {
          appHeight: app?.clientHeight,
          roots: app?.children.length,
          maps: document.querySelectorAll('[data-key="t-map"]').length,
          brand: !!document.querySelector('[data-key="brand"]'),
          canvas: c && {
            width: c.width,
            height: c.height,
            top: c.top,
            bottom: c.bottom,
          },
          headerBottom: h?.bottom,
          footerTop: f?.top,
          footerBottom: f?.bottom,
          viewportHeight: innerHeight,
        }
      })
      if (
        compact.roots !== 1 ||
        compact.maps !== 1 ||
        compact.brand !== compact.appHeight >= 408 ||
        !compact.canvas ||
        compact.canvas.width <= 0 ||
        compact.canvas.height <= 0 ||
        compact.headerBottom === undefined ||
        compact.footerTop === undefined ||
        compact.footerBottom === undefined ||
        compact.canvas.top < compact.headerBottom - 1 ||
        compact.canvas.bottom > compact.footerTop + 1 ||
        compact.footerBottom > compact.viewportHeight + 1
      )
        throw new Error(
          `invalid compact transition: ${JSON.stringify(compact)}`,
        )
      compactMeasurements.push(compact)
    }
    if (candidate) {
      // The pairing shell consumes height outside #app. At a short, wide
      // viewport both its control and the dashboard header must receive clicks.
      await page.setViewportSize({ width: 800, height: 320 })
      const pair = page.getByRole('button', {
        name: 'Pair with Chat',
        exact: true,
      })
      const pairRequest = page.waitForRequest(
        (request) => new URL(request.url()).pathname === '/pair',
      )
      await pair.click()
      const request = await pairRequest
      if (
        JSON.stringify(request.postDataJSON()) !==
        JSON.stringify({
          v: 1,
          generation: snapshot.generation,
        })
      )
        throw new Error('compact pairing click sent the wrong generation')
      await page
        .getByText('Pairing refused: unsupported.', { exact: false })
        .waitFor({ state: 'visible' })
      await page.locator('[data-key="t-goal"]').click()
      await page.locator('[data-key="plan-0"]').waitFor({ state: 'visible' })
      await page.locator('[data-key="t-map"]').click()
      await page.waitForSelector('.bt-scene3d canvas', { state: 'visible' })
    }
    await page.setViewportSize({ width: 1280, height: 720 })
    // Local browser navigation is real; commands are refused by this fixture,
    // so it cannot establish that a host mutation or file operation succeeded.
    const tabs = {}
    const landmarks = {
      goal: '[data-key="plan-0"]',
      files: '[data-key="kpi-start"]',
      context: 'button[data-key="more-context"]',
      coach: '[data-key="coach-run"]',
      settings: '[data-key="lang-en"]',
    }
    for (const tab of ['goal', 'files', 'context', 'coach', 'settings']) {
      const key = tab === 'settings' ? 'settings' : `t-${tab}`
      await page.locator(`[data-key="${key}"]`).click()
      await page.locator(landmarks[tab]).waitFor({ state: 'visible' })
      if (tab === 'goal') {
        const current = await page.locator('[data-key="goal"]').innerText()
        const plan = await page.locator('[data-key="plan"]').innerText()
        const complete = await page.locator('[data-key="plan-0"]').innerText()
        const active = await page.locator('[data-key="plan-1"]').innerText()
        if (
          !current.includes('Check the final summary') ||
          !plan.includes('1/2') ||
          !complete.includes('✓') ||
          !complete.includes('Read the note') ||
          !active.includes('●') ||
          !active.includes('Write the summary')
        )
          throw new Error(
            'goal or plan progress does not match captured events',
          )
        const history = await page.locator('[data-key="history"]').innerText()
        if (
          history.indexOf('Check the final summary') < 0 ||
          history.indexOf('Summarise the notes') < 0 ||
          history.indexOf('Check the final summary') >=
            history.indexOf('Summarise the notes')
        )
          throw new Error('goal history is not newest first')
      }
      tabs[tab] = await page.screenshot({ type: 'png', scale: 'css' })
    }
    await page.locator('[data-key="t-map"]').click()
    await page.locator('[data-key="view-3d"]').click()
    const svgMap = page.locator('[data-key="map-wrap"] .bt-svg')
    await svgMap.waitFor({ state: 'visible' })
    const mapBounds = await svgMap.boundingBox()
    if (!mapBounds || mapBounds.width <= 0 || mapBounds.height <= 0)
      throw new Error('2D map has no visible area')
    tabs.map2d = await page.screenshot({ type: 'png', scale: 'css' })
    await page.locator('[data-key="view-3d"]').click()
    await page.waitForSelector('.bt-scene3d canvas', { state: 'visible' })
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
    if (candidate) {
      // A controlled delayed success tests the real page's response race. It
      // does not stand in for a host executing the command.
      await page.locator('[data-key="view-3d"]').click()
      const mapImage = page.locator('[data-key="map-wrap"] .bt-svg')
      await mapImage.waitFor({ state: 'visible' })
      const viewBox = async () => {
        const src = await mapImage.getAttribute('src')
        return /viewBox="([^"]+)"/.exec(decodeURIComponent(src ?? ''))?.[1]
      }
      const originalBox = await viewBox()
      const mapRect = await mapImage.boundingBox()
      if (!mapRect || !originalBox) throw new Error('2D race probe has no map')
      await page.mouse.move(
        mapRect.x + mapRect.width / 2,
        mapRect.y + mapRect.height / 2,
      )
      await page.mouse.wheel(0, -360)
      await page.clock.runFor(200)
      const zoomedBox = await viewBox()
      if (!zoomedBox || zoomedBox === originalBox)
        throw new Error(
          '2D race probe could not establish a non-default camera',
        )
      await page.locator('[data-key="view-3d"]').click()
      await page.waitForSelector('.bt-scene3d canvas', { state: 'visible' })
      const arrival = new Promise((resolve) => {
        wholeArrived = resolve
      })
      deferWhole = true
      await page.locator('[data-key="whole"]').click()
      await arrival
      await page.locator('[data-key="view-3d"]').click()
      await mapImage.waitFor({ state: 'visible' })
      const beforeReplyBox = await viewBox()
      if (beforeReplyBox !== zoomedBox)
        throw new Error('2D camera changed before delayed 3D reset completed')
      const wholeResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/command' &&
          response.request().postDataJSON()?.command?.intent?.kind === 'whole',
      )
      releaseWhole()
      releaseWhole = undefined
      await wholeResponse
      await page.clock.runFor(100)
      if ((await viewBox()) !== beforeReplyBox)
        throw new Error('delayed 3D reset changed the current 2D camera')
      await page.locator('[data-key="view-3d"]').click()
      await page.waitForSelector('.bt-scene3d canvas', { state: 'visible' })
    }
    // Synthetic presentation variants derived from the captured SDK feed;
    // command execution and host-side failure are not asserted by this replay.
    let probeRevision = snapshot.revision + 20
    const publishVariant = (changes) => {
      const event = {
        ...snapshot,
        revision: probeRevision++,
        facts: { ...snapshot.facts, ...changes },
      }
      for (const client of clients)
        client.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    publishVariant({ workspace: { kind: 'loading', since: Date.now() } })
    await page
      .getByText(
        scenario.lang === 'fr'
          ? 'Je range le dossier en un disque'
          : 'Packing the folder into one disc',
        { exact: false },
      )
      .waitFor({ state: 'visible' })
    tabs.loading = await page.screenshot({ type: 'png', scale: 'css' })
    publishVariant({
      workspace: { kind: 'failed', message: 'SYNTHETIC_INDEX_FAILURE' },
    })
    await page
      .getByText('SYNTHETIC_INDEX_FAILURE', { exact: false })
      .waitFor({ state: 'visible' })
    await page.locator('[data-key="retry"]').waitFor({ state: 'visible' })
    tabs.error = await page.screenshot({ type: 'png', scale: 'css' })
    publishVariant({ events: [] })
    await page.locator('[data-key="map-empty"]').waitFor({ state: 'visible' })
    tabs.empty = await page.screenshot({ type: 'png', scale: 'css' })
    await page.locator('[data-key="t-coach"]').click()
    publishVariant({
      coach: { text: '', at: 0, busy: false, error: 'SYNTHETIC_COACH_REFUSAL' },
    })
    await page
      .getByText('SYNTHETIC_COACH_REFUSAL', { exact: false })
      .waitFor({ state: 'visible' })
    tabs.coachError = await page.screenshot({ type: 'png', scale: 'css' })
    for (const client of clients) client.end()
    await page
      .getByText('Connection lost. Reopen from the host.')
      .waitFor({ state: 'visible' })
    if (!(await page.locator('#app').evaluate((element) => element.inert)))
      throw new Error('disconnected browser did not disable the application')
    if (errors.length) throw new Error(errors.join('; '))
    return {
      png,
      tabs,
      probe: {
        failureProof,
        unavailableProof,
        initial,
        resized,
        revealed,
        compactMeasurements,
        mapBounds,
        stateScreenshotLimit:
          'State screenshots are manual diagnostics, not pixel equality proofs; empty-state WebGL paint timing is nondeterministic.',
        readFilePixels: pixels,
      },
    }
  } finally {
    releaseWhole?.()
    await context.close()
    for (const client of clients) client.end()
    await new Promise((resolve) => server.close(resolve))
  }
}
