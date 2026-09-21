import type { Board } from './board'
import { attackApproachCells } from './geometry'
import type { OccupiedFn } from './geometry'
import { findPath } from './pathfind'
import type { Geometry, TeamId, Vec2 } from './types'

/**
 * Nearest cell from which a weapon can hit `targetCell` that the piece can
 * actually reach with its movement geometry. Falls back to the nearest
 * approach cell when none is reachable (best effort), or null when the weapon
 * has no approach cell at all.
 */
export function bestFiringCell(
  board: Board,
  from: Vec2,
  targetCell: Vec2,
  moveGeom: Geometry,
  weaponGeom: Geometry,
  team: TeamId,
  occupied: OccupiedFn,
): Vec2 | null {
  const candidates = attackApproachCells(board, targetCell, weaponGeom, team, occupied)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const da = (a.x - from.x) ** 2 + (a.y - from.y) ** 2
    const db = (b.x - from.x) ** 2 + (b.y - from.y) ** 2
    return da - db
  })
  // Only probe the nearest few for reachability: enough to avoid picking a
  // blocked cell, while keeping the per-tick A* cost bounded on large boards.
  const limit = Math.min(candidates.length, 8)
  for (let i = 0; i < limit; i++) {
    if (findPath(board, from, candidates[i], moveGeom, team, occupied).found) return candidates[i]
  }
  return candidates[0]
}
