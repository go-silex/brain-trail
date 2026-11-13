#!/usr/bin/env bun
import * as Bun from 'bun'
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
    ['three and addons', 'node_modules/three/LICENSE'],
  ].map(
    async ([name, file]) =>
      `${name}:\n${await readFile(join(root, file), 'utf8')}`,
  ),
)
const banner = `/*! Third-party licenses\n${licenses.join('\n\n').replaceAll('*/', '* /')}\n*/`
const temp = await mkdtemp(join(tmpdir(), 'brain-trail-build-'))
try {
  const result = await Bun.build({
    entrypoints: [join(root, 'hosts/browser/main.ts')],
    outdir: temp,
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
    naming: { entry: 'app.[ext]', asset: 'app.[ext]' },
  })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  const files = ['app.js', 'app.css']
  if (check.length === 0) await mkdir(dist, { recursive: true })
  for (const file of files) {
    const actual = await readFile(join(temp, file))
    if (check.length === 0) await writeFile(join(dist, file), actual)
    else {
      const expected = await readFile(join(dist, file))
      if (!actual.equals(expected))
        throw new Error(`${file} differs from the checked-in asset`)
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
