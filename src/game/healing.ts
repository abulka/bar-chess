import { Cell, Health, PieceType, Team } from '../ecs/components'
import type { Entity, World } from '../ecs/world'
import { chebyshev } from './geometry'
import type { TeamId } from './types'

/** How far from its king a piece is healed, in Chebyshev cells (a 5×5 square). */
export const HEAL_RADIUS = 2

/** Fraction of a piece's max HP regenerated per second inside the aura. */
export const HEAL_RATE = 0.05

/** Green used by the renderer for the aura, ring and healing tendrils. */
export const HEAL_COLOR = '#4ad991'

export interface HealingField {
  /** The team's living king, the source of the aura. */
  king: Entity
  /** Same-team pieces inside the aura, including the king itself. */
  targets: Entity[]
}

/**
 * The team's living king, or null for a king-less (already lost) side. Mirrors
 * the lookup in the king-defense system, kept here so the renderer need not
 * depend on an ECS system module.
 */
export function kingOf(world: World, team: TeamId): Entity | null {
  for (const e of world.query(PieceType, Cell, Team)) {
    if (world.require(e, Team) !== team) continue
    if (world.require(e, PieceType).kind === 'king') return e
  }
  return null
}

/**
 * The king's healing field: the king plus every same-team piece within
 * `HEAL_RADIUS` Chebyshev cells of it. Pieces of the other team are never healed,
 * and a king-less side has no field. Shared by the healing system and the
 * renderer so the mechanic and its overlay can never disagree.
 */
export function healingTargets(world: World, team: TeamId): HealingField | null {
  const king = kingOf(world, team)
  if (king === null) return null
  const kcell = world.get(king, Cell)
  if (!kcell) return null
  const targets: Entity[] = []
  for (const e of world.query(Cell, Team, Health)) {
    if (world.require(e, Team) !== team) continue
    const cell = world.require(e, Cell)
    if (chebyshev(cell.x, cell.y, kcell.x, kcell.y) <= HEAL_RADIUS) targets.push(e)
  }
  return { king, targets }
}
