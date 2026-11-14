import type { Locator } from 'playwright'

export function findScenePoint(
  canvas: Locator,
  target: string,
): Promise<{
  point: { x: number; y: number } | undefined
  observed: [string, { x: number; y: number }][]
  step: number
  bounds: { x: number; y: number; width: number; height: number }
  tipPresent: boolean
}>

export function svgFilePoint(
  image: Locator,
  file: { x: number; y: number },
): Promise<{ x: number; y: number }>
