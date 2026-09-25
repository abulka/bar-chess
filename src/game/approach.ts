import type { Board } from './board'
import { attackApproachCells, containsCell, fireCells } from './geometry'
import type { OccupiedFn } from './geometry'
import { dist2, vecEquals } from './math'
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
  for (const c of attackApproachCells(board, targetCell, weaponGeom, team)) {
    if (reach[board.cellIndex(c.x, c.y)]) return true
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
  avoid?: OccupiedFn,
): Vec2 | null {
  const reach = reachableCells(board, from, moveGeom, team)
  const moves = moveDistances(board, from, moveGeom, team)
  const candidates = attackApproachCells(board, targetCell, weaponGeom, team)
    // The piece's own square is never a "move to" candidate (a caller that is
    // already in firing geometry handles the hold itself).
    .filter((c) => !vecEquals(c, from) && !occupied(c.x, c.y) && reach[board.cellIndex(c.x, c.y)])
  const rank = (cells: Vec2[]) =>
    cells
      .map((c) => ({
        c,
        moves: moves[board.cellIndex(c.x, c.y)],
        // Euclidean total kept as a tie-break among equally-reachable cells.
        s: dist2(c.x, c.y, from.x, from.y) + dist2(c.x, c.y, targetCell.x, targetCell.y),
      }))
      .sort((a, b) => a.moves - b.moves || a.s - b.s)
  // Prefer a firing cell clear of `avoid` (e.g. the 3×3 around an enemy king,
  // where the king's guard can one-shot the shooter); fall back to any firing
  // cell only when every option is inside that danger zone.
  const safe = avoid ? candidates.filter((c) => !avoid(c.x, c.y)) : candidates
  const scored = rank(safe.length > 0 ? safe : candidates)
  return scored.length > 0 ? scored[0].c : null
}

/**
 * Closest currently-empty cell to the target that the piece could actually
 * reach (walls block, other pieces are assumed to move). Used for the
 * theoretical navigation when the target is positionally out of reach, so the
 * route stops on a real square instead of under a piece beside the target.
 *
 * Holds on ties: if the piece's own square is already as close to the target as
 * any reachable square, it returns that square. Stepping to an equally-close one
 * would only shuttle between two cells (the bishop g6↔h7 case when chasing an
 * opposite-colour target), so "as close as it can get" means standing still.
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
  const here = dist2(from.x, from.y, targetCell.x, targetCell.y)
  const candidates: Array<{ c: Vec2; d: number }> = []
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      if (x === targetCell.x && y === targetCell.y) continue
      if (!reach[board.cellIndex(x, y)]) continue
      if (!board.passable(x, y) || occupied(x, y)) continue
      candidates.push({ c: { x, y }, d: dist2(x, y, targetCell.x, targetCell.y) })
    }
  }
  candidates.sort((a, b) => a.d - b.d)
  const best = candidates[0]
  if (!best) return null
  if (here <= best.d) return { x: from.x, y: from.y }
  return best.c
}

/** True when `targetCell` is inside the weapon geometry fired from `from`. */
export function inFiringGeometry(
  board: Board,
  from: Vec2,
  targetCell: Vec2,
  weaponGeom: Geometry,
  team: TeamId,
  occupied: OccupiedFn,
): boolean {
  return containsCell(fireCells(board, from, weaponGeom, team, occupied), targetCell.x, targetCell.y)
}

export interface AttackPlan {
  /** Positionally reachable at all (ignores other pieces). */
  reachable: boolean
  /** Target is already hittable from `from` — caller should hold and fire. */
  inRange: boolean
  /** Goal cell to walk to; equals `targetCell` when nothing better exists. */
  cell: Vec2
}

/**
 * The single attack-navigation policy. Goal selection only: the caller keeps
 * its own occupancy for pathfinding (live vs theoretical), which legitimately
 * differs between preview and execution.
 *
 * `inRange` is the hold signal (already hittable — stop and fire). `cell` is
 * always the walk-to goal chain (firing cell → closest empty → target), even
 * when holding: callers that do not hold (`orderSettled`, `planStep`) need that
 * chain, while holders (`planAttack`, `pursue`) check `inRange` first and ignore it.
 */
export function attackPlan(
  board: Board,
  from: Vec2,
  targetCell: Vec2,
  moveGeom: Geometry,
  weaponGeom: Geometry,
  team: TeamId,
  occupied: OccupiedFn,
  avoid?: OccupiedFn,
): AttackPlan {
  const reachable = firingPositionExists(board, from, targetCell, moveGeom, weaponGeom, team)
  const inRange = inFiringGeometry(board, from, targetCell, weaponGeom, team, occupied)
  const cell =
    previewFiringCell(board, from, targetCell, moveGeom, weaponGeom, team, occupied, avoid) ??
    closestEmptyCell(board, from, targetCell, moveGeom, team, occupied) ??
    { x: targetCell.x, y: targetCell.y }
  return { reachable, inRange, cell }
}
