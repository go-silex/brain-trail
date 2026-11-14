// A transparent layer laid over the map. It reports, as fractions of the map's width and height:
// where the pointer rests (for the name under it), a click and a drag with the button that made them
// (the controller turns them into opening, zooming, panning or turning, as on every other surface).
// The wheel goes to the pane (`ui.scroll`), which zooms the map around the last point this layer reported.
// In a pane whose rows are a frame the hooks draw the map for the box this layer covers: `box` is the
// size they expect, in cells, and the layer tells them when the surface laid it out to another one.
import type { ClientModule } from 'claude-code'

type Tip = { text: string; x: number; y: number }
type Props = { tip?: Tip | null; box?: string; reach?: number }
type Button = 'left' | 'middle' | 'right'
let pressSequence = 0

const Hit: ClientModule<Props, { on: true }> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    let down: { x: number; y: number; fx: number; fy: number; press: number; button: Button } | undefined
    let dragging = false
    // A press ends once: with its button's release, or, when that release never reached the layer,
    // at the next press or the first move that holds no button. It never ends in a click then.
    const release = () => {
      if (dragging) surface.post({ kind: 'dragend' })
      down = undefined; dragging = false
    }
    surface.onPointer(e => {
      const fx = (e.fine?.x ?? e.x + 0.5) / Math.max(1, surface.columns)
      const fy = (e.fine?.y ?? e.y + 0.5) / Math.max(1, surface.rows)
      if (e.type === 'down') {
        if (e.button === undefined) return
        release()
        pressSequence = pressSequence >= Number.MAX_SAFE_INTEGER ? 1 : pressSequence + 1
        down = { x: e.x, y: e.y, fx, fy, press: pressSequence, button: e.button }; dragging = false; return
      }
      if (e.type === 'move' && down !== undefined) {
        if (e.button !== undefined) {
          // a drag starts once the pointer has left the cell it went down in
          if (dragging || Math.abs(down.x - e.x) > 1 || Math.abs(down.y - e.y) > 1) {
            dragging = true
            surface.post({ kind: 'drag', press: down.press, button: down.button, fx, fy, sfx: down.fx, sfy: down.fy })
          }
          return
        }
        release()
      }
      if (e.type === 'up') {
        if (down !== undefined && e.button !== undefined && e.button !== down.button) return
        if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) {
          down = undefined; dragging = false
          surface.post({ kind: 'leave' })
          return
        }
        if (down !== undefined && !dragging) surface.post({ kind: 'click', fx, fy, button: down.button })
        if (dragging) surface.post({ kind: 'dragend' })
        down = undefined; dragging = false
        return
      }
      if (e.type === 'move') surface.post({ kind: 'hover', fx, fy, x: e.x, y: e.y })
      else if (e.type === 'leave' && down === undefined) surface.post({ kind: 'leave' })
    })
    surface.setState({ on: true })
  }
  if (props.box !== undefined && surface.columns > 0 && surface.rows >= 0 && props.box.split('/')[1] !== `${surface.columns}x${surface.rows}`)
    surface.post({ kind: 'box', columns: surface.columns, rows: surface.rows, for: props.box })
  const tip = props.tip
  return (
    <Box width="100%" height={props.reach ?? '100%'} position="relative">
      {tip !== undefined && tip !== null && (
        <Box position="absolute" top={Math.max(0, tip.y - 1)} left={Math.min(Math.max(0, tip.x + 1), Math.max(0, surface.columns - tip.text.length - 2))}>
          <Text backgroundColor="#0b0e10" color="#ededed">{` ${tip.text} `}</Text>
        </Box>
      )}
    </Box>
  )
}

export default Hit
