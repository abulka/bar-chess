import { Cell, PieceType, Target, Team } from '../ecs/components'
import type { Entity, World } from '../ecs/world'
import type { Board } from './board'
import { containsCell, fireCells } from './geometry'
import { makeOccupied } from './occupancy'
import type { Occupancy } from './occupancy'
import { PIECES, WEAPONS } from './pieces'

/**
 * The enemy a piece is *currently* under fire from: its last attacker, but only
 * while that attacker still has line of sight to the piece's square. The raw
 * `Target.underFireUntil` latch is intentionally time-based (the AI treats a
 * recent attacker as a threat so a piece does not flee forever); this helper is
 * for reporting/analysis, where "under fire" should mean real, present danger —
 * a piece that has stepped out of the firing line is no longer under fire.
 */
export function underFireAttacker(
  world: World,
  board: Board,
  occupancy: Occupancy,
  entity: Entity,
  tick: number,
): Entity | null {
  const target = world.get(entity, Target)
  if (!target || target.lastAttacker === null) return null
  if (tick >= target.underFireUntil) return null

  const attacker = target.lastAttacker
  if (!world.isAlive(attacker)) return null

  const attackerCell = world.get(attacker, Cell)
  const cell = world.get(entity, Cell)
  const kind = world.get(attacker, PieceType)?.kind
  const team = world.get(attacker, Team)
  if (!attackerCell || !cell || !kind || !team) return null
  const def = PIECES[kind]
  if (!def) return null

  const occupied = makeOccupied(board, occupancy)
  const covered = containsCell(
    fireCells(board, attackerCell, WEAPONS[def.weapon].geometry, team, occupied),
    cell.x,
    cell.y,
  )
  return covered ? attacker : null
}
