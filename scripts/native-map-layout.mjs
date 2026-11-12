// Focused Claude Desktop host contract, not a general native renderer or pixel test.
// Source: /usr/lib/claude-desktop/resources/ion-dist.asar, SHA256
// d7957c54e70073b6a143e09421d456e268a4fc7cb600bf9bfec791c99c7cdaf4;
// renderer anchors: Lf/Hf/ip 990-1014, Gh/Kh 1296-1298, Qh/bg
// 1307/1333, row CSS 1377, Bp/Vp/Hp/Zp 1044-1059. The host's
// theme spacing variables are represented here by fixed probe values; this
// deliberately tests the captured map subtree, not surrounding pane chrome.

// browser is an already-launched Playwright Browser; tree is the unmodified
// captured tree (or its containing capture). Throws with rectangles on failure.
export async function probeNativeMapLayout(browser, tree) {
  const matches = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    if (node.type === 'Box' && node.props?.key === 'map-col') matches.push(node)
    if (node.children) visit(node.children)
  }
  visit(tree?.tree ?? tree)
  if (matches.length !== 1)
    throw new Error(
      `native map layout: expected one map-col, found ${matches.length}`,
    )
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
  try {
    await page.setContent(`<!doctype html><style>
      html,body { margin:0; width:100%; height:100%; }
      #frame { display:flex; flex-direction:column; width:640px; height:480px; line-height:20px; overflow:hidden; }
      [data-engine-row]>span,[data-engine-row]>b,[data-engine-row]>a,[data-engine-row]>button,[data-engine-row]>form,[data-engine-row]>img,[data-engine-row]>[data-engine-select-field] { align-self:center; }
    </style><div id="frame"></div>`)
    const result = await page.evaluate(async (tree) => {
      const aligns = new Set([
        'flex-start',
        'center',
        'flex-end',
        'stretch',
        'auto',
      ])
      const directions = new Set([
        'row',
        'column',
        'row-reverse',
        'column-reverse',
      ])
      const spacings = {
        xs: '4px',
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      }
      const dimension = (value, unit) =>
        typeof value === 'number' && Number.isFinite(value)
          ? `${value}${unit}`
          : typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value)
            ? value
            : ''
      const spacing = (value, axis) =>
        typeof value === 'number' && Number.isFinite(value)
          ? axis === 'x'
            ? `${value}ch`
            : `calc(${value} * .5lh)`
          : spacings[value] || ''
      const render = (node) => {
        if (typeof node === 'string') return document.createTextNode(node)
        const p = node.props || {}
        let el
        if (node.type === 'Box') {
          el = document.createElement('div')
          el.style.display = p.display === 'none' ? 'none' : 'flex'
          el.style.boxSizing = 'border-box'
          const dir = directions.has(p.flexDirection) ? p.flexDirection : 'row'
          el.style.flexDirection = dir
          if (dir.startsWith('row') && !aligns.has(p.alignItems))
            el.setAttribute('data-engine-row', '')
          if (aligns.has(p.alignItems)) el.style.alignItems = p.alignItems
          if (aligns.has(p.alignSelf)) el.style.alignSelf = p.alignSelf
          if (typeof p.flexGrow === 'number' && Number.isFinite(p.flexGrow))
            el.style.flexGrow = p.flexGrow
          if (typeof p.flexShrink === 'number' && Number.isFinite(p.flexShrink))
            el.style.flexShrink = p.flexShrink
          if (['nowrap', 'wrap', 'wrap-reverse'].includes(p.flexWrap))
            el.style.flexWrap = p.flexWrap
          if (
            [
              'flex-start',
              'center',
              'flex-end',
              'space-between',
              'space-around',
              'space-evenly',
            ].includes(p.justifyContent)
          )
            el.style.justifyContent = p.justifyContent
          for (const [key, unit] of [
            ['width', 'ch'],
            ['height', 'lh'],
            ['minWidth', 'ch'],
            ['minHeight', 'lh'],
          ])
            el.style[key] = dimension(p[key], unit)
          if (['visible', 'hidden'].includes(p.overflow))
            el.style.overflow = p.overflow
          if (p.gap !== undefined) {
            el.style.rowGap = spacing(p.gap, 'y')
            el.style.columnGap = spacing(p.gap, 'x')
          }
          if (p.rowGap !== undefined) el.style.rowGap = spacing(p.rowGap, 'y')
          if (p.columnGap !== undefined)
            el.style.columnGap = spacing(p.columnGap, 'x')
          for (const kind of ['margin', 'padding']) {
            for (const [side, axis] of [
              ['Top', 'y'],
              ['Bottom', 'y'],
              ['Left', 'x'],
              ['Right', 'x'],
            ]) {
              const value =
                p[kind + side] ??
                p[kind + (axis === 'x' ? 'X' : 'Y')] ??
                p[kind]
              if (value !== undefined)
                el.style[kind + side] = spacing(value, axis)
            }
          }
          if (p.position === 'absolute') {
            el.style.position = 'absolute'
            for (const [key, unit] of [
              ['top', 'lh'],
              ['bottom', 'lh'],
              ['left', 'ch'],
              ['right', 'ch'],
            ])
              if (Number.isInteger(p[key])) el.style[key] = `${p[key]}${unit}`
          } else if (
            (node.children || []).some(
              (child) =>
                child?.type === 'Box' && child.props?.position === 'absolute',
            )
          )
            el.style.position = 'relative'
          if (p.key === 'map-wrap') el.dataset.mapWrap = ''
        } else if (node.type === 'Svg') {
          if (p.isInteractive || typeof p.source !== 'string')
            throw new Error('expected a noninteractive map Svg source')
          el = document.createElement('img')
          el.style.cssText = 'display:block;max-width:100%;border:0'
          for (const key of ['width', 'height'])
            if (
              typeof p[key] === 'number' &&
              Number.isFinite(p[key]) &&
              p[key] > 0
            )
              el.style[key] = `${Math.min(p[key], 4096)}px`
          el.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.source.toWellFormed())}`
          el.alt = p.alt || ''
        } else if (node.type === 'Text') {
          el = document.createElement('span')
          el.style.cssText =
            'display:inline-block;max-width:100%;white-space:pre;overflow:hidden;text-overflow:ellipsis;min-width:0'
        } else if (node.type === 'Client') {
          el = document.createElement('div')
          el.style.cssText =
            'display:flex;flex-direction:column;flex-shrink:0;overflow:hidden;max-width:100%'
          el.style.width = dimension(p.width, 'ch')
          el.style.height = dimension(p.height, 'lh')
          if (typeof p.flexGrow === 'number' && Number.isFinite(p.flexGrow))
            el.style.flexGrow = p.flexGrow
          return el
        } else throw new Error(`unsupported map subtree element: ${node.type}`)
        for (const child of node.children || []) el.appendChild(render(child))
        return el
      }
      document.getElementById('frame').appendChild(render(tree))
      const wraps = document.querySelectorAll('[data-map-wrap]')
      const images = document.querySelectorAll('[data-map-wrap] img')
      if (wraps.length !== 1 || images.length !== 1)
        throw new Error(
          `expected one map-wrap and image, found ${wraps.length} and ${images.length}`,
        )
      const wrapper = wraps[0],
        image = images[0]
      let decodeError = null
      try {
        await image.decode()
      } catch (error) {
        decodeError = String(error)
      }
      const rect = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })
      const wr = wrapper.getBoundingClientRect(),
        ir = image.getBoundingClientRect()
      let left = ir.left,
        top = ir.top,
        right = ir.right,
        bottom = ir.bottom
      const ancestors = []
      for (let el = image.parentElement; el; el = el.parentElement) {
        const r = el.getBoundingClientRect(),
          style = getComputedStyle(el)
        ancestors.push({
          tag: el.tagName,
          rect: rect(r),
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        })
        if (style.overflowX !== 'visible') {
          left = Math.max(left, r.left)
          right = Math.min(right, r.right)
        }
        if (style.overflowY !== 'visible') {
          top = Math.max(top, r.top)
          bottom = Math.min(bottom, r.bottom)
        }
      }
      const clipped = {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      }
      return {
        wrapper: rect(wr),
        image: rect(ir),
        clipped,
        ancestors,
        loaded:
          image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        decodeError,
      }
    }, matches[0])
    if (
      !result.loaded ||
      result.decodeError ||
      result.wrapper.width <= 0 ||
      result.wrapper.height <= 0 ||
      result.clipped.width < result.wrapper.width * 0.9 ||
      result.clipped.height < result.wrapper.height * 0.9
    )
      throw new Error(
        `native map layout: image does not cover allocated paint (>= 90% each axis): ${JSON.stringify(result)}`,
      )
    return result
  } finally {
    await page.close()
  }
}
