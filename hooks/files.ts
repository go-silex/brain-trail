// The session's folder as a list of files, and which of them a tool call touched.
import type { TrailEvent } from '../types/model'

// Files that never feed the model as text: left out of the map.
const MEDIA = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|heic|mp4|mov|avi|mkv|webm|mp3|wav|m4a|ogg|flac|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|dmg|pkg|exe|dll|so|dylib|o|a|class|jar|pyc|wasm|bin|dat|db|sqlite3?|DS_Store)$/i
const HEAVY_DIRS = ['node_modules', '.git', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.cache', 'target', 'vendor', '.turbo', 'coverage']
export const MAX_FILES = 12000

export type Index = {
  root: string
  paths: string[]
  ids: Map<string, number>
  byPath: Map<string, number>   // path without .md, lower case
  byStem: Map<string, number[]> // file name without .md, lower case
}

export const makeIndex = (root: string, paths: string[]): Index => {
  const byStem = new Map<string, number[]>()
  paths.forEach((p, n) => {
    const stem = p.replace(/\.md$/, '').toLowerCase().split('/').pop()!
    byStem.set(stem, [...(byStem.get(stem) ?? []), n])
  })
  return {
    root,
    paths,
    ids: new Map(paths.map((p, n) => [p, n])),
    byPath: new Map(paths.map((p, n) => [p.replace(/\.md$/, '').toLowerCase(), n])),
    byStem,
  }
}

export const keepFile = (p: string) => p !== '' && !MEDIA.test(p) && !p.split('/').some(d => HEAVY_DIRS.includes(d) || (d.startsWith('.') && d !== '.claude' && d !== '.github'))

// ---- reading a Bash command ----

const READ_VERB = '(cat|head|tail|sed|awk|grep|rg|less|bat|more|diff|wc|cut|sort|python3?|node|jq|open)\\b'
const READS = new RegExp(`(^\\s*|[;&|]\\s*|\\bxargs\\s+(?:-\\S+\\s+)*|-exec\\s+)${READ_VERB}`)
const PIPED_READ = new RegExp(`(\\bxargs\\s+(?:-\\S+\\s+)*|-exec\\s+)${READ_VERB}`)
const LISTS = /^\s*(ls|find|tree|du|stat|git\s+(status|log|ls-files))\b/

export const segments = (cmd: string) => cmd.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(s => s !== '')
const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2')

// A path as the session sees it: relative to the root when inside it, else absolute. `~` is the home folder.
export const resolve = (dir: string, arg: string, home: string): string | undefined => {
  let a = unquote(arg).normalize('NFC')
  if (a.includes('$') || a.includes('*')) return undefined
  if (a === '~' || a.startsWith('~/')) a = home + a.slice(1)
  const parts: string[] = a.startsWith('/') ? [] : dir.split('/').filter(Boolean)
  for (const part of a.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

// Where the main shell stands after a command's `cd`s (it keeps the last one).
export const afterCd = (cmd: string, start: string, home: string) => {
  let dir = start
  for (const s of segments(cmd)) {
    const cd = /^cd(?:\s+(.+))?$/.exec(s)
    if (cd !== null) dir = cd[1] === undefined ? home : resolve(dir, cd[1], home) ?? dir
  }
  return dir
}

export const isListing = (cmd: string) => {
  const first = segments(cmd).find(s => !/^cd\b/.test(s)) ?? ''
  return LISTS.test(first) && !PIPED_READ.test(cmd)
}

const relOf = (I: Index, abs: string) => (abs.startsWith(I.root + '/') ? abs.slice(I.root.length + 1) : undefined)

type Hit = { p: string; out?: true }
// A file the session can name: inside the root and in the index, or outside it with a file-like name.
const asFile = (I: Index, abs: string | undefined): Hit | undefined => {
  if (abs === undefined) return undefined
  const rel = relOf(I, abs)
  if (rel !== undefined) return I.ids.has(rel) ? { p: rel } : undefined
  return /\/[^/]+\.[A-Za-z0-9]{1,8}$/.test(abs) && !MEDIA.test(abs) ? { p: abs, out: true } : undefined
}

// The files a Bash command names, followed through its `cd`s.
const commandFiles = (I: Index, cmd: string, start: string, home: string, limit: number) => {
  const out: Hit[] = []
  let dir = start
  for (const s of segments(cmd)) {
    const cd = /^cd(?:\s+(.+))?$/.exec(s)
    if (cd !== null) { dir = cd[1] === undefined ? home : resolve(dir, cd[1], home) ?? dir; continue }
    for (const m of s.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)) {
      const token = m[1] ?? m[2] ?? m[3] ?? ''
      if (token.startsWith('-') || !/[./]/.test(token)) continue
      const f = asFile(I, resolve(dir, token, home))
      if (f !== undefined && !out.some(o => o.p === f.p)) out.push(f)
      if (out.length >= limit) return out
    }
  }
  return out
}

// How many file names one result can put on the map: enough for a wide search, few enough to keep the trail light.
export const MAX_SEEN = 300
const EXT = /\.[A-Za-z0-9]{1,8}$/

// Paths in a tool's output (a Grep, a Glob, a `grep -rl`, a connector's JSON, a sub-agent's report):
// file names put in the context, not the files. A whole line, its part before `:`, a quoted string,
// a bare token that ends with an extension, and a [[wikilink]] are tried in turn.
export const pathsIn = (I: Index, text: string, start: string, home: string, limit = MAX_SEEN) => {
  const out: string[] = []
  const tried = new Set<string>()
  const add = (rel: string) => { if (!out.includes(rel)) out.push(rel) }
  const take = (cand: string) => {
    const c = cand.trim().replace(/^[`'"(<[]+|[`'")>\],.;:]+$/g, '')
    if (c === '' || c.length > 400 || tried.has(c)) return false
    tried.add(c)
    const abs = resolve(start, c, home) ?? ''
    const rel = relOf(I, abs) ?? (I.ids.has(c) ? c : undefined)
    if (rel === undefined || !I.ids.has(rel)) return false
    add(rel)
    return true
  }
  for (const raw of text.split('\n').slice(0, 4000)) {
    if (out.length >= limit) break
    const line = raw.trim().normalize('NFC')
    if (line === '' || line.length > 4000) continue
    if (line.length <= 400 && (take(line) || take(line.split(':')[0] ?? ''))) continue
    // the folder's own absolute path inside a sentence, spaces and all: the longest file of the folder that follows it
    for (let at = line.indexOf(`${I.root}/`); at >= 0; at = line.indexOf(`${I.root}/`, at + 1)) {
      const rest = line.slice(at + I.root.length + 1)
      let best: string | undefined
      for (const m of rest.matchAll(/\.[A-Za-z0-9]{1,8}(?=$|[\s"'`)\],;:]|\.(?:\s|$))/g)) {
        const cand = rest.slice(0, (m.index ?? 0) + m[0].length).normalize('NFC')
        if (I.ids.has(cand)) best = cand
      }
      if (best !== undefined) add(best)
    }
    for (const m of line.matchAll(/"((?:[^"\\\n]|\\.){3,400}?)"|'([^'\n]{3,400}?)'/g)) {
      const q = (m[1] ?? m[2] ?? '').replace(/\\\//g, '/')
      if (EXT.test(q)) take(q)
    }
    for (const m of line.matchAll(/[^\s"'`<>|()[\]{},;]+\.[A-Za-z0-9]{1,8}\b/g)) take(m[0])
    for (const m of line.matchAll(/\[\[([^\]|#^]+)/g)) {
      const t = (m[1] ?? '').trim().toLowerCase().replace(/\.md$/, '')
      const byStem = I.byStem.get(t.split('/').pop() ?? t) ?? []
      const n = I.byPath.get(t) ?? (byStem.length === 1 ? byStem[0] : undefined)
      if (n !== undefined) add(I.paths[n]!)
    }
  }
  return out.slice(0, limit)
}

const WRITERS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
// tools whose result names files: a search, a shell command, a sub-agent's report
const SEEN_TOOLS = ['Grep', 'Glob', 'Bash', 'Task', 'Agent']

export const touchedBy = (
  I: Index, tool: string, input: { file_path?: unknown; notebook_path?: unknown; command?: unknown }, output: string,
  _recent: TrailEvent[], at: number, start: string, home: string, agent?: true,
): TrailEvent[] => {
  const found: TrailEvent[] = []
  const tag = agent ? { agent } : {}
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
  const file = path !== undefined ? asFile(I, resolve(start, path, home)) : undefined
  if (file !== undefined && tool === 'Read') found.push({ k: 'read', p: file.p, at, ...(file.out ? { out: true as const } : {}), ...tag })
  if (file !== undefined && WRITERS.includes(tool)) found.push({ k: 'write', p: file.p, at, ...(file.out ? { out: true as const } : {}), ...tag })
  const cmd = tool === 'Bash' && typeof input.command === 'string' ? input.command : ''
  const listing = cmd !== '' && isListing(cmd)
  if (cmd !== '' && !listing) {
    for (const f of commandFiles(I, cmd, start, home, 20)) {
      // written when the path follows a redirection, a `tee`, a `sed -i` or is the target of cp/mv
      const name = f.p.split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const written = new RegExp(`(>>?|tee(\\s+-a)?|sed\\s+-i[^ ]*(\\s+(-e\\s+)?(['"]).*?\\5)?|(cp|mv)\\s+\\S+)\\s*"?'?[^\\s"']*${name}`).test(cmd)
      const k = written ? 'write' : READS.test(cmd) ? 'read' : undefined
      if (k !== undefined) found.push({ k, p: f.p, at, ...(f.out ? { out: true as const } : {}), ...tag })
    }
  }
  // names a search, a listing or a sub-agent's report printed: they are in the context, the files are not
  if (SEEN_TOOLS.includes(tool)) {
    const touched = new Set(found.flatMap(ev => (ev.k === 'read' || ev.k === 'write' ? [ev.p] : [])))
    const ps = pathsIn(I, output, start, home).filter(p => !touched.has(p))
    if (ps.length > 0) found.push({ k: 'seen', ps, via: 'search', at, ...tag })
  }
  return found
}

// ---- links between notes (Markdown only) ----

const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`
export { pairKey }

// [[target]] from a note: its path, the only note of that name, else a note of that name in the same folder.
const resolveWiki = (I: Index, target: string, from: string) => {
  const t = target.toLowerCase().replace(/\.md$/, '')
  const exact = I.byPath.get(t)
  if (exact !== undefined) return exact
  const cands = I.byStem.get(t.split('/').pop() ?? t) ?? []
  if (cands.length === 1) return cands[0]
  const folder = from.split('/').slice(0, -1).join('/')
  const same = cands.filter(n => I.paths[n]!.split('/').slice(0, -1).join('/') === folder)
  return same.length === 1 ? same[0] : undefined
}

// The notes a Markdown text links to: [[wikilinks]] and relative .md links.
export const linksIn = (I: Index, n: number, text: string) => {
  const p = I.paths[n]!
  const out = new Set<number>()
  const add = (m: number | undefined) => { if (m !== undefined && m !== n) out.add(m) }
  const t = text.normalize('NFC')
  for (const w of t.matchAll(/\[\[([^\]|#^]+)/g)) add(resolveWiki(I, (w[1] ?? '').trim(), p))
  for (const l of t.matchAll(/\]\(([^)\s]+?\.md)\)/g)) {
    const target = decodeURIComponent((l[1] ?? '').replace(/%(?![0-9A-Fa-f]{2})/g, '%25'))
    if (target.startsWith('http')) continue
    const parts: string[] = []
    for (const seg of [...p.split('/').slice(0, -1), ...target.split('/')]) {
      if (seg === '..') parts.pop()
      else if (seg !== '.' && seg !== '') parts.push(seg)
    }
    add(I.ids.get(parts.join('/')) ?? I.ids.get(target))
  }
  return out
}

// One line on what a file is: its front matter `description`, its first heading, or its first comment.
export const describe = (text: string) => {
  const head = text.slice(0, 4000)
  const fm = /^---\n([\s\S]*?)\n---/.exec(head)
  const desc = fm ? /^(?:description|summary):\s*["']?(.+?)["']?\s*$/m.exec(fm[1] ?? '') : null
  if (desc?.[1]) return desc[1].slice(0, 140)
  const body = fm ? head.slice(fm[0].length) : head
  const h = /^#{1,3}\s+(.+)$/m.exec(body)
  if (h?.[1]) return h[1].replace(/[*_`]/g, '').slice(0, 140)
  const c = /^\s*(?:\/\/|#(?!!)|\/\*+|\*|"""|--)\s*(\S.{8,})$/m.exec(body)
  return c?.[1] ? c[1].replace(/\*\/\s*$/, '').slice(0, 140) : ''
}
