#!/usr/bin/env bun
import * as Bun from 'bun'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'hosts/browser/dist')
const check = process.argv.slice(2)
if (check.some((arg) => arg !== '--check') || check.length > 1)
  throw new Error('Usage: bun scripts/build-browser.mjs [--check]')
if (Bun.version !== '1.4.4')
  throw new Error(`Expected Bun 1.4.4, got ${Bun.version}`)
const licenses = await Promise.all(
  [
    ['d3-hierarchy', 'hooks/vendor/d3-hierarchy/LICENSE'],
    ['marked', 'node_modules/marked/LICENSE'],
    ['DOMPurify', 'node_modules/dompurify/LICENSE'],
    ['highlight.js', 'node_modules/highlight.js/LICENSE'],
    ['MCP Apps SDK', 'node_modules/@modelcontextprotocol/ext-apps/LICENSE'],
    ['three and addons', 'node_modules/three/LICENSE'],
  ].map(
    async ([name, file]) =>
      `${name}:\n${await readFile(join(root, file), 'utf8')}`,
  ),
)
const banner = `/*! Third-party licenses\n${licenses.join('\n\n').replaceAll('*/', '* /')}\n*/`
const temp = await mkdtemp(join(tmpdir(), 'brain-trail-build-'))
try {
  const shell = await readFile(join(root, 'hosts/browser/shell.html'), 'utf8')
  const render = (style, script) => {
    const styleMarker = '<!-- BRAIN_TRAIL_STYLE -->'
    const scriptMarker = '<!-- BRAIN_TRAIL_SCRIPT -->'
    if (
      shell.split(styleMarker).length !== 2 ||
      shell.split(scriptMarker).length !== 2
    )
      throw new Error(
        'HTML shell must contain exactly one style and script marker',
      )
    return shell
      .replace(styleMarker, () => style)
      .replace(scriptMarker, () => script)
  }
  const build = async (entry, directory, define = {}) => {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir: join(temp, directory),
      root,
      target: 'browser',
      format: 'esm',
      splitting: false,
      sourcemap: 'none',
      packages: 'bundle',
      allowUnresolved: [],
      env: 'disable',
      minify: true,
      banner,
      // The Apps SDK logs full RPC payloads at debug level; keep warnings and errors.
      ...(directory === 'mcp' ? { drop: ['console.debug'] } : {}),
      define,
      naming: { entry: 'app.[ext]', asset: 'app.[ext]' },
    })
    if (!result.success) throw new Error(result.logs.map(String).join('\n'))
    return Promise.all(
      ['app.js', 'app.css'].map((file) =>
        readFile(join(temp, directory, file), 'utf8'),
      ),
    )
  }
  const [browserJs, browserCss] = await build(
    'hosts/browser/main.ts',
    'browser',
  )
  const placeholder = 'BRAIN_TRAIL_BUILD_ID_PLACEHOLDER_9f33aab3'
  const [appJs, appCss] = await build('hosts/mcp-app/main.ts', 'mcp', {
    __BRAIN_TRAIL_UI_BUILD_ID__: JSON.stringify(placeholder),
  })
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  const safeScript = appJs.replace(/<\/script/gi, '<\\/script')
  const safeStyle = appCss.replace(/<\/style/gi, '<\\/style')
  const unfinalized = render(
    `<style>${safeStyle}</style>`,
    `<script type="module">${safeScript}</script>`,
  )
  if (!unfinalized.includes(placeholder))
    throw new Error('MCP entry must use __BRAIN_TRAIL_UI_BUILD_ID__')
  const uiBuildId = hash(unfinalized)
  const html = unfinalized.replaceAll(placeholder, uiBuildId)
  const manifest = { v: 1, wireRevision: 1, uiBuildId, assetDigest: hash(html) }
  const files = {
    'app.js': browserJs,
    'app.css': browserCss,
    'index.html': render(
      '<link rel="stylesheet" href="app.css">',
      '<script type="module" src="app.js"></script>',
    ),
    'mcp-app.html': html,
    'mcp-app-manifest.json': `${JSON.stringify(manifest)}\n`,
  }
  if (check.length === 0) await mkdir(dist, { recursive: true })
  for (const [file, contents] of Object.entries(files)) {
    if (check.length === 0) await writeFile(join(dist, file), contents)
    else if (contents !== (await readFile(join(dist, file), 'utf8')))
      throw new Error(`${file} differs from the checked-in asset`)
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
