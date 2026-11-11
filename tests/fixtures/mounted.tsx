type SvgHit = { props: { alt?: unknown; source?: unknown } }

export const mapSourceOf = (svgs: SvgHit[]) => {
  const map = svgs.find((el) => {
    const alt = typeof el.props.alt === 'string' ? el.props.alt : ''
    const source = typeof el.props.source === 'string' ? el.props.source : ''
    return (
      alt.includes('files touched') &&
      !alt.startsWith('Unkillable Companies') &&
      /viewBox="/.test(source)
    )
  })
  return typeof map?.props.source === 'string' ? map.props.source : undefined
}

export const mapSource = async (ui: {
  findAll: (q: { type: 'Svg' }) => Promise<SvgHit[]>
}) => mapSourceOf(await ui.findAll({ type: 'Svg' }))

export const viewBoxOf = (source: string | undefined) => {
  if (source === undefined) return undefined
  const raw = /viewBox="([^"]+)"/.exec(source)?.[1]
  if (raw === undefined) return undefined
  const [x, y, w, h] = raw.split(' ').map(Number)
  if (x === undefined || y === undefined || w === undefined || h === undefined)
    return undefined
  if ([x, y, w, h].some((n) => Number.isNaN(n))) return undefined
  return { x, y, w, h }
}
