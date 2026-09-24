import type { MotionIntent } from '../ecs/components'

/**
 * Human labels for a motion goal's provenance, shared by the piece panel and the
 * hover readout so both describe an autonomous goal the same way. `none` is blank
 * because callers usually only show a label when there is a goal to explain.
 */
export const INTENT_LABELS: Record<MotionIntent, string> = {
  none: '',
  order: 'ordered',
  preserve: 'self-preservation',
  defense: 'AI defense',
  engage: 'engaging',
  rally: 'rally',
}
