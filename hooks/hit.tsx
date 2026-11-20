import type { ClientModule } from 'claude-code'

type Button = 'left' | 'middle' | 'right'
type Tip = { text: string; x: number; y: number }
type Props = { tip?: Tip | null; box?: string; reach?: number }
type Press = { x: number; y: number; fx: number; fy: number; id: number; button: Button; mixed: boolean }
let sequence = 0

// A native transparent layer owns pointer capture. Only normalized gestures, not paths, go back to the hook.
const Hit: ClientModule<Props, { ready: true }> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    let down: Press | undefined
    let dragging = false
    const release = () => {
      if (dragging) surface.post({ kind: 'dragend' })
      down = undefined
      dragging = false
    }
    surface.onPointer(e => {
      const fx = (e.fine?.x ?? e.x + 0.5) / Math.max(1, surface.columns)
      const fy = (e.fine?.y ?? e.y + 0.5) / Math.max(1, surface.rows)
      if (e.type === 'down') {
        if (e.button === undefined) return
        if (down !== undefined) { down.mixed = true; return }
        sequence = sequence < Number.MAX_SAFE_INTEGER ? sequence + 1 : 1
        down = { x: e.x, y: e.y, fx, fy, id: sequence, button: e.button, mixed: false }
        return
      }
      if (e.type === 'move' && down !== undefined) {
        if (e.button !== undefined) {
          if (e.button !== down.button) down.mixed = true
          if (dragging || Math.abs(down.x - e.x) > 1 || Math.abs(down.y - e.y) > 1) {
            dragging = true
            surface.post({ kind: 'drag', press: down.id, button: down.button, fx, fy, sfx: down.fx, sfy: down.fy })
          }
          return
        }
        release()
      }
      if (e.type === 'up') {
        if (down !== undefined && e.button !== undefined && e.button !== down.button) {
          down.mixed = true
          return
        }
        if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) {
          release()
          surface.post({ kind: 'leave' })
          return
        }
        if (down !== undefined && !dragging && !down.mixed) surface.post({ kind: 'click', fx, fy, button: down.button })
        release()
        return
      }
      if (e.type === 'move') surface.post({ kind: 'hover', fx, fy, x: e.x, y: e.y })
      else if (e.type === 'leave' && down === undefined) surface.post({ kind: 'leave' })
    })
    surface.setState({ ready: true })
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
