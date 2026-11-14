// Exercise the real scene's pointer-move raycast in one browser round trip.
export async function findScenePoint(canvas, target) {
  return canvas.evaluate(async (element, name) => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const rect = element.getBoundingClientRect()
    const tip = element.parentElement?.querySelector('.bt-tip')
    const observed = new Map()
    let point
    let step = 8
    for (const spacing of [8, 2]) {
      step = spacing
      for (let y = rect.top + 1; y < rect.bottom - 1 && !point; y += spacing) {
        for (let x = rect.left + 1; x < rect.right - 1; x += spacing) {
          element.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: x,
              clientY: y,
              bubbles: true,
            }),
          )
          if (tip && !tip.hidden && tip.textContent) {
            if (!observed.has(tip.textContent))
              observed.set(tip.textContent, { x, y })
            if (tip.textContent === name) {
              point = { x, y }
              break
            }
          }
        }
      }
      if (point) break
    }
    return {
      point,
      observed: [...observed],
      step,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      tipPresent: Boolean(tip),
    }
  }, target)
}

// Use the actual SVG's viewBox and displayed image rectangle, not a guessed
// layout size or a second projection of the renderer.
export async function svgFilePoint(image, file) {
  return image.evaluate(async (element, position) => {
    let previous = ''
    let stable = false
    for (let frame = 0; frame < 120; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const rect = element.getBoundingClientRect()
      const current = JSON.stringify([
        element.getAttribute('src'),
        rect.x,
        rect.y,
        rect.width,
        rect.height,
      ])
      if (
        element.complete &&
        current === previous &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        stable = true
        break
      }
      previous = current
    }
    if (!stable) throw new Error('Map SVG did not stabilize')
    await element.decode()
    const src = element.getAttribute('src')
    if (!src?.startsWith('data:image/svg+xml,'))
      throw new Error('Map image is not an SVG data URL')
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(src.slice('data:image/svg+xml,'.length)),
      'image/svg+xml',
    )
    const viewBox = svg.documentElement
      .getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number)
    if (
      !viewBox ||
      viewBox.length !== 4 ||
      !viewBox.every(Number.isFinite) ||
      viewBox[2] <= 0 ||
      viewBox[3] <= 0
    )
      throw new Error('Map SVG has an invalid viewBox')
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0)
      throw new Error('Map SVG has no visible bounds')
    const x = rect.left + ((position.x - viewBox[0]) / viewBox[2]) * rect.width
    const y = rect.top + ((position.y - viewBox[1]) / viewBox[3]) * rect.height
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom)
      throw new Error('Requested file is outside the visible SVG viewBox')
    return { x, y }
  }, file)
}
