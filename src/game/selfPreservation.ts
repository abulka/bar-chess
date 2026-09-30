/**
 * Self-preservation thresholds, shared by the `orders` system and the piece
 * properties panel so the marks drawn on the health bar always match the rules
 * the simulation actually uses.
 */

/** Flat HP fraction at or below which a piece is "critically wounded": it latches
 * a safe-hold to full health and will not advance its order until then. */
export const CRITICAL_WOUND = 0.2

/** Consecutive hits (since the last move) that count as sustained fire. */
export const HIT_STREAK_TRIGGER = 2

/** HP ratio at which a piece starts saving itself, scaled by how costly it is. */
export function preserveThreshold(kind: string): number {
  switch (kind) {
    case 'queen':
    case 'king':
      return 0.5
    case 'rook':
      return 0.45
    case 'bishop':
    case 'knight':
      return 0.4
    default:
      return 0.3
  }
}

/**
 * HP ratio a wounded piece heals to before resuming, above the retreat trigger:
 * about one more hit absorbed (queen/king 0.70, rook 0.65, bishop/knight 0.60).
 * Without this hysteresis the heal trip is wasted — a piece crossing back over
 * the trigger immediately stops preserving and walks into the same fire again.
 */
export function recoverThreshold(kind: string): number {
  return Math.min(0.8, preserveThreshold(kind) + 0.2)
}

export interface SelfPreservationThresholds {
  /** HP ratio below which the piece retreats on its own. */
  preserve: number
  /** HP ratio it heals to before resuming its order. */
  recover: number
  /** HP ratio below which it waits for full health instead. */
  critical: number
}

/** The three HP marks shown on the panel health bar for a piece kind. */
export function selfPreservationThresholds(kind: string): SelfPreservationThresholds {
  return { preserve: preserveThreshold(kind), recover: recoverThreshold(kind), critical: CRITICAL_WOUND }
}
