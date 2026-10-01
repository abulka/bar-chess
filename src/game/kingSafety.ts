import type { Board } from './board'
import { TEAM_IDS } from './constants'
import { cellsBetween, chebyshev, containsCell, fireCells, moveDestinations } from './geometry'
import type { OccupiedFn } from './geometry'
import { kingOf } from './healing'
import { makeOccupied, occupiedExcept } from './occupancy'
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

/**
 * Whether the checked side can answer a single check by taking the checker or by
 * stepping a piece onto the line between the checker and the king. Taking means
 * covering the checker's square with a weapon, which is how this game captures;
 * blocking only works against a line weapon, because a knight cannot be
 * interposed and a range-one shot has no square in between.
 */
function canAnswerCheck(
  board: Board,
  world: World,
  team: TeamId,
  king: Entity,
  kingCell: Vec2,
  attacker: Entity,
  occupied: OccupiedFn,
): boolean {
  const attackerCell = world.get(attacker, Cell)
  if (!attackerCell) return false
  const attackerDef = PIECES[world.require(attacker, PieceType).kind]
  const canBlock = attackerDef !== undefined && WEAPONS[attackerDef.weapon].geometry.kind === 'slide'
  const blocks = canBlock ? cellsBetween(board, attackerCell, kingCell) : []

  for (const e of world.query(Cell, Team, PieceType)) {
    if (e === king) continue
    if (world.require(e, Team) !== team) continue
    const health = world.get(e, Health)
    if (!health || health.cur <= 0) continue
    if (world.has(e, Dead)) continue
    const def = PIECES[world.require(e, PieceType).kind]
    if (!def) continue
    const cell = world.require(e, Cell)
    // Take the checker: this piece's weapon already covers its square.
    if (
      containsCell(
        fireCells(board, cell, WEAPONS[def.weapon].geometry, team, occupied),
        attackerCell.x,
        attackerCell.y,
      )
    ) {
      return true
    }
    // Block the line: a legal step onto an interior square of the firing ray.
    if (blocks.length > 0) {
      const dests = moveDestinations(board, cell, def.move, team, occupied)
      if (dests.some((d) => blocks.some((b) => b.x === d.x && b.y === d.y))) return true
    }
  }
  return false
}

/**
 * Which kings are genuinely checkmated: in check, with no safe square to move
 * to, no friendly piece that can take the checker, and no friendly piece that
 * can step between the checker and the king to block the line. Two checks at
 * once can only be answered by moving the king. Computed from the live world
 * (not a `Game`), so the simulation and the snapshot share one definition.
 */
export function checkmateSides(
  board: Board,
  world: World,
  occupancy: Occupancy,
): Record<TeamId, boolean> {
  const out: Record<TeamId, boolean> = { red: false, blue: false }
  const occupied = makeOccupied(board, occupancy)
  for (const team of TEAM_IDS) {
    const king = kingOf(world, team)
    if (king === null) continue
    const cell = world.get(king, Cell)
    if (!cell) continue
    const covered = enemyCoverage(board, world, occupancy, king, team)
    if (!covered.has(board.cellIndex(cell.x, cell.y))) continue

    const free = occupiedExcept(board, occupancy, king)
    const attackers: Entity[] = []
    for (const e of world.query(Cell, Team, PieceType)) {
      if (e === king) continue
      const enemyTeam = world.require(e, Team)
      if (enemyTeam === team) continue
      const health = world.get(e, Health)
      if (!health || health.cur <= 0) continue
      if (world.has(e, Dead)) continue
      const def = PIECES[world.require(e, PieceType).kind]
      if (!def) continue
      const acell = world.require(e, Cell)
      const hitsKing = containsCell(
        fireCells(board, acell, WEAPONS[def.weapon].geometry, enemyTeam, free),
        cell.x,
        cell.y,
      )
      if (hitsKing) attackers.push(e)
    }
    if (attackers.length === 0) continue

    const canStepOut = moveDestinations(board, cell, PIECES.king.move, team, occupied).some(
      (c) => !covered.has(board.cellIndex(c.x, c.y)),
    )
    if (canStepOut) continue

    // The king may take an adjacent checker that no other enemy defends.
    if (attackers.length === 1) {
      const attackerCell = world.get(attackers[0], Cell)
      if (
        attackerCell &&
        chebyshev(cell.x, cell.y, attackerCell.x, attackerCell.y) === 1 &&
        !covered.has(board.cellIndex(attackerCell.x, attackerCell.y))
      ) {
        continue
      }
    }

    // Two checks at once can only be answered by a king move, already ruled out.
    if (attackers.length > 1) {
      out[team] = true
      continue
    }

    if (canAnswerCheck(board, world, team, king, cell, attackers[0], occupied)) continue
    out[team] = true
  }
  return out
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
