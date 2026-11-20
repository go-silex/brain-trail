import type { ClientModule } from 'claude-code'

type Props = { stamp: string; expectedRows: number; reach: number; kind: 'viewport' | 'content' | 'header' | 'footer' }

// A zero-width client measures its holder without contributing to its layout.
const Measure: ClientModule<Props, never> = (props, surface) => {
  if (surface.rows > 0 && surface.rows !== props.expectedRows)
    surface.post({ kind: props.kind, stamp: props.stamp, rows: surface.rows })
  const { Box } = surface.elements
  return <Box width={0} height={props.reach} />
}

export default Measure
