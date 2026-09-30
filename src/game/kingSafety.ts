import type { Board } from './board'
import { fireCells } from './geometry'
import type { OccupiedFn } from './geometry'
import { kingOf } from './healing'
import { occupiedExcept } from './occupancy'
import { PIECES, WEAPONS } from './pieces'
import type { TeamId, Vec2 } from './types'
import { Cell, Dead, Health, PieceType, Team } from '../ecs/components'
import type { Entity, World } from '../ecs/world'
import type { Occupancy } from './occupancy'

/**
 * Every cell currently covered by an enemy weapon, with `king` removed from
 * occupancy so vacating its square opens the same lines it would have to dodge.
 * This is chess "attacked squares": a king may never move onto one. The enemy
 * king's range-1 ring is included, so kings can never be adjacent.
 */
export function enemyCoverage(
  board: Board,
  world: World,
  occupancy: Occupancy,
  king: Entity,
  team: TeamId,
): Set<number> {
  const free = occupiedExcept(board, occupancy, king)
  const covered = new Set<number>()
  for (const e of world.query(Cell, Team, PieceType)) {
    if (e === king) continue
    const enemyTeam = world.require(e, Team)
    if (enemyTeam === team) continue
    const health = world.get(e, Health)
    if (!health || health.cur <= 0) continue
    if (world.has(e, Dead)) continue
    const def = PIECES[world.require(e, PieceType).kind]
    if (!def) continue
    const cell = world.require(e, Cell)
    for (const c of fireCells(board, cell, WEAPONS[def.weapon].geometry, enemyTeam, free)) {
      covered.add(board.cellIndex(c.x, c.y))
    }
  }
  return covered
}

/** Whether the king's current square is covered by an enemy weapon. */
export function isInCheck(
  board: Board,
  world: World,
  occupancy: Occupancy,
  king: Entity,
  team: TeamId,
): boolean {
  const cell = world.get(king, Cell)
  if (!cell) return false
  return enemyCoverage(board, world, occupancy, king, team).has(board.cellIndex(cell.x, cell.y))
}

/** A predicate that rejects every square in a precomputed coverage set. */
export function notCovered(board: Board, covered: Set<number>): (x: number, y: number) => boolean {
  return (x, y) => !covered.has(board.cellIndex(x, y))
}

/**
 * The 3×3 ring around `kingCell` (the centre excluded), in cell indices. A
 * king's guard hits for 80% of max HP at range 1, so these are the squares an
 * approaching piece treats as a kill zone.
 */
export function kingRing(board: Board, kingCell: Vec2): Set<number> {
  const ring = new Set<number>()
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const x = kingCell.x + dx
      const y = kingCell.y + dy
      if (board.inBounds(x, y)) ring.add(board.cellIndex(x, y))
    }
  }
  return ring
}

/**
 * An `avoid` predicate rejecting `team`'s enemy king's 3×3 kill zone, or null
 * when that king is already dead so callers can skip the check. Shared by the
 * orders system (goal selection) and the game's order preview / settled check so
 * the executed route and the displayed one agree.
 */
export function enemyKingDanger(board: Board, world: World, team: TeamId): OccupiedFn | null {
  const enemyTeam: TeamId = team === 'red' ? 'blue' : 'red'
  const king = kingOf(world, enemyTeam)
  const cell = king !== null ? world.get(king, Cell) : null
  if (!cell) return null
  const ring = kingRing(board, cell)
  return (x, y) => ring.has(board.cellIndex(x, y))
}
