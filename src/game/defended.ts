import type { Board } from './board'
import { fireCells } from './geometry'
import { makeOccupied, occupiedExcept } from './occupancy'
import type { Occupancy } from './occupancy'
import { PIECES, WEAPONS } from './pieces'
import type { TeamId } from './types'
import { Cell, Dead, Health, PieceType, Team } from '../ecs/components'
import type { Entity, World } from '../ecs/world'

/** Fraction of a defended piece's max HP regenerated per second. */
export const DEFENDED_HEAL_RATE = 0.025

function isLive(world: World, e: Entity): boolean {
  const health = world.get(e, Health)
  if (!health || health.cur <= 0) return false
  return !world.has(e, Dead)
}

/**
 * Every cell currently covered by a same-team weapon, i.e. a square this team
 * defends. A piece standing on one of these squares is "chess-protected": a
 * friendly weapon could hit it there, so an enemy capture is answered. `exclude`
 * drops a piece from both the occupancy and the defender sweep, so a moving
 * piece is not credited with defending the square it is about to step onto.
 */
export function friendlyCoverageCells(
  board: Board,
  world: World,
  occupancy: Occupancy,
  team: TeamId,
  exclude?: Entity,
): Set<number> {
  const free = exclude === undefined ? makeOccupied(board, occupancy) : occupiedExcept(board, occupancy, exclude)
  const covered = new Set<number>()
  for (const e of world.query(Cell, Team, PieceType)) {
    if (e === exclude) continue
    if (world.require(e, Team) !== team) continue
    if (!isLive(world, e)) continue
    const def = PIECES[world.require(e, PieceType).kind]
    if (!def) continue
    const cell = world.require(e, Cell)
    for (const c of fireCells(board, cell, WEAPONS[def.weapon].geometry, team, free)) {
      covered.add(board.cellIndex(c.x, c.y))
    }
  }
  return covered
}

/**
 * Same-team pieces protected by at least one other piece's weapon, mapped to
 * their defenders. Used by the renderer to draw a tendril from the defender to
 * the defended piece; the simulation only needs membership, which
 * `friendlyCoverageCells` supplies directly.
 */
export function defendedMap(
  board: Board,
  world: World,
  occupancy: Occupancy,
  team: TeamId,
): Map<Entity, Entity[]> {
  const free = makeOccupied(board, occupancy)
  const coverage = new Map<number, Entity[]>()
  const targets: Entity[] = []
  for (const e of world.query(Cell, Team, PieceType)) {
    if (world.require(e, Team) !== team) continue
    if (!isLive(world, e)) continue
    targets.push(e)
    const def = PIECES[world.require(e, PieceType).kind]
    if (!def) continue
    const cell = world.require(e, Cell)
    for (const c of fireCells(board, cell, WEAPONS[def.weapon].geometry, team, free)) {
      const idx = board.cellIndex(c.x, c.y)
      const list = coverage.get(idx)
      if (list) {
        if (!list.includes(e)) list.push(e)
      } else {
        coverage.set(idx, [e])
      }
    }
  }

  const out = new Map<Entity, Entity[]>()
  for (const target of targets) {
    // The king is never healed, even when its bodyguards cover its square.
    if (world.require(target, PieceType).kind === 'king') continue
    const cell = world.require(target, Cell)
    const list = coverage.get(board.cellIndex(cell.x, cell.y))
    if (!list) continue
    const defenders = list.filter((d) => d !== target)
    if (defenders.length > 0) out.set(target, defenders)
  }
  return out
}

/** Whether `piece` has at least one other same-team piece covering its square. */
export function isDefended(
  board: Board,
  world: World,
  occupancy: Occupancy,
  team: TeamId,
  piece: Entity,
): boolean {
  const cell = world.get(piece, Cell)
  if (!cell) return false
  return friendlyCoverageCells(board, world, occupancy, team, piece).has(board.cellIndex(cell.x, cell.y))
}
