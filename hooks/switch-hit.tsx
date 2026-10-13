import type { ClientModule } from 'claude-code'

// The Auto compact switch's click area on the desktop: an empty region laid over the
// pill. A Button there drew its own hover fill and focus ring round the pill; a region
// draws nothing, and every press on it lands here
const SwitchHit: ClientModule = (_props, surface) => {
  surface.onPointer(e => {
    if (e.type === 'down' && e.button === 'left') surface.post('toggle')
  })
  const { Box } = surface.elements
  return <Box />
}

export default SwitchHit
