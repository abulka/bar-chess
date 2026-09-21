import type { Board } from './board'
import { attackApproachCells } from './geometry'
import type { OccupiedFn } from './geometry'
import { findPath } from './pathfind'
import type { Geometry, TeamId, Vec2 } from './types'

/**
 * Whether the piece can *ever* reach a cell from which its weapon covers the
 * target, ignoring other pieces (they move). Distinguishes a positionally
 * impossible target (e.g. a bishop on the other colour) from one that is merely
 * blocked right now.
 */
export function firingPositionExists(
  board: Board,
  from: Vec2,
  targetCell: Vec2,
  moveGeom: Geometry,
  weaponGeom: Geometry,
  team: TeamId,
): boolean {
  const candidates = attackApproachCells(board, targetCell, weaponGeom, team)
  for (const c of candidates) {
    if (findPath(board, from, c, moveGeom, team).found) return true
  }
  return false
}

/**
 * Firing cell to route an attack preview toward: the empty, reachable approach
 * cell that minimises total travel (piece → cell → target). Picking a genuine
 * approach cell keeps the final shooting line aligned with the weapon geometry
 * (a bishop shoots diagonally, a rook straight) instead of the nearest cell,
 * which can sit directly beside the target.
 */
export function previewFiringCell(
  board: Board,
  from: Vec2,
  targetCell: Vec2,
  moveGeom: Geometry,
  weaponGeom: Geometry,
  team: TeamId,
  occupied: OccupiedFn,
): Vec2 | null {
  const scored = attackApproachCells(board, targetCell, weaponGeom, team)
    .filter((c) => !occupied(c.x, c.y))
    .map((c) => ({
      c,
      s: (c.x - from.x) ** 2 + (c.y - from.y) ** 2 + (c.x - targetCell.x) ** 2 + (c.y - targetCell.y) ** 2,
    }))
    .sort((a, b) => a.s - b.s)
  for (const { c } of scored) {
    if (findPath(board, from, c, moveGeom, team).found) return c
  }
  return null
}

/**
 * Closest currently-empty cell to the target that the piece could reach if the
 * board were clear (only walls block). Used for the theoretical navigation when
 * the target is positionally out of reach, so the route stops on a real square
 * instead of under a piece beside the target.
 */
export function closestEmptyCell(
  board: Board,
  from: Vec2,
  targetCell: Vec2,
  moveGeom: Geometry,
  team: TeamId,
  occupied: OccupiedFn,
): Vec2 | null {
  const candidates: Array<{ c: Vec2; d: number }> = []
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      if (x === targetCell.x && y === targetCell.y) continue
      if (!board.passable(x, y) || occupied(x, y)) continue
      candidates.push({ c: { x, y }, d: (x - targetCell.x) ** 2 + (y - targetCell.y) ** 2 })
    }
  }
  candidates.sort((a, b) => a.d - b.d)
  const limit = Math.min(candidates.length, 64)
  for (let i = 0; i < limit; i++) {
    if (findPath(board, from, candidates[i].c, moveGeom, team).found) return candidates[i].c
  }
  return null
}
