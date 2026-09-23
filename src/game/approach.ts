import type { Board } from './board'
import { attackApproachCells } from './geometry'
import type { OccupiedFn } from './geometry'
import { moveDistances, reachableCells } from './pathfind'
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
  const reach = reachableCells(board, from, moveGeom, team)
  const w = board.width
  for (const c of attackApproachCells(board, targetCell, weaponGeom, team)) {
    if (reach[c.y * w + c.x]) return true
  }
  return false
}

/**
 * Firing cell to route an attack preview toward: the empty, reachable approach
 * cell that minimises total travel (piece → cell → target). The piece → cell leg
 * is scored by actual movement hops (`moveDistances`), because Euclidean distance
 * is a poor proxy for leap (knight) movement — a knight's "nearby" square can be
 * four hops away while a farther-looking one is two. The cell → target leg is a
 * single weapon application for every approach cell, so it is only a tie-break
 * (keeping the chosen square close to the victim). Picking a genuine approach
 * cell keeps the final shooting line aligned with the weapon geometry (a bishop
 * shoots diagonally, a rook straight) instead of the nearest cell, which can sit
 * directly beside the target.
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
  const reach = reachableCells(board, from, moveGeom, team)
  const dist = moveDistances(board, from, moveGeom, team)
  const w = board.width
  const scored = attackApproachCells(board, targetCell, weaponGeom, team)
    // The piece's own square is never a "move to" candidate (a caller that is
    // already in firing geometry handles the hold itself).
    .filter((c) => !(c.x === from.x && c.y === from.y) && !occupied(c.x, c.y) && reach[c.y * w + c.x])
    .map((c) => ({
      c,
      moves: dist[c.y * w + c.x],
      // Euclidean total kept as a tie-break among equally-reachable cells.
      s: (c.x - from.x) ** 2 + (c.y - from.y) ** 2 + (c.x - targetCell.x) ** 2 + (c.y - targetCell.y) ** 2,
    }))
    .sort((a, b) => a.moves - b.moves || a.s - b.s)
  return scored.length > 0 ? scored[0].c : null
}

/**
 * Closest currently-empty cell to the target that the piece could actually
 * reach (walls block, other pieces are assumed to move). Used for the
 * theoretical navigation when the target is positionally out of reach, so the
 * route stops on a real square instead of under a piece beside the target.
 */
export function closestEmptyCell(
  board: Board,
  from: Vec2,
  targetCell: Vec2,
  moveGeom: Geometry,
  team: TeamId,
  occupied: OccupiedFn,
): Vec2 | null {
  const reach = reachableCells(board, from, moveGeom, team)
  const w = board.width
  const candidates: Array<{ c: Vec2; d: number }> = []
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < w; x++) {
      if (x === targetCell.x && y === targetCell.y) continue
      if (!reach[y * w + x]) continue
      if (!board.passable(x, y) || occupied(x, y)) continue
      candidates.push({ c: { x, y }, d: (x - targetCell.x) ** 2 + (y - targetCell.y) ** 2 })
    }
  }
  candidates.sort((a, b) => a.d - b.d)
  return candidates.length > 0 ? candidates[0].c : null
}
