import { Cell, Health, PieceType, Team } from '../ecs/components'
import type { Entity, World } from '../ecs/world'
import { chebyshev } from './geometry'
import type { TeamId } from './types'

/** How far from its king a piece is healed, in Chebyshev cells (a 5×5 square). */
export const HEAL_RADIUS = 2

/** Fraction of a piece's max HP regenerated per second inside the aura. */
export const HEAL_RATE = 0.05

/** Multiplier on `HEAL_RATE` for teams under human control. */
export const HUMAN_HEAL_MULTIPLIER = 3

/** Green used by the renderer for the aura, ring and healing tendrils. */
export const HEAL_COLOR = '#4ad991'

export interface HealingField {
  /** The team's living king, the source of the aura. */
  king: Entity
  /** Same-team pieces inside the aura, excluding the king (the aura source). */
  targets: Entity[]
}

/**
 * The team's living king, or null for a king-less (already lost) side. Shared
 * by the healing field and the king-defense system so the lookup cannot drift.
 */
export function kingOf(world: World, team: TeamId): Entity | null {
  for (const e of world.query(PieceType, Cell, Team)) {
    if (world.require(e, Team) !== team) continue
    if (world.require(e, PieceType).kind === 'king') return e
  }
  return null
}

/**
 * The king's healing field: every same-team piece other than the king within
 * `HEAL_RADIUS` Chebyshev cells of it. The king is the source of the aura and is
 * never a target, so it does not regenerate itself. Pieces of the other team are
 * never healed, and a king-less side has no field. Shared by the healing system
 * and the renderer so the mechanic and its overlay can never disagree.
 */
export function healingTargets(world: World, team: TeamId): HealingField | null {
  const king = kingOf(world, team)
  if (king === null) return null
  const kcell = world.get(king, Cell)
  if (!kcell) return null
  const targets: Entity[] = []
  for (const e of world.query(Cell, Team, Health)) {
    if (e === king) continue
    if (world.require(e, Team) !== team) continue
    const cell = world.require(e, Cell)
    if (chebyshev(cell.x, cell.y, kcell.x, kcell.y) <= HEAL_RADIUS) targets.push(e)
  }
  return { king, targets }
}
