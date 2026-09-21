import type { Board } from './board'
import type { Dir, Geometry, TeamId, Vec2 } from './types'
import { resolveGeometry } from './types'

export type OccupiedFn = (x: number, y: number) => boolean

const NEVER: OccupiedFn = () => false

export function cellKey(x: number, y: number, width: number): number {
  return y * width + x
}

/**
 * Cells a piece can legally step to with one application of its movement
 * geometry. Another piece on a cell blocks it (one piece per square) unless
 * `ignoreOccupancy` is set, which path planning uses so routes may be planned
 * through cells that are merely busy right now.
 */
export function moveDestinations(
  board: Board,
  from: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn = NEVER,
  ignoreOccupancy = false,
): Vec2[] {
  const g = resolveGeometry(geom, team)
  const out: Vec2[] = []
  const free = (x: number, y: number) => board.passable(x, y) && (ignoreOccupancy || !occupied(x, y))

  if (g.kind === 'slide') {
    for (const [dx, dy] of g.dirs) {
      for (let k = 1; k <= g.range; k++) {
        const x = from.x + dx * k
        const y = from.y + dy * k
        if (!board.passable(x, y)) break
        if (!ignoreOccupancy && occupied(x, y)) break
        out.push({ x, y })
      }
    }
    return out
  }

  if (g.kind === 'leap') {
    for (const [dx, dy] of g.offsets) {
      const x = from.x + dx
      const y = from.y + dy
      if (free(x, y)) out.push({ x, y })
    }
    return out
  }

  const fx = from.x
  const fy = from.y + g.dy * g.forward
  if (free(fx, fy)) out.push({ x: fx, y: fy })
  return out
}

/**
 * Cells a weapon can reach from `from`: slide rays stop at walls and at the
 * first piece (which is included as a hittable target); leaps ignore blockers.
 */
export function fireCells(
  board: Board,
  from: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn = NEVER,
): Vec2[] {
  const g = resolveGeometry(geom, team)
  const out: Vec2[] = []

  if (g.kind === 'slide') {
    for (const [dx, dy] of g.dirs) {
      for (let k = 1; k <= g.range; k++) {
        const x = from.x + dx * k
        const y = from.y + dy * k
        if (!board.inBounds(x, y) || board.blocksVision(x, y)) break
        out.push({ x, y })
        if (occupied(x, y)) break
      }
    }
    return out
  }

  if (g.kind === 'leap') {
    for (const [dx, dy] of g.offsets) {
      const x = from.x + dx
      const y = from.y + dy
      if (board.inBounds(x, y)) out.push({ x, y })
    }
    return out
  }

  for (const [dx, dy] of pawnFireDirs(g.dy)) {
    for (let k = 1; k <= 2; k++) {
      const x = from.x + dx * k
      const y = from.y + dy * k
      if (!board.inBounds(x, y) || board.blocksVision(x, y)) break
      out.push({ x, y })
      if (occupied(x, y)) break
    }
  }
  return out
}

function pawnFireDirs(dy: number): Dir[] {
  return [
    [1, dy],
    [-1, dy],
  ]
}

/**
 * True when no wall or piece blocks the sight line between two cells. Used for
 * validation when a target was acquired by vision rather than by geometry.
 */
export function lineClear(
  board: Board,
  a: Vec2,
  b: Vec2,
  occupied: OccupiedFn = NEVER,
  includeEnds = false,
): boolean {
  let x0 = a.x
  let y0 = a.y
  const x1 = b.x
  const y1 = b.y
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  for (;;) {
    const isStart = x0 === a.x && y0 === a.y
    const isEnd = x0 === x1 && y0 === y1
    if (!isStart && !(isEnd && !includeEnds)) {
      if (board.blocksVision(x0, y0)) return false
      if (occupied(x0, y0)) return false
    }
    if (isEnd) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x0 += sx
    }
    if (e2 < dx) {
      err += dx
      y0 += sy
    }
  }
  return true
}

/**
 * Empty cells from which `targetCell` sits inside the given firing geometry.
 * Used to pick a firing position (rather than piling onto the occupied target).
 * Computed as `target - dir`, which is correct for asymmetric patterns too
 * (a pawn approaches from the side it fires toward).
 */
export function attackApproachCells(
  board: Board,
  targetCell: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn = NEVER,
): Vec2[] {
  const g = resolveGeometry(geom, team)
  const out: Vec2[] = []
  const dirs: readonly Dir[] =
    g.kind === 'slide'
      ? g.dirs
      : g.kind === 'leap'
        ? g.offsets
        : ([[0, g.dy], [1, g.dy], [-1, g.dy]] as Dir[])
  const range = g.kind === 'slide' ? g.range : 1
  for (const [dx, dy] of dirs) {
    for (let k = 1; k <= range; k++) {
      const x = targetCell.x - dx * k
      const y = targetCell.y - dy * k
      if (!board.inBounds(x, y) || board.blocksVision(x, y)) break
      if (!occupied(x, y) && board.passable(x, y)) out.push({ x, y })
      if (occupied(x, y)) break
    }
  }
  return out
}

export function containsCell(cells: Vec2[], x: number, y: number): boolean {
  for (const c of cells) {
    if (c.x === x && c.y === y) return true
  }
  return false
}

export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}
