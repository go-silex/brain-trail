// A transparent layer laid over the map. It reports, as fractions of the map's width and height:
// where the pointer rests (for the name under it), a click (left or right) and a drag (to move the map).
// The wheel goes to the pane (`ui.scroll`), which zooms the map around the last point this layer reported.
import type { ClientModule } from 'claude-code'

type Tip = { text: string; x: number; y: number }
type Props = { tip?: Tip | null }

const Hit: ClientModule<Props, { on: true }> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    let down: { x: number; y: number; fx: number; fy: number; button?: string } | undefined
    let dragging = false
    surface.onPointer(e => {
      const fx = (e.fine?.x ?? e.x + 0.5) / Math.max(1, surface.columns)
      const fy = (e.fine?.y ?? e.y + 0.5) / Math.max(1, surface.rows)
      if (e.type === 'down') { down = { x: e.x, y: e.y, fx, fy, button: e.button }; dragging = false; return }
      if (e.type === 'move' && down !== undefined) {
        // a drag starts once the pointer has left the cell it went down in
        if (dragging || Math.abs(down.x - e.x) > 1 || Math.abs(down.y - e.y) > 1) {
          dragging = true
          surface.post({ kind: 'drag', fx, fy, sfx: down.fx, sfy: down.fy })
        }
        return
      }
      if (e.type === 'up') {
        if (down !== undefined && !dragging) surface.post({ kind: 'click', fx, fy, right: down.button === 'right' })
        if (dragging) surface.post({ kind: 'dragend' })
        down = undefined; dragging = false
        return
      }
      if (e.type === 'move') surface.post({ kind: 'hover', fx, fy, x: e.x, y: e.y })
      else if (e.type === 'leave') surface.post({ kind: 'leave' })
    })
    surface.setState({ on: true })
  }
  const tip = props.tip
  return (
    <Box width="100%" height="100%" position="relative">
      {tip !== undefined && tip !== null && (
        <Box position="absolute" top={Math.max(0, tip.y - 1)} left={Math.min(Math.max(0, tip.x + 1), Math.max(0, surface.columns - tip.text.length - 2))}>
          <Text backgroundColor="#0b0e10" color="#ededed">{` ${tip.text} `}</Text>
        </Box>
      )}
    </Box>
  )
}

export default Hit
